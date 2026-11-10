import { describe, expect, it } from "vitest";
import {
  buildTranscriptAnalysisPlan,
  splitChapterIntoWindows,
  splitTranscriptIntoChapters,
  type TranscriptAnalysisChapter,
} from "../src/main/analysis-chunking";
import type { TranscriptSegment } from "../src/shared/types";

function segment(
  id: string,
  start: number,
  text: string,
  end = start + 5,
): TranscriptSegment {
  return { id, start, end, text, confidence: "source" };
}

describe("long transcript analysis planning", () => {
  it("starts a new chapter at explicit markers and long pauses", () => {
    const transcript = [
      segment("one", 0, "第一章：先讲目标和分数。"),
      segment("two", 5, "家长要先看孩子的短板。"),
      segment("three", 50, "第二章：再讲专业和就业。"),
      segment("four", 55, "专业选择要结合就业方向。"),
    ];

    const chapters = splitTranscriptIntoChapters(transcript, {
      chapterBreakGapSeconds: 20,
      maxChapterChars: 10_000,
      maxChapterSeconds: 900,
    });

    expect(chapters.map((chapter) => chapter.segments.map((item) => item.id))).toEqual([
      ["one", "two"],
      ["three", "four"],
    ]);
    expect(chapters.map((chapter) => chapter.id)).toEqual(["chapter-1", "chapter-2"]);
  });

  it("keeps chapter boundaries isolated while splitting windows by size and time", () => {
    const transcript = [
      segment("a", 0, "一".repeat(6)),
      segment("b", 5, "二".repeat(6)),
      segment("c", 10, "三".repeat(6)),
      segment("d", 15, "四".repeat(6)),
      segment("e", 20, "五".repeat(6)),
      segment("f", 25, "六".repeat(6)),
    ];
    const chapters = splitTranscriptIntoChapters(transcript, {
      maxChapterChars: 40,
      maxChapterSeconds: 900,
      maxWindowChars: 10,
      maxWindowSeconds: 60,
      chapterBreakGapSeconds: 100,
      overlapSegments: 1,
    });

    expect(chapters).toHaveLength(1);
    const windows = splitChapterIntoWindows(chapters[0]!, {
      maxWindowChars: 10,
      maxWindowSeconds: 60,
      overlapSegments: 1,
    });
    expect(windows.map((item) => item.coreStartIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(windows[1]?.segments.map((item) => item.id)).toEqual(["a", "b"]);
    expect(windows.at(-1)?.segments.map((item) => item.id)).toEqual(["e", "f"]);
    expect(windows.every((item) => item.segments.every((cue) => transcript.includes(cue)))).toBe(true);
  });

  it("builds windows in chapter/source order", () => {
    const chapter: TranscriptAnalysisChapter = {
      id: "chapter-1",
      index: 0,
      start: 0,
      end: 30,
      segments: [
        segment("one", 0, "一".repeat(8)),
        segment("two", 10, "二".repeat(8)),
        segment("three", 20, "三".repeat(8)),
      ],
    };
    const plan = buildTranscriptAnalysisPlan(chapter.segments, {
      maxChapterChars: 100,
      maxChapterSeconds: 100,
      maxWindowChars: 10,
      maxWindowSeconds: 100,
      overlapSegments: 0,
      chapterBreakGapSeconds: 100,
    });

    expect(plan.chapters).toHaveLength(1);
    expect(plan.windows.map((item) => item.id)).toEqual([
      "chapter-1-window-1",
      "chapter-1-window-2",
      "chapter-1-window-3",
    ]);
    expect(plan.windows.map((item) => item.segments[0]?.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });
});
