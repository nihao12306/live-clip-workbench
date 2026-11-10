import { describe, expect, it } from "vitest";
import {
  cleanSpokenSegment,
  cleanSpokenSegments,
} from "../src/main/speech-cleanup";

describe("speech cleanup", () => {
  it("keeps context-dependent boundary words on a coarse sentence cue", () => {
    const cleaned = cleanSpokenSegment({
      id: "segment-1",
      start: 10,
      end: 20,
      text: "嗯，农村经济管理和工商管理哪个好，对吧",
      confidence: "source",
    });
    expect(cleaned?.text).toBe("嗯，农村经济管理和工商管理哪个好，对吧");
    expect(cleaned?.start).toBe(10);
    expect(cleaned?.end).toBe(20);
  });

  it("does not delete connectors and tone words by word list", () => {
    expect(
      cleanSpokenSegment({
        id: "segment-2",
        start: 0,
        end: 3,
        text: "其实这个问题不能只看分数",
        confidence: "source",
      })?.text,
    ).toBe("其实这个问题不能只看分数");
    expect(
      cleanSpokenSegment({
        id: "segment-3",
        start: 0,
        end: 1,
        text: "嗯嗯",
        confidence: "source",
      })?.text,
    ).toBe("嗯嗯");
  });

  it("does not guess an in-sentence audio cut from coarse timestamps", () => {
    const pieces = cleanSpokenSegments({
      id: "segment-4",
      start: 0,
      end: 12,
      text: "好学生，我觉得，嗯，这个选择不能只看分数",
      confidence: "source",
    });
    expect(pieces.map((piece) => piece.text)).toEqual([
      "好学生，我觉得，嗯，这个选择不能只看分数",
    ]);
  });

  it("does not remove short words when they are part of a meaningful word", () => {
    const cleaned = cleanSpokenSegment({
      id: "segment-5",
      start: 0,
      end: 5,
      text: "好学校和对比不能这样判断",
      confidence: "source",
    });
    expect(cleaned?.text).toBe("好学校和对比不能这样判断");
  });

  it("keeps a configured word inside a coarse sentence until precise alignment", () => {
    const cleaned = cleanSpokenSegment(
      {
        id: "segment-6",
        start: 0,
        end: 5,
        text: "我们这个观点其实很重要",
        confidence: "source",
      },
      ["观点"],
    );
    expect(cleaned?.text).toBe("我们这个观点其实很重要");
  });

  it("removes only an unambiguous word-timed hesitation cue", () => {
    expect(cleanSpokenSegment({
      id: "segment-7",
      start: 2,
      end: 2.3,
      text: "呃",
      confidence: "source",
      timingPrecision: "word",
    })).toBeUndefined();
  });
});
