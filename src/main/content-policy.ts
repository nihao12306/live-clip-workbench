import type { AccountProfile, Candidate } from "../shared/types";

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .trim();
}

export interface PolicyMatch {
  term: string;
  source: "forbiddenTopic" | "sensitiveWord";
}

/** Returns configured blocked terms that occur in any supplied text. */
export function findPolicyMatches(
  account: Pick<AccountProfile, "forbiddenTopics" | "sensitiveWords">,
  texts: Array<string | undefined>,
): PolicyMatch[] {
  const haystack = texts
    .filter((text): text is string => Boolean(text))
    .map(normalize)
    .join(" ");
  if (!haystack) return [];
  const terms: Array<PolicyMatch & { normalized: string }> = [
    ...account.forbiddenTopics.map((term) => ({
      term: term.trim(),
      source: "forbiddenTopic" as const,
      normalized: normalize(term),
    })),
    ...account.sensitiveWords.map((term) => ({
      term: term.trim(),
      source: "sensitiveWord" as const,
      normalized: normalize(term),
    })),
  ];
  const seen = new Set<string>();
  return terms.filter((item) => {
    if (!item.normalized || seen.has(item.normalized)) return false;
    seen.add(item.normalized);
    return haystack.includes(item.normalized);
  });
}

export function policyMatchMessage(matches: PolicyMatch[]): string {
  const terms = [...new Set(matches.map((match) => match.term))].join("、");
  return `内容命中账号屏蔽词/禁止话题：${terms}`;
}

export function candidatePolicyTexts(candidate: Candidate): string[] {
  return [
    candidate.title,
    candidate.hookText,
    candidate.transcriptText,
    candidate.renderPlan.title,
    candidate.renderPlan.hookText,
    candidate.renderPlan.subtitleText,
    ...candidate.renderPlan.segments.map((segment) => segment.text),
  ];
}
