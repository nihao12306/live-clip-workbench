import { describe, expect, it } from "vitest";
import { buildTopicContext } from "../src/main/topic-context";
import type { EditSegment, TranscriptSegment } from "../src/shared/types";

const transcript: TranscriptSegment[] = [
  { id: "before-far", start: 20, end: 24, text: "前面先讲分数段和家长人群。", confidence: "source" },
  { id: "before-near", start: 70, end: 74, text: "接着解释专业组变化。", confidence: "source" },
  { id: "selected", start: 100, end: 112, text: "今年示例大学的专业组拆得更细。", confidence: "source" },
  { id: "after-near", start: 130, end: 136, text: "还要比较城市和就业。", confidence: "source" },
  { id: "after-far", start: 195, end: 200, text: "最后再给出填报建议。", confidence: "source" },
];

const selected: EditSegment[] = [{
  id: "edit-1",
  sourceStart: 100,
  sourceEnd: 112,
  text: "今年示例大学的专业组拆得更细。",
  topicId: "shantou",
  order: 0,
}];

describe("topic context", () => {
  it("gives 示例账号甲 a wider evidence window and marks selected cues", () => {
    const result = buildTopicContext(
      transcript,
      selected,
      { name: "示例账号甲", selectionPrinciples: "升学决策选题预设" },
    );
    expect(result.map((item) => item.id)).toEqual([
      "before-far",
      "before-near",
      "selected",
      "after-near",
      "after-far",
    ]);
    expect(result.find((item) => item.id === "before-far")?.relation).toBe("before");
    expect(result.find((item) => item.id === "selected")?.included).toBe(true);
    expect(result.find((item) => item.id === "after-far")?.relation).toBe("after");
  });

  it("keeps the normal account window smaller", () => {
    const result = buildTopicContext(
      transcript,
      selected,
      { name: "普通账号", selectionPrinciples: "" },
    );
    expect(result.map((item) => item.id)).toEqual([
      "before-near",
      "selected",
      "after-near",
    ]);
  });
});
