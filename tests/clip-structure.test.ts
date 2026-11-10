import { describe, expect, it } from "vitest";
import { reorderForOpening } from "../src/main/clip-structure";

describe("clip opening structure", () => {
  it("moves the strongest sentence to the front without crossing topics", () => {
    const segments = [
      { id: "a", start: 0, end: 8, text: "先说一下背景和常见情况。", confidence: "source" as const },
      { id: "b", start: 8, end: 16, text: "但是，真正关键的是家长的选择。", confidence: "source" as const },
      { id: "c", start: 16, end: 24, text: "最后再讲具体方法。", confidence: "source" as const },
    ];
    expect(reorderForOpening(segments, undefined, "家长应该怎么选择").map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("honors a model-selected opening segment", () => {
    const segments = [
      { id: "a", start: 0, end: 8, text: "先说一下这个选择的基本背景。", confidence: "source" as const },
      { id: "b", start: 8, end: 16, text: "真正关键的是孩子的目标和分数。", confidence: "source" as const },
    ];
    expect(reorderForOpening(segments, "b").map((item) => item.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("rejects a model opening that does not match the topic hook", () => {
    const segments = [
      { id: "topic", start: 0, end: 8, text: "国际班简单来说基本上要出国，因为没有在教育部备案。", confidence: "source" as const },
      { id: "tail", start: 8, end: 16, text: "不会讲国际，不会讲计划外的内容。", confidence: "source" as const },
    ];
    expect(reorderForOpening(segments, "tail", "国际班没有在教育部备案", "国际班备案").map((item) => item.id)).toEqual([
      "topic",
      "tail",
    ]);
  });

  it("moves a later conclusion matching a semantic hook ahead of chronological setup", () => {
    const segments = [
      {
        id: "setup",
        start: 0,
        end: 5,
        text: "我觉得甘肃的学生不适合中科大这个学校，你卷不过的，选不过的，",
        confidence: "source" as const,
      },
      {
        id: "conclusion",
        start: 10,
        end: 18,
        text: "我我我我怎么觉得甘肃的孩子去了中科大有很大的被淘汰的风险，甚至退学的风险。",
        confidence: "source" as const,
      },
    ];
    expect(
      reorderForOpening(
        segments,
        undefined,
        "高考弱省考生进中科大，可能卷不过被淘汰；选能匹配你80分努力的学校。",
        "甘肃390名报中科大，为什么主播劝退？",
      ).map((item) => item.id),
    ).toEqual(["conclusion", "setup"]);
  });
});
