import { usesAdmissionsReviewPreset } from "../shared/constants";
import type {
  AccountProfile,
  Candidate,
  EditSegment,
  TopicContextSegment,
  TranscriptSegment,
} from "../shared/types";

/** Builds a review window around the selected passages. */
export function buildTopicContext(
  transcript: TranscriptSegment[],
  selected: Pick<EditSegment, "sourceStart" | "sourceEnd">[],
  account: Pick<AccountProfile, "name" | "selectionPrinciples">,
): TopicContextSegment[] {
  if (!transcript.length || !selected.length) return [];
  const ordered = [...selected].sort((left, right) => left.sourceStart - right.sourceStart);
  const first = Math.min(...ordered.map((segment) => segment.sourceStart));
  const last = Math.max(...ordered.map((segment) => segment.sourceEnd));
  const padding = usesAdmissionsReviewPreset(account.selectionPrinciples) ? 90 : 60;
  const lower = Math.max(0, first - padding);
  const upper = last + padding;
  const selectedRanges = ordered.map((segment) => ({ start: segment.sourceStart, end: segment.sourceEnd }));

  return transcript
    .filter((segment) => segment.end > lower && segment.start < upper)
    .map<TopicContextSegment>((segment) => {
      const included = selectedRanges.some(
        (range) => segment.start < range.end && segment.end > range.start,
      );
      const relation = segment.end <= first + 0.05
        ? "before"
        : segment.start >= last - 0.05
          ? "after"
          : "selected";
      return {
        id: segment.id,
        sourceStart: segment.start,
        sourceEnd: segment.end,
        text: segment.text,
        confidence: segment.confidence,
        timingPrecision: segment.timingPrecision,
        relation,
        included,
      };
    });
}

/** Returns true when a context cue overlaps any current render-plan range. */
export function contextSegmentIncluded(
  segment: Pick<TopicContextSegment, "sourceStart" | "sourceEnd">,
  renderSegments: Pick<EditSegment, "sourceStart" | "sourceEnd">[],
): boolean {
  return renderSegments.some(
    (range) => segment.sourceStart < range.sourceEnd && segment.sourceEnd > range.sourceStart,
  );
}
