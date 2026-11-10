import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type {
  AccountProfile,
  AppSettings,
  Candidate,
  CandidateEditVersion,
  ClipTask,
  DashboardSnapshot,
  BlindTestSession,
  SaveBlindTestSessionInput,
  FeedbackRecord,
  PerformanceRecord,
  PerformanceReminder,
  SourceInspection,
  SourceStats,
} from "../shared/types";
import {
  DEFAULT_CROP_PRESET,
  DEFAULT_PLATFORM_SAFE_AREAS,
  DEFAULT_SUBTITLE_TEMPLATE,
} from "../shared/constants";
import { safeJsonParse } from "../shared/utils";
import { candidatePolicyTexts, findPolicyMatches } from "./content-policy";
import { assessSelectionPrinciples } from "./selection-principles";
import { assessContentDensity } from "./content-density";
import { buildSampleLearningProfileFromTranscript } from "./sample-learning";
import {
  BLIND_TEST_ISSUE_LABELS,
  BLIND_TEST_PUBLISHABILITY_LABELS,
  buildBlindTestSnapshot,
} from "../shared/blind-test";

interface RowResult {
  json: string;
}

const MAX_EDIT_HISTORY = 30;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function editableCandidateState(candidate: Pick<
  Candidate,
  "title" | "hookText" | "transcriptText" | "duration" | "contextSegments" | "renderPlan"
>) {
  return {
    title: candidate.title,
    hookText: candidate.hookText,
    transcriptText: candidate.transcriptText,
    duration: candidate.duration,
    contextSegments: cloneJson(candidate.contextSegments ?? []),
    renderPlan: cloneJson(candidate.renderPlan),
  };
}

function editVersionMatchesCandidate(
  version: CandidateEditVersion,
  candidate: Candidate,
): boolean {
  return JSON.stringify(editableCandidateState(version))
    === JSON.stringify(editableCandidateState(candidate));
}

function createEditVersion(
  candidate: Candidate,
  version: number,
  label: string,
): CandidateEditVersion {
  const state = editableCandidateState(candidate);
  return {
    version,
    savedAt: new Date().toISOString(),
    label,
    ...state,
    contextSegments: state.contextSegments,
    renderPlan: state.renderPlan,
  };
}

export class DatabaseService {
  private db?: Database;
  private SQL?: SqlJsStatic;

  constructor(private readonly databasePath: string) {}

