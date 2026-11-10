import { isLowInformationPhrase, meaningfulLength, normalizeSpokenText } from "./candidate-quality";

export type ContentSignal =
  | "decision"
  | "claim"
  | "evidence"
  | "contrast"
  | "condition"
  | "action";

export interface ContentDensityAssessment {
  accepted: boolean;
  score: number;
  meaningfulCharacters: number;
  substantiveClauses: number;
  signals: ContentSignal[];
  blockers: string[];
}

const SIGNAL_PATTERNS: Record<ContentSignal, RegExp> = {
  decision: /(?:怎么选|如何选|选择|选哪个|值得(?:报|读|选)|能不能|要不要|适不适合|是否|为什么|怎么办|怎么填|报考|报(?:上|的|这个)?|志愿填报|比较|决定)/u,
  claim: /(?:真正|关键|意味着|不等于|不是.{0,12}而是|本质|判断|结论|问题在于|核心|我建议|我认为|我觉得|所以|因此|只能|必须|不适合|适合|有问题|一般|更好|更差|优点|缺点|值得|不值得|赢者通吃|要掂量)/u,
  evidence: /(?:分数|位次|省排|排名|数学|物理|数据|比例|保研|就业|学费|政策|录取|扩招|案例|招聘|学校|专业|年份|招生|师资|校招|行业|岗位|直博|外保|计算机|自动化|机械)/u,
  contrast: /(?:但是|但|不过|而不是|相比|对比|区别|取舍|代价|冲突|一方面|另一方面|反而|却|优点|缺点|更好|更差)/u,
  condition: /(?:如果|要是|但凡|只要|适合|不适合|前提|取决于|更看重|想要|目标是|必须|对于|在.{0,12}情况下|看孩子|能接受|不卷|分数比较低|数学物理够不够)/u,
  action: /(?:建议|应该|需要|优先|可以考虑|先看|再看|核对|准备|填报|选择|比较|研究|做好|考虑|掂量|决定|不要|不能|别|报|选|慎选|慎入|盲目)/u,
};

function splitClauses(value: string): string[] {
  return normalizeSpokenText(value)
    .split(/[。！？!?；;，,、]+/u)
    .map((item) => item.trim())
    .filter((item) => meaningfulLength(item) >= 10 && !isLowInformationPhrase(item));
}

/**
 * Measures whether a candidate contains a usable argument rather than merely
 * enough ASR characters. The gate is intentionally deterministic: it does not
 * trust a model-provided score and it applies after filler cleanup.
 */
export function assessContentDensity(
  title: string,
  hookText: string,
  transcript: string,
): ContentDensityAssessment {
  const normalizedTitle = normalizeSpokenText(title);
  const normalizedHook = normalizeSpokenText(hookText);
  const normalizedTranscript = normalizeSpokenText(transcript);
  const allText = `${normalizedTitle} ${normalizedHook} ${normalizedTranscript}`;
  const meaningfulCharacters = meaningfulLength(normalizedTranscript);
  const clauses = splitClauses(normalizedTranscript);
  const signals = (Object.keys(SIGNAL_PATTERNS) as ContentSignal[]).filter((signal) =>
    SIGNAL_PATTERNS[signal].test(allText),
  );
  // A generated title or hook may summarize a topic, but it cannot invent a
  // conclusion that was never spoken. Required evidence therefore has to be
  // present in the original transcript itself.
  const transcriptSignals = (Object.keys(SIGNAL_PATTERNS) as ContentSignal[]).filter((signal) =>
    SIGNAL_PATTERNS[signal].test(normalizedTranscript),
  );
  const blockers: string[] = [];
  if (meaningfulCharacters < 90) blockers.push("正文有效信息少于 90 字");
  if (clauses.length < 3) blockers.push("正文不足 3 个独立信息单元");
  if (!transcriptSignals.includes("decision")) blockers.push("没有明确要解决的决策问题");
  if (!transcriptSignals.includes("claim")) blockers.push("没有清晰的核心判断或结论");
  if (!transcriptSignals.includes("evidence")) blockers.push("缺少学校、专业、分数、政策、就业或案例依据");
  if (!transcriptSignals.includes("condition")) blockers.push("没有说明适用条件、适合谁或不适合谁");
  if (!transcriptSignals.includes("action")) blockers.push("没有给出观众下一步的行动建议");
  if (transcriptSignals.length < 4) blockers.push("论证维度不足，不能只靠关键词拼成选题");
  const score =
    Math.min(20, Math.floor(meaningfulCharacters / 10))
    + Math.min(12, clauses.length * 2)
    + signals.length * 5;
  return {
    accepted: blockers.length === 0,
    score,
    meaningfulCharacters,
    substantiveClauses: clauses.length,
    signals,
    blockers,
  };
}

export function assertContentDensity(
  title: string,
  hookText: string,
  transcript: string,
): void {
  const assessment = assessContentDensity(title, hookText, transcript);
  if (!assessment.accepted) {
    throw new Error(`候选未通过内容密度硬门槛：${assessment.blockers.join("；")}`);
  }
}
