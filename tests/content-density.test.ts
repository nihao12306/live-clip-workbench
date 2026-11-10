import { describe, expect, it } from "vitest";
import { assessContentDensity } from "../src/main/content-density";

describe("content density gate", () => {
  it("rejects long but one-sided school praise", () => {
    const result = assessContentDensity(
      "南大新工科崛起",
      "南大新工科水平被低估",
      "南大的老师非常强，学校引进了很多牛人，年轻老师以后会成长，科研条件也很好，整体水平很不错。",
    );
    expect(result.accepted).toBe(false);
    expect(result.blockers).toContain("没有明确要解决的决策问题");
  });

  it("rejects a stitched employment opinion without conditions or action", () => {
    const result = assessContentDensity(
      "芯片专业就业行情一般",
      "芯片热潮下是否值得报考",
      "芯片行业未来会有成长性公司，但专业增长性没有那么好，行业增长性没有那么好，高端岗位校招一直走下坡路，招人数量也在走下坡路，所以一般是赢者通吃。清华的尖子生能拿到好岗位，剩下的就业行情一般。",
    );
    expect(result.accepted).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("accepts a complete conditional decision argument", () => {
    const result = assessContentDensity(
      "广东595—625分，华工国际和南科大怎么选",
      "不要先看名气，先看分数稳定性、专业自由度和家庭预算",
      "很多家长以为985标签一定最重要，但这两个选择真正的矛盾是学校标签和专业自由度。华工国际学费更高，南科大专业选择更自由；如果更看重985和普通批兜底，华工可能更适合，如果孩子分数稳定且看重专业自由，可以重点研究南科大。建议先核对当年招生政策和学费，再按家庭预算填报。",
    );
    expect(result.accepted).toBe(true);
  });

  it("accepts a spoken recommendation with evidence and a boundary", () => {
    const result = assessContentDensity(
      "具身智能报考分层",
      "华五以下要看数学物理，纯机械师资的专业要慎选",
      "选人工智能可能要到华五层次才行。华五以下考北航、西交这类专业，要掂量自己的数学物理够不够好。再往下选东北大学、南航的具身智能，要考虑自己是不是适合，因为有些专业是纯机械学院的老师带。分数不高又不想读机械方向的孩子，不建议盲目填报。",
    );
    expect(result.accepted).toBe(true);
  });
});
