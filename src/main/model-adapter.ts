import { z } from "zod";
import type {
  AccountProfile,
  AnalyzeCandidateInput,
  FeedbackRecord,
  ModelCallInfo,
  ModelConnectionInput,
  ModelCandidate,
  ModelHealth,
  RiskFlag,
  SampleLearningProfile,
  TranscriptSegment,
} from "../shared/types";
import { deriveCandidateTitle } from "./candidate-quality";
import { chooseOpeningSegment } from "./clip-structure";
import { selectionPrinciplesForAccount } from "./selection-principles";
import { usesAdmissionsReviewPreset } from "../shared/constants";
import {
  buildTranscriptAnalysisPlan,
  DEFAULT_ANALYSIS_CHUNKING_OPTIONS,
  type AnalysisChunkingOptions,
  type TranscriptAnalysisWindow,
} from "./analysis-chunking";

const MODEL_REQUEST_TIMEOUT_MS = 180_000;
const MODEL_ANALYSIS_TIMEOUT_MS = 300_000;
// Long transcript requests can fail before the response body is opened when a
// VPN/proxy briefly resets the connection. Three attempts were too short for
// that common case, so use bounded exponential backoff (five total attempts)
// while keeping a single task finite and recoverable.
const MODEL_RETRY_DELAYS_MS = [1_500, 4_000, 8_000, 15_000];
// DeepSeek-V4 currently documents a 384K maximum output and a 1M context.
// Keep that ceiling available for long transcript analysis. The value is a
// ceiling, not a reservation: billing is based on tokens actually generated.
const V4_MAX_OUTPUT_TOKENS = 384_000;
// Older/custom DeepSeek-compatible models commonly reject the V4 ceiling.
const LEGACY_ANALYSIS_MAX_OUTPUT_TOKENS = 32_768;
const LEGACY_COPY_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_ANALYSIS_CONCURRENCY = 2;
const MAX_ANALYSIS_CONCURRENCY = 4;

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = "cause" in error ? String((error as Error & { cause?: unknown }).cause ?? "") : "";
  return `${error.message} ${cause}`.trim();
}

function isRetryableModelNetworkError(error: unknown): boolean {
  const message = errorText(error);
  return /terminated|fetch failed|econnreset|econnrefused|etimedout|eai_again|enetunreach|socket|network|abort|HTTP (408|425|429|5\d\d)|未返回有效内容|输出达到 token 上限/i.test(
    message,
  );
}

function modelErrorMessage(error: unknown): string {
  const message = errorText(error);
  if (/^terminated$/i.test(message.trim())) {
    return "DeepSeek 网络连接被中断（可能是 VPN、代理或长请求超时），系统已自动重试仍未成功";
  }
  if (/fetch failed|econnreset|econnrefused|eai_again|enetunreach|socket|network|abort/i.test(message)) {
    return "无法连接 DeepSeek（网络、VPN 或代理连接中断），系统已自动重试仍未成功";
  }
  if (/HTTP (408|425|429|5\d\d)/i.test(message)) {
    return "DeepSeek 服务暂时繁忙或限流，系统已自动退避重试仍未成功";
  }
  if (/timeout|timed out|aborted due to timeout/i.test(message)) {
    return "DeepSeek 长文本分析超过 5 分钟，已自动停止；原视频和逐字稿已保留，请稍后重试";
  }
  return message;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const runWorker = async (): Promise<void> => {
    while (true) {
      if (failed) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => runWorker(),
    ),
  );
  if (failed) throw firstError;
  return results;
}

function extractCandidateJson(value: string): string | undefined {
  const match = value.match(/\{\s*"candidates"\s*:[\s\S]*\}/);
  return match?.[0];
}

