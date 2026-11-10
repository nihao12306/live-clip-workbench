import type {
  Candidate,
  EditSegment,
  TopicContextSegment,
  TranscriptWordTiming,
} from "./types";

export interface SubtitleSyncInput {
  subtitleText: string;
  currentSegments: EditSegment[];
  contextSegments: TopicContextSegment[];
  wordTimings?: TranscriptWordTiming[];
  topicId: string;
}

export interface SubtitleSyncPartialMatch {
  requestedText: string;
  sourceText: string;
}

export interface SubtitleSyncResult {
  subtitleText: string;
  transcriptText: string;
  segments: EditSegment[];
  unmatched: string[];
  partialMatches: SubtitleSyncPartialMatch[];
  matchedUnits: number;
  totalUnits: number;
  /** True when a partial spoken-text edit still relies on estimated timing. */
  needsWordAlignment: boolean;
}

interface SourceUnit {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  text: string;
  timingPrecision: "word" | "sentence" | "estimated";
}

interface SourceMatch {
  indices: number[];
  score: number;
  exact: boolean;
  targetCoverage: number;
}

interface SourceCharacter {
  value: string;
  start: number;
  end: number;
  sourceId: string;
  position: number;
  startBoundaryPrecise: boolean;
  endBoundaryPrecise: boolean;
  wordAligned: boolean;
}

// Fine-grained SRT exports may represent one spoken sentence with dozens of
// tiny cues. Keep enough cues to edit a long sentence without forcing the
// user to insert artificial line breaks.
const MAX_SOURCE_UNITS_PER_MATCH = 128;
const MAX_SOURCE_TO_TARGET_RATIO = 2.4;
const MAX_SOURCE_EXTRA_CHARS = 80;
const MAX_SOURCE_GAP_SECONDS = 2.5;
// A final subtitle edit may remove a few filler characters from the middle of
// a sentence. The source range is split around those characters so the same
// words are removed from the rendered video and audio as well.
const MAX_SUBTITLE_DELETION_CHARS = 24;
const MAX_SUBTITLE_DELETION_RATIO = 0.35;
// Model-generated candidates often merge several transcript cues into one
// editable sentence. A reviewer may remove a whole redundant sentence from
// that merged text, so the deleted portion can be much longer than a filler
// word. Keep the guardrails: the remaining subtitle must still be a fairly
// substantial in-order subsequence of the source.
const MAX_SUBTITLE_SENTENCE_DELETION_CHARS = 240;
const MIN_SUBTITLE_SENTENCE_REMAINDER_CHARS = 8;
const MIN_SUBTITLE_SOURCE_REMAINDER_RATIO = 0.25;
// A saved subtitle unit must have every spoken character represented by the
// matched source range. Missing target characters would create a
// subtitle/audio mismatch.
const REQUIRED_TARGET_COVERAGE = 1;
const WORD_ALIGNMENT_WINDOW_SECONDS = 1;
const MIN_WORD_ALIGNMENT_COVERAGE = 0.55;
const MAX_LOCAL_ALIGNMENT_INTERPOLATION_CHARS = 3;
const WORD_EDGE_PADDING_SECONDS = 0.04;
const ESTIMATED_EDGE_PADDING_SECONDS = 0.16;
const MIN_REMOVED_AUDIO_SECONDS = 0.06;
const MAX_NATURAL_PAUSE_SECONDS = 0.3;

/**
 * Splits the editable subtitle into audio-addressable units. New lines are
 * always boundaries; sentence punctuation is also a boundary so the user
 * can reorder sentences without having to format the field first.
 */
export function splitSubtitleUnits(text: string): string[] {
  return text
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/u)
    .flatMap((line) => line.split(/(?<=[。！？!?；;])\s*/u))
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Reorders existing subtitle sentences to follow a newly reordered audio
 * plan. The user's subtitle wording is preserved; only the sentence order is
 * changed when each unit can still be matched to a real render segment.
 */
