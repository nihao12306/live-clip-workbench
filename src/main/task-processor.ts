import { usesAdmissionsReviewPreset } from "../shared/constants";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AccountProfile,
  Candidate,
  ClipTask,
  EditSegment,
  ModelCandidate,
  TranscriptSegment,
} from "../shared/types";
import { DatabaseService } from "./database";
import { MediaService } from "./media";
import type { ModelAdapter } from "./model-adapter";
import {
  deriveCandidateTitle,
  hasTopicSignal,
  isLowInformationPhrase,
  isMatureTopic,
  meaningfulLength,
  normalizeSpokenText,
} from "./candidate-quality";
import { findPolicyMatches } from "./content-policy";
import { reorderForOpening } from "./clip-structure";
import { cleanSpokenSegments } from "./speech-cleanup";
import { assessContentDensity } from "./content-density";
import {
  assessSelectionPrinciples,
} from "./selection-principles";
import {
  SourceAdapterRegistry,
  providerFromUrl,
  type SourceImportProgress,
} from "./source-adapters";
import { parseTranscriptFile, transcriptWindow } from "./transcript";
import { buildTopicContext } from "./topic-context";
import { reorderSubtitleUnitsToSegments } from "../shared/subtitle-sync";

const CHECKPOINT_ORDER = ["none", "validated", "analyzed", "candidates", "previews"] as const;

const ANALYSIS_GROUP_MAX_CHARS = 120;
const ANALYSIS_GROUP_MAX_SECONDS = 10;
const ANALYSIS_GROUP_MAX_GAP_SECONDS = 0.8;
const PREVIEW_RENDER_ATTEMPTS = 3;
const PREVIEW_RETRY_DELAYS_MS = [350, 900];
// Bump this whenever preview timing semantics change so an existing preview
// cannot silently survive a renderer fix.
const PREVIEW_RENDERER_VERSION = "subtitle-timeline-v3-word-aligned";

interface AnalysisTranscript {
  segments: TranscriptSegment[];
  sourceIdsByAnalysisId: Map<string, string[]>;
}

/**
 * SRT exports from Tongyi often contain one 1–2 character cue per subtitle
 * refresh. Sending every cue as a separate JSON object makes a 2-hour
 * transcript needlessly huge and causes V4 thinking requests to time out.
 * Coalesce nearby cues for topic analysis, while retaining a reversible map
 * back to the original time-coded segments for rendering.
 */
function coalesceTranscriptForAnalysis(transcript: TranscriptSegment[]): AnalysisTranscript {
  const segments: TranscriptSegment[] = [];
  const sourceIdsByAnalysisId = new Map<string, string[]>();
  let current: TranscriptSegment[] = [];
  const flush = () => {
    if (!current.length) return;
    const sourceIds = current.map((segment) => segment.id);
    if (current.length === 1) {
      const segment = current[0];
      segments.push(segment);
      sourceIdsByAnalysisId.set(segment.id, sourceIds);
    } else {
      const first = current[0];
      const last = current[current.length - 1];
      const id = `analysis-${first.id}`;
      segments.push({
        id,
        start: first.start,
        end: last.end,
        text: normalizeSpokenText(current.map((segment) => segment.text).join(" ")),
        confidence: current.some((segment) => segment.confidence === "estimated")
          ? "estimated"
          : "source",
      });
      sourceIdsByAnalysisId.set(id, sourceIds);
    }
    current = [];
  };
  for (const segment of transcript) {
    const previous = current.at(-1);
    const currentTextLength = current.reduce((sum, item) => sum + item.text.length, 0);
    const gap = previous ? segment.start - previous.end : 0;
    const sentenceEnded = Boolean(previous?.text.trim().match(/[。！？!?；;]$/u));
    if (
      previous
      && (
        gap > ANALYSIS_GROUP_MAX_GAP_SECONDS
        || currentTextLength + segment.text.length > ANALYSIS_GROUP_MAX_CHARS
        || segment.end - current[0].start > ANALYSIS_GROUP_MAX_SECONDS
        || sentenceEnded
      )
    ) {
      flush();
    }
    current.push(segment);
  }
  flush();
  return { segments, sourceIdsByAnalysisId };
}

function expandAnalysisCandidates(
  candidates: ModelCandidate[],
  sourceIdsByAnalysisId: Map<string, string[]>,
): ModelCandidate[] {
  // The model may occasionally hallucinate an id (for example an old
  // analysis-* alias). Never pass such ids to the renderer: they cannot be
  // resolved against the source transcript and would silently discard the
  // entire candidate set later in toCandidates().
  return candidates
    .map((candidate) => {
      const segmentIds = candidate.segmentIds.flatMap((id) =>
        sourceIdsByAnalysisId.get(id) ?? [],
      );
      const openingSegmentId = candidate.openingSegmentId
        ? sourceIdsByAnalysisId.get(candidate.openingSegmentId)?.[0]
        : undefined;
      return { ...candidate, segmentIds, openingSegmentId };
    })
    .filter((candidate) => candidate.segmentIds.length > 0);
}

