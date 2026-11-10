import type { TranscriptSegment } from "../shared/types";

/**
 * A chapter is a bounded, ordered portion of one transcript. Chapters are
 * deliberately physical rather than semantic: the model and the existing
 * local quality gates remain responsible for deciding whether a topic is
 * mature and whether related sub-angles belong together.
 */
export interface TranscriptAnalysisChapter {
  id: string;
  index: number;
  start: number;
  end: number;
  segments: TranscriptSegment[];
}

/** A model-sized window inside one chapter. */
export interface TranscriptAnalysisWindow {
  id: string;
  chapterId: string;
  chapterIndex: number;
  windowIndex: number;
  start: number;
  end: number;
  /** Index of the first segment that belongs to the window's core range. */
  coreStartIndex: number;
  /** Exclusive index of the window's core range. */
  coreEndIndex: number;
  segments: TranscriptSegment[];
}

export interface AnalysisChunkingOptions {
  /** Maximum text size of one physical chapter. */
  maxChapterChars?: number;
  /** Maximum timeline span of one physical chapter. */
  maxChapterSeconds?: number;
  /** Maximum text size sent in one model request. */
  maxWindowChars?: number;
  /** Maximum timeline span sent in one model request. */
  maxWindowSeconds?: number;
  /** Number of prior analysis segments repeated at a window boundary. */
  overlapSegments?: number;
  /** A long pause is treated as a chapter boundary. */
  chapterBreakGapSeconds?: number;
}

export const DEFAULT_ANALYSIS_CHUNKING_OPTIONS = {
  // Keep the request payload materially smaller than the previous 28k-char
  // chunks. The chapter cap still prevents a very long replay from becoming
  // one unstructured analysis stream.
  maxChapterChars: 56_000,
  maxChapterSeconds: 15 * 60,
  maxWindowChars: 14_000,
  maxWindowSeconds: 8 * 60,
  overlapSegments: 2,
  chapterBreakGapSeconds: 30,
} as const satisfies Required<AnalysisChunkingOptions>;

