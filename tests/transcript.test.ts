import { describe, expect, it } from "vitest";
import { estimatePlainText, parseSrtOrVtt, parseTimecodedText } from "../src/main/transcript";

describe("transcript parser", () => {
  it("parses SRT and preserves source timestamps", () => {
    const result = parseSrtOrVtt(`1\n00:00:02,000 --> 00:00:05,500\n很多家长真正焦虑的不是成绩。\n\n2\n00:00:05,500 --> 00:00:09,000\n而是不知道孩子为什么学。`);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ start: 2, end: 5.5, confidence: "source" });
    expect(result[1].text).toContain("为什么学");
  });

  it("parses common bracketed timecodes", () => {
    const result = parseTimecodedText(`[00:01:20] 第一段观点\n【00:01:25】第二段解释\n(01:30) 第三段结论`);
    expect(result).toHaveLength(3);
    expect(result.map((item) => item.start)).toEqual([80, 85, 90]);
    expect(result[0].end).toBe(85);
  });

  it("estimates a monotonic full-duration timeline for plain text", () => {
    const result = estimatePlainText("第一句比较短。第二句包含更多信息，所以它应该获得更长的估算时间！第三句收尾。", 120);
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0].start).toBe(0);
    expect(result.at(-1)?.end).toBeCloseTo(120, 4);
    expect(result.every((item, index) => index === 0 || item.start >= result[index - 1].end)).toBe(true);
    expect(result.every((item) => item.confidence === "estimated")).toBe(true);
  });
});
