import { describe, expect, it } from "vitest";
import {
  prepareCandidateSubtitleSync,
  reorderSubtitleUnitsToSegments,
  syncSubtitleToSegments,
} from "../src/shared/subtitle-sync";
import type { Candidate, EditSegment, TopicContextSegment } from "../src/shared/types";

const context: TopicContextSegment[] = [
  {
    id: "a",
    sourceStart: 0,
    sourceEnd: 4,
    text: "第一句。",
    confidence: "source",
    relation: "selected",
    included: true,
  },
  {
    id: "b",
    sourceStart: 4,
    sourceEnd: 8,
    text: "第二句。",
    confidence: "source",
    relation: "selected",
    included: true,
  },
  {
    id: "c",
    sourceStart: 8,
    sourceEnd: 12,
    text: "第三句。",
    confidence: "source",
    relation: "after",
    included: false,
  },
];

const current: EditSegment[] = [
  { id: "edit-a", sourceStart: 0, sourceEnd: 4, text: "第一句。", topicId: "topic", order: 0 },
  { id: "edit-b", sourceStart: 4, sourceEnd: 8, text: "第二句。", topicId: "topic", order: 1 },
];

describe("subtitle sync", () => {
  it("deletes and reorders source cues from the final subtitle", () => {
    const result = syncSubtitleToSegments({
      subtitleText: "第三句。\n第一句。",
      currentSegments: current,
      contextSegments: context,
      topicId: "topic",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.segments.map((segment) => segment.id)).toEqual(["c", "a"]);
    expect(result.segments.map((segment) => segment.sourceStart)).toEqual([8, 0]);
    expect(result.transcriptText).toBe("第三句。 第一句。");
  });

  it("keeps edited subtitle wording while following reordered audio segments", () => {
    const reordered: EditSegment[] = [current[1], current[0]];
    expect(
      reorderSubtitleUnitsToSegments("第一句（人工精简）。\n第二句。", reordered),
    ).toBe("第二句。\n第一句（人工精简）。");
  });

  it("adds a cue that exists in the loaded context window", () => {
    const result = syncSubtitleToSegments({
      subtitleText: "第一句。\n第二句。",
      currentSegments: current.slice(0, 1),
      contextSegments: context,
      topicId: "topic",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.segments.map((segment) => segment.id)).toEqual(["a", "b"]);
  });

  it("reports newly invented text instead of creating silent audio", () => {
    const result = syncSubtitleToSegments({
      subtitleText: "第一句。\n这是原视频没有说过的新话。",
      currentSegments: current,
      contextSegments: context,
      topicId: "topic",
    });

    expect(result.unmatched).toEqual(["这是原视频没有说过的新话。"]);
    expect(result.segments.map((segment) => segment.id)).toEqual(["a"]);
  });

  it("trims the source audio when the final subtitle keeps only a sentence prefix", () => {
    const result = syncSubtitleToSegments({
      subtitleText: "第一句话",
      currentSegments: [],
      contextSegments: [{ ...context[0], text: "第一句话以及后面的原话。" }],
      topicId: "topic",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.partialMatches).toHaveLength(1);
    expect(result.segments[0]?.sourceStart).toBe(0);
    expect(result.segments[0]?.sourceEnd).toBeLessThan(4);
  });

  it("allows removing a few filler characters from inside a sentence", () => {
    const result = syncSubtitleToSegments({
      subtitleText: "这是一个非常重要的功能。",
      currentSegments: [],
      contextSegments: [{
        ...context[0],
        text: "这是一个其实非常重要的功能。",
      }],
      topicId: "topic",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.partialMatches).toHaveLength(1);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.text).toBe("这是一个");
    expect(result.segments[1]?.text).toContain("非常重要");
    expect(result.segments[0]?.sourceEnd).toBeLessThan(result.segments[1]?.sourceStart ?? 0);
    expect(result.segments[1]?.sourceEnd).toBeLessThanOrEqual(4.2);
    expect(result.needsWordAlignment).toBe(true);
    expect(result.segments[0]?.subtitleGroupId).toBe(result.segments[1]?.subtitleGroupId);
  });

  it("uses word timing and padding when a reviewer deletes the reported sentence prefix", () => {
    const result = syncSubtitleToSegments({
      subtitleText: "它是个计算机电子大类。",
      currentSegments: [],
      contextSegments: [{
        id: "tongji-computer",
        sourceStart: 1128.47,
        sourceEnd: 1133.178956521739,
        text: "什么同期今年的普通班没有计算机，它是个计算机电子大类。",
        confidence: "source",
        timingPrecision: "estimated",
        relation: "selected",
        included: true,
      }],
      wordTimings: [
        { text: "什么", start: 1128.42, end: 1128.74 },
        { text: "同", start: 1128.74, end: 1129.22 },
        { text: "期", start: 1129.22, end: 1129.42 },
        { text: "今年", start: 1129.42, end: 1129.84 },
        { text: "的", start: 1129.84, end: 1129.98 },
        { text: "普通班", start: 1129.98, end: 1130.24 },
        { text: "没有", start: 1130.24, end: 1130.54 },
        { text: "计算机", start: 1130.54, end: 1131.1 },
        { text: "它", start: 1131.1, end: 1131.34 },
        { text: "是", start: 1131.34, end: 1131.46 },
        { text: "个", start: 1131.46, end: 1131.56 },
        { text: "计算机", start: 1131.56, end: 1132.74 },
        { text: "电子", start: 1132.74, end: 1133.18 },
        { text: "大类", start: 1133.18, end: 1133.32 },
      ],
      topicId: "tongji-cs",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.needsWordAlignment).toBe(false);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.timingPrecision).toBe("word");
    expect(result.segments[0]?.sourceStart).toBeLessThanOrEqual(1131.1);
    expect(result.segments[0]?.sourceEnd).toBeGreaterThanOrEqual(1133.32);
  });

  it("allows deleting a whole sentence from a merged transcript cue", () => {
    const source = [{
      id: "merged",
      sourceStart: 0,
      sourceEnd: 12,
      text: "保留的开头。这句需要删掉，因为它是很长的无用解释内容，完全不应该进入成片。保留的结尾。",
      confidence: "source" as const,
      timingPrecision: "word" as const,
      relation: "selected" as const,
      included: true,
    }];

    const result = syncSubtitleToSegments({
      subtitleText: "保留的开头。保留的结尾。",
      currentSegments: [],
      contextSegments: source,
      topicId: "topic",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.text).toBe("保留的开头。");
    expect(result.segments[1]?.text).toBe("保留的结尾。");
    expect(result.segments[0]?.sourceEnd).toBeLessThan(result.segments[1]?.sourceStart ?? 0);
  });

  it("coalesces word-level cues into one render range per edited sentence", () => {
    const result = syncSubtitleToSegments({
      subtitleText: "第一句话。",
      currentSegments: [],
      contextSegments: [
        { ...context[0], sourceEnd: 1, text: "第一" },
        { ...context[0], id: "a-2", sourceStart: 1, sourceEnd: 2, text: "句话。" },
      ],
      topicId: "topic",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.sourceStart).toBe(0);
    expect(result.segments[0]?.sourceEnd).toBe(2);
  });

  it("keeps a short natural pause between adjacent spoken cues", () => {
    const result = syncSubtitleToSegments({
      subtitleText: "第一句。\n第二句。",
      currentSegments: [],
      contextSegments: [
        { ...context[0], sourceStart: 0, sourceEnd: 1 },
        { ...context[1], sourceStart: 2, sourceEnd: 3 },
      ],
      topicId: "topic",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.sourceEnd).toBeCloseTo(1.15, 5);
    expect(result.segments[1]?.sourceStart).toBeCloseTo(1.85, 5);
  });

  it("does not restore pauses across skipped speech", () => {
    const result = syncSubtitleToSegments({
      subtitleText: "第一句。\n第三句。",
      currentSegments: [],
      contextSegments: [
        { ...context[0], sourceStart: 0, sourceEnd: 1 },
        { ...context[1], sourceStart: 2, sourceEnd: 3 },
        { ...context[2], sourceStart: 4, sourceEnd: 5 },
      ],
      topicId: "topic",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.sourceEnd).toBe(1);
    expect(result.segments[1]?.sourceStart).toBe(4);
  });

  it("keeps a trailing word cue when the source contains an inserted filler word", () => {
    const sourceTexts = ["甚至", "这个", "叫", "什么", "退学", "的", "风险。"];
    const source = sourceTexts.map((text, index) => ({
      id: `risk-${index}`,
      sourceStart: index,
      sourceEnd: index + 1,
      text,
      confidence: "source" as const,
      timingPrecision: "word" as const,
      relation: "selected" as const,
      included: true,
    }));

    const result = syncSubtitleToSegments({
      subtitleText: "甚至叫什么退学的风险。",
      currentSegments: [],
      contextSegments: source,
      topicId: "topic",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.sourceEnd).toBeGreaterThanOrEqual(1);
    expect(result.segments[0]?.sourceEnd).toBeLessThan(result.segments[1]?.sourceStart ?? 0);
    expect(result.segments[1]?.sourceStart).toBeLessThanOrEqual(2);
    expect(result.segments[1]?.sourceEnd).toBeLessThanOrEqual(7.05);
    expect(result.segments[1]?.sourceEnd).toBeGreaterThan(6);
    expect(result.segments[1]?.text).toContain("风险");
  });

  it("blocks a subtitle unit when its trailing words are absent from the source audio", () => {
    const sourceTexts = ["甚至", "这个", "叫", "什么", "退学", "的"];
    const source = sourceTexts.map((text, index) => ({
      id: `missing-risk-${index}`,
      sourceStart: index,
      sourceEnd: index + 1,
      text,
      confidence: "source" as const,
      relation: "selected" as const,
      included: true,
    }));

    const result = syncSubtitleToSegments({
      subtitleText: "甚至叫什么退学的风险。",
      currentSegments: [],
      contextSegments: source,
      topicId: "topic",
    });

    expect(result.unmatched).toEqual(["甚至叫什么退学的风险。"]);
    expect(result.segments).toEqual([]);
  });

  it("starts a match after a large gap in a legacy selected-segment plan", () => {
    const result = syncSubtitleToSegments({
      subtitleText: "间隔之后的原话。",
      currentSegments: [
        { id: "early", sourceStart: 0, sourceEnd: 2, text: "前面的原话。", topicId: "topic", order: 0 },
        { id: "late", sourceStart: 20, sourceEnd: 24, text: "间隔之后的原话。", topicId: "topic", order: 1 },
      ],
      contextSegments: [],
      topicId: "topic",
    });

    expect(result.unmatched).toEqual([]);
    expect(result.segments.map((segment) => segment.id)).toEqual(["late"]);
  });

  it("keeps the last usable audio plan when part of a draft is unmatched", () => {
    const candidate = {
      id: "legacy-candidate",
      topicId: "topic",
      duration: 8,
      transcriptText: "第一句。 第二句。",
      renderPlan: {
        subtitleText: "第一句。\n原视频没有的新句子。",
        segments: current,
      },
      originalRenderPlan: {
        subtitleText: "第一句。\n第二句。",
        segments: current,
      },
    } as unknown as Candidate;

    const first = prepareCandidateSubtitleSync(candidate);
    const second = prepareCandidateSubtitleSync(first.nextCandidate);

    expect(first.canSave).toBe(false);
    expect(first.result.unmatched).toEqual(["原视频没有的新句子。"]);
    expect(first.nextCandidate.renderPlan.segments).toEqual(current);
    expect(second.result.unmatched).toEqual(first.result.unmatched);
    expect(second.nextCandidate.renderPlan.segments).toEqual(current);
  });

  it("repeatedly syncs the reported legacy candidate without losing source audio", () => {
    const legacySegments: EditSegment[] = [
      { id: "opening", sourceStart: 1128.47, sourceEnd: 1140.16, text: "什么同期今年的普通班没有计算机，它是个计算机电子大类。学校的学校惯犯儿，每一次在招生的时候，大类分流会把好专业提前都承诺完", topicId: "tongji-cs", order: 0 },
      { id: "hook", sourceStart: 1116.77, sourceEnd: 1120.53, text: "算了，同济的普通班的计算机值得吗？", topicId: "tongji-cs", order: 1 },
      { id: "worst-major", sourceStart: 1144.52, sourceEnd: 1146.43, text: "专业里面最差的专业给你", topicId: "tongji-cs", order: 2 },
      { id: "worst-category", sourceStart: 1146.96, sourceEnd: 1148.88, text: "大类里面最差的专业给你", topicId: "tongji-cs", order: 3 },
      { id: "promise", sourceStart: 1152.54, sourceEnd: 1159.02, text: "如果给你承诺了计算机，同期的计算机还不错。如果没有给你承诺，你盲目的报了。", topicId: "tongji-cs", order: 4 },
      { id: "fantasy-1", sourceStart: 1160.77, sourceEnd: 1164.79, text: "计算机有可能只会是你脑海里的一股幻想了，幻想了", topicId: "tongji-cs", order: 5 },
      { id: "fantasy-2", sourceStart: 1165.14, sourceEnd: 1165.49, text: "幻想", topicId: "tongji-cs", order: 6 },
      { id: "fantasy-3", sourceStart: 1165.84, sourceEnd: 1167.94, text: "幻想有的时候是学校的原因", topicId: "tongji-cs", order: 7 },
    ];
    const subtitleText = [
      "同期今年的普通班没有计算机，它是个计算机电子大类。",
      "学校的学校惯犯儿，每一次在招生的时候，大类分流会把好专业提前都承诺完专业里面最差的专业给你大类里面最差的专业给你如果给你承诺了计算机，同期的计算机还不错。",
      "算了，同济的普通班的计算机值得吗？",
      "如果没有给你承诺，你盲目的报了。",
      "计算机有可能只会是你脑海里的一股幻想了，幻想了幻想幻想有的时候是学校的原因",
    ].join("\n");
    let candidate = {
      id: "reported-legacy-candidate",
      topicId: "tongji-cs",
      duration: 40,
      transcriptText: legacySegments.map((segment) => segment.text).join(" "),
      renderPlan: { subtitleText, segments: legacySegments },
      originalRenderPlan: { subtitleText, segments: legacySegments },
      wordTimings: legacySegments.flatMap((segment) => {
        const characters = Array.from(segment.text.replace(/[^\p{L}\p{N}\u3400-\u9fff]/gu, ""));
        const duration = segment.sourceEnd - segment.sourceStart;
        return characters.map((text, index) => ({
          text,
          start: segment.sourceStart + duration * index / characters.length,
          end: segment.sourceStart + duration * (index + 1) / characters.length,
          probability: 1,
        }));
      }),
    } as unknown as Candidate;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const prepared = prepareCandidateSubtitleSync(candidate);
      expect(prepared.canSave).toBe(true);
      expect(prepared.result.unmatched).toEqual([]);
      expect(prepared.nextCandidate.renderPlan.segments).toHaveLength(5);
      candidate = prepared.nextCandidate;
    }
  });
});
