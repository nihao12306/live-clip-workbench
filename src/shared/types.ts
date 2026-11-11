export type Platform = "douyin" | "wechat_channels" | "xiaohongshu";

export type TaskStatus =
  | "queued"
  | "paused"
  | "imported"
  | "validating"
  | "analyzing"
  | "generating_candidates"
  | "generating_previews"
  | "awaiting_review"
  | "rendering"
  | "exported"
  | "failed";

export type ReviewDecision = "pending" | "approved" | "rejected";

export type RejectionReason =
  | "not_debatable"
  | "incomplete"
  | "off_brand"
  | "duplicate"
  | "high_risk"
  | "rough_edit";

export type RiskLevel = "none" | "medium" | "high";

export interface CropPreset {
  topPercent: number;
  rightPercent: number;
  bottomPercent: number;
  leftPercent: number;
}

export interface SubtitleTemplate {
  fontFamily: string;
  fontSize: number;
  primaryColor: string;
  highlightColor: string;
  outlineColor: string;
  bottomMargin: number;
}

export interface SafeAreaPreset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SamplePerformance {
  path: string;
  platform?: Platform;
  views?: number;
  completionRate?: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

export type SampleLearningSource =
  | "sidecar_transcript"
  | "embedded_subtitle"
  | "local_whisper"
  | "manual"
  | "unavailable";

export interface SampleLearningItem {
  path: string;
  source: SampleLearningSource;
  status: "learned" | "skipped" | "failed";
  textLength: number;
  message?: string;
}

/**
 * A compact, explainable style/content profile derived from sample text.
 * It contains patterns rather than copied sample wording or sample facts.
 */
export interface SampleLearningProfile {
  version: 1;
  generatedAt: string;
  sampleCount: number;
  learnedSampleCount: number;
  summary: string;
  hookPatterns: string[];
  structurePatterns: string[];
  audienceSignals: string[];
  evidenceSignals: string[];
  toneSignals: string[];
  recommendationPatterns: string[];
  avoidPatterns: string[];
  performanceSignals: string[];
}

export interface SampleLearningState {
  learnedAt: string;
  model: string;
  transcriptChars: number;
  items: SampleLearningItem[];
  profile?: SampleLearningProfile;
}

export interface SampleLearningReport {
  accountId: string;
  state: SampleLearningState;
  transcript: string;
}

export interface AccountProfile {
  id: string;
  name: string;
  vertical: string;
  audience: string;
  persona: string;
  stance: string;
  forbiddenTopics: string[];
  sensitiveWords: string[];
  preferenceSummary: string;
  samplePaths: string[];
  sampleProfiles?: SamplePerformance[];
  /**
   * Optional text extracted or pasted from representative samples. DeepSeek
   * receives this as style/content reference only; it must never reuse the
   * sample's wording or segment ids in a new clip.
   */
  sampleTranscript?: string;
  /** Local sample-learning audit: what was read and by which local source. */
  sampleLearning?: SampleLearningState;
  /** Account-specific topic selection rules. */
  selectionPrinciples?: string;
  fillerWords?: string[];
  platformSafeAreas?: Partial<Record<Platform, SafeAreaPreset>>;
  subtitleTemplate: SubtitleTemplate;
  cropPreset: CropPreset;
  introPath?: string;
  outroPath?: string;
  logoPath?: string;
  musicPath?: string;
  coverTemplate: "bold" | "clean" | "academic";
  minClipSeconds: number;
  maxClipSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  confidence: "source" | "estimated";
  /** Granularity of the timestamp carried by this transcript cue. */
  timingPrecision?: "word" | "sentence" | "estimated";
}

/** A source word/token with an absolute media timestamp. */
export interface TranscriptWordTiming {
  start: number;
  end: number;
  text: string;
  probability?: number;
}

export interface EditSegment {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  text: string;
  topicId: string;
  order: number;
  /** Multiple pieces from one edited subtitle unit share this preview group. */
  subtitleGroupId?: string;
  /** Stable logical subtitle unit assigned during subtitle/audio sync. */
  subtitleUnitIndex?: number;
  /** Whether both audible cut edges came from word/token timestamps. */
  timingPrecision?: "word" | "estimated";
}

export interface TopicContextSegment {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  text: string;
  confidence: "source" | "estimated";
  timingPrecision?: "word" | "sentence" | "estimated";
  relation: "before" | "selected" | "after";
  included: boolean;
}

export interface RiskFlag {
  type:
    | "platform"
    | "misleading"
    | "context"
    | "fact"
    | "minor"
    | "education_claim";
  level: RiskLevel;
  reason: string;
  contextBefore: string;
  contextAfter: string;
  acknowledged: boolean;
}

export interface RenderPlan {
  version: 1;
  sourceVideoPath: string;
  segments: EditSegment[];
  hookText: string;
  title: string;
  subtitleText: string;
  cropPreset: CropPreset;
  subtitleTemplate: SubtitleTemplate;
  transitionSeconds: number;
  templateVersion: string;
  overlayPreset?: OverlayPreset;
  effectPreset?: EffectPreset;
  platformSafeAreas?: Partial<Record<Platform, SafeAreaPreset>>;
}

/** A persisted snapshot of the editable parts of a candidate. */
export interface CandidateEditVersion {
  version: number;
  savedAt: string;
  label: string;
  title: string;
  hookText: string;
  transcriptText: string;
  duration: number;
  contextSegments?: TopicContextSegment[];
  renderPlan: RenderPlan;
}

export interface EffectPreset {
  name: "light";
  pushInPercent: number;
  transitionSeconds: number;
}

export interface OverlayPreset {
  topPercent: number;
  heightPercent: number;
  color: string;
  confidence: number;
}

export interface Candidate {
  id: string;
  taskId: string;
  rank: number;
  tier: "featured" | "more";
  topicId: string;
  title: string;
  hookText: string;
  transcriptText: string;
  duration: number;
  previewPath?: string;
  /** Fingerprint of the render plan used to create previewPath. */
  previewPlanFingerprint?: string;
  /** Last preview error for the current render plan, if any. */
  previewError?: string;
  /** Original transcript cues around the selected topic for human comparison and extension. */
  contextSegments?: TopicContextSegment[];
  /** Cached absolute word timings used for safe in-sentence subtitle edits. */
  wordTimings?: TranscriptWordTiming[];
  /** Saved edit snapshots used by the review page's undo/history controls. */
  editHistory?: CandidateEditVersion[];
  originalRenderPlan?: RenderPlan;
  renderPlan: RenderPlan;
  riskFlags: RiskFlag[];
  decision: ReviewDecision;
  rejectionReason?: RejectionReason;
  rejectionNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClipTask {
  id: string;
  accountId: string;
  name: string;
  sourceType: "link" | "file";
  sourceUrl?: string;
  sourceVideoPath?: string;
  transcriptPath?: string;
  transcriptConfidence?: "source" | "estimated";
  status: TaskStatus;
  progress: number;
  statusMessage: string;
  duration?: number;
  overlayPreset?: OverlayPreset;
  checkpoint?: TaskCheckpoint;
  exportCheckpoint?: {
    candidateId: string;
    outputDirectory: string;
    completedPlatforms: Platform[];
  };
  error?: string;
  workDir: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskCheckpointStage =
  | "none"
  | "validated"
  | "analyzed"
  | "candidates"
  | "previews";

export interface TaskCheckpoint {
  stage: TaskCheckpointStage;
  normalizedTranscriptPath?: string;
  modelCandidates?: ModelCandidate[];
  modelCall?: ModelCallInfo;
  candidateIds?: string[];
  previewIds?: string[];
  updatedAt: string;
}

export interface PlatformPackage {
  platform: Platform;
  videoPath: string;
  coverPath: string;
  title: string;
  body: string;
  hashtags: string[];
  pinnedComment: string;
  metadataPath: string;
}

export interface FeedbackRecord {
  id: string;
  accountId: string;
  taskId: string;
  candidateId: string;
  decision: Exclude<ReviewDecision, "pending">;
  rejectionReason?: RejectionReason;
  note?: string;
  originalPlan: RenderPlan;
  finalPlan: RenderPlan;
  createdAt: string;
}

export interface PerformanceRecord {
  id: string;
  accountId: string;
  candidateId: string;
  platform: Platform;
  publishedAt: string;
  publicationUrl: string;
  window: "published" | "day3" | "day7";
  views: number;
  completionRate: number;
  likes: number;
  comments: number;
  shares: number;
  relativeScore?: number;
  createdAt: string;
}

/** A concrete T+3/T+7 performance window that still needs local data entry. */
export interface PerformanceReminder {
  id: string;
  accountId: string;
  taskId: string;
  candidateId: string;
  candidateTitle: string;
  taskName: string;
  accountName: string;
  platform: Platform;
  publishedAt: string;
  publicationUrl: string;
  window: "day3" | "day7";
  dueAt: string;
}

export const BLIND_TEST_TOTAL_SESSIONS = 20;
export const BLIND_TEST_LIGHT_EDIT_TARGET = 0.7;
export const BLIND_TEST_MANUAL_MINUTES_TARGET = 12;

export type BlindTestPublishability =
  | "not_assessed"
  | "light_edit_publishable"
  | "major_edit_required"
  | "not_publishable";

export type BlindTestIssueType =
  | "none"
  | "candidate_quality"
  | "transcript"
  | "timing"
  | "subtitle"
  | "render"
  | "model"
  | "workflow"
  | "other";

export type BlindTestGateStatus = "pending" | "passed" | "failed";

export interface BlindTestCandidateRef {
  id?: string;
  taskId?: string;
  title: string;
  rank?: number;
}

export interface BlindTestSession {
  id: string;
  sessionNumber: number;
  taskId?: string;
  taskName?: string;
  candidates: BlindTestCandidateRef[];
  /** A manually entered candidate title/summary when no persisted candidate is available. */
  candidateNote?: string;
  /** Active human editing/review time, in minutes. */
  manualMinutes?: number;
  /** Local processing time, in minutes. */
  processingMinutes?: number;
  publishability: BlindTestPublishability;
  issueType: BlindTestIssueType;
  notes: string;
  testedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type SaveBlindTestSessionInput = Omit<
  BlindTestSession,
  "id" | "createdAt" | "updatedAt"
> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
};

export interface BlindTestMetrics {
  totalSessions: number;
  completedSessions: number;
  remainingSessions: number;
  sessionsWithCandidates: number;
  publishabilityEvaluated: number;
  lightEditPublishable: number;
  lightEditPublishRate?: number;
  lightEditTarget: number;
  lightEditTargetStatus: BlindTestGateStatus;
  manualDurationCount: number;
  averageManualMinutes?: number;
  manualMinutesTarget: number;
  manualMinutesTargetStatus: BlindTestGateStatus;
  processingDurationCount: number;
  averageProcessingMinutes?: number;
  issueCounts: Record<BlindTestIssueType, number>;
  overallStatus: BlindTestGateStatus;
}

export interface BlindTestSnapshot {
  sessions: BlindTestSession[];
  metrics: BlindTestMetrics;
}

export interface AppSettings {
  workspacePath: string;
  feishuSyncPath: string;
  feishuAppId: string;
  feishuUpdateFolderToken: string;
  ffmpegPath: string;
  ffprobePath: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  retentionDays: number;
  hasApiKey: boolean;
  updateManifestPath?: string;
}

export interface UpdateInfo {
  currentVersion: string;
  platform: "win32" | "darwin";
  available: boolean;
  source?: "local" | "feishu" | "github";
  version?: string;
  installerPath?: string;
  githubAssetId?: number;
  feishuFileToken?: string;
  installerFileName?: string;
  installerSize?: number;
  installerSha256?: string;
  feishuFileChunks?: UpdateFileChunk[];
  notes?: string;
  message: string;
}

export interface UpdateFileChunk {
  fileName: string;
  token: string;
  size: number;
  sha256?: string;
}

export interface UpdatePublishResult {
  version: string;
  source: "local" | "feishu";
  manifestPath?: string;
  targetDirectory?: string;
  files: string[];
  warnings: string[];
}

export interface UpdateInstallRequest {
  installerPath?: string;
  githubAssetId?: number;
  feishuFileToken?: string;
  installerFileName?: string;
  installerSize?: number;
  installerSha256?: string;
  feishuFileChunks?: UpdateFileChunk[];
}

export interface FeishuConnectionInfo {
  connected: boolean;
  appIdConfigured: boolean;
  updateFolderConfigured: boolean;
  message: string;
}

export interface FeishuFolderSetupResult {
  folderToken: string;
  folderName: string;
  folderUrl?: string;
}

export interface CreateTaskInput {
  accountId: string;
  name: string;
  sourceUrl?: string;
  videoPath?: string;
  transcriptPath?: string;
}

export interface AnalyzeCandidateInput {
  account: AccountProfile;
  task: ClipTask;
  transcript: TranscriptSegment[];
}

export interface ModelCandidate {
  topicId: string;
  title: string;
  hookText: string;
  segmentIds: string[];
  openingSegmentId?: string;
  riskFlags: Omit<RiskFlag, "acknowledged">[];
  internalScore: number;
  principleScore?: number;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ModelCallInfo {
  provider: "deepseek";
  operation: "health" | "analysis" | "copy";
  status: "success" | "error";
  model: string;
  baseUrl: string;
  requestId?: string;
  callCount?: number;
  usage?: ModelUsage;
  latencyMs?: number;
  error?: string;
  createdAt: string;
}

export interface ModelHealth {
  ok: boolean;
  model: string;
  baseUrl: string;
  latencyMs: number;
  message: string;
  usage?: ModelUsage;
  requestId?: string;
}

export interface ModelConnectionInput {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface SourceInspection {
  provider: "feishu" | "tingwu" | "qianwen" | "unknown";
  supported: boolean;
  requiresFallback: boolean;
  videoUrl?: string;
  transcriptUrl?: string;
  message: string;
}

export interface BatchTaskRow {
  accountName: string;
  taskName: string;
  sourceUrl?: string;
  videoPath?: string;
  transcriptPath?: string;
}

export interface DashboardSnapshot {
  accounts: AccountProfile[];
  tasks: ClipTask[];
  pendingCandidates: number;
  approvedCandidates: number;
  remindersDue: number;
  dueReminders: PerformanceReminder[];
  sourceStats?: SourceStats[];
}

export interface SourceStats {
  provider: SourceInspection["provider"];
  attempts: number;
  successes: number;
  lastError?: string;
  updatedAt: string;
}

export interface BatchExportResult {
  candidateIds: string[];
  zipPath: string;
  outputDirectories: string[];
}

export interface ExportResult {
  candidateId: string;
  outputDirectory: string;
  zipPath: string;
  packages: PlatformPackage[];
}

export type TextFeishuExport = { documentId: string; url?: string; cutNumber?: number; importDate?: string; formatVersion?: number };

export interface WorkbenchApi {
  listTextJobs(): Promise<import('./text-selection').TextJob[]>;
  rateTextTopic(jobId: string, clipId: string, verdict: import('./text-selection').TextTopicVerdict, reason: string): Promise<import('./text-selection').TextClip>;
  clearTextTopicFeedback(jobId: string, clipId: string): Promise<import('./text-selection').TextClip>;
  confirmTextFinal(jobId: string, clipId: string, note: string, expectedEdit: import('./text-selection').TextEdit): Promise<import('./text-selection').TextClip>;
  withdrawTextFinal(jobId: string, clipId: string): Promise<import('./text-selection').TextClip>;
  getTextLearningSummary(): Promise<import('./text-selection').TextLearningSummary>;
  getTextExportDestinations(): Promise<Record<string, string>>;
  startTextJobs(inputs: import('./text-selection').TextJobInput[]): Promise<import('./text-selection').TextJob[]>;
  retryTextJob(jobId: string): Promise<import('./text-selection').TextJob>;
  dismissTextJob(jobId: string): Promise<void>;
  renameTextJob(jobId: string, name: string, teacher?: string): Promise<import('./text-selection').TextJob>;
  readTextTranscript(jobId: string): Promise<import('./text-selection').TextUnit[]>;
  supplementTextJob(jobId: string, startMs: number, endMs: number): Promise<import('./text-selection').TextClip>;
  importTextSubtitle(jobId: string): Promise<import('./text-selection').TextJob | null>;
  saveTextClip(jobId: string, clipId: string, edit: import('./text-selection').TextEdit): Promise<import('./text-selection').TextClip>;
  reviewTextClip(jobId: string, clipId: string): Promise<import('./text-selection').TextClip>;
  syncTextClip(jobId: string, clipId: string): Promise<void>;
  exportTextClip(jobId: string, clipId: string, folder: string, teacher: string): Promise<TextFeishuExport>;
  connectFeishuDocument(): Promise<FeishuConnectionInfo>;
  openFeishuDocument(url: string): Promise<void>;
  openTextSource(jobId: string): Promise<void>;
  getSnapshot(): Promise<DashboardSnapshot>;
  listAccounts(): Promise<AccountProfile[]>;
  saveAccount(
    input: Partial<AccountProfile> & Pick<AccountProfile, "name">,
  ): Promise<AccountProfile>;
  learnAccountSamples(accountId: string, samplePaths?: string[]): Promise<SampleLearningReport>;
  deleteAccount(id: string): Promise<void>;
  selectFiles(options: {
    type: "video" | "transcript" | "media" | "binary" | "csv" | "directory";
    multiple?: boolean;
  }): Promise<string[]>;
  createTask(input: CreateTaskInput): Promise<ClipTask>;
  attachTaskFiles(input: {
    taskId: string;
    videoPath?: string;
    transcriptPath?: string;
  }): Promise<ClipTask>;
  importBatch(csvPath: string): Promise<ClipTask[]>;
  inspectSource(url: string): Promise<SourceInspection>;
  openSourceLogin(url: string): Promise<void>;
  runTask(taskId: string): Promise<void>;
  pauseTask(taskId: string): Promise<void>;
  rebuildCandidates(taskId: string): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  listCandidates(taskId: string): Promise<Candidate[]>;
  generateCandidatePreview(candidateId: string): Promise<Candidate>;
  deleteCandidate(candidateId: string): Promise<void>;
  saveCandidate(candidate: Candidate): Promise<Candidate>;
  ensureCandidateWordTimings(candidate: Candidate): Promise<Candidate>;
  saveCandidateAndPreview(candidate: Candidate): Promise<Candidate>;
  reviewCandidate(input: {
    candidateId: string;
    decision: Exclude<ReviewDecision, "pending">;
    reason?: RejectionReason;
    note?: string;
  }): Promise<Candidate>;
  acknowledgeRisk(input: {
    candidateId: string;
    index: number;
  }): Promise<Candidate>;
  exportCandidate(candidateId: string): Promise<ExportResult>;
  exportCandidates(candidateIds: string[]): Promise<BatchExportResult>;
  getSettings(): Promise<AppSettings>;
  saveSettings(
    input: Partial<AppSettings> & { apiKey?: string; feishuAppSecret?: string },
  ): Promise<AppSettings>;
  testModelConnection(input?: ModelConnectionInput): Promise<ModelHealth>;
  openPath(path: string): Promise<void>;
  savePerformance(
    input: Omit<PerformanceRecord, "id" | "createdAt" | "relativeScore">,
  ): Promise<PerformanceRecord>;
  listPerformance(candidateId?: string): Promise<PerformanceRecord[]>;
  getBlindTestSnapshot(): Promise<BlindTestSnapshot>;
  saveBlindTestSession(input: SaveBlindTestSessionInput): Promise<BlindTestSession>;
  backupNow(): Promise<string>;
  getFeishuStatus(): Promise<FeishuConnectionInfo>;
  connectFeishu(): Promise<FeishuConnectionInfo>;
  disconnectFeishu(): Promise<FeishuConnectionInfo>;
  testFeishuUpdateFolder(): Promise<FeishuFolderSetupResult>;
  checkForUpdate(): Promise<UpdateInfo>;
  installUpdate(request: UpdateInstallRequest): Promise<void>;
  publishUpdate(notes?: string): Promise<UpdatePublishResult>;
}
