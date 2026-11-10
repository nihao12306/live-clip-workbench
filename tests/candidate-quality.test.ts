import { describe, expect, it } from "vitest";
import {
  deriveCandidateTitle,
  isLowInformationPhrase,
  isMatureTopic,
  normalizeSpokenText,
} from "../src/main/candidate-quality";

describe("candidate quality gate", () => {
  it("rejects filler-only clips", () => {
    expect(isMatureTopic("好", "好 行 嗯 张老师")).toBe(false);
    expect(isMatureTopic("一般", "一般 一般 可以")).toBe(false);
    expect(
      isMatureTopic(
        "今天直播",
        "大家好欢迎来到直播间，今天我们先简单聊几句，感谢大家一直以来的支持和关注。",
      ),
    ).toBe(false);
  });

  it("requires a complete topic with enough context", () => {
    expect(
      isMatureTopic(
        "农村经济管理和工商管理哪个好",
        "很多家长会问农村经济管理和工商管理哪个好，关键要看孩子未来想从事什么工作，不能只看专业名称。",
      ),
    ).toBe(true);
    expect(isMatureTopic("张老师", "张老师您好谢谢大家")).toBe(false);
  });

  it("derives a useful title when the model returns a filler word", () => {
    expect(
      deriveCandidateTitle(
        "好",
        "农村经济管理和工商管理哪个好，关键要看孩子未来想从事什么工作。",
      ),
    ).toBe("农村经济管理和工商管理哪个好");
  });

  it("rejects greetings and derives the first substantive thought", () => {
    expect(isLowInformationPhrase("2025 2025年来 晚上好")).toBe(true);
    expect(isLowInformationPhrase("家长需要先明确孩子的学习目标")).toBe(false);
    expect(
      isMatureTopic(
        "2025 2025年来 晚上好",
        "晚上好，欢迎大家来到直播间。家长需要先明确孩子的学习目标，再根据反馈调整方法，不能只看一次考试分数。",
      ),
    ).toBe(false);
    expect(
      deriveCandidateTitle(
        "2025 2025年来 晚上好",
        "晚上好，欢迎大家来到直播间。家长需要先明确孩子的学习目标，再根据反馈调整方法。",
      ),
    ).toBe("家长需要先明确孩子的学习目标");
  });

  it("skips chatter titles and accepts a substantive sentence after a short hook", () => {
    const transcript =
      "来看大问题，招收20号睿意升学最新专业组没有教育部，教育考试院没公布。";
    const title = deriveCandidateTitle("给 三号 点点 关注点", transcript);
    expect(title).toContain("招收20号睿意升学");
    const matureTitle = deriveCandidateTitle(
      "当然 有 区别",
      "当然有区别。国际班简单来说基本上要出国的。因为国际班他没有在教育部备案。",
    );
    expect(
      isMatureTopic(
        matureTitle,
        "当然有区别。国际班简单来说基本上要出国的。因为国际班他没有在教育部备案，普遍要求出国一到两年，家长需要先算清楚总成本。",
      ),
    ).toBe(true);
  });

  it("normalizes spaces inserted between Chinese transcript words", () => {
    expect(normalizeSpokenText("因为 国际 班 他 没有 在 教育部 令 去 备案， 需要 出国。"))
      .toBe("因为国际班他没有在教育部备案，需要出国。");
    expect(normalizeSpokenText("因为国际班他没有在教育部令去备案，需要出国。"))
      .toBe("因为国际班他没有在教育部备案，需要出国。");
  });
});
