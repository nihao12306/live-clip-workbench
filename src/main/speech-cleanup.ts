import type { TranscriptSegment } from "../shared/types";

const SEPARATOR_CLASS = "[，,、；;：:。！？!?\\s]";

// Only unambiguous hesitation sounds belong in the mechanical cleanup pass.
// Connectors such as “然后/其实/这个/但是” can carry sequence, reference or
// contrast and must never be deleted by a global word list.
const GLOBAL_FILLER_TERMS = [
  "呃",
  "额",
];

// Short words can also carry meaning (for example “好学校” or “对比”), so
// these are removed only at a clause/segment boundary. Longer phrases may be
// followed directly by Chinese text: “就是这个问题” should become “问题”.
const LOOSE_BOUNDARY_FILLER_TERMS: string[] = [];
const STRICT_BOUNDARY_FILLER_TERMS: string[] = [];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alternation(terms: string[]): string {
  return terms
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegex)
    .join("|");
}

interface TextMatch {
  start: number;
  end: number;
}

function collectMatches(value: string, extraFillers: string[]): TextMatch[] {
  const matches: TextMatch[] = [];
  const add = (expression: RegExp) => {
    expression.lastIndex = 0;
    for (const match of value.matchAll(expression)) {
      const start = match.index ?? 0;
      matches.push({ start, end: start + match[0].length });
    }
  };

  // Account-specific filler words are explicit user instructions, so remove
  // them wherever they occur instead of relying on punctuation.
  const custom = extraFillers
    .map((item) => item.trim())
    .filter(Boolean);
  const globalTerms = [...GLOBAL_FILLER_TERMS, ...custom];
  if (globalTerms.length) add(new RegExp(alternation(globalTerms), "gu"));

  const loose = alternation(LOOSE_BOUNDARY_FILLER_TERMS);
  if (loose) {
    add(new RegExp(
      `(?:^|(?<=${SEPARATOR_CLASS}))(?:${loose})(?=$|${SEPARATOR_CLASS}|[\\u3400-\\u9fff\\d])`,
      "gu",
    ));
  }
  const strict = alternation(STRICT_BOUNDARY_FILLER_TERMS);
  if (strict) {
    add(new RegExp(
      `(?:^|(?<=${SEPARATOR_CLASS}))(?:${strict})(?=$|${SEPARATOR_CLASS})`,
      "gu",
    ));
  }

  return matches
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((match, index, all) => index === 0 || match.start >= all[index - 1].end);
}

function meaningfulCharacters(value: string): number {
  return (value.match(/[\p{L}\p{N}\u3400-\u9fff]/gu) ?? []).length;
}

function trimBoundaryPunctuation(value: string): {
  text: string;
  left: number;
  right: number;
} {
  const leftMatch = value.match(/^[，,、；;：:。！？!?\s]+/u);
  const rightMatch = value.match(/[，,、；;：:。！？!?\s]+$/u);
  const left = leftMatch?.[0].length ?? 0;
  const right = rightMatch?.[0].length ?? 0;
  return {
    text: value.slice(left, value.length - right).trim(),
    left,
    right,
  };
}

function makeSegment(
  source: TranscriptSegment,
  rawText: string,
  rawStart: number,
  rawEnd: number,
): TranscriptSegment | undefined {
  const trimmed = trimBoundaryPunctuation(rawText);
  if (!trimmed.text || meaningfulCharacters(trimmed.text) < 2) return undefined;
  const duration = Math.max(0, rawEnd - rawStart);
  const charDuration = rawText.length ? duration / rawText.length : 0;
  return {
    ...source,
    start: Math.min(source.end - 0.1, rawStart + trimmed.left * charDuration),
    end: Math.max(
      rawStart + trimmed.left * charDuration + 0.1,
      rawEnd - trimmed.right * charDuration,
    ),
    text: trimmed.text,
  };
}

/**
 * Removes only safe mechanical fillers. Each remaining piece keeps an
 * independent source range so the corresponding audio is removed rather than
 * merely hidden from subtitles. Context-dependent words are deliberately
 * left for semantic review.
 */
export function cleanSpokenSegments(
  segment: TranscriptSegment,
  extraFillers: string[] = [],
): TranscriptSegment[] {
  const original = segment.text.trim();
  if (!original) return [];
  const matches = collectMatches(original, extraFillers);
  if (!matches.length) return [segment];
  // Coarse sentence timestamps do not provide a safe in-sentence cut point.
  // Whole-word cues can be removed here; longer cues are aligned precisely
  // when the reviewer saves a subtitle edit.
  if (segment.timingPrecision !== "word") {
    const spoken = (value: string) =>
      value.replace(/[^\p{L}\p{N}\u3400-\u9fff]/gu, "");
    const matchedText = matches
      .map((match) => original.slice(match.start, match.end))
      .join("");
    return spoken(matchedText) === spoken(original) ? [] : [segment];
  }

  const pieces: TranscriptSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    const start = match.start;
    let end = match.end;
    // A separator immediately after a removed filler belongs to the cut,
    // otherwise the following piece would begin with dangling punctuation.
    while (/[，,、；;：:。！？!?\s]/u.test(original[end] ?? "")) end += 1;
    const piece = makeSegment(
      segment,
      original.slice(cursor, start),
      segment.start + ((segment.end - segment.start) * cursor) / original.length,
      segment.start + ((segment.end - segment.start) * start) / original.length,
    );
    if (piece) pieces.push(piece);
    cursor = end;
  }
  const tail = makeSegment(
    segment,
    original.slice(cursor),
    segment.start + ((segment.end - segment.start) * cursor) / original.length,
    segment.end,
  );
  if (tail) pieces.push(tail);
  return pieces;
}

/** Backward-compatible helper for callers that expect one segment. */
export function cleanSpokenSegment(
  segment: TranscriptSegment,
  extraFillers: string[] = [],
): TranscriptSegment | undefined {
  const pieces = cleanSpokenSegments(segment, extraFillers);
  if (!pieces.length) return undefined;
  if (pieces.length === 1) return pieces[0];
  const chineseOnly = pieces.every((piece) =>
    /^[\u3400-\u9fff\d，。！？!?；;、：:]+$/u.test(piece.text),
  );
  return {
    ...segment,
    start: pieces[0].start,
    end: pieces.at(-1)?.end ?? segment.end,
    text: pieces.map((piece) => piece.text).join(chineseOnly ? "" : " "),
  };
}