export function reorderSubtitleUnitsToSegments(
  subtitleText: string,
  segments: EditSegment[],
): string {
  const units = splitSubtitleUnits(subtitleText);
  if (units.length < 2 || segments.length < 2) return subtitleText.trim();
  const ranked = units.map((unit, unitIndex) => {
    const target = normalizeSubtitleForMatch(unit);
    let bestSegmentIndex = Number.POSITIVE_INFINITY;
    let bestScore = 0;
    segments.forEach((segment, segmentIndex) => {
      const source = normalizeSubtitleForMatch(segment.text);
      if (!target || !source) return;
      const common = longestCommonSubsequenceLength(target, source);
      const coverage = common / target.length;
      const sourceFit = common / source.length;
      const score = coverage * 0.78 + sourceFit * 0.22;
      if (score > bestScore) {
        bestScore = score;
        bestSegmentIndex = segmentIndex;
      }
    });
    return { unit, unitIndex, bestSegmentIndex, bestScore };
  });
  if (ranked.every((item) => item.bestSegmentIndex === Number.POSITIVE_INFINITY)) {
    return subtitleText.trim();
  }
  const ordered = [...ranked].sort(
    (left, right) => left.bestSegmentIndex - right.bestSegmentIndex || left.unitIndex - right.unitIndex,
  );
  if (ordered.every((item, index) => item.unitIndex === index)) return subtitleText.trim();
  // Do not silently move a completely unrelated manual sentence. Keep such
  // units at the end while still correcting the source-addressable units.
  const usable = ordered.filter((item) => item.bestScore >= 0.35);
  const unusable = ranked.filter((item) => item.bestScore < 0.35);
  return [...usable, ...unusable].map((item) => item.unit).join("\n");
}

/**
 * Removes presentation punctuation and whitespace while keeping the actual
 * spoken characters. This lets a hand edit such as adding a comma or a space
 * continue to point at the original time-coded speech.
 */
export function normalizeSubtitleForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/[，,。！？!?；;：:、、“”‘’'"（）()【】［］[\]《》<>…—\-]/gu, "");
}

function longestCommonSubsequenceLength(left: string, right: string): number {
  if (!left || !right) return 0;
  const previous = new Array<number>(right.length + 1).fill(0);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const saved = previous[rightIndex + 1];
      if (left[leftIndex] === right[rightIndex]) {
        previous[rightIndex + 1] = diagonal + 1;
      } else {
        previous[rightIndex + 1] = Math.max(
          previous[rightIndex + 1],
          previous[rightIndex],
        );
      }
      diagonal = saved;
    }
  }
  return previous[right.length];
}

function isSubsequence(target: string, source: string): boolean {
  if (!target) return true;
  let sourceIndex = 0;
  for (const character of target) {
    const nextIndex = source.indexOf(character, sourceIndex);
    if (nextIndex < 0) return false;
    sourceIndex = nextIndex + 1;
  }
  return true;
}

interface TimedCharacter {
  value: string;
  start: number;
  end: number;
  startBoundaryPrecise: boolean;
  endBoundaryPrecise: boolean;
}

function normalizedCharacters(value: string): string[] {
  return Array.from(normalizeSubtitleForMatch(value));
}

function fallbackSourceCharacters(sources: SourceUnit[]): SourceCharacter[] {
  const characters: SourceCharacter[] = [];
  for (const source of sources) {
    const values = normalizedCharacters(source.text);
    const duration = Math.max(0, source.sourceEnd - source.sourceStart);
    values.forEach((value, index) => {
      characters.push({
        value,
        start: source.sourceStart + (duration * index) / Math.max(1, values.length),
        end: source.sourceStart + (duration * (index + 1)) / Math.max(1, values.length),
        sourceId: source.id,
        position: characters.length,
        startBoundaryPrecise: source.timingPrecision === "word" && index === 0,
        endBoundaryPrecise: source.timingPrecision === "word" && index === values.length - 1,
        wordAligned: source.timingPrecision === "word",
      });
    });
  }
  return characters;
}