function checkpointAtLeast(
  stage: ClipTask["checkpoint"] extends infer Checkpoint
    ? Checkpoint extends { stage: infer Stage }
      ? Stage
      : never
    : never,
  target: (typeof CHECKPOINT_ORDER)[number],
): boolean {
  return CHECKPOINT_ORDER.indexOf(stage as (typeof CHECKPOINT_ORDER)[number]) >= CHECKPOINT_ORDER.indexOf(target);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, bytes / 1024).toFixed(0)} KB`;
}

function downloadStatus(progress: SourceImportProgress): string {
  if (progress.phase === "retrying") {
    return `网络连接中断，正在第 ${progress.attempt} 次自动续传（已保留 ${formatBytes(progress.downloadedBytes)}）`;
  }
  const total = progress.totalBytes
    ? ` / ${formatBytes(progress.totalBytes)}`
    : "";
  const speed = progress.bytesPerSecond
    ? ` · ${formatBytes(progress.bytesPerSecond)}/秒`
    : "";
  return `正在下载直播视频 ${formatBytes(progress.downloadedBytes)}${total}${speed}`;
}

// Only explicit changes to another topic split a model-selected answer.
// “关于/说到/另一方面/再说一个” may introduce a sub-angle of the same
// school decision (score, major, city or employment), so they are retained.
const TOPIC_BREAK_PATTERN = /^(?:接下来(?:我们)?(?:换|讲另一个|说另一个)|转到另一个话题|换个话题|换一个话题)/u;
// The first three candidates are rendered immediately as the featured set.
// There is intentionally no task-wide candidate cap: every additional
// candidate that survives the content, policy, density and de-duplication
// gates remains available under “更多候选”. The model has a per-analysis-window
// response budget, but a long replay can contribute candidates from multiple
// windows.
const MAX_FEATURED_CANDIDATES = 3;
const SEGMENT_MERGE_GAP_SECONDS = 0.75;
const TOPIC_RUN_GAP_SECONDS = 8;
const OPENING_DEPENDENCY_PATTERN = /^(?:但是|但|所以|因此|然后|而且|并且|另外|此外|这个|那个|这|那|他|她|它|他们|其中)/u;
const CHATTER_PENALTY_PATTERN =
  /点.{0,4}(?:关注|点赞|灯牌)|直播间|安排(?:老师|联系)|连麦|已拍|欢迎大家|感谢大家/gu;

function sameSegmentOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function preservesRelativeOrder(currentIds: string[], referenceIds: string[]): boolean {
  const referencePositions = new Map(referenceIds.map((id, index) => [id, index]));
  const positions = currentIds
    .map((id) => referencePositions.get(id))
    .filter((position): position is number => position !== undefined);
  return positions.every((position, index) => index === 0 || position > positions[index - 1]!);
}

/**
 * Repairs candidates generated before hook ordering was enforced. Only a
 * still-chronological, otherwise untouched plan is eligible; a deliberate
 * reviewer reorder remains authoritative.
 */
export function repairCandidateOpening(candidate: Candidate): Candidate {
  const currentSegments = candidate.renderPlan.segments;
  if (currentSegments.length < 2) return candidate;
  const currentIds = currentSegments.map((segment) => segment.id);
  const sourceOrdered = [...currentSegments].sort(
    (left, right) => left.sourceStart - right.sourceStart || left.order - right.order,
  );
  if (!sameSegmentOrder(currentIds, sourceOrdered.map((segment) => segment.id))) return candidate;
  const originalIds = candidate.originalRenderPlan?.segments.map((segment) => segment.id);
  if (originalIds && !preservesRelativeOrder(currentIds, originalIds)) return candidate;
  const openingOrdered = reorderForOpening(
    sourceOrdered.map((segment) => ({
      id: segment.id,
      start: segment.sourceStart,
      end: segment.sourceEnd,
      text: segment.text,
      confidence: "source" as const,
    })),
    undefined,
    candidate.hookText,
    candidate.title,
  );
  const openingIds = openingOrdered.map((segment) => segment.id);
  if (sameSegmentOrder(currentIds, openingIds)) return candidate;
  const reorderedSegments = openingIds.map((id, order) => {
    const segment = currentSegments.find((item) => item.id === id);
    if (!segment) throw new Error("开头钩子重排时找不到原始片段");
    return { ...segment, order };
  });
  return {
    ...candidate,
    previewPath: undefined,
    transcriptText: reorderedSegments.map((segment) => segment.text).join(" "),
    renderPlan: {
      ...candidate.renderPlan,
      segments: reorderedSegments,
      subtitleText: reorderSubtitleUnitsToSegments(
        candidate.renderPlan.subtitleText,
        reorderedSegments,
      ),
    },
  };
}

function joinSpokenText(left: string, right: string): string {
  if (!left) return right;
  const joined = /[\u3400-\u9fff]$/u.test(left) || /^[\u3400-\u9fff]/u.test(right)
    ? `${left}${right}`
    : `${left} ${right}`;
  return normalizeSpokenText(joined);
}

/**
 * Word-level transcripts can contain hundreds of tiny records for one
 * sentence. Keep the original time range but present/render nearby speech as
 * one coherent edit segment so the reviewer is not forced to reorder crumbs.
 */
function mergeNearbySegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (
      previous
      // A single transcript segment may be split into multiple pieces when
      // a filler is removed. Never merge those pieces back together: doing
      // so would re-introduce the removed audio range into the render plan.
      && previous.id !== segment.id
      && segment.start - previous.end <= SEGMENT_MERGE_GAP_SECONDS
      && segment.start - previous.end >= -0.25
    ) {
      previous.end = Math.max(previous.end, segment.end);
      previous.text = joinSpokenText(previous.text, segment.text);
      previous.timingPrecision = "sentence";
      if (previous.confidence === "estimated" || segment.confidence === "estimated") {
        previous.confidence = "estimated";
      }
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/**
 * Restore the missing lead-in when a model starts on a word-level cue in the
 * middle of a sentence. The added cues are from the same source transcript,
 * never from another task, and are limited to a short local window so a hook
 * cannot pull an unrelated answer into the clip.
 */
function expandOpeningContext(
  segments: TranscriptSegment[],
  transcript: TranscriptSegment[],
): TranscriptSegment[] {
  if (!segments.length) return [];
  const ordered = [...segments].sort((left, right) => left.start - right.start);
  const first = ordered[0];
  const firstIndex = transcript.findIndex((segment) => segment.id === first.id);
  if (firstIndex <= 0) return ordered;
  const needsContext = OPENING_DEPENDENCY_PATTERN.test(first.text.trim())
    || !/[。！？!?；;]$/u.test(transcript[firstIndex - 1]?.text.trim() ?? "");
  if (!needsContext) return ordered;
  const expanded = [...ordered];
  let cursor = firstIndex - 1;
  let addedDuration = 0;
  while (cursor >= 0 && addedDuration < 8) {
    const previous = transcript[cursor];
    const current = transcript[cursor + 1];
    if (!previous || !current) break;
    const gap = current.start - previous.end;
    if (gap > 1.8) break;
    const previousDuration = Math.max(0, previous.end - previous.start);
    if (addedDuration + previousDuration > 8) break;
    expanded.unshift(previous);
    addedDuration += previousDuration;
    const previousText = previous.text.trim();
    cursor -= 1;
    if (/[。！？!?；;]$/u.test(previousText)) break;
  }
  return [...new Map(expanded.map((segment) => [segment.id, segment])).values()]
    .sort((left, right) => left.start - right.start);
}

/**
 * Model responses over word-level transcripts can contain pauses between
 * paragraphs of one answer. A school topic may legitimately cover score,
 * major groups, city, employment and family preference in separate runs.
 * Preserve the model-selected runs; only trim an obvious leading chatter cue.
 */
function selectContentRun(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (!segments.length) return [];
  const ordered = [...segments].sort((left, right) => left.start - right.start);
  // Remove a short hook fragment such as “给你更新的也是假的” when the
  // actual topic starts in the next selected run. `expandOpeningContext`
  // restores a small amount of source context after this step.
  const anchor = ordered.findIndex(
    (segment) => meaningfulLength(segment.text) >= 12 && hasTopicSignal(segment.text),
  );
  return anchor > 0 ? ordered.slice(anchor) : ordered;
}

/**
 * A model can occasionally select the same topic twice from different parts
 * of a long replay (for example, the explanation and a later chat answer).
 * Joining those distant ranges would make an invalid clip. Keep the run that
 * contains the model's requested opening when possible; otherwise keep the
 * densest local run. This recovers a usable contiguous explanation instead of
 * throwing away the whole candidate.
 */
function restrictToLocalTopicRun(
  segments: TranscriptSegment[],
  openingSegmentId?: string,
  transcript?: TranscriptSegment[],
): TranscriptSegment[] {
  if (segments.length < 2) return segments;
  const ordered = [...segments].sort((left, right) => left.start - right.start);
  // The model has already selected the passages for one topic. A pause or a
  // sub-angle marker is not enough evidence to discard part of the argument;
  // otherwise score, major, city and employment paragraphs get separated and
  // the candidate fails the content-density gate. Keep all selected source
  // ranges; explicit topic breaks are handled by the model's selection.
  void openingSegmentId;
  void transcript;
  return ordered;
}

/**
 * Keeps a model proposal inside one local topic window. The model still
 * decides the topic, but this guard prevents a malformed response from
 * silently joining distant sections of a long live stream.
 */
function staysInOneTopicWindow(
  pickedIds: string[],
  transcript: TranscriptSegment[],
  maxSpanSeconds: number,
): boolean {
  const positions = pickedIds
    .map((id) => transcript.findIndex((segment) => segment.id === id))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  if (positions.length < 2) return true;
  const first = transcript[positions[0]];
  const last = transcript[positions[positions.length - 1]];
  if (!first || !last || last.end - first.start > maxSpanSeconds) return false;
  const picked = new Set(pickedIds);
  return !transcript
    .slice(positions[0], positions[positions.length - 1] + 1)
    .some((segment) => !picked.has(segment.id) && TOPIC_BREAK_PATTERN.test(segment.text.trim()));
}

type TaskControlAction = "pause" | "delete";
type TaskControl = {
  controller: AbortController;
  action?: TaskControlAction;
};

const PROCESSING_TASK_STATUSES: ClipTask["status"][] = [
  "queued",
  "validating",
  "analyzing",
  "generating_candidates",
  "generating_previews",
];

export class TaskProcessor {
  private readonly running = new Set<string>();
  private readonly previewJobs = new Map<string, Promise<Candidate>>();
  // Preview rendering is CPU/disk intensive. Serializing it also prevents two
  // saves for different candidates from racing over FFmpeg's temporary files
  // and makes a saved edit deterministic.
  private previewTail: Promise<void> = Promise.resolve();
  private readonly queue: Array<{
    taskId: string;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly controls = new Map<string, TaskControl>();
  private pumping = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly media: MediaService,
    private readonly model: ModelAdapter,
    private readonly sources: SourceAdapterRegistry,
  ) {}

  /**
   * Generate a preview for any candidate selected during review. The first
   * three candidates are featured and generated during task processing; the
   * next three are available on demand so the review feed stays fast.
   */
  async generateCandidatePreview(candidateId: string): Promise<Candidate> {
    const existing = this.previewJobs.get(candidateId);
    if (existing) return existing;

    const job = this.enqueuePreview(() => this.generateCandidatePreviewOnce(candidateId))
      .catch((error) => {
        const candidate = this.database.getCandidate(candidateId);
        if (candidate) {
          candidate.previewPath = undefined;
          candidate.previewPlanFingerprint = undefined;
          candidate.previewError = error instanceof Error ? error.message : String(error);
          this.database.saveCandidate(candidate);
        }
        throw error;
      })
      .finally(() => {
        this.previewJobs.delete(candidateId);
      });
    this.previewJobs.set(candidateId, job);
    return job;
  }

  private enqueuePreview<T>(job: () => Promise<T>): Promise<T> {
    const run = this.previewTail.then(job, job);
    this.previewTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async createPreviewWithRetry(
    candidate: Candidate,
    account: AccountProfile,
    outputPath: string,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PREVIEW_RENDER_ATTEMPTS; attempt += 1) {
      try {
        return await this.media.createPreview(candidate, account, outputPath);
      } catch (error) {
        lastError = error;
        const delay = PREVIEW_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async generateCandidatePreviewOnce(candidateId: string): Promise<Candidate> {
    const initial = this.database.getCandidate(candidateId);
    if (!initial) throw new Error("候选不存在");
    const task = this.database.getTask(initial.taskId);
    if (!task) throw new Error("任务不存在");
    const account = this.database.getAccount(task.accountId);
    if (!account) throw new Error("账号不存在");
    const previewPath = path.join(
      task.workDir,
      "previews",
      `${candidateId}.mp4`,
    );

    // A save can happen while FFmpeg is rendering. Never let the older job
    // write its preview or candidate object over the newly saved plan.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let candidate = this.database.getCandidate(candidateId);
      if (!candidate) throw new Error("候选不存在");
      const repaired = repairCandidateOpening(candidate);
      if (repaired !== candidate) candidate = this.database.saveCandidate(repaired);
      const planFingerprint = JSON.stringify({
        renderer: PREVIEW_RENDERER_VERSION,
        renderPlan: candidate.renderPlan,
      });
      if (candidate.previewPath && candidate.previewPlanFingerprint === planFingerprint) {
        try {
          await fs.access(candidate.previewPath);
          return candidate;
        } catch {
          candidate.previewPath = undefined;
        }
      }
      const temporaryPreviewPath = path.join(
        task.workDir,
        "previews",
        `.${candidateId}.${crypto.randomUUID()}.tmp.mp4`,
      );
      try {
        await this.createPreviewWithRetry(candidate, account, temporaryPreviewPath);
        const latest = this.database.getCandidate(candidateId);
        const latestPlanFingerprint = latest
          ? JSON.stringify({
            renderer: PREVIEW_RENDERER_VERSION,
            renderPlan: latest.renderPlan,
          })
          : undefined;
        if (!latest || latestPlanFingerprint !== planFingerprint) {
          await fs.rm(temporaryPreviewPath, { force: true });
          continue;
        }
        await fs.rm(previewPath, { force: true });
        await fs.rename(temporaryPreviewPath, previewPath);
        latest.previewPath = previewPath;
        latest.previewPlanFingerprint = planFingerprint;
        latest.previewError = undefined;
        await fs.access(previewPath);
        return this.database.saveCandidate(latest);
      } catch (error) {
        await fs.rm(temporaryPreviewPath, { force: true });
        throw error;
      }
    }
    throw new Error("剪辑方案在预览生成期间发生变化，请稍后重试");
  }

  private update(
    task: ClipTask,
    status: ClipTask["status"],
    progress: number,
    statusMessage: string,
  ): void {
    task.status = status;
    task.progress = progress;
    task.statusMessage = statusMessage;
    task.error = undefined;
    this.database.saveTask(task);
  }

  async run(taskId: string): Promise<void> {
    return this.enqueue(taskId);
  }

  async pauseTask(taskId: string): Promise<void> {
    const task = this.database.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.status === "paused") return;
    if (!PROCESSING_TASK_STATUSES.includes(task.status)) {
      throw new Error("当前任务不在处理中，无法暂停");
    }

    const control = this.controls.get(taskId);
    if (!control) {
      this.markPaused(task);
      return;
    }
    control.action = "pause";
    control.controller.abort();
    const queued = this.removeQueued(taskId);
    if (queued) {
      queued.resolve();
      this.controls.delete(taskId);
      this.markPaused(task);
      return;
    }
    const running = this.activeRuns.get(taskId);
    if (running) await running.catch(() => undefined);
  }

  /** Stop a queued/running task before the caller removes its local files. */
  async cancelTask(taskId: string): Promise<void> {
    const task = this.database.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (!PROCESSING_TASK_STATUSES.includes(task.status)) return;

    const control = this.controls.get(taskId);
    if (!control) return;
    control.action = "delete";
    control.controller.abort();
    const queued = this.removeQueued(taskId);
    if (queued) {
      queued.resolve();
      this.controls.delete(taskId);
      return;
    }
    const running = this.activeRuns.get(taskId);
    if (running) await running.catch(() => undefined);
  }

  private removeQueued(taskId: string): { resolve: () => void; reject: (error: unknown) => void } | undefined {
    const index = this.queue.findIndex((item) => item.taskId === taskId);
    if (index < 0) return undefined;
    const [item] = this.queue.splice(index, 1);
    return item;
  }

  private markPaused(task: ClipTask): void {
    task.status = "paused";
    task.error = undefined;
    task.statusMessage = "已暂停，可点击继续处理";
    this.database.saveTask(task);
  }

  private controlAction(taskId: string): TaskControlAction | undefined {
    return this.controls.get(taskId)?.action;
  }

  private stopIfRequested(taskId: string): void {
    const action = this.controlAction(taskId);
    if (action) throw new Error(action === "pause" ? "任务已暂停" : "任务已删除");
  }

  /**
   * Re-run analysis for an already reviewable task with the current quality
   * rules. Source files stay in place; the next successful run replaces the
   * old candidate set, while the old records remain available until then.
   */
  async rebuildCandidates(taskId: string): Promise<void> {
    const task = this.database.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (!(["awaiting_review", "failed"] as ClipTask["status"][]).includes(task.status)) {
      throw new Error("只有失败或待审核任务可以重新筛选候选");
    }
    task.status = "imported";
    task.progress = 0;
    task.error = undefined;
    task.statusMessage = "正在按最新规则重新筛选候选";
    // Re-run validation as well so overlay detection and any corrected media
    // rules apply to the regenerated previews. Existing source files remain
    // in place, so this does not download the replay again.
    task.checkpoint = {
      stage: "none",
      updatedAt: new Date().toISOString(),
    };
    this.database.saveTask(task);
    void this.enqueue(taskId).catch((error) => {
      console.error("重新筛选候选失败", error);
    });
  }

  async enqueue(taskId: string): Promise<void> {
    const existing = this.activeRuns.get(taskId);
    if (existing) return existing;
    const task = this.database.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.status === "awaiting_review" || task.status === "exported") return;
    this.controls.set(taskId, { controller: new AbortController() });
    task.status = "queued";
    task.statusMessage = "已进入本地处理队列";
    task.error = undefined;
    this.database.saveTask(task);
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({ taskId, resolve, reject });
    });
    this.activeRuns.set(taskId, promise);
    void this.pump();
    return promise.finally(() => this.activeRuns.delete(taskId));
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        try {
          await this.runTask(item.taskId);
          item.resolve();
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runTask(taskId: string): Promise<void> {
    if (this.running.has(taskId)) return;
    const task = this.database.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    const account = this.database.getAccount(task.accountId);
    if (!account) throw new Error("账号不存在");
    const control = this.controls.get(taskId);
    this.running.add(taskId);
    try {
      this.stopIfRequested(taskId);
      const currentCheckpoint = task.checkpoint ?? {
        stage: "none" as const,
        updatedAt: new Date().toISOString(),
      };
      task.checkpoint = currentCheckpoint;
      this.update(task, "validating", 8, "正在检查素材与逐字稿");
      await fs.mkdir(task.workDir, { recursive: true });
      this.stopIfRequested(taskId);
      if (!checkpointAtLeast(currentCheckpoint.stage, "validated") && (!task.sourceVideoPath || !task.transcriptPath) && task.sourceUrl) {
        let provider: Parameters<DatabaseService["recordSourceStat"]>[0] = "unknown";
        try {
          provider = providerFromUrl(task.sourceUrl);
          const imported = await this.sources.import(
            task.sourceUrl,
            task.workDir,
            (download) => {
              const downloadPercent = download.totalBytes
                ? 8 + Math.round((download.downloadedBytes / download.totalBytes) * 12)
                : 9;
              this.update(
                task,
                "validating",
                Math.max(task.progress, Math.min(20, downloadPercent)),
                downloadStatus(download),
              );
            },
            control?.controller.signal,
          );
          task.sourceVideoPath ||= imported.videoPath;
          task.transcriptPath ||= imported.transcriptPath;
          this.database.recordSourceStat(provider, true);
          this.database.saveTask(task);
        } catch (error) {
          if (this.controlAction(taskId)) throw error;
          this.database.recordSourceStat(
            provider,
            false,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      }
      if (!task.sourceVideoPath || !task.transcriptPath) {
        throw new Error("链接未能同时取得视频和逐字稿，请补传这两个文件后重试");
      }
      this.stopIfRequested(taskId);
      await fs.access(task.sourceVideoPath);
      await fs.access(task.transcriptPath);
      const mediaInfo = await this.media.probe(task.sourceVideoPath, control?.controller.signal);
      this.stopIfRequested(taskId);
      task.duration = mediaInfo.duration;
      if (!checkpointAtLeast(currentCheckpoint.stage, "validated")) {
        // Keep the original source framing and live-stream sticker. The
        // overlay detector remains available for future experiments, but it
        // is intentionally not part of the current processing path.
        this.update(task, "validating", 18, "正在保持原始画面");
        task.overlayPreset = undefined;
        task.checkpoint = {
          ...currentCheckpoint,
          stage: "validated",
          updatedAt: new Date().toISOString(),
        };
        this.database.saveTask(task);
      }
      let transcript: TranscriptSegment[];
      const normalizedPath = task.checkpoint.normalizedTranscriptPath ?? path.join(task.workDir, "transcript.normalized.json");
      if (checkpointAtLeast(task.checkpoint.stage, "analyzed")) {
        transcript = JSON.parse(await fs.readFile(normalizedPath, "utf8")) as TranscriptSegment[];
        this.stopIfRequested(taskId);
      } else {
        this.update(task, "analyzing", 22, "正在解析逐字稿并识别话题");
        transcript = await parseTranscriptFile(task.transcriptPath, mediaInfo.duration);
        this.stopIfRequested(taskId);
        if (!transcript.length) throw new Error("逐字稿为空或格式无法识别");
        task.transcriptConfidence = transcript.some((segment) => segment.confidence === "estimated") ? "estimated" : "source";
        await fs.writeFile(normalizedPath, JSON.stringify(transcript, null, 2), "utf8");
        const feedback = this.database.listRecentFeedback(account.id);
        const analysisTranscript = coalesceTranscriptForAnalysis(transcript);
        const modelCandidates = expandAnalysisCandidates(
          await this.model.analyze({ account, task, transcript: analysisTranscript.segments }, feedback, control?.controller.signal),
          analysisTranscript.sourceIdsByAnalysisId,
        );
        this.stopIfRequested(taskId);
        const modelCall = this.model.getLastCallInfo?.();
        task.checkpoint = {
          ...task.checkpoint,
          stage: "analyzed",
          normalizedTranscriptPath: normalizedPath,
          modelCandidates,
          modelCall,
          updatedAt: new Date().toISOString(),
        };
        this.database.saveTask(task);
      }
      let candidates: Candidate[];
      let loadedExistingCandidates = false;
      if (checkpointAtLeast(task.checkpoint.stage, "candidates") && task.checkpoint.candidateIds?.length) {
        candidates = task.checkpoint.candidateIds
          .map((id) => this.database.getCandidate(id))
          .filter((item): item is Candidate => Boolean(item));
        loadedExistingCandidates = candidates.length > 0;
      } else {
        const modelCandidates = task.checkpoint.modelCandidates ?? [];
        this.update(task, "generating_candidates", 58, "正在生成精剪方案并去重");
        this.stopIfRequested(taskId);
        candidates = this.toCandidates(task, transcript, modelCandidates, account);
        task.checkpoint = {
          ...task.checkpoint,
          stage: "candidates",
          candidateIds: candidates.map((candidate) => candidate.id),
          updatedAt: new Date().toISOString(),
        };
      }
      if (!candidates.length) {
        const blocked = findPolicyMatches(
          account,
          transcript.map((segment) => segment.text),
        );
        if (blocked.length) {
          throw new Error(
            `账号屏蔽词/禁止话题已排除相关内容：${[
              ...new Set(blocked.map((match) => match.term)),
            ].join("、")}`,
          );
        }
        throw new Error("没有找到达到完整性门槛的候选片段");
      }
      if (!loadedExistingCandidates) {
        this.database.replaceTaskCandidates(task.id, candidates);
      }
      this.database.saveTask(task);
      this.update(task, "generating_previews", 70, `正在优先生成 ${MAX_FEATURED_CANDIDATES} 条精选预览，其余合格候选按需生成`);
      this.stopIfRequested(taskId);
      const featured = candidates.filter(
        (candidate) => candidate.tier === "featured",
      );
      for (let index = 0; index < featured.length; index += 1) {
        this.stopIfRequested(taskId);
        const candidate = featured[index];
        if (candidate.previewPath && await fs.access(candidate.previewPath).then(() => true, () => false)) continue;
        const previewPath = path.join(
          task.workDir,
          "previews",
          `${candidate.id}.mp4`,
        );
        try {
          candidate.previewPath = await this.media.createPreview(
            candidate,
            account,
            previewPath,
            control?.controller.signal,
          );
          this.database.saveCandidate(candidate);
        } catch (error) {
          if (this.controlAction(taskId)) throw error;
          candidate.previewPath = undefined;
          this.database.saveCandidate(candidate);
          task.statusMessage = `候选 ${index + 1} 预览失败，可在审核时使用原片时间码：${error instanceof Error ? error.message : String(error)}`;
        }
        task.progress = 70 + Math.round(((index + 1) / featured.length) * 28);
        task.checkpoint = {
          ...task.checkpoint,
          previewIds: featured.filter((item) => Boolean(item.previewPath)).map((item) => item.id),
          updatedAt: new Date().toISOString(),
        };
        this.database.saveTask(task);
      }
      this.stopIfRequested(taskId);
      task.checkpoint = {
        ...task.checkpoint,
        stage: "previews",
        previewIds: featured.filter((item) => Boolean(item.previewPath)).map((item) => item.id),
        updatedAt: new Date().toISOString(),
      };
      this.update(
        task,
        "awaiting_review",
        100,
        `已生成 ${featured.filter((item) => Boolean(item.previewPath)).length} 条精选预览`,
      );
    } catch (error) {
      const action = this.controlAction(taskId);
      if (action === "pause") {
        this.markPaused(task);
        return;
      }
      if (action === "delete") return;
      task.status = "failed";
      task.progress = 0;
      const rawError = error instanceof Error ? error.message : String(error);
      const modelCall = this.model.getLastCallInfo?.();
      task.error =
        modelCall?.status === "error" &&
        modelCall.error &&
        (
          rawError === "terminated"
          || rawError === "fetch failed"
          || /timeout|timed out|aborted due to timeout/i.test(rawError)
        )
          ? modelCall.error
          : rawError;
      task.statusMessage = `处理失败：${task.error}`;
      task.checkpoint = {
        ...(task.checkpoint ?? { stage: "none" as const }),
        modelCall,
        updatedAt: new Date().toISOString(),
      };
      this.database.saveTask(task);
      throw error;
    } finally {
      this.running.delete(taskId);
      this.controls.delete(taskId);
    }
  }

  /** @internal Exposed for deterministic pipeline tests and rule audits. */
  toCandidates(
    task: ClipTask,
    transcript: TranscriptSegment[],
    modelCandidates: ModelCandidate[],
    account: AccountProfile,
  ): Candidate[] {
    const byId = new Map(transcript.map((segment) => [segment.id, segment]));
    const dedupe = new Set<string>();
    const candidates: Candidate[] = [];
    for (const modelCandidate of modelCandidates.sort(
      (a, b) => b.internalScore - a.internalScore,
    )) {
      const picked = modelCandidate.segmentIds
        .map((id) => byId.get(id))
        .filter((item): item is TranscriptSegment => Boolean(item));
      if (!picked.length) continue;
      const localPicked = restrictToLocalTopicRun(
        picked,
        modelCandidate.openingSegmentId,
        transcript,
      );
      const uniquePicked = [
        ...new Map(localPicked.map((segment) => [segment.id, segment])).values(),
      ]
        .flatMap((segment) => cleanSpokenSegments(segment, account.fillerWords ?? []))
        .map((segment) => ({ ...segment, text: normalizeSpokenText(segment.text) }))
        .filter((segment) => !isLowInformationPhrase(segment.text));
      if (!uniquePicked.length) continue;
      const compactedPicked = mergeNearbySegments(
        [...uniquePicked].sort((left, right) => left.start - right.start),
      );
      const contentPicked = expandOpeningContext(
        selectContentRun(compactedPicked),
        transcript,
      );
      if (!contentPicked.length) continue;
      if (!staysInOneTopicWindow(
        contentPicked.map((segment) => segment.id),
        transcript,
        account.maxClipSeconds + 180,
      )) continue;
      const orderedPicked = reorderForOpening(
        contentPicked,
        modelCandidate.openingSegmentId,
        modelCandidate.hookText,
        modelCandidate.title,
      );
      const duration = orderedPicked.reduce(
        (sum, segment) => sum + Math.max(0, segment.end - segment.start),
        0,
      );
      if (
        duration < Math.min(15, account.minClipSeconds) ||
        duration > account.maxClipSeconds + 20
      )
        continue;
      const semanticKey = orderedPicked
        .map((segment) => segment.text.replace(/\W/g, "").slice(0, 30))
        .join("|");
      if (dedupe.has(semanticKey)) continue;
      dedupe.add(semanticKey);
      const ordered = orderedPicked.map<EditSegment>((segment, index) => ({
        id: crypto.randomUUID(),
        sourceStart: segment.start,
        sourceEnd: segment.end,
        text: segment.text,
        topicId: modelCandidate.topicId,
        order: index,
        timingPrecision: segment.timingPrecision === "word" ? "word" : "estimated",
      }));
      const transcriptText = ordered.reduce(
        (text, segment) => joinSpokenText(text, segment.text),
        "",
      );
      const title = deriveCandidateTitle(modelCandidate.title, transcriptText);
      const hookText = deriveCandidateTitle(
        modelCandidate.hookText,
        transcriptText,
      );
      if (!isMatureTopic(title, transcriptText)) continue;
      if (!assessContentDensity(title, hookText, transcriptText).accepted) continue;
      if (usesAdmissionsReviewPreset(account.selectionPrinciples)) {
        const assessment = assessSelectionPrinciples(
          account,
          title,
          hookText,
          transcriptText,
        );
        // The deterministic local rubric is authoritative. A model-provided
        // principleScore is only an additional rejection signal when present.
        if (!assessment.accepted) continue;
        if (
          modelCandidate.principleScore !== undefined
          && modelCandidate.principleScore < 24
        ) continue;
      }
      const policyMatches = findPolicyMatches(account, [
        title,
        hookText,
        transcriptText,
        ...ordered.map((segment) => segment.text),
      ]);
      // Account bans are hard exclusions. They must not be left as a warning
      // because the blocked phrase could still appear in the burned captions.
      if (policyMatches.length) continue;
      const start = Math.min(...ordered.map((segment) => segment.sourceStart));
      const end = Math.max(...ordered.map((segment) => segment.sourceEnd));
      const now = new Date().toISOString();
      const riskFlags = modelCandidate.riskFlags.map((risk) => ({
        ...risk,
        contextBefore:
          risk.contextBefore ||
          transcriptWindow(transcript, start - 20, start, 0),
        contextAfter:
          risk.contextAfter || transcriptWindow(transcript, end, end + 20, 0),
        acknowledged: false,
      }));
      const renderPlan = {
        version: 1 as const,
        sourceVideoPath: task.sourceVideoPath!,
        segments: ordered,
        hookText,
        title,
        subtitleText: transcriptText,
        // Explicitly record a zero crop so this render plan is reproducible
        // even when the account still has an older crop setting saved.
        cropPreset: { topPercent: 0, rightPercent: 0, bottomPercent: 0, leftPercent: 0 },
        subtitleTemplate: account.subtitleTemplate,
        transitionSeconds: 0.14,
        templateVersion: "v1",
        effectPreset: {
          name: "light" as const,
          pushInPercent: 0,
          transitionSeconds: 0.14,
        },
        platformSafeAreas: account.platformSafeAreas,
      };
      candidates.push({
        id: crypto.randomUUID(),
        taskId: task.id,
        rank: candidates.length + 1,
        tier: candidates.length < MAX_FEATURED_CANDIDATES ? "featured" : "more",
        topicId: modelCandidate.topicId,
        title,
        hookText,
        transcriptText,
        duration,
        contextSegments: buildTopicContext(transcript, ordered, account),
        originalRenderPlan: JSON.parse(JSON.stringify(renderPlan)) as typeof renderPlan,
        renderPlan,
        riskFlags,
        decision: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
    return candidates;
  }
}