interface CompletionData {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
  reasoningContent?: string;
  finishReason?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

async function readCompletionResponse(
  response: Response,
  streaming: boolean,
): Promise<CompletionData> {
  const contentType = response.headers.get("content-type") ?? "";
  // Test doubles and a few OpenAI-compatible gateways ignore `stream: true`
  // and still return one regular JSON object.
  if (!streaming || !contentType.includes("text/event-stream") || !response.body) {
    return (await response.json()) as CompletionData;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let id: string | undefined;
  let model: string | undefined;
  let reasoningContent = "";
  let finishReason: string | undefined;
  let usage: CompletionData["usage"];
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const chunk = JSON.parse(payload) as {
      id?: string;
      model?: string;
      choices?: Array<{
        delta?: { content?: string; reasoning_content?: string };
        message?: { content?: string; reasoning_content?: string };
        finish_reason?: string | null;
      }>;
      usage?: CompletionData["usage"];
    };
    id ||= chunk.id;
    model ||= chunk.model;
    usage ||= chunk.usage;
    const choice = chunk.choices?.[0];
    content += choice?.delta?.content ?? choice?.message?.content ?? "";
    reasoningContent +=
      choice?.delta?.reasoning_content ??
      choice?.message?.reasoning_content ??
      "";
    finishReason ||= choice?.finish_reason ?? undefined;
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(consume);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer.trim());
  return {
    id,
    model,
    choices: [{ message: { content } }],
    reasoningContent,
    finishReason,
    usage,
  };
}

export interface ModelAdapter {
  analyze(
    input: AnalyzeCandidateInput,
    recentFeedback: FeedbackRecord[],
    signal?: AbortSignal,
  ): Promise<ModelCandidate[]>;
  generatePlatformCopy(input: {
    accountName: string;
    title: string;
    hookText: string;
    transcript: string;
    platform: string;
    blockedTerms?: string[];
    accountContext?: Partial<Pick<
      AccountProfile,
      | "audience"
      | "persona"
      | "stance"
      | "preferenceSummary"
      | "selectionPrinciples"
      | "sampleProfiles"
      | "sampleTranscript"
      | "fillerWords"
    >> & { sampleLearningProfile?: SampleLearningProfile };
    recentFeedback?: Array<{
      decision: string;
      reason?: string;
      title?: string;
      hook?: string;
      note?: string;
    }>;
  }): Promise<{
    title: string;
    body: string;
    hashtags: string[];
    pinnedComment: string;
    coverText: string;
  }>;
  getLastCallInfo?(): ModelCallInfo | undefined;
  testConnection?(): Promise<ModelHealth>;
}

const RISK_TYPES = [
  "platform",
  "misleading",
  "context",
  "fact",
  "minor",
  "education_claim",
] as const;
const RISK_LEVELS = ["none", "medium", "high"] as const;

function normalizeModelRisk(value: unknown): {
  type: (typeof RISK_TYPES)[number];
  level: (typeof RISK_LEVELS)[number];
  reason: string;
  contextBefore: string;
  contextAfter: string;
} {
  if (typeof value === "string") {
    return {
      type: "context",
      level: "medium",
      reason: value,
      contextBefore: "",
      contextAfter: "",
    };
  }
  const raw = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
  const type = RISK_TYPES.includes(raw.type as (typeof RISK_TYPES)[number])
    ? (raw.type as (typeof RISK_TYPES)[number])
    : "context";
  const level = RISK_LEVELS.includes(raw.level as (typeof RISK_LEVELS)[number])
    ? (raw.level as (typeof RISK_LEVELS)[number])
    : "medium";
  return {
    type,
    level,
    reason: String(raw.reason ?? "模型标记了需要人工确认的风险"),
    contextBefore: String(raw.contextBefore ?? ""),
    contextAfter: String(raw.contextAfter ?? ""),
  };
}

const candidateSchema = z.object({
  topicId: z.string(),
  title: z.string(),
  hookText: z.string(),
  segmentIds: z.array(z.string()).min(1),
  openingSegmentId: z.string().optional(),
  // DeepSeek occasionally returns a short risk explanation string instead
  // of the full object. Normalize that shape into a reviewable medium-risk
  // flag rather than discarding the entire model response.
  riskFlags: z.preprocess(
    (value) =>
      (Array.isArray(value) ? value : value == null ? [] : [value]).map(
        normalizeModelRisk,
      ),
    z.array(
      z.object({
        type: z.enum(RISK_TYPES),
        level: z.enum(RISK_LEVELS),
        reason: z.string(),
        contextBefore: z.string(),
        contextAfter: z.string(),
      }),
    ),
  ),
  internalScore: z.number().min(0).max(100),
  // Internal-only score from the account's topic rubric. It is never shown in
  // the reviewer UI; the local guard remains authoritative when omitted.
  principleScore: z.number().min(0).max(43).optional(),
});

const responseSchema = z.object({ candidates: z.array(candidateSchema) });

function stripJsonFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

/**
 * Recover complete candidate objects when a provider appends an incomplete
 * final object after one or more valid candidates. We never repair a partial
 * string; only independently balanced JSON objects are accepted.
 */
function extractCompleteCandidateObjects(value: string): unknown[] {
  const keyIndex = value.indexOf('"candidates"');
  const arrayStart = keyIndex >= 0 ? value.indexOf("[", keyIndex) : -1;
  if (arrayStart < 0) return [];
  const objects: unknown[] = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = arrayStart + 1; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (character !== "}") continue;
    if (depth <= 0) continue;
    depth -= 1;
    if (depth !== 0 || objectStart < 0) continue;
    try {
      objects.push(JSON.parse(value.slice(objectStart, index + 1)));
    } catch {
      // Ignore an invalid object and continue looking for a later balanced one.
    }
    objectStart = -1;
  }
  return objects;
}

function parseCandidateResponse(value: string): z.infer<typeof responseSchema> {
  const cleaned = stripJsonFence(value);
  try {
    return responseSchema.parse(JSON.parse(cleaned));
  } catch (error) {
    const recovered = extractCompleteCandidateObjects(cleaned);
    if (!recovered.length) throw error;
    return responseSchema.parse({ candidates: recovered });
  }
}