function timedCharactersFromWords(
  words: TranscriptWordTiming[],
  start: number,
  end: number,
): TimedCharacter[] {
  return words
    .filter((word) =>
      word.end >= start - WORD_ALIGNMENT_WINDOW_SECONDS
      && word.start <= end + WORD_ALIGNMENT_WINDOW_SECONDS,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .flatMap((word) => {
      const values = normalizedCharacters(word.text);
      const duration = Math.max(0, word.end - word.start);
      return values.map((value, index) => ({
        value,
        start: word.start + (duration * index) / Math.max(1, values.length),
        end: word.start + (duration * (index + 1)) / Math.max(1, values.length),
        startBoundaryPrecise: index === 0,
        endBoundaryPrecise: index === values.length - 1,
      }));
    });
}

/** Returns source-index -> timed-index pairs from one deterministic LCS. */
function alignCharacterIndices(
  source: SourceCharacter[],
  timed: TimedCharacter[],
): Map<number, number> {
  const rows = source.length + 1;
  const columns = timed.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let sourceIndex = 1; sourceIndex < rows; sourceIndex += 1) {
    for (let timedIndex = 1; timedIndex < columns; timedIndex += 1) {
      table[sourceIndex]![timedIndex] = source[sourceIndex - 1]?.value === timed[timedIndex - 1]?.value
        ? (table[sourceIndex - 1]?.[timedIndex - 1] ?? 0) + 1
        : Math.max(
          table[sourceIndex - 1]?.[timedIndex] ?? 0,
          table[sourceIndex]?.[timedIndex - 1] ?? 0,
        );
    }
  }
  const pairs = new Map<number, number>();
  let sourceIndex = source.length;
  let timedIndex = timed.length;
  while (sourceIndex > 0 && timedIndex > 0) {
    if (source[sourceIndex - 1]?.value === timed[timedIndex - 1]?.value) {
      pairs.set(sourceIndex - 1, timedIndex - 1);
      sourceIndex -= 1;
      timedIndex -= 1;
    } else if (
      (table[sourceIndex - 1]?.[timedIndex] ?? 0)
      >= (table[sourceIndex]?.[timedIndex - 1] ?? 0)
    ) {
      sourceIndex -= 1;
    } else {
      timedIndex -= 1;
    }
  }
  return pairs;
}

function sourceCharactersFromUnits(
  sources: SourceUnit[],
  wordTimings: TranscriptWordTiming[],
): SourceCharacter[] {
  const fallback = fallbackSourceCharacters(sources);
  const first = sources[0];
  const last = sources.at(-1);
  if (!first || !last || !wordTimings.length || !fallback.length) return fallback;
  const timed = timedCharactersFromWords(wordTimings, first.sourceStart, last.sourceEnd);
  if (!timed.length) return fallback;
  const pairs = alignCharacterIndices(fallback, timed);
  if (pairs.size / fallback.length < MIN_WORD_ALIGNMENT_COVERAGE) return fallback;
  const alignedCharacters = fallback.map((character, index) => {
    const timedIndex = pairs.get(index);
    const aligned = timedIndex === undefined ? undefined : timed[timedIndex];
    return aligned
      ? {
          ...character,
          start: aligned.start,
          end: aligned.end,
          startBoundaryPrecise: aligned.startBoundaryPrecise,
          endBoundaryPrecise: aligned.endBoundaryPrecise,
          wordAligned: true,
        }
      : character;
  });
  // A recognizer can spell one character differently while still locating
  // the words on both sides correctly. Interpolate only very short holes;
  // this keeps the cut anchored to nearby word timestamps without pretending
  // that a long unmatched phrase has precise timing.
  for (let index = 0; index < alignedCharacters.length; index += 1) {
    const character = alignedCharacters[index];
    if (!character || character.wordAligned) continue;
    let previousIndex = index - 1;
    while (
      previousIndex >= 0
      && index - previousIndex <= MAX_LOCAL_ALIGNMENT_INTERPOLATION_CHARS
      && !alignedCharacters[previousIndex]?.wordAligned
    ) previousIndex -= 1;
    let nextIndex = index + 1;
    while (
      nextIndex < alignedCharacters.length
      && nextIndex - index <= MAX_LOCAL_ALIGNMENT_INTERPOLATION_CHARS
      && !alignedCharacters[nextIndex]?.wordAligned
    ) nextIndex += 1;
    const previous = alignedCharacters[previousIndex];
    const next = alignedCharacters[nextIndex];
    const hasNearbyPrevious = previous?.wordAligned
      && index - previousIndex <= MAX_LOCAL_ALIGNMENT_INTERPOLATION_CHARS;
    const hasNearbyNext = next?.wordAligned
      && nextIndex - index <= MAX_LOCAL_ALIGNMENT_INTERPOLATION_CHARS;
    if (hasNearbyPrevious && hasNearbyNext && next.start > previous.end) {
      const slots = nextIndex - previousIndex - 1;
      const slot = index - previousIndex - 1;
      const duration = (next.start - previous.end) / Math.max(1, slots);
      character.start = previous.end + slot * duration;
      character.end = character.start + duration;
      character.wordAligned = true;
    } else if (hasNearbyPrevious && !hasNearbyNext) {
      const duration = Math.max(0.06, Math.min(0.4, character.end - character.start));
      character.start = previous.end + duration * (index - previousIndex - 1);
      character.end = character.start + duration;
      character.wordAligned = true;
    } else if (!hasNearbyPrevious && hasNearbyNext) {
      const duration = Math.max(0.06, Math.min(0.4, character.end - character.start));
      character.end = next.start - duration * (nextIndex - index - 1);
      character.start = Math.max(0, character.end - duration);
      character.wordAligned = true;
    }
  }
  return alignedCharacters;
}

