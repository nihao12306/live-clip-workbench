import { describe, expect, it } from "vitest";
import { findPolicyMatches, policyMatchMessage } from "../src/main/content-policy";

describe("account content policy", () => {
  it("matches forbidden phrases across punctuation and case", () => {
    const matches = findPolicyMatches(
      { forbiddenTopics: ["哈工"], sensitiveWords: ["敏感词"] },
      ["这个话题：哈 工，暂时不要展开", "还有敏感词。"],
    );
    expect(matches.map((match) => match.term)).toEqual(["哈工", "敏感词"]);
    expect(policyMatchMessage(matches)).toContain("哈工");
  });

  it("does not flag an unrelated account when the list is empty", () => {
    expect(
      findPolicyMatches(
        { forbiddenTopics: [], sensitiveWords: [] },
        ["哈工这两个字也可以正常出现"],
      ),
    ).toEqual([]);
  });
});