const CHAPTER_MARKER_PATTERN = /^\s*(?:#{1,3}\s+|[【\[]?\s*(?:第[一二三四五六七八九十百千万\d]+\s*[章节部分篇节]|(?:chapter|part|section)\s*[-#]?\s*\d+)\s*[】\]]?\s*[:：.、\-]?\s*)/iu;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.floor(value)
    : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function resolveOptions(options: AnalysisChunkingOptions): Required<AnalysisChunkingOptions> {
  const maxWindowChars = positiveInteger(
    options.maxWindowChars,
    DEFAULT_ANALYSIS_CHUNKING_OPTIONS.maxWindowChars,
  );
  const maxWindowSeconds = positiveNumber(
    options.maxWindowSeconds,
    DEFAULT_ANALYSIS_CHUNKING_OPTIONS.maxWindowSeconds,
  );
  return {
    maxChapterChars: positiveInteger(
      options.maxChapterChars,
      DEFAULT_ANALYSIS_CHUNKING_OPTIONS.maxChapterChars,
    ),
    maxChapterSeconds: positiveNumber(
      options.maxChapterSeconds,
      DEFAULT_ANALYSIS_CHUNKING_OPTIONS.maxChapterSeconds,
    ),
    maxWindowChars,
    maxWindowSeconds,
    overlapSegments: Math.min(
      nonNegativeInteger(
        options.overlapSegments,
        DEFAULT_ANALYSIS_CHUNKING_OPTIONS.overlapSegments,
      ),
      32,
    ),
    chapterBreakGapSeconds: positiveNumber(
      options.chapterBreakGapSeconds,
      DEFAULT_ANALYSIS_CHUNKING_OPTIONS.chapterBreakGapSeconds,
    ),
  };
}

function segmentDuration(segment: TranscriptSegment): number {
  return Math.max(0, segment.end - segment.start);
}

function isChapterMarker(text: string): boolean {
  return CHAPTER_MARKER_PATTERN.test(text);
}

function chapterShouldBreak(
  current: TranscriptSegment[],
  next: TranscriptSegment,
  currentChars: number,
  options: Required<AnalysisChunkingOptions>,
): boolean {
  if (!current.length) return false;
  const previous = current[current.length - 1]!;
  const gap = Math.max(0, next.start - previous.end);
  const chapterStart = current[0]!.start;
  return (
    isChapterMarker(next.text)
    || gap >= options.chapterBreakGapSeconds
    || currentChars + next.text.length > options.maxChapterChars
    || next.end - chapterStart > options.maxChapterSeconds
  );
}

function makeChapter(index: number, segments: TranscriptSegment[]): TranscriptAnalysisChapter {
  return {
    id: `chapter-${index + 1}`,
    index,
    start: segments[0]!.start,
    end: segments[segments.length - 1]!.end,
    segments,
  };
}

/**
 * Splits a transcript into bounded chapters while preserving source order and
 * source segment identity. A chapter marker is kept in the following chapter
 * so the model can use it as context instead of receiving an orphan cue.
 */
export function splitTranscriptIntoChapters(
  transcript: TranscriptSegment[],
  options: AnalysisChunkingOptions = {},
): TranscriptAnalysisChapter[] {
  if (!transcript.length) return [];
  const resolved = resolveOptions(options);
  const ordered = transcript
    .map((segment, sourceIndex) => ({ segment, sourceIndex }))
    .sort(
      (left, right) =>
        left.segment.start - right.segment.start || left.sourceIndex - right.sourceIndex,
    )
    .map(({ segment }) => segment);
  const chapters: TranscriptAnalysisChapter[] = [];
  let current: TranscriptSegment[] = [];
  let currentChars = 0;
  const flush = () => {
    if (!current.length) return;
    chapters.push(makeChapter(chapters.length, current));
    current = [];
    currentChars = 0;
  };

  for (const segment of ordered) {
    if (chapterShouldBreak(current, segment, currentChars, resolved)) flush();
    current.push(segment);
    currentChars += segment.text.length;
  }
  flush();
  return chapters;
}

function windowStartIndex(
  coreStartIndex: number,
  overlapSegments: number,
): number {
  return Math.max(0, coreStartIndex - overlapSegments);
}

/**
 * Splits one chapter into model-sized windows. Only the core range advances;
 * the small repeated prefix gives a candidate that straddles a window edge a
 * chance to be discovered twice and then deduplicated by the result merger.
 */
export function splitChapterIntoWindows(
  chapter: TranscriptAnalysisChapter,
  options: AnalysisChunkingOptions = {},
): TranscriptAnalysisWindow[] {
  if (!chapter.segments.length) return [];
  const resolved = resolveOptions(options);
  const windows: TranscriptAnalysisWindow[] = [];
  let coreStartIndex = 0;
  let windowIndex = 0;

  while (coreStartIndex < chapter.segments.length) {
    const first = chapter.segments[coreStartIndex]!;
    const chapterStart = first.start;
    let coreEndIndex = coreStartIndex;
    let chars = 0;
    while (coreEndIndex < chapter.segments.length) {
      const segment = chapter.segments[coreEndIndex]!;
      const exceedsChars =
        coreEndIndex > coreStartIndex
        && chars + segment.text.length > resolved.maxWindowChars;
      const exceedsSeconds =
        coreEndIndex > coreStartIndex
        && segment.end - chapterStart > resolved.maxWindowSeconds;
      if (exceedsChars || exceedsSeconds) break;
      chars += segment.text.length;
      coreEndIndex += 1;
    }
    // A single oversized cue cannot be split without losing the reversible
    // source mapping, so keep it intact as a one-segment window.
    if (coreEndIndex === coreStartIndex) coreEndIndex += 1;

    const startIndex = windowStartIndex(coreStartIndex, resolved.overlapSegments);
    const segments = chapter.segments.slice(startIndex, coreEndIndex);
    windows.push({
      id: `${chapter.id}-window-${windowIndex + 1}`,
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      windowIndex,
      start: segments[0]!.start,
      end: segments[segments.length - 1]!.end,
      coreStartIndex,
      coreEndIndex,
      segments,
    });
    coreStartIndex = coreEndIndex;
    windowIndex += 1;
  }
  return windows;
}

export interface TranscriptAnalysisPlan {
  chapters: TranscriptAnalysisChapter[];
  windows: TranscriptAnalysisWindow[];
}

export function buildTranscriptAnalysisPlan(
  transcript: TranscriptSegment[],
  options: AnalysisChunkingOptions = {},
): TranscriptAnalysisPlan {
  const chapters = splitTranscriptIntoChapters(transcript, options);
  return {
    chapters,
    windows: chapters.flatMap((chapter) => splitChapterIntoWindows(chapter, options)),
  };
}