function mapTargetToSourceCharacters(
  target: string,
  sourceCharacters: SourceCharacter[],
): SourceCharacter[] | undefined {
  const mapped: SourceCharacter[] = [];
  let cursor = 0;
  for (const character of Array.from(target)) {
    const index = sourceCharacters.findIndex(
      (item, itemIndex) => itemIndex >= cursor && item.value === character,
    );
    if (index < 0) return undefined;
    const sourceCharacter = sourceCharacters[index];
    if (!sourceCharacter) return undefined;
    mapped.push(sourceCharacter);
    cursor = index + 1;
  }
  return mapped;
}

function materializeMatchSegments(
  rangeSources: SourceUnit[],
  targetNormalized: string,
  topicId: string,
  groupIndex: number,
  wordTimings: TranscriptWordTiming[],
): EditSegment[] {
  const first = rangeSources[0];
  const last = rangeSources.at(-1);
  if (!first || !last) return [];
  const sourceNormalized = rangeSources
    .map((source) => normalizeSubtitleForMatch(source.text))
    .join("");
  if (sourceNormalized === targetNormalized) {
    return [{
      id: first.id,
      sourceStart: Math.min(...rangeSources.map((source) => source.sourceStart)),
      sourceEnd: Math.max(...rangeSources.map((source) => source.sourceEnd)),
      text: rangeSources.map((source) => source.text).join(" "),
      topicId,
      order: 0,
      timingPrecision: rangeSources.every((source) => source.timingPrecision === "word")
        ? "word"
        : "estimated",
    }];
  }

  const sourceCharacters = sourceCharactersFromUnits(rangeSources, wordTimings);
  const mapped = mapTargetToSourceCharacters(targetNormalized, sourceCharacters);
  // Matching already guarantees full target coverage. Keep a conservative
  // fallback here so an unusual Unicode normalization never drops audio
  // silently when we cannot derive safe character boundaries.
  if (!mapped?.length) {
    return [{
      id: first.id,
      sourceStart: Math.min(...rangeSources.map((source) => source.sourceStart)),
      sourceEnd: Math.max(...rangeSources.map((source) => source.sourceEnd)),
      text: rangeSources.map((source) => source.text).join(" "),
      topicId,
      order: 0,
      timingPrecision: "estimated",
    }];
  }

  const groupId = `${first.id}:subtitle:${groupIndex}`;
  const drafts: Array<{
    segment: EditSegment;
    rawStart: number;
    rawEnd: number;
    leadPadding: number;
    trailPadding: number;
  }> = [];
  let runStart = 0;
  const flush = (runEndExclusive: number) => {
    const run = mapped.slice(runStart, runEndExclusive);
    const firstCharacter = run[0];
    const lastCharacter = run.at(-1);
    if (!firstCharacter || !lastCharacter || lastCharacter.end <= firstCharacter.start) return;
    const partIndex = drafts.length;
    const precise = firstCharacter.wordAligned && lastCharacter.wordAligned;
    const padding = precise ? WORD_EDGE_PADDING_SECONDS : ESTIMATED_EDGE_PADDING_SECONDS;
    drafts.push({
      rawStart: firstCharacter.start,
      rawEnd: lastCharacter.end,
      leadPadding: padding,
      trailPadding: padding,
      segment: {
      id: partIndex === 0
        ? firstCharacter.sourceId
        : `${firstCharacter.sourceId}:subtitle-part:${groupIndex}:${partIndex}`,
      sourceStart: Math.max(0, firstCharacter.start - padding),
      sourceEnd: lastCharacter.end + padding,
      text: run.map((character) => character.value).join(""),
      topicId,
      order: 0,
      subtitleGroupId: groupId,
      timingPrecision: precise ? "word" : "estimated",
      },
    });
  };
  for (let index = 1; index < mapped.length; index += 1) {
    const previous = mapped[index - 1];
    const current = mapped[index];
    if (!previous || !current) continue;
    if (current.position !== previous.position + 1) {
      flush(index);
      runStart = index;
    }
  }
  flush(mapped.length);
  // Padding prevents clipped syllables, but it must not grow far enough to
  // reintroduce the filler or sentence that the reviewer removed. Apply the
  // same boundary clamp used by mature transcript editors: the two pads
  // around one removed span must leave a small amount of that span absent.
  for (let index = 1; index < drafts.length; index += 1) {
    const previous = drafts[index - 1];
    const current = drafts[index];
    if (!previous || !current) continue;
    const removedDuration = Math.max(0, current.rawStart - previous.rawEnd);
    const maximumCombinedPadding = Math.max(0, removedDuration - MIN_REMOVED_AUDIO_SECONDS);
    const requestedPadding = previous.trailPadding + current.leadPadding;
    if (requestedPadding <= maximumCombinedPadding) continue;
    const ratio = requestedPadding > 0
      ? maximumCombinedPadding / requestedPadding
      : 0;
    previous.segment.sourceEnd = previous.rawEnd + previous.trailPadding * ratio;
    current.segment.sourceStart = Math.max(
      0,
      current.rawStart - current.leadPadding * ratio,
    );
  }
  return drafts.map((draft) => draft.segment);
}