function invalidCandidateSegmentIds(
  candidates: z.infer<typeof responseSchema>["candidates"],
  validIds: Set<string>,
): string[] {
  return [
    ...new Set(
      candidates.flatMap((candidate) =>
        [
          ...candidate.segmentIds.filter((segmentId) => !validIds.has(segmentId)),
          ...(candidate.openingSegmentId && !validIds.has(candidate.openingSegmentId)
            ? [candidate.openingSegmentId]
            : []),
        ],
      ),
    ),
  ];
}

function keepResolvableCandidateIds(
  candidates: z.infer<typeof responseSchema>["candidates"],
  validIds: Set<string>,
): z.infer<typeof responseSchema>["candidates"] {
  return candidates
    .map((candidate) => {
      const segmentIds = candidate.segmentIds.filter((segmentId) =>
        validIds.has(segmentId),
      );
      const openingSegmentId = candidate.openingSegmentId &&
        validIds.has(candidate.openingSegmentId)
        ? candidate.openingSegmentId
        : undefined;
      return { ...candidate, segmentIds, openingSegmentId };
    })
    .filter((candidate) => candidate.segmentIds.length > 0);
}

class InvalidSegmentReferenceError extends Error {
  constructor(readonly invalidIds: string[]) {
    super(`候选引用了当前输入不存在的 segmentIds：${invalidIds.slice(0, 12).join(", ")}`);
    this.name = "InvalidSegmentReferenceError";
  }
}

const TOPIC_SHIFT_PATTERN =
  /^(?:另外|再说|换个话题|接下来|下一个|还有一个|我们再看|说到|回到|最后|一方面|另一方面|顺便说|除此之外|关于[^，,。]+[，,])/u;
const NATURAL_END_PATTERN =
  /(?:所以|因此|总之|关键是|建议|记住|答案是|结论是|这就是|才是)[^。！？!?]*[。！？!?]$/u;

function closesThought(text: string, nextText = ""): boolean {
  return (
    NATURAL_END_PATTERN.test(text) ||
    TOPIC_SHIFT_PATTERN.test(nextText) ||
    /(?:吗|呢)[。！？!?]$/u.test(text)
  );
}

export function heuristicCandidates(input: AnalyzeCandidateInput): ModelCandidate[] {
  const { transcript, account } = input;
  const groups: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let duration = 0;
  for (let index = 0; index < transcript.length; index += 1) {
    const segment = transcript[index];
    const segmentDuration = Math.max(0, segment.end - segment.start);
    const next = transcript[index + 1];
    const nextText = next?.text ?? "";
    if (current.length && TOPIC_SHIFT_PATTERN.test(segment.text) && duration >= 15) {
      groups.push(current);
      current = [];
      duration = 0;
    }
    if (
      current.length &&
      duration + segmentDuration > account.maxClipSeconds
    ) {
      groups.push(current);
      current = [];
      duration = 0;
    }
    current.push(segment);
    duration += segmentDuration;
    const enoughForStandaloneClip = duration >= Math.min(15, account.minClipSeconds);
    if (enoughForStandaloneClip && closesThought(segment.text, nextText)) {
      groups.push(current);
      current = [];
      duration = 0;
    }
  }
  if (current.length && duration >= Math.min(15, account.minClipSeconds))
    groups.push(current);
  return groups.map((group, index) => {
    const text = group.map((item) => item.text).join(" ");
    const title = deriveCandidateTitle("", text);
    const risky = account.sensitiveWords.find(
      (word) => word && text.includes(word),
    );
    return {
      topicId: `topic-${index + 1}`,
      title,
      hookText: title,
      segmentIds: group.map((item) => item.id),
      openingSegmentId: chooseOpeningSegment(group, title, title)?.id,
      riskFlags: risky
        ? [
            {
              type: "platform",
              level: "medium",
              reason: `包含账号敏感词：${risky}`,
              contextBefore: "",
              contextAfter: "",
            },
          ]
        : [],
      internalScore: Math.max(45, 78 - index * 2),
    };
  });
}

function textFingerprint(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const grams = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1)
    grams.add(normalized.slice(index, index + 2));
  return grams;
}

