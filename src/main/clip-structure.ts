import type { TranscriptSegment } from "../shared/types";

const OPENING_SIGNALS =
  /但是|但|其实|关键|真正|很多人|大多数|你可能|为什么|不要|千万|最重要|问题是|注意|结论|如果|到底|并不是|不是|要不要|能不能|如何|选择|影响|孩子|家长|分数|就业|专业|学校/u;
const DEPENDENT_OPENING_PREFIX =
  /^(?:的|了|着|而|和|与|及|在|从|对|给|把|被|并|也|还|再|就|都|但是|但|所以|因此|然后|而且|并且|另外|此外|这|那|他|她|它|他们|这个|那个|其中)/u;
const HOOK_TOPIC_PHRASES = [
  "高考",
  "弱省",
  "考生",
  "学校",
  "专业",
  "分数",
  "就业",
  "选择",
  "适合",
  "不适合",
  "中科大",
  "卷不过",
  "选不过",
  "被淘汰",
  "淘汰",
  "退学",
  "风险",
  "劝退",
  "建议",
  "关键",
  "真正",
  "不要",
  "不能",
  "值得",
  "优势",
  "没戏",
];
const HOOK_TENSION_PATTERN = /淘汰|退学|风险|劝退|后果|代价|失败|没戏/gu;

function compact(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function overlapScore(left: string, right: string): number {
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) return 0;
  const grams = new Set<string>();
  for (let index = 0; index < a.length - 1; index += 1) {
    grams.add(a.slice(index, index + 2));
  }
  if (!grams.size) return 0;
  let matches = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    if (grams.has(b.slice(index, index + 2))) matches += 1;
  }
  return matches / Math.max(1, b.length - 1);
}

function countMatches(value: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return [...value.matchAll(pattern)].length;
}

/**
 * Hook copy is often a compact editorial summary rather than a verbatim ASR
 * sentence. Give the real transcript cue extra weight when it contains the
 * hook's distinctive topic terms, especially a conclusion/risk phrase.
 */
function hookEvidenceScore(text: string, hookText: string, title: string): number {
  const source = compact(text);
  const request = compact(`${hookText}${title}`);
  const phraseScore = HOOK_TOPIC_PHRASES.reduce((score, phrase) => {
    const normalized = compact(phrase);
    if (!request.includes(normalized) || !source.includes(normalized)) return score;
    return score + (normalized.length >= 3 ? 2.4 : 1.2);
  }, 0);
  const requestedTension = countMatches(request, HOOK_TENSION_PATTERN);
  const tensionScore = requestedTension
    ? countMatches(source, HOOK_TENSION_PATTERN) * 2.8
    : 0;
  return phraseScore + tensionScore;
}

function containsTopicPhrase(text: string, hookText: string, title: string): boolean {
  const phrase = compact(hookText || title);
  if (phrase.length < 6) return false;
  return compact(text).includes(phrase.slice(0, Math.min(18, phrase.length)));
}

/**
 * A word-level ASR cue can score highly simply because it contains a hook
 * keyword (for example “所以” or “这个”). Moving that cue to frame one makes
 * the finished clip start mid-sentence. Only allow a sentence-sized cue to be
 * promoted; short dependent cues stay in their original context.
 */
function isOpeningCandidate(text: string): boolean {
  const cleaned = text.trim();
  if (cleaned.length < 10) return false;
  if (/^[，。！？!?、；;：:,]/u.test(cleaned)) return false;
  if (DEPENDENT_OPENING_PREFIX.test(cleaned) && cleaned.length < 18) return false;
  return true;
}