function scoreMatch(target: string, source: string): {
  score: number;
  exact: boolean;
  targetCoverage: number;
} {
  if (!target || !source) return { score: 0, exact: false, targetCoverage: 0 };
  if (target === source) return { score: 1, exact: true, targetCoverage: 1 };

  const common = longestCommonSubsequenceLength(target, source);
  const overlap = common / Math.max(target.length, source.length);
  const lengthFit = Math.min(target.length, source.length) / Math.max(target.length, source.length);
  const targetCoverage = common / target.length;
  const contained = source.includes(target) || target.includes(source);
  const score = contained
    ? 0.72 + lengthFit * 0.28
    : overlap * 0.72 + lengthFit * 0.28;
  return { score: Math.min(0.99, score), exact: false, targetCoverage };
}

function isUsablePartialMatch(
  target: string,
  source: string,
  score: number,
  targetCoverage: number,
): boolean {
  // A very short fragment is too ambiguous to identify a source time range.
  if (target.length < 4) return false;
  const common = longestCommonSubsequenceLength(target, source);
  const overlap = common / Math.max(target.length, source.length);
  const lengthFit = Math.min(target.length, source.length) / Math.max(target.length, source.length);
  const contained = source.includes(target) || target.includes(source);

  // When the edited subtitle is an in-order subsequence of the original
  // source, the user has only removed spoken characters. Allow a modest
  // amount of that cleanup even when the removed characters are in the
  // middle of the sentence; materializeMatchSegments will split the source
  // range around those characters so their audio is removed too.
  const deletedChars = source.length - target.length;
  const smallInSentenceDeletion = targetCoverage === 1
    && deletedChars > 0
    && deletedChars <= MAX_SUBTITLE_DELETION_CHARS
    && deletedChars <= Math.max(4, target.length * MAX_SUBTITLE_DELETION_RATIO)
    && isSubsequence(target, source);
  if (smallInSentenceDeletion) return true;

  // The same rule also covers deleting a complete sentence from a merged
  // transcript cue. Requiring a long enough remainder and a meaningful
  // source/target ratio prevents a short, ambiguous fragment from silently
  // selecting a large unrelated audio range.
  const wholeSentenceDeletion = targetCoverage === 1
    && deletedChars > 0
    && deletedChars <= MAX_SUBTITLE_SENTENCE_DELETION_CHARS
    && target.length >= MIN_SUBTITLE_SENTENCE_REMAINDER_CHARS
    && target.length / Math.max(1, source.length) >= MIN_SUBTITLE_SOURCE_REMAINDER_RATIO
    && isSubsequence(target, source);
  if (wholeSentenceDeletion) return true;

  if (contained) return lengthFit >= 0.34;
  return score >= 0.78 && targetCoverage >= 0.76 && overlap >= 0.76 && lengthFit >= 0.6;
}

