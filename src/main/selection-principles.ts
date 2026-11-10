import type { AccountProfile } from "../shared/types";
import {
  hasTopicSignal,
  isLowInformationPhrase,
  meaningfulLength,
} from "./candidate-quality";

import { usesAdmissionsReviewPreset } from "../shared/constants";

export function selectionPrinciplesForAccount(
  account: Pick<AccountProfile, "name" | "selectionPrinciples">,
): string {
  return account.selectionPrinciples?.trim() ?? "";
}

function distinctMatches(text: string, pattern: RegExp): string[] {
  return [...new Set((text.match(pattern) ?? []).map((item) => item.toLocaleLowerCase()))];
}

function audienceLabelCount(text: string): number {
  const labels = new Set<string>();
  if (/(?:广东|粤|广州|深圳|珠海|佛山|东莞|惠州|粤东西北)/u.test(text)) labels.add("region");
  if (/(?:\d{3,4}\s*(?:[-—~至到]\s*\d{3,4})?\s*分|特控线|位次|排名)/u.test(text)) labels.add("score");
  if (/(?:物理类|历史类|物理|历史|选科|科类)/u.test(text)) labels.add("subject");
  for (const school of distinctMatches(
    text,
    /华工(?:国际)?|华南理工|南科大|中大|中山大学|暨大|暨南大学|广外|广东外语外贸大学|深大|深圳大学|汕大|汕头大学|五邑大学|985|211|双一流/gu,
  )) labels.add(`school:${school}`);
  for (const major of distinctMatches(
    text,
    /临床医学|计算机|电子信息|电气|自动化|工程力学|数学|人工智能|通信工程|机械|金融|新工科/gu,
  )) labels.add(`major:${major}`);
  if (/(?:家长|孩子|考生|学生|家庭|广东娃)/u.test(text)) labels.add("person");
  if (/(?:本科就业|直接就业|就业|保研|读研|升学|职业路径|研究生)/u.test(text)) labels.add("goal");
  if (/(?:学费|预算|成本|城市|留在广州|留在深圳)/u.test(text)) labels.add("preference");
  return Math.min(5, labels.size);
}

export interface SelectionPrincipleAssessment {
  accepted: boolean;
  score: number;
  blockers: string[];
  labels: number;
}

/**
 * Local, deterministic guard for the optional admissions review preset. DeepSeek still performs
 * the semantic ranking, but a malformed or generic model response cannot pass
 * through merely because it has a plausible title.
 */
export function assessSelectionPrinciples(
  account: Pick<AccountProfile, "name" | "selectionPrinciples">,
  title: string,
  hookText: string,
  transcript: string,
): SelectionPrincipleAssessment {
  if (!usesAdmissionsReviewPreset(account.selectionPrinciples)) {
    return { accepted: true, score: 0, blockers: [], labels: 0 };
  }
  const text = `${title} ${hookText} ${transcript}`.replace(/\s+/gu, " ").trim();
  const decision = /(?:怎么选|如何选|选哪个|值得(?:报|读|选)|能不能|要不要|适不适合|是否|为什么|怎么办|怎么填|报考|志愿|就业|升学|适合谁|不适合|还是|VS|冲|稳|保|走|读医|读工科)/iu.test(text);
  const conflict = /(?:还是|和.{1,18}(?:怎么选|比较|区别)|对比|取舍|代价|冲突|但|但是|不等于|不是.{0,8}而是|一方面|另一方面|稳妥|冲刺|保底|只能|优先|好不好|友好|不友好|更细|拆细|拆分|混在一起|分组)/u.test(text);
  const evidence = /(?:分数|位次|数据|比例|保研|就业|学费|政策|录取|扩招|案例|招聘|学校|专业|年份|招生|时间点)/u.test(text);
  const conditional = /(?:如果|适合|不适合|取决于|看孩子|对于|前提|条件|更看重|想要|目标是|必须|建议|应该|需要)/u.test(text);
  const counterIntuitive = /(?:很多人|大家以为|误区|不一定|并不是|其实|但真正|不能只看|不要先|看起来)/u.test(text);
  const chain = [
    /因为|原因|之所以/u.test(text),
    /所以|因此|关键|意味着/u.test(text),
    evidence,
    /边界|但是|不过|前提|风险|不适合/u.test(text),
    conditional,
    /建议|应该|需要|可以考虑|优先/u.test(text),
  ].filter(Boolean).length;
  const labels = audienceLabelCount(text);
  const clipReady = meaningfulLength(transcript) >= 72 && !isLowInformationPhrase(title);
  const score =
    (decision ? 5 : 0)
    + Math.min(5, labels)
    + (/20\d{2}|今年|当年|最新|变化|上涨|下降|扩招|政策|录取时间/u.test(text) ? 5 : 0)
    + (conflict ? 5 : 0)
    + (counterIntuitive ? 5 : 0)
    + (evidence ? 5 : 0)
    + (conditional ? 5 : 0)
    + Math.min(5, chain)
    + (clipReady ? 3 : 0);
  const blockers: string[] = [];
  if (!decision) blockers.push("没有明确的升学决策问题");
  if (labels < 2) blockers.push("缺少至少两个具体人群或条件标签");
  if (!conflict) blockers.push("没有讲清一个主矛盾或取舍");
  if (!evidence) blockers.push("缺少学校、专业、分数、政策、就业或案例依据");
  if (!conditional) blockers.push("没有给出适用条件和行动建议");
  if (chain < 3) blockers.push("现象—原因—证据—建议链条不完整");
  if (!clipReady) blockers.push("正文信息量不足或标题仍是泛泛知识");
  if (score < 24) blockers.push(`选题内部评分仅 ${score} 分，低于 24 分生成线`);
  return { accepted: blockers.length === 0, score, blockers, labels };
}

export function assertSelectionPrinciples(
  account: Pick<AccountProfile, "name" | "selectionPrinciples">,
  title: string,
  hookText: string,
  transcript: string,
): void {
  const assessment = assessSelectionPrinciples(account, title, hookText, transcript);
  if (!assessment.accepted) {
    throw new Error(`候选未通过升学决策选题校验：${assessment.blockers.join("；")}`);
  }
}
