import {
  BLIND_TEST_LIGHT_EDIT_TARGET,
  BLIND_TEST_MANUAL_MINUTES_TARGET,
  BLIND_TEST_TOTAL_SESSIONS,
  type BlindTestGateStatus,
  type BlindTestIssueType,
  type BlindTestMetrics,
  type BlindTestPublishability,
  type BlindTestSession,
  type BlindTestSnapshot,
} from "./types";

export const BLIND_TEST_PUBLISHABILITY_LABELS: Record<BlindTestPublishability, string> = {
  not_assessed: "未评估",
  light_edit_publishable: "轻改可发布",
  major_edit_required: "需大改后可用",
  not_publishable: "不可发布",
};

export const BLIND_TEST_ISSUE_LABELS: Record<BlindTestIssueType, string> = {
  none: "无问题",
  candidate_quality: "候选质量",
  transcript: "逐字稿/时间码",
  timing: "切点/节奏",
  subtitle: "字幕/安全区",
  render: "预览/渲染",
  model: "模型判断",
  workflow: "操作流程",
  other: "其他",
};

export const BLIND_TEST_ISSUE_TYPES = Object.keys(
  BLIND_TEST_ISSUE_LABELS,
) as BlindTestIssueType[];

export function createBlankBlindTestSession(sessionNumber: number): BlindTestSession {
  return {
    id: "",
    sessionNumber,
    candidates: [],
    publishability: "not_assessed",
    issueType: "none",
    notes: "",
    createdAt: "",
    updatedAt: "",
  };
}

function finiteNonNegative(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

export function sessionHasCandidate(session: Pick<BlindTestSession, "candidates" | "candidateNote">): boolean {
  return session.candidates.length > 0 || Boolean(session.candidateNote?.trim());
}

export function isBlindTestSessionComplete(session: BlindTestSession): boolean {
  return (
    sessionHasCandidate(session)
    && finiteNonNegative(session.manualMinutes)
    && finiteNonNegative(session.processingMinutes)
    && session.publishability !== "not_assessed"
  );
}

function average(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function gateStatus(
  complete: boolean,
  passed: boolean,
): BlindTestGateStatus {
  if (!complete) return "pending";
  return passed ? "passed" : "failed";
}

function emptyIssueCounts(): Record<BlindTestIssueType, number> {
  return Object.fromEntries(
    BLIND_TEST_ISSUE_TYPES.map((type) => [type, 0]),
  ) as Record<BlindTestIssueType, number>;
}

export function computeBlindTestMetrics(
  sessions: BlindTestSession[],
): BlindTestMetrics {
  const normalized = Array.from({ length: BLIND_TEST_TOTAL_SESSIONS }, (_, index) =>
    sessions.find((session) => session.sessionNumber === index + 1)
    ?? createBlankBlindTestSession(index + 1),
  );
  const completedSessions = normalized.filter(isBlindTestSessionComplete).length;
  const remainingSessions = BLIND_TEST_TOTAL_SESSIONS - completedSessions;
  const sessionsWithCandidates = normalized.filter(sessionHasCandidate).length;
  const evaluated = normalized.filter(
    (session) => session.publishability !== "not_assessed",
  );
  const lightEditPublishable = evaluated.filter(
    (session) => session.publishability === "light_edit_publishable",
  ).length;
  const lightEditPublishRate = evaluated.length
    ? lightEditPublishable / evaluated.length
    : undefined;
  const manualDurations = normalized
    .map((session) => session.manualMinutes)
    .filter(finiteNonNegative);
  const processingDurations = normalized
    .map((session) => session.processingMinutes)
    .filter(finiteNonNegative);
  const issueCounts = emptyIssueCounts();
  for (const session of normalized) {
    // Empty placeholders are rendered for the 20-row execution sheet, but
    // must not be counted as an explicit "无问题" result.
    if (session.id || isBlindTestSessionComplete(session)) {
      issueCounts[session.issueType] += 1;
    }
  }

  const finalGateComplete = completedSessions === BLIND_TEST_TOTAL_SESSIONS;
  const lightEditTargetStatus = gateStatus(
    finalGateComplete,
    evaluated.length === BLIND_TEST_TOTAL_SESSIONS
      && (lightEditPublishRate ?? 0) >= BLIND_TEST_LIGHT_EDIT_TARGET,
  );
  const manualMinutesTargetStatus = gateStatus(
    finalGateComplete,
    (average(manualDurations) ?? Number.POSITIVE_INFINITY)
      <= BLIND_TEST_MANUAL_MINUTES_TARGET,
  );
  const overallStatus: BlindTestGateStatus =
    !finalGateComplete
      ? "pending"
      : lightEditTargetStatus === "passed" && manualMinutesTargetStatus === "passed"
        ? "passed"
        : "failed";

  return {
    totalSessions: BLIND_TEST_TOTAL_SESSIONS,
    completedSessions,
    remainingSessions,
    sessionsWithCandidates,
    publishabilityEvaluated: evaluated.length,
    lightEditPublishable,
    lightEditPublishRate,
    lightEditTarget: BLIND_TEST_LIGHT_EDIT_TARGET,
    lightEditTargetStatus,
    manualDurationCount: manualDurations.length,
    averageManualMinutes: average(manualDurations),
    manualMinutesTarget: BLIND_TEST_MANUAL_MINUTES_TARGET,
    manualMinutesTargetStatus,
    processingDurationCount: processingDurations.length,
    averageProcessingMinutes: average(processingDurations),
    issueCounts,
    overallStatus,
  };
}

export function buildBlindTestSnapshot(
  records: BlindTestSession[],
): BlindTestSnapshot {
  const sessions = Array.from({ length: BLIND_TEST_TOTAL_SESSIONS }, (_, index) =>
    records.find((record) => record.sessionNumber === index + 1)
    ?? createBlankBlindTestSession(index + 1),
  );
  return { sessions, metrics: computeBlindTestMetrics(sessions) };
}