function semanticSimilarity(left: string, right: string): number {
  const a = textFingerprint(left);
  const b = textFingerprint(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((item) => b.has(item)).length;
  return intersection / (a.size + b.size - intersection);
}

function feedbackAdjustment(candidate: ModelCandidate, feedback: FeedbackRecord[]): number {
  const candidateText = `${candidate.title}${candidate.hookText}`;
  let adjustment = 0;
  for (const item of feedback.slice(0, 30)) {
    const finalText = `${item.finalPlan.title}${item.finalPlan.hookText}`;
    const similarity = semanticSimilarity(candidateText, finalText);
    if (item.decision === "approved") adjustment += similarity * 5;
    if (item.decision === "rejected") adjustment -= similarity * (item.rejectionReason === "high_risk" ? 8 : 4);
  }
  return Math.max(-15, Math.min(15, adjustment));
}

export interface DeepSeekModelAdapterOptions extends AnalysisChunkingOptions {
  request?: typeof fetch;
  /** Maximum number of analysis requests allowed to be in flight at once. */
  analysisConcurrency?: number;
}

/**
 * Merge candidates returned by independent analysis windows without moving
 * any of the local quality gates into the model layer. Exact source ranges
 * and highly similar titles/hooks are treated as duplicates; all other
 * candidates remain available for TaskProcessor.toCandidates() to evaluate.
 */
export function mergeModelCandidates(
  candidates: ModelCandidate[],
  recentFeedback: FeedbackRecord[] = [],
): ModelCandidate[] {
  const unique = new Map<string, ModelCandidate>();
  for (const sourceCandidate of [...candidates].sort(
    (left, right) => right.internalScore - left.internalScore,
  )) {
    const candidate: ModelCandidate = {
      ...sourceCandidate,
      segmentIds: [...new Set(sourceCandidate.segmentIds)],
    };
    candidate.internalScore = Math.max(
      0,
      Math.min(100, candidate.internalScore + feedbackAdjustment(candidate, recentFeedback)),
    );
    const key = [...candidate.segmentIds].sort().join("|");
    const semanticText = `${candidate.title}${candidate.hookText}`;
    const duplicatesExisting = [...unique.values()].some(
      (existing) =>
        semanticSimilarity(
          `${existing.title}${existing.hookText}`,
          semanticText,
        ) >= 0.72,
    );
    if (!unique.has(key) && !duplicatesExisting) unique.set(key, candidate);
  }
  return [...unique.values()].sort((left, right) => right.internalScore - left.internalScore);
}

export class DeepSeekModelAdapter implements ModelAdapter {
  private lastCallInfo?: ModelCallInfo;
  private readonly completedAnalysisCalls: ModelCallInfo[] = [];
  private readonly request: typeof fetch;
  private readonly analysisConcurrency: number;
  private readonly chunkingOptions: AnalysisChunkingOptions;

  constructor(
    private readonly getConfig: () => Promise<{
      apiKey: string;
      baseUrl: string;
      model: string;
    }>,
    options: DeepSeekModelAdapterOptions = {},
  ) {
    this.request = options.request ?? ((input, init) => fetch(input, init));
    const requestedConcurrency = options.analysisConcurrency;
    const safeConcurrency = Number.isFinite(requestedConcurrency)
      && requestedConcurrency !== undefined
      && requestedConcurrency > 0
      ? Math.floor(requestedConcurrency)
      : DEFAULT_ANALYSIS_CONCURRENCY;
    this.analysisConcurrency = Math.min(MAX_ANALYSIS_CONCURRENCY, safeConcurrency);
    this.chunkingOptions = {
      ...DEFAULT_ANALYSIS_CHUNKING_OPTIONS,
      ...options,
    };
  }

  async getSelectionIdentity() {
    const config = await this.getConfig();
    return { model: config.model, baseUrl: config.baseUrl.replace(/\/$/, '') };
  }

  getLastCallInfo(): ModelCallInfo | undefined {
    return this.lastCallInfo;
  }

  async textSelection(system: string, input: unknown, operation: 'analysis' | 'copy', reasoningEffort: 'low' | 'high' = 'high'): Promise<unknown> {
    try {
      return JSON.parse(await this.complete(system, JSON.stringify(input), operation, undefined, undefined, reasoningEffort));
    } catch (error) {
      if (!isRetryableModelNetworkError(error)) throw error;
      const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
      const code = cause?.code?.match(/^[A-Z0-9_]+$/)?.[0];
      throw new Error(modelErrorMessage(error) + (code ? '（' + code + '）' : ''), { cause: error });
    }
  }

  private async complete(
    system: string,
    user: string,
    operation: ModelCallInfo["operation"],
    configOverride?: ModelConnectionInput,
    signal?: AbortSignal,
    reasoningEffort: 'low' | 'high' = 'high',
  ): Promise<string> {
    const startedAt = Date.now();
    let config: Awaited<ReturnType<typeof this.getConfig>> | undefined;
    try {
      const baseConfig = await this.getConfig();
      // Do not let an omitted field from the settings form overwrite a valid
      // stored value. In particular, the UI clears the password input after
      // saving; `{ apiKey: undefined }` must not erase the key for a later
      // connection test.
      config = {
        ...baseConfig,
        ...(configOverride?.apiKey !== undefined
          ? { apiKey: configOverride.apiKey }
          : {}),
        ...(configOverride?.baseUrl !== undefined
          ? { baseUrl: configOverride.baseUrl }
          : {}),
        ...(configOverride?.model !== undefined
          ? { model: configOverride.model }
          : {}),
      };
      const baseUrl = config.baseUrl.replace(/\/$/, "");
      if (!config.apiKey) throw new Error("尚未配置 DeepSeek API Key");
      signal?.throwIfAborted();
      const activeConfig = config;
      const supportsThinking = /^(?:deepseek-flash(?:$|-)|deepseek-v4)/i.test(activeConfig.model);
      const analysisOperation = operation === "analysis";
      const outputTokenLimit = supportsThinking
        ? V4_MAX_OUTPUT_TOKENS
        : analysisOperation
          ? LEGACY_ANALYSIS_MAX_OUTPUT_TOKENS
          : LEGACY_COPY_MAX_OUTPUT_TOKENS;
      const requestBody = JSON.stringify({
          model: activeConfig.model,
          ...(supportsThinking
            ? {}
            : { temperature: operation === "analysis" ? 0.15 : 0.2 }),
          max_tokens: outputTokenLimit,
          response_format: { type: "json_object" },
          ...(supportsThinking
            ? {
              // Platform copy only needs a compact JSON object. Disabling
              // reasoning there prevents a shared multi-user API key from
              // spending most of the output budget on hidden CoT tokens.
              thinking: { type: analysisOperation ? "enabled" : "disabled" },
              ...(analysisOperation ? { reasoning_effort: reasoningEffort } : {}),
            }
            : {}),
          ...(operation === "analysis"
            ? { stream: true, stream_options: { include_usage: true } }
            : {}),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        });
      const makeRequest = () =>
        ({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${activeConfig.apiKey}`,
          },
          body: requestBody,
          // A new timeout signal is required for every retry attempt.
          signal: signal
            ? AbortSignal.any([
              signal,
              AbortSignal.timeout(
                operation === "analysis" ? MODEL_ANALYSIS_TIMEOUT_MS : MODEL_REQUEST_TIMEOUT_MS,
              ),
            ])
            : AbortSignal.timeout(
              operation === "analysis" ? MODEL_ANALYSIS_TIMEOUT_MS : MODEL_REQUEST_TIMEOUT_MS,
            ),
        }) satisfies RequestInit;
      let data: CompletionData | undefined;
      let requestError: unknown;
      for (let attempt = 0; attempt <= MODEL_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const response = await this.request(
            `${baseUrl}/chat/completions`,
            makeRequest(),
          );
          if (!response.ok) {
            throw new Error(
              `DeepSeek 请求失败：HTTP ${response.status} ${await response.text()}`,
            );
          }
          // Read and parse the body inside the retry block. Undici can return
          // a Response successfully and then throw `terminated` while the
          // response body is being read when a long connection is interrupted.
          data = await readCompletionResponse(response, operation === "analysis");
          const message = data.choices?.[0]?.message;
          const finishReason =
            data.finishReason ?? data.choices?.[0]?.finish_reason ?? undefined;
          const responseContent = message?.content?.trim();
          if (finishReason === "length") {
            throw new Error("DeepSeek 输出达到 token 上限，响应被截断");
          }
          if (!responseContent) {
            const reasoningContent =
              data.reasoningContent ?? message?.reasoning_content ?? "";
            const recovered =
              operation === "analysis"
                ? extractCandidateJson(reasoningContent)
                : undefined;
            if (recovered) {
              data.choices = [{ message: { content: recovered } }];
            } else {
              throw new Error(
                finishReason === "length"
                  ? "DeepSeek 输出达到 token 上限，未返回有效内容"
                  : "DeepSeek 未返回有效内容",
              );
            }
          }
          requestError = undefined;
          break;
        } catch (error) {
          requestError = error;
          if (signal?.aborted) throw error;
          if (
            attempt >= MODEL_RETRY_DELAYS_MS.length ||
            !isRetryableModelNetworkError(error)
          ) {
            throw error;
          }
          await wait(MODEL_RETRY_DELAYS_MS[attempt]);
        }
      }
      if (!data) throw requestError ?? new Error("DeepSeek 请求未返回响应");
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("DeepSeek 未返回有效内容");
      this.lastCallInfo = {
        provider: "deepseek",
        operation,
        status: "success",
        model: data.model || config.model,
        baseUrl,
        requestId: data.id,
        usage: {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
        },
        latencyMs: Date.now() - startedAt,
        createdAt: new Date().toISOString(),
      };
      if (operation === "analysis") this.completedAnalysisCalls.push(this.lastCallInfo);
      return content;
    } catch (error) {
      const baseUrl = config?.baseUrl?.replace(/\/$/, "") ?? "";
      this.lastCallInfo = {
        provider: "deepseek",
        operation,
        status: "error",
        model: config?.model ?? "",
        baseUrl,
        latencyMs: Date.now() - startedAt,
        error: modelErrorMessage(error),
        createdAt: new Date().toISOString(),
      };
      throw error;
    }
  }

  async testConnection(configOverride?: ModelConnectionInput): Promise<ModelHealth> {
    const startedAt = Date.now();
    try {
      await this.complete(
        "你正在执行 API 连通性测试。只返回 JSON。",
        '{"ping":"ok"}',
        "health",
        configOverride,
      );
      const info = this.lastCallInfo;
      return {
        ok: true,
        model: info?.model ?? "",
        baseUrl: info?.baseUrl ?? "",
        latencyMs: info?.latencyMs ?? Date.now() - startedAt,
        message: "DeepSeek API 调用成功",
        usage: info?.usage,
        requestId: info?.requestId,
      };
    } catch (error) {
      const info = this.lastCallInfo;
      return {
        ok: false,
        model: info?.model ?? "",
        baseUrl: info?.baseUrl ?? "",
        latencyMs: info?.latencyMs ?? Date.now() - startedAt,
        message: info?.error ?? (error instanceof Error ? error.message : String(error)),
        usage: info?.usage,
        requestId: info?.requestId,
      };
    }
  }

  async analyze(
    input: AnalyzeCandidateInput,
    recentFeedback: FeedbackRecord[],
    signal?: AbortSignal,
  ): Promise<ModelCandidate[]> {
    signal?.throwIfAborted();
    const analysisPlan = buildTranscriptAnalysisPlan(
      input.transcript,
      this.chunkingOptions,
    );
    const windows = analysisPlan.windows;
    const allCandidates: ModelCandidate[] = [];
    const analysisCallStart = this.completedAnalysisCalls.length;
    const sampleReference = (input.account.sampleTranscript?.trim() ?? "").slice(0, 16_000);
    const sampleLearningProfile = input.account.sampleLearning?.profile;
    // Analyze independent windows concurrently, but keep the number of open
    // long-lived requests bounded. mapWithConcurrency writes results by input
    // index, so merge order remains deterministic even when responses finish
    // out of order.
    const windowResults = await mapWithConcurrency(
      windows,
      this.analysisConcurrency,
      async (analysisWindow: TranscriptAnalysisWindow, index) => {
        signal?.throwIfAborted();
        const chunk = analysisWindow.segments;
        // UUIDs are reliable for local persistence but are unnecessarily hard
        // for a language model to copy over a long transcript. Give the model
        // short, chunk-local aliases and map them back before returning. This
        // prevents the recurring `analysis-*`/truncated-id hallucination while
        // preserving the original source ids for rendering and auditability.
        const sourceIdByModelId = new Map<string, string>();
        chunk.forEach((segment, segmentIndex) => {
          sourceIdByModelId.set(`seg-${segmentIndex}`, segment.id);
          // Accept an exact source id for backwards compatibility with a
          // provider response produced before the short-alias protocol. It
          // is still validated against this exact chunk and can never cross a
          // task or transcript boundary.
          sourceIdByModelId.set(segment.id, segment.id);
        });
        const segmentPayload = chunk.map((segment, segmentIndex) => ({
          id: `seg-${segmentIndex}`,
          start: segment.start,
          end: segment.end,
          text: segment.text,
        }));
        const validSegmentIds = new Set(sourceIdByModelId.keys());
        const system = [
          "你是教育类直播短视频编导。只返回 JSON，不解释。",
          "目标是找观点明确、可理性讨论、表达完整的 30 秒到 3 分钟片段，不刻意制造对立；30 秒和 3 分钟只是边界，不是统一时长目标。",
          "只保留成熟话题：必须有完整判断、问题、原因、方法或建议，能脱离上下文独立理解。",
          "内容密度是硬门槛，不是字数门槛：每条必须至少包含 3 个独立信息单元，并同时具备明确决策问题、具体依据（学校/专业/分数/政策/就业/案例）、适用条件和行动建议。只有‘某学校很强’、‘行业不错/不好’、连续评价或把多句口语拼成长段，都不要返回。",
          "如果原话本身没有完整论证链，就不要用标题或钩子替它补出不存在的结论；宁可返回 0 条。",
          "selectionPrinciples 是账号级硬规则，不是参考意见；必须逐条执行。若一个候选无法回答规则中的检查问题，宁可不返回，绝不能为了凑数量降低门槛。",
          ...(usesAdmissionsReviewPreset(input.account.selectionPrinciples) ? [
            "升学决策选题需要讲清一个具体选择，给出判断依据、适用条件和行动建议。",
          ] : []),
          "不要返回寒暄、单个词、肯定/否定、称呼、追问、重复确认或只有数字的片段。title 至少 8 个有效字，segmentIds 对应的原话至少 36 个有效字。",
          "只能组合输入中同一内容簇的原话，segmentIds 必须来自输入，不得编造或跨场。同一所学校或同一个升学选择下，分数、专业组/科类、地域、就业、政策和家庭偏好属于同一内容簇，允许合并；只有明确转到另一所学校或另一核心选择时才拆分。",
          "segmentIds 必须从本次输入 segments[].id 原样复制（形如 seg-0、seg-1），禁止使用 analysis-*、原始 UUID、裸序号、时间字符串或任何输入外编号。若无法定位原话，返回 candidates:[]。",
          "只排除明确无意义且独立出现的犹豫音（如‘呃、额’）和确认属于失败重说的内容。‘然后、这个、那个、其实、就是说、所以、但是、对’等词必须结合语境判断：承担顺序、指代、转折、因果、强调或自然语气时必须保留，禁止按词表机械删除；不确定时保留。",
          "账号给出的 forbiddenTopics 和 sensitiveWords 都是硬禁用项；候选原话、标题和钩子只要命中任一项就不要返回。",
          "账号的 sampleTranscript 只是该账号历史样片的内容与表达参考，不能复制样片原句，不能把样片内容当作本场直播内容，也不能跨场拼接；新的 segmentIds 只能来自本次输入。",
          "内容完整性优先于时长：不要为了达到 minClipSeconds 拼接无关句子，也不要把每条候选裁成相近长度；在自然话题边界结束，允许不同话题产生明显不同的时长。",
          "请返回本分析窗口内所有达到质量门槛的候选，不要人为凑数或人为截断；整场直播会合并多个分析窗口的结果，因此全场不设固定数量上限。全场按得分排序后前 3 条作为精选，其余所有通过质量门槛的候选作为可选。宁缺毋滥，不要返回寒暄、日期、更新、单个词或表达不完整的片段。",
          "从 segmentIds 中选出最适合作为开头的一句，写入 openingSegmentId，并把它放在最前；不能改变说话人的真实立场。",
          "重点识别教育承诺、未成年人、断章取义、事实和平台风险。",
          "内部评分按账号规则的 9 个维度估算，24 分以下不要返回；可在每条中返回 principleScore（0–43），但不要把评分或推荐解释写进 title/hookText。",
          "最终 content 只输出紧凑、合法、可直接 JSON.parse 的对象，不要在 JSON 外解释；每条候选最多 12 个 segmentIds，risk reason/context 各不超过 60 个字。不要输出任何 reasoning_content 或分析过程。",
          "返回 {candidates:[{topicId,title,hookText,segmentIds,openingSegmentId,riskFlags,internalScore,principleScore}]}。",
        ].join("\n");
        const user = JSON.stringify({
          chapter: analysisWindow.chapterIndex + 1,
          window: analysisWindow.windowIndex + 1,
          windowId: analysisWindow.id,
          windowIndex: index + 1,
          // Keep the legacy field for request traces and compatible gateways;
          // it now means the global analysis-window number.
          chunk: index + 1,
          totalChapters: analysisPlan.chapters.length,
          totalWindows: windows.length,
          account: {
            name: input.account.name,
            audience: input.account.audience,
            persona: input.account.persona,
            stance: input.account.stance,
            forbiddenTopics: input.account.forbiddenTopics,
            sensitiveWords: input.account.sensitiveWords,
            preferenceSummary: input.account.preferenceSummary,
            selectionPrinciples: selectionPrinciplesForAccount(input.account).slice(0, 16_000),
              sampleProfiles: input.account.sampleProfiles ?? [],
              sampleTranscript: sampleReference || undefined,
              sampleLearningProfile,
            fillerWords: input.account.fillerWords ?? [],
            minClipSeconds: input.account.minClipSeconds,
            maxClipSeconds: input.account.maxClipSeconds,
          },
          recentFeedback: recentFeedback.slice(0, 12).map((item) => ({
            decision: item.decision,
            reason: item.rejectionReason,
            title: item.finalPlan.title,
            hook: item.finalPlan.hookText,
            originalTitle: item.originalPlan.title,
            originalHook: item.originalPlan.hookText,
            originalSegments: item.originalPlan.segments.length,
            finalSegments: item.finalPlan.segments.length,
            note: item.note,
          })),
          segments: segmentPayload,
        });
        let parsed: z.infer<typeof responseSchema> | undefined;
        let parseError: unknown;
        let invalidReferenceIds: string[] = [];
        for (let parseAttempt = 0; parseAttempt < 2 && !parsed; parseAttempt += 1) {
          try {
            const response = await this.complete(
              parseAttempt === 0
                ? system
                : `${system}\n上一轮响应格式或时间段编号不合规。请立刻重试：只输出紧凑 JSON，不要输出任何解释、Markdown 或未闭合字符串；返回本窗口所有能够确认的合格候选，不要人为凑数或截断。只能复制本次 segments[].id，上一轮无效编号为：${invalidReferenceIds.slice(0, 12).join(", ")}。如果无法确认对应原话，请返回 candidates:[]。`,
              user,
              "analysis",
              undefined,
              signal,
            );
            const parsedResponse = parseCandidateResponse(response);
            const invalidIds = invalidCandidateSegmentIds(
              parsedResponse.candidates,
              validSegmentIds,
            );
            if (invalidIds.length) {
              invalidReferenceIds = invalidIds;
              if (parseAttempt === 0) {
                throw new InvalidSegmentReferenceError(invalidIds);
              }
              // Never allow an unknown id to reach the renderer. If a retry
              // still includes a mixed response, retain only the resolvable
              // candidates; a candidate with no valid source segment is
              // discarded and reported below.
              parsed = {
                candidates: keepResolvableCandidateIds(
                  parsedResponse.candidates,
                  validSegmentIds,
                ),
              };
            } else {
              parsed = parsedResponse;
            }
          } catch (error) {
            parseError = error;
            const message = error instanceof Error ? error.message : String(error);
            const retryableFormatError =
              error instanceof SyntaxError
              || error instanceof z.ZodError
              || error instanceof InvalidSegmentReferenceError
              || /JSON|候选|segmentIds|时间段|输出达到 token 上限|响应被截断/u.test(message);
            if (!retryableFormatError) break;
          }
        }
        if (!parsed) throw parseError ?? new Error("DeepSeek 返回的候选 JSON 无法解析");
          return {
            candidates: parsed.candidates.map((candidate) => ({
              ...candidate,
              segmentIds: candidate.segmentIds.map((segmentId) =>
                sourceIdByModelId.get(segmentId) ?? segmentId,
              ),
              openingSegmentId: candidate.openingSegmentId
                ? sourceIdByModelId.get(candidate.openingSegmentId)
                  ?? candidate.openingSegmentId
                : undefined,
            })),
            invalidReferenceIds,
          };
      },
    );
    const successfulCalls = this.completedAnalysisCalls.slice(analysisCallStart);
    const invalidReferenceIds = [
      ...new Set(windowResults.flatMap((result) => result.invalidReferenceIds)),
    ];
    for (const result of windowResults) allCandidates.push(...result.candidates);
    if (!allCandidates.length && invalidReferenceIds.length) {
      throw new Error(
        "DeepSeek 返回了候选，但引用的时间段编号与当前逐字稿不匹配；已自动重试，仍无法定位原话。请重试或检查逐字稿版本。",
      );
    }
    if (successfulCalls.length) {
      const totalTokens = successfulCalls.reduce(
        (sum, call) => sum + (call.usage?.totalTokens ?? 0),
        0,
      );
      const promptTokens = successfulCalls.reduce(
        (sum, call) => sum + (call.usage?.promptTokens ?? 0),
        0,
      );
      const completionTokens = successfulCalls.reduce(
        (sum, call) => sum + (call.usage?.completionTokens ?? 0),
        0,
      );
      this.lastCallInfo = {
        ...successfulCalls[successfulCalls.length - 1],
        callCount: successfulCalls.length,
        latencyMs: successfulCalls.reduce(
          (sum, call) => sum + (call.latencyMs ?? 0),
          0,
        ),
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
        },
      };
    }
    return mergeModelCandidates(allCandidates, recentFeedback);
  }

  async generatePlatformCopy(input: {
    accountName: string;
    title: string;
    hookText: string;
    transcript: string;
    platform: string;
    blockedTerms?: string[];
    accountContext?: Partial<Pick<
      AccountProfile,
      | "audience"
      | "persona"
      | "stance"
      | "preferenceSummary"
      | "selectionPrinciples"
      | "sampleProfiles"
      | "sampleTranscript"
      | "fillerWords"
    >> & { sampleLearningProfile?: SampleLearningProfile };
    recentFeedback?: Array<{
      decision: string;
      reason?: string;
      title?: string;
      hook?: string;
      note?: string;
    }>;
  }): Promise<{
    title: string;
    body: string;
    hashtags: string[];
    pinnedComment: string;
    coverText: string;
  }> {
    const system =
      "你是教育类短视频运营。只返回 JSON，字段为 title、body、hashtags、pinnedComment、coverText。不得夸大承诺或编造事实。不要在任何字段中出现 blockedTerms。账号样片、结构化风格画像和历史反馈只能用于学习表达结构、信息密度和账号偏好，不能复制样片原句，也不能把样片事实当作当前视频事实；当前视频的事实只能来自 transcript。严格遵守 selectionPrinciples 和 fillerWords。";
    const profile = input.accountContext?.sampleLearningProfile;
    const request = {
      ...input,
      accountContext: input.accountContext
        ? {
          ...input.accountContext,
          selectionPrinciples: input.accountContext.selectionPrinciples?.slice(0, 16_000),
          sampleTranscript: (
            input.accountContext.sampleTranscript?.trim()
            || ""
          ).slice(0, 16_000),
          sampleProfiles: input.accountContext.sampleProfiles?.slice(0, 10),
          sampleLearningProfile: profile,
        }
        : profile ? { sampleLearningProfile: profile } : undefined,
      recentFeedback: input.recentFeedback?.slice(0, 12),
    };
    const content = await this.complete(system, JSON.stringify(request), "copy");
    const parsed = JSON.parse(stripJsonFence(content)) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.title !== "string" ||
      typeof parsed.body !== "string" ||
      !Array.isArray(parsed.hashtags) ||
      typeof parsed.pinnedComment !== "string" ||
      typeof parsed.coverText !== "string"
    ) {
      throw new Error("DeepSeek 发布文案返回字段不完整");
    }
    return {
      title: parsed.title,
      body: parsed.body,
      hashtags: parsed.hashtags.map(String).slice(0, 8),
      pinnedComment: parsed.pinnedComment,
      coverText: parsed.coverText.slice(0, 28),
    };
  }
}
