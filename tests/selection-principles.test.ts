import { ADMISSIONS_REVIEW_PRESET, usesAdmissionsReviewPreset } from "../src/shared/constants";
import { describe, expect, it } from "vitest";
import {
  assessSelectionPrinciples,
} from "../src/main/selection-principles";

const account = {
  name: "示例账号甲",
  selectionPrinciples: ADMISSIONS_REVIEW_PRESET,
};

describe("升学决策选题预设", () => {
  it("启用升学预设并放行完整的决策型话题", () => {
    expect(usesAdmissionsReviewPreset(account.selectionPrinciples)).toBe(true);
    const result = assessSelectionPrinciples(
      account,
      "广东595—625分的孩子，华工国际和南科大怎么选？",
      "不要先看名气，先看分数稳定性、专业自由度和家庭预算",
      "很多家长以为985标签一定最重要，但这两个选择真正的矛盾是学校标签和专业自由度。华工国际学费更高，南科大专业选择更自由；如果更看重985和普通批兜底，华工可能更适合，如果孩子分数稳定且看重专业自由，可以重点研究南科大。建议先核对当年招生政策和学费，再按家庭预算填报。",
    );
    expect(result.accepted).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(24);
  });

  it("拒绝问候、泛知识和没有条件建议的片段", () => {
    const result = assessSelectionPrinciples(
      account,
      "晚上好，欢迎大家来到直播间",
      "今天给大家更新一下",
      "晚上好晚上好，感谢大家，今天我们聊一聊大学。",
    );
    expect(result.accepted).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("普通账号不被升学预设评分误伤", () => {
    const result = assessSelectionPrinciples(
      { name: "林老师", selectionPrinciples: "" },
      "一个成熟话题",
      "",
      "这是一段普通内容。",
    );
    expect(result.accepted).toBe(true);
  });
});