function openingLeadStart(
  segments: TranscriptSegment[],
  openingIndex: number,
): number {
  let start = openingIndex;
  let combined = segments[openingIndex]?.text.trim() ?? "";
  // Bring along at most a short prerequisite phrase. This repairs openings
  // such as “所以…”/“这个学校…” without moving a whole preceding topic.
  for (let count = 0; count < 3 && start > 0; count += 1) {
    const previous = segments[start - 1];
    const current = segments[start];
    if (!previous || !current) break;
    const gap = current.start - previous.end;
    if (gap > 1.8) break;
    const previousText = previous.text.trim();
    const needsPrevious =
      DEPENDENT_OPENING_PREFIX.test(combined)
      || previousText.length < 12
      || !/[。！？!?；;]$/u.test(previousText);
    if (!needsPrevious) break;
    const nextCombined = `${previousText}${combined}`;
    if (nextCombined.length > 52) break;
    start -= 1;
    combined = nextCombined;
  }
  return start;
}

/** Picks a complete, high-tension sentence as the opening of a clip. */
export function chooseOpeningSegment(
  segments: TranscriptSegment[],
  hookText = "",
  title = "",
): TranscriptSegment | undefined {
  return segments
    .map((segment, index) => {
      const text = segment.text.trim();
      const duration = Math.max(0.1, segment.end - segment.start);
      const lengthScore = Math.min(3, text.length / 18);
      const signalScore = OPENING_SIGNALS.test(text) ? 3 : 0;
      const questionScore = /[？?！!]/u.test(text) ? 2 : 0;
      const numberScore = /\d{2,}|百分之|第一|唯一/u.test(text) ? 1.5 : 0;
      const overlap = overlapScore(`${hookText}${title}`, text) * 4;
      const hookEvidence = hookEvidenceScore(text, hookText, title);
      const exactTopicBonus = containsTopicPhrase(text, hookText, title) ? 8 : 0;
      const shortPenalty = text.length < 8 ? 3 : 0;
      const durationPenalty = duration < 0.8 ? 1 : 0;
      // A slight preference for an earlier sentence keeps the edit natural
      // when two lines are equally strong.
      const positionBonus = Math.max(0, 0.8 - index * 0.08);
      return {
        segment,
        score:
          lengthScore +
          signalScore +
          questionScore +
          numberScore +
          overlap +
          hookEvidence +
          exactTopicBonus +
          positionBonus -
          shortPenalty -
          durationPenalty,
      };
    })
    .filter(({ segment }) => isOpeningCandidate(segment.text))
    .sort((left, right) => right.score - left.score)[0]?.segment;
}

export function reorderForOpening(
  segments: TranscriptSegment[],
  requestedId: string | undefined,
  hookText = "",
  title = "",
): TranscriptSegment[] {
  if (segments.length < 2) return segments;
  const requested = requestedId
    ? segments.find((segment) => segment.id === requestedId)
    : undefined;
  const automatic = chooseOpeningSegment(segments, hookText, title);
  // Model-provided opening ids can point at a greeting or a later sentence
  // after word-level segments have been merged. Keep them only when they
  // actually overlap the requested hook/title; otherwise use the local
  // content-first scorer so the first frame contains the real point.
  const requestedOverlap = requested
    ? overlapScore(`${hookText}${title}`, requested.text)
    : 0;
  const automaticOverlap = automatic
    ? overlapScore(`${hookText}${title}`, automatic.text)
    : 0;
  const requestedMatchesTopic = requested
    ? containsTopicPhrase(requested.text, hookText, title)
    : false;
  const automaticMatchesTopic = automatic
    ? containsTopicPhrase(automatic.text, hookText, title)
    : false;
  const opening = requested
    && isOpeningCandidate(requested.text)
    && (requestedMatchesTopic || (!automaticMatchesTopic && (requestedOverlap >= 0.24 || requestedOverlap >= automaticOverlap - 0.04)))
    ? requested
    : automatic;
  if (!opening) return segments;
  const index = segments.findIndex((segment) => segment.id === opening.id);
  if (index <= 0) return segments;
  const leadStart = openingLeadStart(segments, index);
  return [
    ...segments.slice(leadStart, index + 1),
    ...segments.slice(0, leadStart),
    ...segments.slice(index + 1),
  ];
}