  async initialize(): Promise<void> {
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.SQL = await initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve("sql.js/dist/sql-wasm.js")), file)
    });
    this.db = fs.existsSync(this.databasePath)
      ? new this.SQL.Database(fs.readFileSync(this.databasePath))
      : new this.SQL.Database();
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        rank INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_task ON candidates(task_id, rank);
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_account ON feedback(account_id, created_at);
      CREATE TABLE IF NOT EXISTS performance (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_performance_baseline ON performance(account_id, platform, created_at);
      CREATE TABLE IF NOT EXISTS blind_test_sessions (
        session_number INTEGER PRIMARY KEY,
        id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.migrateSampleLearningProfiles();
    this.persist();
  }

  /** Backfill the structured profile for accounts learned by older builds. */
  private migrateSampleLearningProfiles(): void {
    for (const account of this.listAccounts()) {
      if (
        !account.sampleLearning
        || account.sampleLearning.profile
        || !account.sampleTranscript?.trim()
      ) {
        continue;
      }
      const learnedSampleCount = account.sampleLearning.items.filter(
        (item) => item.status === "learned",
      ).length;
      this.saveAccount({
        ...account,
        sampleLearning: {
          ...account.sampleLearning,
          profile: buildSampleLearningProfileFromTranscript(
            account.sampleTranscript,
            account.sampleProfiles,
            learnedSampleCount || account.samplePaths.length,
            account.fillerWords,
          ),
        },
      });
    }
  }

  close(): void {
    this.persist();
    this.db?.close();
  }

  private get database(): Database {
    if (!this.db) throw new Error("Database has not been initialized");
    return this.db;
  }

  private persist(): void {
    if (!this.db) return;
    const data = this.db.export();
    const tempPath = `${this.databasePath}.tmp`;
    fs.writeFileSync(tempPath, Buffer.from(data));
    fs.renameSync(tempPath, this.databasePath);
  }

  private queryJson<T>(sql: string, params: unknown[] = []): T[] {
    const statement = this.database.prepare(sql);
    statement.bind(params as never[]);
    const items: T[] = [];
    while (statement.step()) {
      const row = statement.getAsObject() as unknown as RowResult;
      items.push(safeJsonParse<T>(row.json, {} as T));
    }
    statement.free();
    return items;
  }

  listAccounts(): AccountProfile[] {
    return this.queryJson<AccountProfile>("SELECT json FROM accounts ORDER BY updated_at DESC");
  }

  getAccount(id: string): AccountProfile | undefined {
    return this.queryJson<AccountProfile>("SELECT json FROM accounts WHERE id = ?", [id])[0];
  }

  saveAccount(input: Partial<AccountProfile> & Pick<AccountProfile, "name">): AccountProfile {
    const now = new Date().toISOString();
    const existing = input.id ? this.getAccount(input.id) : undefined;
    const sampleProfiles = input.sampleProfiles ?? existing?.sampleProfiles ?? [];
    const sampleSignals = sampleProfiles
      .filter((item) => item.views || item.completionRate)
      .map((item) => `${path.basename(item.path)}${item.views ? ` 播放${item.views}` : ""}${item.completionRate ? ` 完播${Math.round(item.completionRate * 100)}%` : ""}`)
      .slice(0, 10)
      .join("；");
    const suppliedPreference = input.preferenceSummary ?? existing?.preferenceSummary ?? "";
    const account: AccountProfile = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name.trim(),
      vertical: input.vertical ?? existing?.vertical ?? "教育",
      audience: input.audience ?? existing?.audience ?? "",
      persona: input.persona ?? existing?.persona ?? "",
      stance: input.stance ?? existing?.stance ?? "",
      forbiddenTopics: input.forbiddenTopics ?? existing?.forbiddenTopics ?? [],
      sensitiveWords: input.sensitiveWords ?? existing?.sensitiveWords ?? [],
      preferenceSummary: suppliedPreference || (sampleSignals ? `历史样片表现：${sampleSignals}` : ""),
      samplePaths: input.samplePaths ?? existing?.samplePaths ?? [],
      sampleProfiles,
      sampleTranscript: input.sampleTranscript ?? existing?.sampleTranscript ?? "",
      sampleLearning: input.sampleLearning ?? existing?.sampleLearning,
      selectionPrinciples: input.selectionPrinciples ?? existing?.selectionPrinciples ?? "",
      fillerWords: input.fillerWords ?? existing?.fillerWords ?? [],
      platformSafeAreas: input.platformSafeAreas ?? existing?.platformSafeAreas ?? DEFAULT_PLATFORM_SAFE_AREAS,
      subtitleTemplate: input.subtitleTemplate ?? existing?.subtitleTemplate ?? DEFAULT_SUBTITLE_TEMPLATE,
      cropPreset: input.cropPreset ?? existing?.cropPreset ?? DEFAULT_CROP_PRESET,
      introPath: input.introPath ?? existing?.introPath,
      outroPath: input.outroPath ?? existing?.outroPath,
      logoPath: input.logoPath ?? existing?.logoPath,
      musicPath: input.musicPath ?? existing?.musicPath,
      coverTemplate: input.coverTemplate ?? existing?.coverTemplate ?? "bold",
      minClipSeconds: input.minClipSeconds ?? existing?.minClipSeconds ?? 30,
      maxClipSeconds: input.maxClipSeconds ?? existing?.maxClipSeconds ?? 180,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.database.run(
      "INSERT OR REPLACE INTO accounts(id, name, updated_at, json) VALUES(?, ?, ?, ?)",
      [account.id, account.name, now, JSON.stringify(account)]
    );
    this.persist();
    return account;
  }

  saveSampleLearning(
    accountId: string,
    transcript: string,
    sampleLearning: AccountProfile["sampleLearning"],
  ): AccountProfile {
    const existing = this.getAccount(accountId);
    if (!existing) throw new Error("老师账号不存在");
    return this.saveAccount({
      ...existing,
      sampleTranscript: transcript,
      sampleLearning,
    });
  }

  deleteAccount(id: string): void {
    const taskCount = this.database.exec(`SELECT COUNT(*) AS count FROM tasks WHERE account_id = '${id.replaceAll("'", "''")}'`);
    const count = Number(taskCount[0]?.values[0]?.[0] ?? 0);
    if (count > 0) throw new Error("该账号已有任务，不能直接删除");
    this.database.run("DELETE FROM accounts WHERE id = ?", [id]);
    this.persist();
  }

  listTasks(): ClipTask[] {
    return this.queryJson<ClipTask>("SELECT json FROM tasks ORDER BY updated_at DESC");
  }

  getTask(id: string): ClipTask | undefined {
    return this.queryJson<ClipTask>("SELECT json FROM tasks WHERE id = ?", [id])[0];
  }

  saveTask(task: ClipTask): ClipTask {
    task.updatedAt = new Date().toISOString();
    this.database.run(
      "INSERT OR REPLACE INTO tasks(id, account_id, status, updated_at, json) VALUES(?, ?, ?, ?, ?)",
      [task.id, task.accountId, task.status, task.updatedAt, JSON.stringify(task)]
    );
    this.persist();
    return task;
  }

  listCandidates(taskId: string): Candidate[] {
    return this.queryJson<Candidate>("SELECT json FROM candidates WHERE task_id = ? ORDER BY rank ASC", [taskId]);
  }

  getCandidate(id: string): Candidate | undefined {
    return this.queryJson<Candidate>("SELECT json FROM candidates WHERE id = ?", [id])[0];
  }

  saveCandidate(candidate: Candidate): Candidate {
    const existing = this.getCandidate(candidate.id);
    if (existing) {
      if (!candidate.originalRenderPlan) candidate.originalRenderPlan = existing.originalRenderPlan ?? existing.renderPlan;
      const renderPlanChanged = JSON.stringify(existing.renderPlan) !== JSON.stringify(candidate.renderPlan);
      if (renderPlanChanged) {
        candidate.previewPath = undefined;
        candidate.previewPlanFingerprint = undefined;
        candidate.previewError = undefined;
      }
    } else if (!candidate.originalRenderPlan) {
      candidate.originalRenderPlan = JSON.parse(JSON.stringify(candidate.renderPlan)) as Candidate["renderPlan"];
    }
    const history = [...(existing?.editHistory ?? candidate.editHistory ?? [])];
    if (existing && !history.length) {
      history.push(createEditVersion(existing, 1, "初始版本"));
    }
    if (!history.length || !editVersionMatchesCandidate(history.at(-1)!, candidate)) {
      history.push(
        createEditVersion(
          candidate,
          history.length + 1,
          `版本 ${history.length + 1}`,
        ),
      );
    }
    candidate.editHistory = history.slice(-MAX_EDIT_HISTORY);
    candidate.updatedAt = new Date().toISOString();
    this.database.run(
      "INSERT OR REPLACE INTO candidates(id, task_id, decision, rank, updated_at, json) VALUES(?, ?, ?, ?, ?, ?)",
      [candidate.id, candidate.taskId, candidate.decision, candidate.rank, candidate.updatedAt, JSON.stringify(candidate)]
    );
    this.persist();
    return candidate;
  }

  replaceTaskCandidates(taskId: string, candidates: Candidate[]): void {
    this.database.run("DELETE FROM candidates WHERE task_id = ?", [taskId]);
    for (const candidate of candidates) this.saveCandidate(candidate);
    this.persist();
  }

  /**
   * Remove a rejected candidate and its feedback/performance rows. Approved
   * candidates are guarded by the IPC layer so an accidental click cannot
   * remove a publishable result.
   */
  deleteCandidate(id: string): Candidate | undefined {
    const candidate = this.getCandidate(id);
    if (!candidate) return undefined;
    const task = this.getTask(candidate.taskId);
    this.database.run("DELETE FROM candidates WHERE id = ?", [id]);
    this.database.run("DELETE FROM feedback WHERE candidate_id = ?", [id]);
    this.database.run("DELETE FROM performance WHERE candidate_id = ?", [id]);
    if (task?.checkpoint) {
      task.checkpoint.candidateIds = task.checkpoint.candidateIds?.filter(
        (candidateId) => candidateId !== id,
      );
      task.checkpoint.previewIds = task.checkpoint.previewIds?.filter(
        (candidateId) => candidateId !== id,
      );
      task.checkpoint.updatedAt = new Date().toISOString();
      this.saveTask(task);
    }
    this.persist();
    return candidate;
  }

  /** Remove a task record and all relational rows, leaving filesystem cleanup
   * to the main process where the workspace safety check is available. */
  deleteTask(id: string): ClipTask | undefined {
    const task = this.getTask(id);
    if (!task) return undefined;
    const candidates = this.listCandidates(id);
    for (const candidate of candidates) {
      this.database.run("DELETE FROM feedback WHERE candidate_id = ?", [candidate.id]);
      this.database.run("DELETE FROM performance WHERE candidate_id = ?", [candidate.id]);
    }
    this.database.run("DELETE FROM candidates WHERE task_id = ?", [id]);
    this.database.run("DELETE FROM tasks WHERE id = ?", [id]);
    this.persist();
    return task;
  }

  saveFeedback(feedback: FeedbackRecord): FeedbackRecord {
    this.database.run(
      "INSERT OR REPLACE INTO feedback(id, account_id, candidate_id, created_at, json) VALUES(?, ?, ?, ?, ?)",
      [feedback.id, feedback.accountId, feedback.candidateId, feedback.createdAt, JSON.stringify(feedback)]
    );
    this.persist();
    return feedback;
  }

  recordSourceStat(
    provider: SourceInspection["provider"],
    success: boolean,
    error?: string,
  ): SourceStats {
    const stats = this.getSetting<SourceStats[]>("source-stats", []);
    const existing = stats.find((item) => item.provider === provider);
    const next: SourceStats = {
      provider,
      attempts: (existing?.attempts ?? 0) + 1,
      successes: (existing?.successes ?? 0) + (success ? 1 : 0),
      lastError: success ? existing?.lastError : error,
      updatedAt: new Date().toISOString(),
    };
    const rest = stats.filter((item) => item.provider !== provider);
    this.setSetting("source-stats", [...rest, next]);
    return next;
  }

  listSourceStats(): SourceStats[] {
    return this.getSetting<SourceStats[]>("source-stats", []);
  }

  listRecentFeedback(accountId: string, limit = 30): FeedbackRecord[] {
    return this.queryJson<FeedbackRecord>(
      `SELECT json FROM feedback WHERE account_id = ? ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`,
      [accountId]
    );
  }

  savePerformance(input: Omit<PerformanceRecord, "relativeScore">): PerformanceRecord {
    const previousByCandidate = new Map<string, PerformanceRecord>();
    for (const item of this.queryJson<PerformanceRecord>(
      "SELECT json FROM performance WHERE account_id = ? AND platform = ? ORDER BY created_at DESC",
      [input.accountId, input.platform],
    ).filter((item) => item.window !== "published")) {
      if (!previousByCandidate.has(item.candidateId))
        previousByCandidate.set(item.candidateId, item);
    }
    const previous = [...previousByCandidate.values()]
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
      .slice(0, 20);
    const engagement = input.views > 0 ? (input.likes + input.comments * 2 + input.shares * 3) / input.views : 0;
    const scores = previous.map((item) =>
      item.views > 0 ? (item.likes + item.comments * 2 + item.shares * 3) / item.views + item.completionRate : 0
    );
    const baseline = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
    const record: PerformanceRecord = {
      ...input,
      relativeScore: baseline > 0 ? (engagement + input.completionRate) / baseline : undefined
    };
    this.database.run(
      "INSERT OR REPLACE INTO performance(id, account_id, candidate_id, platform, created_at, json) VALUES(?, ?, ?, ?, ?, ?)",
      [record.id, record.accountId, record.candidateId, record.platform, record.createdAt, JSON.stringify(record)]
    );
    this.persist();
    return record;
  }

  listPerformance(candidateId?: string): PerformanceRecord[] {
    return candidateId
      ? this.queryJson<PerformanceRecord>("SELECT json FROM performance WHERE candidate_id = ? ORDER BY created_at DESC", [candidateId])
      : this.queryJson<PerformanceRecord>("SELECT json FROM performance ORDER BY created_at DESC");
  }

  listBlindTestSessions(): BlindTestSession[] {
    return this.queryJson<BlindTestSession>(
      "SELECT json FROM blind_test_sessions ORDER BY session_number ASC",
    );
  }

  saveBlindTestSession(input: SaveBlindTestSessionInput): BlindTestSession {
    const sessionNumber = Math.trunc(Number(input.sessionNumber));
    if (sessionNumber < 1 || sessionNumber > 20) {
      throw new Error("盲测场次必须在 1 到 20 之间");
    }
    if (!(input.publishability in BLIND_TEST_PUBLISHABILITY_LABELS)) {
      throw new Error("盲测发布可用性选项无效");
    }
    if (!(input.issueType in BLIND_TEST_ISSUE_LABELS)) {
      throw new Error("盲测问题类型无效");
    }
    const existing = this.listBlindTestSessions().find(
      (session) => session.sessionNumber === sessionNumber,
    );
    const normalizeMinutes = (value: number | undefined): number | undefined => {
      if (value === undefined || value === null) return undefined;
      const next = Number(value);
      if (!Number.isFinite(next) || next < 0) {
        throw new Error("盲测时长必须是大于等于 0 的数字");
      }
      return Math.round(next * 100) / 100;
    };
    const now = new Date().toISOString();
    const session: BlindTestSession = {
      id: input.id?.trim() || existing?.id || crypto.randomUUID(),
      sessionNumber,
      taskId: input.taskId?.trim() || undefined,
      taskName: input.taskName?.trim() || undefined,
      candidates: (input.candidates ?? [])
        .map((candidate) => ({
          id: candidate.id?.trim() || undefined,
          taskId: candidate.taskId?.trim() || undefined,
          title: candidate.title.trim(),
          rank: candidate.rank,
        }))
        .filter((candidate) => candidate.title),
      candidateNote: input.candidateNote?.trim() || undefined,
      manualMinutes: normalizeMinutes(input.manualMinutes),
      processingMinutes: normalizeMinutes(input.processingMinutes),
      publishability: input.publishability,
      issueType: input.issueType,
      notes: input.notes?.trim() ?? "",
      testedAt: input.testedAt || existing?.testedAt || now,
      createdAt: existing?.createdAt || input.createdAt || now,
      updatedAt: now,
    };
    this.database.run(
      "INSERT OR REPLACE INTO blind_test_sessions(session_number, id, updated_at, json) VALUES(?, ?, ?, ?)",
      [session.sessionNumber, session.id, session.updatedAt, JSON.stringify(session)],
    );
    this.persist();
    return session;
  }

  blindTestSnapshot() {
    return buildBlindTestSnapshot(this.listBlindTestSessions());
  }

  getSetting<T>(key: string, fallback: T): T {
    const statement = this.database.prepare("SELECT value FROM settings WHERE key = ?");
    statement.bind([key]);
    const value = statement.step() ? String(statement.getAsObject().value ?? "") : "";
    statement.free();
    return value ? safeJsonParse<T>(value, fallback) : fallback;
  }

  setSetting<T>(key: string, value: T): void {
    this.database.run("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", [key, JSON.stringify(value)]);
    this.persist();
  }

  private buildPerformanceReminders(
    accounts: AccountProfile[],
    tasks: ClipTask[],
    performance: PerformanceRecord[],
  ): PerformanceReminder[] {
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const candidateRefs = new Map<string, { candidate: Candidate; task: ClipTask }>();
    for (const task of tasks) {
      for (const candidate of this.listCandidates(task.id)) {
        candidateRefs.set(candidate.id, { candidate, task });
      }
    }

    const publications = [
      ...new Map(
        performance
          .filter((item) => item.window === "published")
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map((item) => [`${item.candidateId}:${item.platform}`, item] as const),
      ).values(),
    ];
    const windows: Array<{ window: PerformanceReminder["window"]; days: number }> = [
      { window: "day3", days: 3 },
      { window: "day7", days: 7 },
    ];
    const now = Date.now();
    const reminders: PerformanceReminder[] = [];

    for (const publication of publications) {
      const publishedAtMs = new Date(publication.publishedAt).getTime();
      if (!Number.isFinite(publishedAtMs)) continue;
      const matching = performance.filter(
        (item) =>
          item.candidateId === publication.candidateId &&
          item.platform === publication.platform,
      );
      const reference = candidateRefs.get(publication.candidateId);
      const account = accountById.get(publication.accountId);
      const task = reference?.task;
      for (const target of windows) {
        const dueAtMs = publishedAtMs + target.days * 86_400_000;
        if (now < dueAtMs || matching.some((item) => item.window === target.window)) {
          continue;
        }
        reminders.push({
          id: `${publication.id}:${target.window}`,
          accountId: publication.accountId,
          taskId: task?.id ?? "",
          candidateId: publication.candidateId,
          candidateTitle: reference?.candidate.title || "未命名切片",
          taskName: task?.name || "任务已删除",
          accountName: account?.name || "账号已删除",
          platform: publication.platform,
          publishedAt: publication.publishedAt,
          publicationUrl: publication.publicationUrl,
          window: target.window,
          dueAt: new Date(dueAtMs).toISOString(),
        });
      }
    }

    return reminders.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  }

  snapshot(): DashboardSnapshot {
    const accounts = this.listAccounts();
    const tasks = this.listTasks();
    const allCandidates = tasks.flatMap((task) => {
      const account = accounts.find((item) => item.id === task.accountId);
      return this.listCandidates(task.id).filter(
        (candidate) =>
          !account ||
          (
            findPolicyMatches(account, candidatePolicyTexts(candidate)).length === 0
            && assessSelectionPrinciples(
              account,
              candidate.title,
              candidate.hookText,
              candidate.transcriptText,
            ).accepted
            && assessContentDensity(
              candidate.title,
              candidate.hookText,
              candidate.transcriptText,
            ).accepted
          ),
      );
    });
    const performance = this.listPerformance();
    const dueReminders = this.buildPerformanceReminders(accounts, tasks, performance);
    return {
      accounts,
      tasks,
      pendingCandidates: allCandidates.filter((candidate) => candidate.decision === "pending").length,
      approvedCandidates: allCandidates.filter((candidate) => candidate.decision === "approved").length,
      remindersDue: dueReminders.length,
      dueReminders,
      sourceStats: this.listSourceStats(),
    };
  }

  dueReminders(): PerformanceRecord[] {
    const all = this.listPerformance();
    const now = Date.now();
    const publications = [
      ...new Map(
        all
          .filter((item) => item.window === "published")
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map((item) => [`${item.candidateId}:${item.platform}`, item]),
      ).values(),
    ];
    return publications.filter((item) => {
      const ageDays = (now - new Date(item.publishedAt).getTime()) / 86_400_000;
      const matching = all.filter(
        (candidate) =>
          candidate.candidateId === item.candidateId &&
          candidate.platform === item.platform,
      );
      return (
        (ageDays >= 3 && !matching.some((candidate) => candidate.window === "day3")) ||
        (ageDays >= 7 && !matching.some((candidate) => candidate.window === "day7"))
      );
    });
  }

  exportCopy(destination: string): string {
    this.persist();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(this.databasePath, destination);
    return destination;
  }

  recoverInterruptedTasks(): ClipTask[] {
    const interrupted = this.listTasks().filter((task) =>
      ["queued", "validating", "analyzing", "generating_candidates", "generating_previews", "rendering"].includes(task.status)
    );
    for (const task of interrupted) {
      task.status = task.status === "rendering" ? "awaiting_review" : "imported";
      task.statusMessage = "应用重启后已恢复，可重新继续处理";
      this.saveTask(task);
    }
    return interrupted;
  }
}

export function defaultSettings(userDataPath: string, ffmpegPath: string, ffprobePath: string): AppSettings {
  return {
    workspacePath: path.join(userDataPath, "workspace"),
    feishuSyncPath: "",
    feishuAppId: "",
    feishuUpdateFolderToken: "",
    ffmpegPath,
    ffprobePath,
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-flash",
    retentionDays: 30,
    hasApiKey: false
  };
}