function sourceUnitsFromContext(contextSegments: TopicContextSegment[]): SourceUnit[] {
  const seen = new Set<string>();
  return [...contextSegments]
    .filter((segment) => segment.text.trim())
    .sort((left, right) => left.sourceStart - right.sourceStart || left.sourceEnd - right.sourceEnd)
    .filter((segment) => {
      const key = `${segment.id}|${segment.sourceStart}|${segment.sourceEnd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .flatMap((segment) => splitSourceUnitByPunctuation({
      id: segment.id,
      sourceStart: segment.sourceStart,
      sourceEnd: segment.sourceEnd,
      text: segment.text.trim(),
      timingPrecision: segment.timingPrecision ?? "estimated",
    }));
}

function sourceUnitsFromCurrent(currentSegments: EditSegment[]): SourceUnit[] {
  return [...currentSegments]
    .filter((segment) => segment.text.trim())
    .sort((left, right) => left.sourceStart - right.sourceStart || left.order - right.order)
    .flatMap((segment) => splitSourceUnitByPunctuation({
      id: segment.id,
      sourceStart: segment.sourceStart,
      sourceEnd: segment.sourceEnd,
      text: segment.text.trim(),
      timingPrecision: segment.timingPrecision ?? "estimated",
    }));
}

/**
 * A single estimated transcript cue can contain several spoken sentences.
 * Split those cues before matching so deleting or retaining two sentences
 * from the same cue does not make the second sentence look like a duplicate
 * or an unmatched phrase. Time is apportioned by normalized character count;
 * the final character keeps the original cue's exact end time.
 */
function splitSourceUnitByPunctuation(source: SourceUnit): SourceUnit[] {
  const parts = source.text
    .split(/(?<=[。！？!?；;])/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [source];

  const weights = parts.map((part) => Math.max(1, normalizeSubtitleForMatch(part).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const duration = Math.max(0, source.sourceEnd - source.sourceStart);
  let cursor = source.sourceStart;
  return parts.map((part, index) => {
    const end = index === parts.length - 1
      ? source.sourceEnd
      : cursor + duration * ((weights[index] ?? 1) / totalWeight);
    const result: SourceUnit = {
      id: `${source.id}:sentence:${index}`,
      sourceStart: cursor,
      sourceEnd: end,
      text: part,
      timingPrecision: "estimated",
    };
    cursor = end;
    return result;
  });
}

function findBestSourceMatch(
  requestedText: string,
  requestedNormalized: string,
  sources: SourceUnit[],
  used: Set<number>,
  maxGapSeconds: number,
): SourceMatch | undefined {
  let best: SourceMatch | undefined;
  for (let start = 0; start < sources.length; start += 1) {
    if (used.has(start)) continue;
    let normalized = "";
    const indices: number[] = [];
    for (
      let end = start;
      end < sources.length && indices.length < MAX_SOURCE_UNITS_PER_MATCH;
      end += 1
    ) {
      if (used.has(end)) break;
      const previous = sources[end - 1];
      if (
        end > start
        && previous
        && sources[end].sourceStart - previous.sourceEnd > maxGapSeconds
      ) {
        break;
      }
      const nextNormalized = normalizeSubtitleForMatch(sources[end].text);
      if (!nextNormalized) continue;
      normalized += nextNormalized;
      indices.push(end);
      if (
        normalized.length > requestedNormalized.length * MAX_SOURCE_TO_TARGET_RATIO
        + MAX_SOURCE_EXTRA_CHARS
      ) {
        break;
      }
      const match = scoreMatch(requestedNormalized, normalized);
      const exact = match.exact;
      const usable = exact || isUsablePartialMatch(
        requestedNormalized,
        normalized,
        match.score,
        match.targetCoverage,
      );
      if (!usable) continue;
      const candidate: SourceMatch = { indices: [...indices], ...match };
      if (
        !best
        || candidate.targetCoverage > best.targetCoverage + 0.001
        || (
          Math.abs(candidate.targetCoverage - best.targetCoverage) <= 0.001
          && (
            candidate.score > best.score + 0.001
            || (
              Math.abs(candidate.score - best.score) <= 0.001
              && candidate.indices.length < best.indices.length
            )
          )
        )
      ) {
        best = candidate;
      }
      // Once a contiguous source range is an exact match, adding more source
      // cues can only make the mapping less precise.
      if (exact) break;
    }
  }
  // Keep this parameter explicit in the function signature: it makes the
  // matching intent clear at call sites and protects against accidental empty
  // fragment matches when the splitter is changed later.
  void requestedText;
  return best;
}

/**
 * Maps edited subtitle units back to time-coded source cues.
 *
 * The source of truth for audio is the returned `segments`; the returned
 * `subtitleText` remains the user's edited text. Exact source matches can be
 * deleted and reordered. A small in-order deletion is split into multiple
 * source ranges, removing the corresponding audio/video. A newly typed phrase
 * that is not present in the transcript is reported in `unmatched` instead of
 * silently creating a subtitle/audio mismatch.
 */
export function syncSubtitleToSegments(input: SubtitleSyncInput): SubtitleSyncResult {
  const subtitleText = input.subtitleText.trim();
  const units = splitSubtitleUnits(subtitleText);
  const contextSources = sourceUnitsFromContext(input.contextSegments);
  const sources = contextSources.length
    ? contextSources
    : sourceUnitsFromCurrent(input.currentSegments);
  // Context windows contain unselected speech, so a large time gap is a
  // meaningful boundary there. A legacy candidate without context only has
  // its deliberately selected edit segments; those segments may come from
  // distant timestamps and must still be allowed to form one final sentence.
  const maxGapSeconds = contextSources.length
    ? MAX_SOURCE_GAP_SECONDS
    : Number.POSITIVE_INFINITY;
  const used = new Set<number>();
  const unmatched: string[] = [];
  const partialMatches: SubtitleSyncPartialMatch[] = [];
  const matchedRanges: Array<{
    indices: number[];
    requestedText: string;
    requestedNormalized: string;
    unitIndex: number;
  }> = [];

  for (const [unitIndex, unit] of units.entries()) {
    const normalized = normalizeSubtitleForMatch(unit);
    if (!normalized) continue;
    const match = findBestSourceMatch(
      unit,
      normalized,
      sources,
      used,
      maxGapSeconds,
    );
    if (!match) {
      unmatched.push(unit);
      continue;
    }
    if (match.targetCoverage < REQUIRED_TARGET_COVERAGE) {
      unmatched.push(unit);
      continue;
    }
    match.indices.forEach((index) => {
      used.add(index);
    });
    matchedRanges.push({
      indices: match.indices,
      requestedText: unit,
      requestedNormalized: normalized,
      unitIndex,
    });
    if (!match.exact) {
      partialMatches.push({
        requestedText: unit,
        sourceText: match.indices.map((index) => sources[index].text).join(" "),
      });
    }
  }

  const segments = matchedRanges
    .flatMap((range, groupIndex) => materializeMatchSegments(
      range.indices.map((index) => sources[index]).filter((source): source is SourceUnit => Boolean(source)),
      range.requestedNormalized,
      input.topicId,
      groupIndex,
      input.wordTimings ?? [],
    ).map((segment) => ({
      ...segment,
      subtitleUnitIndex: range.unitIndex,
    })))
    .map((segment, order) => ({ ...segment, order }));
  // Consecutive transcript cues can be separated by a real breath or pause.
  // Keep at most 0.3s of that gap instead of hard-concatenating both words to
  // zero. Do this only for truly adjacent source cues; skipped speech and
  // reviewer reordering must not be pulled back into the edit.
  for (let index = 1; index < matchedRanges.length; index += 1) {
    const previousRange = matchedRanges[index - 1];
    const currentRange = matchedRanges[index];
    const previousSourceIndex = previousRange?.indices.at(-1);
    const currentSourceIndex = currentRange?.indices[0];
    if (
      previousSourceIndex === undefined
      || currentSourceIndex !== previousSourceIndex + 1
    ) continue;
    const previousSource = sources[previousSourceIndex];
    const currentSource = sources[currentSourceIndex];
    if (!previousSource || !currentSource) continue;
    const gap = currentSource.sourceStart - previousSource.sourceEnd;
    if (gap <= 0) continue;
    const preserved = Math.min(MAX_NATURAL_PAUSE_SECONDS, gap);
    const previousSegment = [...segments]
      .reverse()
      .find((segment) => segment.subtitleUnitIndex === previousRange.unitIndex);
    const currentSegment = segments.find(
      (segment) => segment.subtitleUnitIndex === currentRange.unitIndex,
    );
    if (!previousSegment || !currentSegment) continue;
    previousSegment.sourceEnd += preserved / 2;
    currentSegment.sourceStart = Math.max(0, currentSegment.sourceStart - preserved / 2);
  }
  segments.forEach((segment, order) => { segment.order = order; });
  return {
    subtitleText,
    transcriptText: segments.map((segment) => segment.text).join(" "),
    segments,
    unmatched,
    partialMatches,
    matchedUnits: units.length - unmatched.length,
    totalUnits: units.length,
    needsWordAlignment: partialMatches.length > 0
      && segments.some((segment) =>
        segment.subtitleGroupId && segment.timingPrecision !== "word",
      ),
  };
}

export interface PreparedCandidateSubtitleSync {
  result: SubtitleSyncResult;
  nextCandidate: Candidate;
  canSave: boolean;
}

/**
 * Applies an editable subtitle draft to a candidate without destroying its
 * last usable audio plan when only part of the draft can be matched.
 *
 * Older candidates may not have a context window. Their original render plan
 * is the widest reliable source that remains available, so use it for
 * matching instead of a previously narrowed edit plan.
 */
export function prepareCandidateSubtitleSync(
  candidate: Candidate,
): PreparedCandidateSubtitleSync {
  const contextSegments = candidate.contextSegments ?? [];
  const fallbackSegments = contextSegments.length
    ? candidate.renderPlan.segments
    : candidate.originalRenderPlan?.segments?.length
      ? candidate.originalRenderPlan.segments
      : candidate.renderPlan.segments;
  const result = syncSubtitleToSegments({
    subtitleText: candidate.renderPlan.subtitleText,
    currentSegments: fallbackSegments,
    contextSegments,
    wordTimings: candidate.wordTimings,
    topicId: candidate.topicId,
  });
  const canSave = result.segments.length > 0
    && result.unmatched.length === 0
    && !result.needsWordAlignment;
  const nextCandidate: Candidate = {
    ...candidate,
    renderPlan: {
      ...candidate.renderPlan,
      subtitleText: result.subtitleText,
    },
  };

  // A partial result is diagnostic only. Replacing the render plan here would
  // remove the source needed by the next matching attempt, causing the count
  // of unmatched subtitles to grow every time the editor loses focus.
  if (!canSave) return { result, nextCandidate, canSave };

  const ordered = result.segments.map((segment, index) => ({
    ...segment,
    order: index,
  }));
  nextCandidate.duration = ordered.reduce(
    (sum, segment) => sum + Math.max(0, segment.sourceEnd - segment.sourceStart),
    0,
  );
  nextCandidate.transcriptText = result.transcriptText;
  nextCandidate.contextSegments = contextSegments.map((context) => ({
    ...context,
    included: ordered.some(
      (segment) => context.sourceStart < segment.sourceEnd
        && context.sourceEnd > segment.sourceStart,
    ),
  }));
  nextCandidate.renderPlan = {
    ...nextCandidate.renderPlan,
    segments: ordered,
  };
  return { result, nextCandidate, canSave };
}
