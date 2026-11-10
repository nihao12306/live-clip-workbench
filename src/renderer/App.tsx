import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AccountProfile,
  AppSettings,
  Candidate,
  CandidateEditVersion,
  ClipTask,
  CreateTaskInput,
  DashboardSnapshot,
  ExportResult,
  ModelConnectionInput,
  ModelHealth,
  PerformanceRecord,
  PerformanceReminder,
  RejectionReason,
  SourceInspection,
  FeishuConnectionInfo,
  TopicContextSegment,
  UpdateInstallRequest,
  UpdateInfo,
  UpdatePublishResult,
} from "../shared/types";
import {
  DEFAULT_CROP_PRESET,
  DEFAULT_PLATFORM_SAFE_AREAS,
  DEFAULT_SUBTITLE_TEMPLATE,
  PLATFORM_LABELS,
  REJECTION_LABELS,
  STATUS_LABELS,
  usesAdmissionsReviewPreset,
} from "../shared/constants";
import { prepareCandidateSubtitleSync } from "../shared/subtitle-sync";
import { formatDuration, toFileUrl } from "../shared/utils";
import { TextSelectionView } from "./TextSelectionView";

type View = "dashboard" | "accounts" | "review" | "settings" | "text-selection";
type Toast = { kind: "success" | "error" | "info"; text: string };
type SubtitleSyncNotice = {
  kind: "success" | "warning" | "error" | "info";
  text: string;
};
type ContextGroupRelation = TopicContextSegment["relation"];
type ContextTextRange = {
  contextId: string;
  start: number;
  end: number;
};
type ContextSegmentGroup = {
  relation: ContextGroupRelation;
  segments: TopicContextSegment[];
  sourceStart: number;
  sourceEnd: number;
  text: string;
  textRanges: ContextTextRange[];
};

const CONTEXT_GROUP_ORDER: ContextGroupRelation[] = ["before", "selected", "after"];

function buildContextSegmentGroups(
  segments: TopicContextSegment[],
): ContextSegmentGroup[] {
  return CONTEXT_GROUP_ORDER.flatMap((relation) => {
    const groupSegments = segments
      .filter((segment) => segment.relation === relation)
      .sort((left, right) => left.sourceStart - right.sourceStart);
    if (!groupSegments.length) return [];
    let text = "";
    const textRanges: ContextTextRange[] = [];
    for (const segment of groupSegments) {
      const value = segment.text.trim();
      if (!value) continue;
      if (text) text += " ";
      const start = text.length;
      text += value;
      textRanges.push({ contextId: segment.id, start, end: text.length });
    }
    return [{
      relation,
      segments: groupSegments,
      sourceStart: Math.min(...groupSegments.map((segment) => segment.sourceStart)),
      sourceEnd: Math.max(...groupSegments.map((segment) => segment.sourceEnd)),
      text,
      textRanges,
    }];
  });
}

const EMPTY_SNAPSHOT: DashboardSnapshot = {
  accounts: [],
  tasks: [],
  pendingCandidates: 0,
  approvedCandidates: 0,
  remindersDue: 0,
  dueReminders: [],
};

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function candidateMatchesEditVersion(
  candidate: Candidate,
  version: CandidateEditVersion,
): boolean {
  return JSON.stringify({
    title: candidate.title,
    hookText: candidate.hookText,
    transcriptText: candidate.transcriptText,
    duration: candidate.duration,
    contextSegments: candidate.contextSegments ?? [],
    renderPlan: candidate.renderPlan,
  }) === JSON.stringify({
    title: version.title,
    hookText: version.hookText,
    transcriptText: version.transcriptText,
    duration: version.duration,
    contextSegments: version.contextSegments ?? [],
    renderPlan: version.renderPlan,
  });
}

function applyCandidateEditVersion(
  candidate: Candidate,
  version: CandidateEditVersion,
): Candidate {
  return {
    ...candidate,
    title: version.title,
    hookText: version.hookText,
    transcriptText: version.transcriptText,
    duration: version.duration,
    contextSegments: cloneValue(version.contextSegments ?? []),
    renderPlan: cloneValue(version.renderPlan),
    previewPath: undefined,
    previewPlanFingerprint: undefined,
    previewError: undefined,
  };
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    home: (
      <>
        <path d="M3 11.5 12 4l9 7.5" />
        <path d="M5.5 10.5V20h13v-9.5" />
        <path d="M9.5 20v-6h5v6" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 19c.4-4 2.4-6 5.5-6s5.1 2 5.5 6" />
        <path d="M15.5 5.5c2.2.1 3.5 1.4 3.5 3.2 0 1.7-1.2 2.9-3.2 3.1M16.5 14c2.5.5 3.8 2.1 4 5" />
      </>
    ),
    play: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="m10 9 5 3-5 3Z" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    upload: (
      <>
        <path d="M12 16V4m0 0L7 9m5-5 5 5" />
        <path d="M4 15v5h16v-5" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    folder: <path d="M3 6h7l2 2h9v11H3Z" />,
    spark: (
      <>
        <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4Z" />
        <path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z" />
      </>
    ),
    warning: (
      <>
        <path d="M12 3 2.5 20h19Z" />
        <path d="M12 9v5m0 3h.01" />
      </>
    ),
    edit: (
      <>
        <path d="m4 16-.8 4 4-.8L18 8.4 14.6 5Z" />
        <path d="m13.5 6 3.5 3.5" />
      </>
    ),
    chart: (
      <>
        <path d="M4 20V10m6 10V4m6 16v-7m6 7H2" />
      </>
    ),
    clipboard: (
      <>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 4.5V3h6v1.5M8.5 9h7M8.5 13h7M8.5 17h4" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5" />
        <path d="M4 17v-5h5" />
        <path d="M18 12a6 6 0 0 0-10.5-4M6 12a6 6 0 0 0 10.5 4" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[name]}
    </svg>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className={`modal ${wide ? "modal-wide" : ""}`}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function TimeInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | undefined>();
  return (
    <input
      type="number"
      step="0.1"
      value={draft ?? String(value)}
      onFocus={() => setDraft(String(value))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        const next = Number(event.currentTarget.value);
        setDraft(undefined);
        if (Number.isFinite(next)) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function StatusPill({ task }: { task: ClipTask }) {
  return (
    <span className={`status-pill status-${task.status}`}>
      {STATUS_LABELS[task.status]}
    </span>
  );
}

function pathLeaf(value?: string): string {
  if (!value) return "未选择";
  return value.split(/[\\/]/).pop() || value;
}

function updateInstallRequest(info?: UpdateInfo | null): UpdateInstallRequest | undefined {
  if (!info) return undefined;
  if (info.installerPath) return { installerPath: info.installerPath };
  if (info.feishuFileToken) {
    return {
      feishuFileToken: info.feishuFileToken,
      installerFileName: info.installerFileName,
    };
  }
  if (info.feishuFileChunks?.length) {
    return {
      feishuFileChunks: info.feishuFileChunks,
      installerFileName: info.installerFileName,
      installerSize: info.installerSize,
      installerSha256: info.installerSha256,
    };
  }
  return undefined;
}

function App() {
  const [view, setView] = useState<View>("text-selection");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(EMPTY_SNAPSHOT);
  const [toast, setToast] = useState<Toast | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string>();
  const [accountModal, setAccountModal] = useState<
    AccountProfile | "new" | null
  >(null);
  const [taskModal, setTaskModal] = useState(false);
  const [reviewTaskId, setReviewTaskId] = useState<string | undefined>();
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>();
  const refreshingRef = useRef(false);

  const notify = useCallback((next: Toast) => {
    setToast(next);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const checkForAvailableUpdate = useCallback(async () => {
    try {
      setUpdateInfo(await window.workbench.checkForUpdate());
    } catch {
      // Update checks are best-effort and should never interrupt local work.
    }
  }, []);

  useEffect(() => {
    void checkForAvailableUpdate();
    const timer = window.setInterval(
      () => void checkForAvailableUpdate(),
      6 * 60 * 60 * 1000,
    );
    return () => window.clearInterval(timer);
  }, [checkForAvailableUpdate]);

  const installAvailableUpdate = async () => {
    const request = updateInstallRequest(updateInfo);
    if (!request || installingUpdate) return;
    setInstallingUpdate(true);
    try {
      await window.workbench.installUpdate(request);
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstallingUpdate(false);
    }
  };

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      setSnapshot(await window.workbench.getSnapshot());
      setLastRefreshedAt(new Date().toISOString());
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [notify]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const openReview = (taskId: string) => {
    setReviewTaskId(taskId);
    setView("review");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Icon name="spark" />
          </div>
          <div>
            <strong>闪剪</strong>
            <span>LIVE CLIP STUDIO</span>
          </div>
        </div>
        <nav aria-label="主导航">
          <button className={view === "text-selection" ? "active" : ""} onClick={() => setView("text-selection")}>
            <Icon name="clipboard" />
            <span>文字选稿</span>
          </button>
          <button
            className={view === "dashboard" ? "active" : ""}
            onClick={() => setView("dashboard")}
          >
            <Icon name="home" />
            <span>工作台</span>
          </button>
          <button
            className={view === "accounts" ? "active" : ""}
            onClick={() => setView("accounts")}
          >
            <Icon name="users" />
            <span>老师账号</span>
          </button>
          <button
            className={view === "review" ? "active" : ""}
            onClick={() => setView("review")}
          >
            <Icon name="play" />
            <span>候选审核</span>
            <em>{snapshot.pendingCandidates || ""}</em>
          </button>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
          >
            <Icon name="settings" />
            <span>本地设置</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <span className="local-dot" />
          视频在本机渲染
        </div>
      </aside>
      <main className="main-content">
        {updateInfo?.available && updateInfo.version !== dismissedUpdateVersion && (
          <div className="update-banner">
            <div className="update-banner-icon">
              <Icon name="refresh" />
            </div>
            <div className="update-banner-copy">
              <strong>发现 {updateInfo.platform === "darwin" ? "Mac" : "Windows"} 新版本 {updateInfo.version}</strong>
              <span>{updateInfo.notes || updateInfo.message}</span>
            </div>
            <div className="update-banner-actions">
              {updateInstallRequest(updateInfo) ? (
                <button
                  className="button primary small"
                  disabled={installingUpdate}
                  onClick={() => void installAvailableUpdate()}
                >
                  {installingUpdate
                    ? "正在下载更新…"
                    : updateInfo.platform === "darwin"
                      ? "打开更新包"
                      : "立即更新"}
                </button>
              ) : null}
              <button
                className="button ghost small"
                onClick={() => setDismissedUpdateVersion(updateInfo.version)}
              >
                稍后
              </button>
            </div>
          </div>
        )}
        {view === "dashboard" && (
          <Dashboard
            snapshot={snapshot}
            refresh={refresh}
            notify={notify}
            onNewTask={() => setTaskModal(true)}
            onNewAccount={() => setAccountModal("new")}
            onReview={openReview}
            onOpenBackfill={() => setBackfillOpen(true)}
            isRefreshing={refreshing}
            lastRefreshedAt={lastRefreshedAt}
          />
        )}
        {view === "accounts" && (
          <AccountsView
            accounts={snapshot.accounts}
            onEdit={setAccountModal}
            onNew={() => setAccountModal("new")}
            notify={notify}
            refresh={refresh}
          />
        )}
        {view === "review" && (
          <ReviewView
            tasks={snapshot.tasks}
            accounts={snapshot.accounts}
            initialTaskId={reviewTaskId}
            notify={notify}
            refresh={refresh}
          />
        )}
        <div hidden={view !== "text-selection"}>
          <TextSelectionView active={view === "text-selection"} accounts={snapshot.accounts} />
        </div>
        {view === "settings" && (
          <SettingsView
            notify={notify}
            onSettingsSaved={checkForAvailableUpdate}
          />
        )}
      </main>
      {accountModal && (
        <AccountEditor
          account={accountModal === "new" ? undefined : accountModal}
          onClose={() => setAccountModal(null)}
          onSaved={async () => {
            setAccountModal(null);
            await refresh();
          }}
          notify={notify}
        />
      )}
      {taskModal && (
        <TaskCreator
          accounts={snapshot.accounts}
          onClose={() => setTaskModal(false)}
          onCreated={async (task) => {
            setTaskModal(false);
            await refresh();
            notify({ kind: "success", text: `任务“${task.name}”已创建` });
          }}
          notify={notify}
        />
      )}
      {backfillOpen && (
        <BackfillModal
          reminders={snapshot.dueReminders}
          onClose={() => setBackfillOpen(false)}
          onSaved={refresh}
          notify={notify}
        />
      )}
      {toast && (
        <div className={`toast toast-${toast.kind}`}>
          {toast.kind === "success" ? (
            <Icon name="check" />
          ) : toast.kind === "error" ? (
            <Icon name="warning" />
          ) : (
            <Icon name="spark" />
          )}
          {toast.text}
        </div>
      )}
    </div>
  );
}

function Dashboard({
  snapshot,
  refresh,
  notify,
  onNewTask,
  onNewAccount,
  onReview,
  onOpenBackfill,
  isRefreshing,
  lastRefreshedAt,
}: {
  snapshot: DashboardSnapshot;
  refresh: () => Promise<void>;
  notify: (toast: Toast) => void;
  onNewTask: () => void;
  onNewAccount: () => void;
  onReview: (taskId: string) => void;
  onOpenBackfill: () => void;
  isRefreshing: boolean;
  lastRefreshedAt?: string;
}) {
  const activeTasks = snapshot.tasks.filter(
    (task) => !["exported"].includes(task.status),
  );
  const exportedTasks = snapshot.tasks.filter((task) => task.status === "exported");
  const run = async (task: ClipTask) => {
    try {
      await window.workbench.runTask(task.id);
      notify({ kind: "info", text: "任务已进入本地处理队列" });
      await refresh();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      await refresh();
    }
  };
  const pause = async (task: ClipTask) => {
    try {
      await window.workbench.pauseTask(task.id);
      notify({ kind: "info", text: "任务已暂停，素材和进度已保留" });
      await refresh();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      await refresh();
    }
  };
  const attach = async (task: ClipTask) => {
    const video = await window.workbench.selectFiles({ type: "video" });
    if (!video[0]) return;
    const transcript = await window.workbench.selectFiles({
      type: "transcript",
    });
    if (!transcript[0]) return;
    await window.workbench.attachTaskFiles({
      taskId: task.id,
      videoPath: video[0],
      transcriptPath: transcript[0],
    });
    notify({ kind: "success", text: "补传完成，可以重新处理" });
    await refresh();
  };
  const rebuildCandidates = async (task: ClipTask) => {
    if (!window.confirm("将按最新规则重新分析并替换这场直播的候选，原视频和逐字稿不会重新下载。继续吗？")) return;
    try {
      await window.workbench.rebuildCandidates(task.id);
      notify({ kind: "info", text: "已进入重新筛选队列" });
      await refresh();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      await refresh();
    }
  };
  const deleteTask = async (task: ClipTask) => {
    const processing = [
      "queued",
      "validating",
      "analyzing",
      "generating_candidates",
      "generating_previews",
    ].includes(task.status);
    if (
      !window.confirm(
        `确认删除任务“${task.name}”？${processing ? "当前处理会先停止。" : ""}这会同时删除本机保存的直播回放、逐字稿、预览和任务记录，不能撤销。`,
      )
    )
      return;
    try {
      await window.workbench.deleteTask(task.id);
      notify({ kind: "success", text: "任务及本机素材已删除" });
      await refresh();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const batch = async () => {
    const files = await window.workbench.selectFiles({ type: "csv" });
    if (!files[0]) return;
    const tasks = await window.workbench.importBatch(files[0]);
    notify({ kind: "success", text: `已导入 ${tasks.length} 条批量任务` });
    await refresh();
  };
  return (
    <div className="page dashboard-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">今天</span>
          <h1>今天的处理任务</h1>
          <p>从待审核候选开始，完成审核后即可生成发布包。</p>
        </div>
        <div className="header-actions">
          <button className="button secondary" onClick={batch}>
            <Icon name="upload" />
            批量导入
          </button>
          <button className="button primary" onClick={onNewTask}>
            <Icon name="plus" />
            新建处理任务
          </button>
        </div>
      </header>
      <section className="stats-grid">
        <div className="stat-card accent">
          <div className="stat-icon">
            <Icon name="play" />
          </div>
          <div>
            <span>待审核候选</span>
            <strong>{snapshot.pendingCandidates}</strong>
            <small>精选优先审核</small>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">
            <Icon name="check" />
          </div>
          <div>
            <span>已通过切片</span>
            <strong>{snapshot.approvedCandidates}</strong>
            <small>可生成发布包</small>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">
            <Icon name="users" />
          </div>
          <div>
            <span>老师账号</span>
            <strong>{snapshot.accounts.length}</strong>
            <small>建议每人管理 1–5 个</small>
          </div>
        </div>
        <button
          className={`stat-card stat-card-action${snapshot.remindersDue ? " accent" : ""}`}
          onClick={onOpenBackfill}
          aria-label={`查看数据待回填，共 ${snapshot.remindersDue} 项`}
        >
          <div className="stat-icon">
            <Icon name="chart" />
          </div>
          <div>
            <span>数据待回填</span>
            <strong>{snapshot.remindersDue}</strong>
            <small>{snapshot.remindersDue ? "点击查看并回填" : "暂无待回填"}</small>
          </div>
        </button>
      </section>
      {snapshot.accounts.length === 0 ? (
        <section className="empty-hero">
          <div className="empty-graphic">
            <Icon name="users" size={42} />
          </div>
          <h2>先建立第一个老师账号</h2>
          <p>
            填写受众、人设与内容禁区，之后每场直播都会沿用同一套判断和包装模板。
          </p>
          <button className="button primary" onClick={onNewAccount}>
            <Icon name="plus" />
            创建账号
          </button>
        </section>
      ) : (
        <section className="panel task-panel">
          <div className="panel-heading">
            <div>
              <h2>处理队列</h2>
              <p>
                {activeTasks.length} 个进行中或待处理任务
                {exportedTasks.length ? ` · ${exportedTasks.length} 个已导出任务仍可查看候选` : ""}
                <span className="refresh-meta">
                  {lastRefreshedAt
                    ? `上次刷新 ${new Date(lastRefreshedAt).toLocaleTimeString("zh-CN")}`
                    : "尚未刷新"}
                </span>
              </p>
            </div>
            <button
              className="text-button"
              disabled={isRefreshing}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" />
              {isRefreshing ? "刷新中…" : "刷新"}
            </button>
          </div>
          {snapshot.tasks.length === 0 ? (
            <div className="compact-empty">
              还没有任务，粘贴第一条直播回放开始处理。
            </div>
          ) : (
            <div className="task-list">
              {snapshot.tasks.slice(0, 12).map((task) => {
                const account = snapshot.accounts.find(
                  (item) => item.id === task.accountId,
                );
                return (
                  <div className="task-row" key={task.id}>
                    <div className="account-avatar">
                      {account?.name.slice(0, 1) ?? "?"}
                    </div>
                    <div className="task-main">
                      <div className="task-title">
                        <strong>{task.name}</strong>
                        <StatusPill task={task} />
                      </div>
                      <div className="task-meta">
                        <span>{account?.name ?? "账号已删除"}</span>
                        <i /> <span>{formatDuration(task.duration)}</span>
                        <i />
                        <span>
                          {new Date(task.createdAt).toLocaleString("zh-CN", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {task.transcriptConfidence === "estimated" && (
                          <span className="low-confidence">低置信时间码</span>
                        )}
                      </div>
                      <div className="task-progress">
                        <span style={{ width: `${task.progress}%` }} />
                      </div>
                      <small className={task.error ? "error-text" : ""}>
                        {task.error || task.statusMessage}
                      </small>
                    </div>
                    <div className="task-actions">
                      {(task.status === "imported" ||
                        task.status === "failed" ||
                        task.status === "paused") && (
                        <button
                          className="button ghost"
                          onClick={() => void run(task)}
                        >
                          {task.status === "failed"
                            ? "重试"
                            : task.status === "paused"
                              ? "继续处理"
                              : "开始处理"}
                        </button>
                      )}
                      {["queued", "validating", "analyzing", "generating_candidates", "generating_previews"].includes(
                        task.status,
                      ) && (
                        <button
                          className="button ghost"
                          onClick={() => void pause(task)}
                        >
                          暂停
                        </button>
                      )}
                      {task.status === "failed" && (
                        <button
                          className="button ghost"
                          onClick={() => void attach(task)}
                        >
                          补传文件
                        </button>
                      )}
                      {(task.status === "awaiting_review" ||
                        task.status === "failed") && (
                        <button
                          className="button ghost"
                          onClick={() => void rebuildCandidates(task)}
                        >
                          按新规则重筛
                        </button>
                      )}
                      {["awaiting_review", "exported"].includes(
                        task.status,
                      ) && (
                        <button
                          className="button primary small"
                          onClick={() => onReview(task.id)}
                        >
                          审核候选
                          <Icon name="chevron" />
                        </button>
                      )}
                      {["imported", "paused", "failed", "queued", "validating", "analyzing", "generating_candidates", "generating_previews"].includes(
                        task.status,
                      ) && (
                        <button
                          className="button danger small"
                          onClick={() => void deleteTask(task)}
                        >
                          删除任务
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
      {snapshot.sourceStats?.length ? (
        <section className="panel source-stats-panel">
          <div className="panel-heading">
            <div>
              <h2>链接解析统计</h2>
              <p>仅统计本机尝试，不把失败伪装成成功</p>
            </div>
          </div>
          <div className="source-stats-grid">
            {snapshot.sourceStats.map((stat) => (
              <div key={stat.provider}>
                <strong>{stat.provider}</strong>
                <span>{stat.successes}/{stat.attempts} 次成功</span>
                {stat.lastError && <small>{stat.lastError}</small>}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function BackfillModal({
  reminders,
  onClose,
  onSaved,
  notify,
}: {
  reminders: PerformanceReminder[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: (toast: Toast) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(reminders[0]?.id);
  useEffect(() => {
    if (!reminders.some((reminder) => reminder.id === selectedId)) {
      setSelectedId(reminders[0]?.id);
    }
  }, [reminders, selectedId]);

  const selected = reminders.find((reminder) => reminder.id === selectedId) ?? reminders[0];
  return (
    <Modal
      title={`数据回填${reminders.length ? `（${reminders.length}）` : ""}`}
      onClose={onClose}
      wide
    >
      <div className="modal-body backfill-body">
        {selected ? (
          <div className="backfill-layout">
            <div className="backfill-list">
              <div className="backfill-list-heading">待回填窗口</div>
              {reminders.map((reminder) => (
                <button
                  type="button"
                  key={reminder.id}
                  className={`backfill-item${selected.id === reminder.id ? " active" : ""}`}
                  onClick={() => setSelectedId(reminder.id)}
                >
                  <div className="backfill-item-topline">
                    <strong>{reminder.candidateTitle}</strong>
                    <span className="backfill-window">
                      {reminder.window === "day3" ? "T+3" : "T+7"}
                    </span>
                  </div>
                  <span>{reminder.accountName} · {PLATFORM_LABELS[reminder.platform]}</span>
                  <small>到期 {new Date(reminder.dueAt).toLocaleDateString("zh-CN")}</small>
                </button>
              ))}
            </div>
            <BackfillForm
              key={selected.id}
              reminder={selected}
              onSaved={onSaved}
              notify={notify}
            />
          </div>
        ) : (
          <div className="backfill-empty">
            <Icon name="check" size={30} />
            <strong>当前没有到期的 T+3 / T+7 数据</strong>
            <p>登记发布后，到了对应时间窗口会自动出现在这里。</p>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}

function BackfillForm({
  reminder,
  onSaved,
  notify,
}: {
  reminder: PerformanceReminder;
  onSaved: () => Promise<void>;
  notify: (toast: Toast) => void;
}) {
  const [form, setForm] = useState({
    publicationUrl: reminder.publicationUrl,
    views: 0,
    completionRate: 0,
    likes: 0,
    comments: 0,
    shares: 0,
  });
  const [saving, setSaving] = useState(false);
  const windowLabel = reminder.window === "day3" ? "T+3" : "T+7";

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await window.workbench.savePerformance({
        accountId: reminder.accountId,
        candidateId: reminder.candidateId,
        platform: reminder.platform,
        publishedAt: reminder.publishedAt,
        publicationUrl: form.publicationUrl,
        window: reminder.window,
        views: form.views,
        completionRate: form.completionRate,
        likes: form.likes,
        comments: form.comments,
        shares: form.shares,
      });
      notify({ kind: "success", text: `${windowLabel} 数据已保存` });
      await onSaved();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="backfill-editor">
      <div className="backfill-editor-heading">
        <div>
          <span className="eyebrow">{windowLabel} PERFORMANCE</span>
          <h3>{reminder.candidateTitle}</h3>
          <p>{reminder.taskName} · {reminder.accountName} · {PLATFORM_LABELS[reminder.platform]}</p>
        </div>
        <span className="backfill-window large">{windowLabel}</span>
      </div>
      <div className="backfill-publish-meta">
        <span>发布时间 {new Date(reminder.publishedAt).toLocaleString("zh-CN")}</span>
        <span>回填截止 {new Date(reminder.dueAt).toLocaleDateString("zh-CN")}</span>
      </div>
      <Field label="发布链接">
        <input
          value={form.publicationUrl}
          onChange={(event) => setForm({ ...form, publicationUrl: event.target.value })}
          placeholder="可选：粘贴平台作品链接"
        />
      </Field>
      <div className="form-grid three">
        <Field label="播放量">
          <input
            type="number"
            min="0"
            value={form.views}
            onChange={(event) => setForm({ ...form, views: Number(event.target.value) })}
          />
        </Field>
        <Field label="完播率（0–1）">
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={form.completionRate}
            onChange={(event) => setForm({ ...form, completionRate: Number(event.target.value) })}
          />
        </Field>
        <Field label="点赞">
          <input
            type="number"
            min="0"
            value={form.likes}
            onChange={(event) => setForm({ ...form, likes: Number(event.target.value) })}
          />
        </Field>
        <Field label="评论">
          <input
            type="number"
            min="0"
            value={form.comments}
            onChange={(event) => setForm({ ...form, comments: Number(event.target.value) })}
          />
        </Field>
        <Field label="分享">
          <input
            type="number"
            min="0"
            value={form.shares}
            onChange={(event) => setForm({ ...form, shares: Number(event.target.value) })}
          />
        </Field>
      </div>
      <div className="backfill-editor-actions">
        <button className="button primary" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : `保存${windowLabel}数据`}
        </button>
      </div>
    </div>
  );
}

function AccountsView({
  accounts,
  onEdit,
  onNew,
  notify,
  refresh,
}: {
  accounts: AccountProfile[];
  onEdit: (account: AccountProfile | "new") => void;
  onNew: () => void;
  notify: (toast: Toast) => void;
  refresh: () => Promise<void>;
}) {
  const remove = async (account: AccountProfile) => {
    if (!confirm(`确认删除账号“${account.name}”？`)) return;
    try {
      await window.workbench.deleteAccount(account.id);
      notify({ kind: "success", text: "账号已删除" });
      await refresh();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">ACCOUNT PROFILES</span>
          <h1>老师账号</h1>
          <p>每个账号拥有独立的选片偏好、风险边界和视觉模板。</p>
        </div>
        <button className="button primary" onClick={onNew}>
          <Icon name="plus" />
          创建账号
        </button>
      </header>
      {accounts.length === 0 ? (
        <div className="compact-empty large">还没有账号。</div>
      ) : (
        <div className="account-grid">
          {accounts.map((account, index) => (
            <article className="account-card" key={account.id}>
              <div className={`avatar avatar-${index % 5}`}>
                {account.name.slice(0, 1)}
              </div>
              <div className="account-card-head">
                <div>
                  <h3>{account.name}</h3>
                  <span>{account.vertical || "教育"}</span>
                </div>
                <button className="icon-button" onClick={() => onEdit(account)}>
                  <Icon name="edit" />
                </button>
              </div>
              <p>{account.persona || "尚未填写账号人设"}</p>
              <div className="account-tags">
                <span>{account.audience || "受众待补充"}</span>
                <span>
                  {account.coverTemplate === "bold"
                    ? "冲突大字封面"
                    : account.coverTemplate === "academic"
                      ? "知识感封面"
                      : "简洁封面"}
                </span>
              </div>
              <div className="account-card-foot">
                <span>
                  {account.samplePaths.length} 条建档样片
                  {account.sampleLearning
                    ? ` · 已学习 ${account.sampleLearning.items.filter((item) => item.status === "learned").length} 条文字`
                    : " · 尚未学习文字"}
                </span>
                <button
                  className="danger-link"
                  onClick={() => void remove(account)}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountEditor({
  account,
  onClose,
  onSaved,
  notify,
}: {
  account?: AccountProfile;
  onClose: () => void;
  onSaved: () => void;
  notify: (toast: Toast) => void;
}) {
  const [form, setForm] = useState<Partial<AccountProfile>>(
    () =>
      account
        ? {
            ...account,
            sampleProfiles:
              account.sampleProfiles ?? account.samplePaths.map((path) => ({ path })),
            fillerWords: account.fillerWords ?? [],
            platformSafeAreas: account.platformSafeAreas ?? DEFAULT_PLATFORM_SAFE_AREAS,
          }
        : {
        name: "",
        vertical: "教育",
        audience: "",
        persona: "",
        stance: "",
        forbiddenTopics: [],
        sensitiveWords: [],
        preferenceSummary: "",
        samplePaths: [],
        sampleProfiles: [],
        fillerWords: [],
        platformSafeAreas: DEFAULT_PLATFORM_SAFE_AREAS,
        subtitleTemplate: DEFAULT_SUBTITLE_TEMPLATE,
        cropPreset: DEFAULT_CROP_PRESET,
        coverTemplate: "bold",
        minClipSeconds: 30,
        maxClipSeconds: 180,
          },
  );
  const [saving, setSaving] = useState(false);
  const [learning, setLearning] = useState(false);
  const update = <K extends keyof AccountProfile>(
    key: K,
    value: AccountProfile[K],
  ) => setForm((current) => ({ ...current, [key]: value }));
  const pick = async (
    kind: "samples" | "music" | "logo" | "intro" | "outro",
  ) => {
    const files = await window.workbench.selectFiles({
      type: "media",
      multiple: kind === "samples",
    });
    if (!files.length) return;
    if (kind === "samples") {
      update("samplePaths", files);
      update(
        "sampleProfiles",
        files.map((file) =>
          form.sampleProfiles?.find((item) => item.path === file) ?? { path: file },
        ),
      );
    }
    if (kind === "music") update("musicPath", files[0]);
    if (kind === "logo") update("logoPath", files[0]);
    if (kind === "intro") update("introPath", files[0]);
    if (kind === "outro") update("outroPath", files[0]);
  };
  const learnSamples = async (accountId: string, samplePaths: string[]) => {
    setLearning(true);
    try {
      const report = await window.workbench.learnAccountSamples(accountId, samplePaths);
      setForm((current) => ({
        ...current,
        sampleTranscript: report.transcript,
        sampleLearning: report.state,
      }));
      const learned = report.state.items.filter((item) => item.status === "learned").length;
      const skipped = report.state.items.length - learned;
      const profiled = report.state.profile?.learnedSampleCount ?? 0;
      const succeeded = learned > 0 || profiled > 0;
      notify({
        kind: succeeded ? "success" : "error",
        text: learned
          ? `已读取 ${learned} 条样片文字${skipped ? `，${skipped} 条未找到可读文字` : ""}`
          : profiled
            ? "已生成结构化风格画像"
          : "样片未找到逐字稿、内嵌字幕或可用的本地转写结果",
      });
      return learned
        ? `，已读取 ${learned} 条样片文字${skipped ? `，${skipped} 条未找到可读文字` : ""}`
        : profiled
          ? "，已生成结构化风格画像"
          : "，样片学习未读取到可用文字";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify({ kind: "error", text: `样片学习失败：${message}` });
      return `，样片学习失败：${message}`;
    } finally {
      setLearning(false);
    }
  };
  const save = async () => {
    if (!form.name?.trim())
      return notify({ kind: "error", text: "请填写账号名称" });
    const sampleCount = form.sampleProfiles?.length ?? form.samplePaths?.length ?? 0;
    if (sampleCount > 0 && (sampleCount < 3 || sampleCount > 10))
      return notify({ kind: "error", text: "代表样片请提供 3–10 条" });
    setSaving(true);
    try {
      const saved = await window.workbench.saveAccount({
        ...form,
        id: account?.id,
        name: form.name,
      });
      setForm((current) => ({ ...current, ...saved }));
      let learningText = "";
      const savedPaths = new Set(saved.samplePaths);
      const learnedPaths = new Set(saved.sampleLearning?.items.map((item) => item.path) ?? []);
      const pathsChanged = savedPaths.size !== learnedPaths.size || [...savedPaths].some((item) => !learnedPaths.has(item));
      const needsLearning = (saved.samplePaths.length > 0 || Boolean(saved.sampleTranscript?.trim())) &&
        (!saved.sampleLearning || saved.sampleLearning.transcriptChars === 0 || pathsChanged || !saved.sampleLearning.profile);
      if (needsLearning) {
        learningText = await learnSamples(saved.id, saved.samplePaths);
      }
      notify({ kind: "success", text: `账号配置已保存${learningText}` });
      onSaved();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };
  const profile = form.sampleLearning?.profile;
  const profileGroups = profile
    ? [
      { label: "开头", values: profile.hookPatterns },
      { label: "结构", values: profile.structurePatterns },
      { label: "受众", values: profile.audienceSignals },
      { label: "证据", values: profile.evidenceSignals },
      { label: "语气", values: profile.toneSignals },
      { label: "建议", values: profile.recommendationPatterns },
      { label: "规避", values: profile.avoidPatterns },
      { label: "表现", values: profile.performanceSignals },
    ].filter((group) => group.values.length)
    : [];
  return (
    <Modal
      title={account ? `编辑账号 · ${account.name}` : "创建老师账号"}
      onClose={onClose}
      wide
    >
      <div className="modal-body account-form">
        <div className="form-section">
          <h3>内容画像</h3>
          <div className="form-grid two">
            <Field label="账号名称">
              <input
                value={form.name ?? ""}
                onChange={(e) => update("name", e.target.value)}
                placeholder="例如：张老师升学规划"
              />
            </Field>
            <Field label="教育细分领域">
              <input
                value={form.vertical ?? ""}
                onChange={(e) => update("vertical", e.target.value)}
                placeholder="高考志愿 / 学科教育 / 家庭教育"
              />
            </Field>
            <Field label="核心受众">
              <input
                value={form.audience ?? ""}
                onChange={(e) => update("audience", e.target.value)}
                placeholder="例如：高一至高三学生家长"
              />
            </Field>
            <Field label="账号人设">
              <input
                value={form.persona ?? ""}
                onChange={(e) => update("persona", e.target.value)}
                placeholder="专业、直接、敢讲真话"
              />
            </Field>
          </div>
          <Field label="常用口癖" hint="用逗号分隔，命中后会从原音频中切掉">
            <input
              value={(form.fillerWords ?? []).join("，")}
              onChange={(e) =>
                update(
                  "fillerWords",
                  e.target.value
                    .split(/[，,]/)
                    .map((value) => value.trim())
                    .filter(Boolean),
                )
              }
              placeholder="例如：大家好、对不对、我认为"
            />
          </Field>
          <Field label="表达立场">
            <textarea
              value={form.stance ?? ""}
              onChange={(e) => update("stance", e.target.value)}
              placeholder="账号长期坚持的核心观点与表达边界"
              rows={3}
            />
          </Field>
          <div className="form-grid two">
            <Field label="禁止话题" hint="用逗号分隔">
              <input
                value={(form.forbiddenTopics ?? []).join("，")}
                onChange={(e) =>
                  update(
                    "forbiddenTopics",
                    e.target.value
                      .split(/[，,]/)
                      .map((v) => v.trim())
                      .filter(Boolean),
                  )
                }
              />
            </Field>
            <Field label="敏感词" hint="命中后不生成，也不能导出">
              <input
                value={(form.sensitiveWords ?? []).join("，")}
                onChange={(e) =>
                  update(
                    "sensitiveWords",
                    e.target.value
                      .split(/[，,]/)
                      .map((v) => v.trim())
                      .filter(Boolean),
                  )
                }
              />
            </Field>
          </div>
          <Field label="初始偏好摘要">
            <textarea
              value={form.preferenceSummary ?? ""}
              onChange={(e) => update("preferenceSummary", e.target.value)}
              placeholder="哪些观点、节奏和表达最适合这个账号"
              rows={3}
            />
          </Field>
          <Field
            label="内容选题原则（账号硬规则）"
            hint="可粘贴账号的选题原则。首行写「升学决策选题预设」可启用额外的本地校验。"
          >
            <textarea
              value={form.selectionPrinciples ?? ""}
              onChange={(e) => update("selectionPrinciples", e.target.value)}
              placeholder="例如：只做具体决策问题；每条只解决一个核心选择；必须有数据、边界和条件化建议。"
              rows={10}
            />
          </Field>
          <Field
            label="历史样片逐字稿/内容参考"
            hint="保存账号时会在本机读取样片：优先同名逐字稿/字幕，其次视频内嵌字幕，最后使用本机 Whisper 转写；结果只作为账号内容规律参考"
          >
            <textarea
              value={form.sampleTranscript ?? ""}
              onChange={(e) => update("sampleTranscript", e.target.value)}
              placeholder="可手动补充你确认过的成熟样片文字；保存账号后工作台会自动把选中的样片转成文字并合并到这里。"
              rows={6}
            />
          </Field>
          <div className="file-picker-row">
            <button
              className="button secondary"
              onClick={() => void pick("samples")}
              disabled={saving || learning}
            >
              <Icon name="upload" />
              选择 3–10 条代表样片
            </button>
            <span>
              {form.samplePaths?.length
                ? `已选择 ${form.samplePaths.length} 条`
                : "尚未选择样片"}
            </span>
            {account?.id && form.samplePaths?.length ? (
              <button
                className="button secondary"
                disabled={saving || learning}
                onClick={() => void learnSamples(account.id!, form.samplePaths ?? [])}
              >
                {learning ? "读取样片中…" : "重新读取样片文字"}
              </button>
            ) : null}
            {form.sampleLearning ? (
              <span className="muted-text">
                最近学习：{form.sampleLearning.transcriptChars} 字 · {new Date(form.sampleLearning.learnedAt).toLocaleString()}
              </span>
            ) : null}
          </div>
          {profile ? (
            <div className="sample-learning-profile">
              <div className="sample-learning-profile-header">
                <strong>结构化风格画像</strong>
                <span className="muted-text">
                  {profile.learnedSampleCount}/{profile.sampleCount} 条样片
                </span>
              </div>
              <p>{profile.summary}</p>
              <div className="sample-learning-profile-groups">
                {profileGroups.map(({ label, values }) => (
                  <div key={label} className="sample-learning-profile-group">
                    <span>{label}</span>
                    <div>
                      {values.map((value) => <em key={value}>{value}</em>)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {form.sampleProfiles?.length ? (
            <div className="sample-performance-list">
              {form.sampleProfiles.map((sample, index) => (
                <div className="sample-performance-row" key={sample.path}>
                  <span title={sample.path}>{pathLeaf(sample.path)}</span>
                  <select
                    value={sample.platform ?? "douyin"}
                    onChange={(e) =>
                      update("sampleProfiles", form.sampleProfiles!.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, platform: e.target.value as "douyin" | "wechat_channels" | "xiaohongshu" } : item,
                      ))
                    }
                  >
                    {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    placeholder="播放"
                    value={sample.views ?? ""}
                    onChange={(e) => update("sampleProfiles", form.sampleProfiles!.map((item, itemIndex) => itemIndex === index ? { ...item, views: Number(e.target.value) || undefined } : item))}
                  />
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step="0.01"
                    placeholder="完播率"
                    value={sample.completionRate ?? ""}
                    onChange={(e) => update("sampleProfiles", form.sampleProfiles!.map((item, itemIndex) => itemIndex === index ? { ...item, completionRate: Number(e.target.value) || undefined } : item))}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="form-section">
          <h3>剪辑与包装</h3>
          <div className="form-grid three">
            <Field label="建议最短时长（秒）" hint="软约束，内容完整性优先">
              <input
                type="number"
                min={15}
                max={180}
                value={form.minClipSeconds ?? 30}
                onChange={(e) =>
                  update("minClipSeconds", Number(e.target.value))
                }
              />
            </Field>
            <Field label="允许最长时长（秒）" hint="到自然话题边界即可结束">
              <input
                type="number"
                min={30}
                max={240}
                value={form.maxClipSeconds ?? 180}
                onChange={(e) =>
                  update("maxClipSeconds", Number(e.target.value))
                }
              />
            </Field>
            <Field label="封面风格">
              <select
                value={form.coverTemplate ?? "bold"}
                onChange={(e) =>
                  update(
                    "coverTemplate",
                    e.target.value as AccountProfile["coverTemplate"],
                  )
                }
              >
                <option value="bold">冲突大字</option>
                <option value="clean">简洁留白</option>
                <option value="academic">知识感</option>
              </select>
            </Field>
          </div>
          <div className="form-grid three">
            <Field label="裁掉顶部">
              <input
                type="number"
                min={0}
                max={60}
                value={Math.round((form.cropPreset?.topPercent ?? 0) * 100)}
                onChange={(e) =>
                  update("cropPreset", {
                    ...(form.cropPreset ?? DEFAULT_CROP_PRESET),
                    topPercent: Number(e.target.value) / 100,
                  })
                }
              />
            </Field>
            <Field label="裁掉底部">
              <input
                type="number"
                min={0}
                max={60}
                value={Math.round((form.cropPreset?.bottomPercent ?? 0) * 100)}
                onChange={(e) =>
                  update("cropPreset", {
                    ...(form.cropPreset ?? DEFAULT_CROP_PRESET),
                    bottomPercent: Number(e.target.value) / 100,
                  })
                }
              />
            </Field>
            <Field label="字幕字号">
              <input
                type="number"
                min={36}
                max={88}
                value={form.subtitleTemplate?.fontSize ?? 58}
                onChange={(e) =>
                  update("subtitleTemplate", {
                    ...(form.subtitleTemplate ?? DEFAULT_SUBTITLE_TEMPLATE),
                    fontSize: Number(e.target.value),
                  })
                }
              />
            </Field>
          </div>
          <div className="form-grid two">
            <Field label="字幕颜色">
              <input
                type="color"
                value={form.subtitleTemplate?.primaryColor ?? "#FFFFFF"}
                onChange={(e) =>
                  update("subtitleTemplate", {
                    ...(form.subtitleTemplate ?? DEFAULT_SUBTITLE_TEMPLATE),
                    primaryColor: e.target.value,
                  })
                }
              />
            </Field>
            <Field label="强调色">
              <input
                type="color"
                value={form.subtitleTemplate?.highlightColor ?? "#D8FF4F"}
                onChange={(e) =>
                  update("subtitleTemplate", {
                    ...(form.subtitleTemplate ?? DEFAULT_SUBTITLE_TEMPLATE),
                    highlightColor: e.target.value,
                  })
                }
              />
            </Field>
          </div>
          <div className="form-section-inline">
            <h4>平台字幕安全区（底部留白 %）</h4>
            <div className="form-grid three">
              {(Object.keys(PLATFORM_LABELS) as Array<keyof typeof PLATFORM_LABELS>).map((platform) => (
                <Field key={platform} label={PLATFORM_LABELS[platform]}>
                  <input
                    type="number"
                    min={0}
                    max={40}
                    value={Math.round(((form.platformSafeAreas ?? DEFAULT_PLATFORM_SAFE_AREAS)[platform]?.bottom ?? DEFAULT_PLATFORM_SAFE_AREAS[platform].bottom) * 100)}
                    onChange={(e) =>
                      update("platformSafeAreas", {
                        ...(form.platformSafeAreas ?? DEFAULT_PLATFORM_SAFE_AREAS),
                        [platform]: {
                          ...(form.platformSafeAreas?.[platform] ?? DEFAULT_PLATFORM_SAFE_AREAS[platform]),
                          bottom: Number(e.target.value) / 100,
                        },
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          </div>
          <div className="file-picker-row split">
            <button
              className="button secondary"
              onClick={() => void pick("music")}
            >
              <Icon name="folder" />
              授权背景音乐
            </button>
            <span>{pathLeaf(form.musicPath)}</span>
            <button
              className="button secondary"
              onClick={() => void pick("logo")}
            >
              <Icon name="folder" />
              账号角标
            </button>
            <span>{pathLeaf(form.logoPath)}</span>
          </div>
        </div>
        <div className="file-picker-row split template-assets">
          <button
            className="button secondary"
            onClick={() => void pick("intro")}
          >
            <Icon name="play" />
            片头视频
          </button>
          <span>{pathLeaf(form.introPath)}</span>
          <button
            className="button secondary"
            onClick={() => void pick("outro")}
          >
            <Icon name="play" />
            片尾视频
          </button>
          <span>{pathLeaf(form.outroPath)}</span>
        </div>
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          disabled={saving || learning}
          onClick={() => void save()}
        >
          {learning ? "学习样片中…" : saving ? "保存中…" : "保存账号"}
        </button>
      </div>
    </Modal>
  );
}

function TaskCreator({
  accounts,
  onClose,
  onCreated,
  notify,
}: {
  accounts: AccountProfile[];
  onClose: () => void;
  onCreated: (task: ClipTask) => void;
  notify: (toast: Toast) => void;
}) {
  const [mode, setMode] = useState<"link" | "file">("link");
  const [form, setForm] = useState<CreateTaskInput>({
    accountId: accounts[0]?.id ?? "",
    name: "",
  });
  const [inspection, setInspection] = useState<SourceInspection | null>(null);
  const [saving, setSaving] = useState(false);
  const choose = async (type: "video" | "transcript") => {
    const files = await window.workbench.selectFiles({ type });
    if (files[0])
      setForm((current) => ({
        ...current,
        [type === "video" ? "videoPath" : "transcriptPath"]: files[0],
      }));
  };
  const inspect = async () => {
    if (!form.sourceUrl) return;
    try {
      setInspection(await window.workbench.inspectSource(form.sourceUrl));
    } catch (error) {
      setInspection(null);
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const submit = async (startNow: boolean) => {
    if (!form.accountId || !form.name.trim())
      return notify({ kind: "error", text: "请选择账号并填写任务名称" });
    if (mode === "file" && (!form.videoPath || !form.transcriptPath))
      return notify({
        kind: "error",
        text: "文件导入必须同时选择视频和逐字稿",
      });
    if (mode === "link" && !form.sourceUrl?.trim())
      return notify({ kind: "error", text: "请粘贴分享链接" });
    setSaving(true);
    try {
      const task = await window.workbench.createTask({
        ...form,
        sourceUrl: mode === "link" ? form.sourceUrl : undefined,
      });
      if (startNow) await window.workbench.runTask(task.id);
      onCreated(task);
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="新建处理任务" onClose={onClose}>
      <div className="modal-body">
        <div className="segmented">
          <button
            className={mode === "link" ? "active" : ""}
            onClick={() => setMode("link")}
          >
            分享链接
          </button>
          <button
            className={mode === "file" ? "active" : ""}
            onClick={() => setMode("file")}
          >
            本地文件
          </button>
        </div>
        <Field label="老师账号">
          <select
            value={form.accountId}
            onChange={(e) => setForm({ ...form, accountId: e.target.value })}
          >
            <option value="">请选择</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="任务名称">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="例如：8 月 6 日升学答疑直播"
          />
        </Field>
        {mode === "link" ? (
          <>
            <Field
              label="回放分享链接"
              hint="飞书妙记链接可直接读取视频和带时间码逐字稿；先在本地设置连接飞书。云盘素材文件夹仍可作为备用导入方式"
            >
              <div className="input-action">
                <input
                  value={form.sourceUrl ?? ""}
                  onChange={(e) => {
                    setForm({ ...form, sourceUrl: e.target.value });
                    setInspection(null);
                  }}
                  placeholder="粘贴飞书妙记链接或其他回放分享链接"
                />
                <button onClick={() => void inspect()}>检查</button>
                <button
                  className="button secondary"
                  disabled={!form.sourceUrl?.trim()}
                  onClick={() => void window.workbench.openSourceLogin(form.sourceUrl!.trim())}
                >
                  在工作台登录
                </button>
              </div>
            </Field>
            {inspection && (
              <div
                className={`inspection ${inspection.requiresFallback ? "warning" : "success"}`}
              >
                <Icon
                  name={inspection.requiresFallback ? "warning" : "check"}
                />
                <div>
                  <strong>{inspection.provider.toUpperCase()}</strong>
                  <p>{inspection.message}</p>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="drop-grid">
            <button
              className={`file-drop ${form.videoPath ? "selected" : ""}`}
              onClick={() => void choose("video")}
            >
              <Icon name="play" size={28} />
              <strong>
                {form.videoPath ? pathLeaf(form.videoPath) : "选择原始视频"}
              </strong>
              <span>MP4 / MOV / MKV</span>
            </button>
            <button
              className={`file-drop ${form.transcriptPath ? "selected" : ""}`}
              onClick={() => void choose("transcript")}
            >
              <Icon name="upload" size={28} />
              <strong>
                {form.transcriptPath
                  ? pathLeaf(form.transcriptPath)
                  : "选择逐字稿"}
              </strong>
              <span>SRT / VTT / TXT / DOCX</span>
            </button>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          取消
        </button>
        <button
          className="button secondary"
          disabled={saving}
          onClick={() => void submit(false)}
        >
          仅加入队列
        </button>
        <button
          className="button primary"
          disabled={saving}
          onClick={() => void submit(true)}
        >
          {saving ? "创建中…" : "创建并开始"}
        </button>
      </div>
    </Modal>
  );
}

function ReviewView({
  tasks,
  accounts,
  initialTaskId,
  notify,
  refresh,
}: {
  tasks: ClipTask[];
  accounts: AccountProfile[];
  initialTaskId?: string;
  notify: (toast: Toast) => void;
  refresh: () => Promise<void>;
}) {
  const reviewable = tasks.filter((task) =>
    ["awaiting_review", "exported"].includes(task.status),
  );
  const [taskId, setTaskId] = useState(
    initialTaskId ?? reviewable[0]?.id ?? "",
  );
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] =
    useState<RejectionReason>("not_debatable");
  const [rejectNote, setRejectNote] = useState("");
  const [exporting, setExporting] = useState(false);
  const [previewingId, setPreviewingId] = useState<string>();
  const [wordAligningId, setWordAligningId] = useState<string>();
  const [performanceCandidate, setPerformanceCandidate] =
    useState<Candidate | null>(null);
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [subtitleSyncNotices, setSubtitleSyncNotices] = useState<
    Record<string, SubtitleSyncNotice>
  >({});
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({});
  const [historyExpanded, setHistoryExpanded] = useState<Record<string, boolean>>({});
  const [contextTextSelections, setContextTextSelections] = useState<
    Record<string, { start: number; end: number }>
  >({});
  const [performanceRecords, setPerformanceRecords] = useState<PerformanceRecord[]>([]);
  const task = tasks.find((item) => item.id === taskId);
  const account = accounts.find((item) => item.id === task?.accountId);
  const selected =
    candidates.find((item) => item.id === selectedId) ?? candidates[0];
  const visible = candidates.filter(
    (item) => showMore || item.tier === "featured",
  );
  const contextGroups = useMemo(
    () => buildContextSegmentGroups(selected?.contextSegments ?? []),
    [selected?.contextSegments],
  );
  const latestPublication = [...performanceRecords]
    .filter((record) => record.window === "published")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const hasDay3 = performanceRecords.some((record) => record.window === "day3");
  const hasDay7 = performanceRecords.some((record) => record.window === "day7");
  const publicationAgeDays = latestPublication
    ? (Date.now() - new Date(latestPublication.publishedAt).getTime()) / 86_400_000
    : 0;
  const publicationStatus = selected?.decision !== "approved"
    ? undefined
    : !latestPublication
      ? {
          kind: "pending",
          label: "尚未登记发布",
          detail: "真正发布后，点击“登记发布数据”开始计时",
        }
      : hasDay7
        ? {
            kind: "complete",
            label: "数据已回填",
            detail: `${PLATFORM_LABELS[latestPublication.platform]} · 已完成 T+3 / T+7`,
          }
        : publicationAgeDays >= 7
          ? {
              kind: "due",
              label: "待回填 T+7",
              detail: `${PLATFORM_LABELS[latestPublication.platform]} · 发布于 ${new Date(latestPublication.publishedAt).toLocaleDateString("zh-CN")}`,
            }
          : hasDay3
            ? {
                kind: "waiting",
                label: "已回填 T+3，等待 T+7",
                detail: `${PLATFORM_LABELS[latestPublication.platform]} · T+7 到期后继续回填`,
              }
            : publicationAgeDays >= 3
              ? {
                  kind: "due",
                  label: "待回填 T+3",
                  detail: `${PLATFORM_LABELS[latestPublication.platform]} · 发布于 ${new Date(latestPublication.publishedAt).toLocaleDateString("zh-CN")}`,
                }
              : {
                  kind: "published",
                  label: "已登记发布，等待 T+3",
                  detail: `${PLATFORM_LABELS[latestPublication.platform]} · 发布于 ${new Date(latestPublication.publishedAt).toLocaleDateString("zh-CN")}`,
                };

  const loadPerformance = useCallback(async (candidateId: string) => {
    try {
      setPerformanceRecords(await window.workbench.listPerformance(candidateId));
    } catch {
      setPerformanceRecords([]);
    }
  }, []);

  const load = useCallback(async (nextTaskId: string) => {
    if (!nextTaskId) {
      setCandidates([]);
      return;
    }
    const items = await window.workbench.listCandidates(nextTaskId);
    setCandidates(items);
    setSelectedId((current) =>
      items.some((item) => item.id === current)
        ? current
        : (items[0]?.id ?? ""),
    );
  }, []);
  const regeneratePreview = useCallback(async (candidateId: string) => {
    setPreviewingId(candidateId);
    setPreviewErrors((items) => {
      const next = { ...items };
      delete next[candidateId];
      return next;
    });
    try {
      const updated = await window.workbench.generateCandidatePreview(candidateId);
      setCandidates((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (updated.previewError) {
        setPreviewErrors((items) => ({ ...items, [candidateId]: updated.previewError! }));
      }
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPreviewErrors((items) => ({ ...items, [candidateId]: message }));
      return undefined;
    } finally {
      setPreviewingId((current) =>
        current === candidateId ? undefined : current,
      );
    }
  }, []);
  useEffect(() => {
    if (initialTaskId) setTaskId(initialTaskId);
  }, [initialTaskId]);
  useEffect(() => {
    setContextTextSelections({});
  }, [selected?.id]);
  useEffect(() => {
    if (!selected) {
      setPerformanceRecords([]);
      return;
    }
    void loadPerformance(selected.id);
  }, [loadPerformance, selected?.id]);
  useEffect(() => {
    // A task can disappear after deleting a failed run or the last rejected
    // candidate. Keep the review selector pointed at a remaining task instead
    // of leaving the editor mounted against a stale id.
    if (taskId && reviewable.some((item) => item.id === taskId)) return;
    setTaskId(reviewable[0]?.id ?? "");
  }, [reviewable, taskId]);
  useEffect(() => {
    void load(taskId);
  }, [taskId, load]);
  useEffect(() => {
    if (!selected || selected.previewPath || selected.previewError) {
      setPreviewingId(undefined);
      return;
    }
    void regeneratePreview(selected.id);
  }, [regeneratePreview, selected?.id, selected?.previewPath]);

  const patchCandidate = (patch: Partial<Candidate>) => {
    if (!selected) return;
    setCandidates((items) =>
      items.map((item) =>
        item.id === selected.id ? { ...item, ...patch } : item,
      ),
    );
  };

  const prepareSubtitleSync = (candidate: Candidate) =>
    prepareCandidateSubtitleSync(candidate);

  const prepareSubtitleSyncPrecisely = async (candidate: Candidate) => {
    let prepared = prepareSubtitleSync(candidate);
    if (!prepared.result.needsWordAlignment) return prepared;
    setWordAligningId(candidate.id);
    setSubtitleSyncNotice(candidate.id, {
      kind: "info",
      text: "这条素材只有粗时间码，正在自动定位每个词的真实切口…",
    });
    try {
      const aligned = await window.workbench.ensureCandidateWordTimings(candidate);
      prepared = prepareSubtitleSync(aligned);
      patchCandidate({ wordTimings: aligned.wordTimings });
      return prepared;
    } finally {
      setWordAligningId((current) => current === candidate.id ? undefined : current);
    }
  };

  const subtitleSyncNoticeFor = (candidateId: string): SubtitleSyncNotice | undefined =>
    subtitleSyncNotices[candidateId];

  const setSubtitleSyncNotice = (
    candidateId: string,
    notice: SubtitleSyncNotice,
  ) => {
    setSubtitleSyncNotices((items) => ({ ...items, [candidateId]: notice }));
  };

  const reportSubtitleSync = (
    candidate: Candidate,
    prepared: ReturnType<typeof prepareSubtitleSync>,
    persisted = false,
  ) => {
    const { result } = prepared;
    if (!result.segments.length) {
      setSubtitleSyncNotice(candidate.id, {
        kind: "error",
        text: "最终字幕不能为空，至少保留一个能在原逐字稿中定位的片段。",
      });
      return;
    }
    if (result.unmatched.length) {
      const examples = result.unmatched.slice(0, 2).join("、");
      setSubtitleSyncNotice(candidate.id, {
        kind: "error",
        text: `有 ${result.unmatched.length} 段文字未在当前逐字稿中找到${examples ? `：${examples}` : ""}。请从上方前后文加入原话；未定位文字不会加入音频。`,
      });
      return;
    }
    if (result.needsWordAlignment) {
      setSubtitleSyncNotice(candidate.id, {
        kind: "info",
        text: "检测到句中删字；保存时会先自动定位词级切口，避免吞掉前后音节。",
      });
      return;
    }
    if (result.partialMatches.length) {
      setSubtitleSyncNotice(candidate.id, {
        kind: "warning",
        text: `已${persisted ? "同步并保存" : "同步"} ${result.segments.length} 个音频片段；其中 ${result.partialMatches.length} 段是原句的局部删改，字幕和对应音频已同步剪除。`,
      });
      return;
    }
    setSubtitleSyncNotice(candidate.id, {
      kind: "success",
      text: persisted
        ? `已同步并保存 ${result.segments.length} 个音频片段，预览正在按新的增删顺序重新生成。`
        : `已同步 ${result.segments.length} 个音频片段。保存后预览会按新的增删顺序重新生成。`,
    });
  };

  const syncSubtitleDraft = (draftText?: string) => {
    if (!selected) return false;
    const draftCandidate = draftText === undefined
      ? selected
      : {
          ...selected,
          renderPlan: {
            ...selected.renderPlan,
            subtitleText: draftText,
          },
        };
    const prepared = prepareSubtitleSync(draftCandidate);
    patchCandidate(prepared.nextCandidate);
    reportSubtitleSync(draftCandidate, prepared);
    return prepared.canSave;
  };

  const syncSubtitleAndSave = async () => {
    if (!selected) return;
    try {
      const prepared = await prepareSubtitleSyncPrecisely(selected);
      patchCandidate(prepared.nextCandidate);
      reportSubtitleSync(selected, prepared);
      if (!prepared.canSave) {
        notify({ kind: "error", text: "字幕还没有完全对应到原始逐字稿，暂不能保存切片。" });
        return;
      }
      const result = await window.workbench.saveCandidateAndPreview(prepared.nextCandidate);
      setCandidates((items) =>
        items.map((item) => (item.id === result.id ? result : item)),
      );
      reportSubtitleSync(result, prepared, true);
      if (result.previewPath) {
        notify({ kind: "success", text: "字幕与切片已同步并保存，预览已更新" });
      } else {
        const message = result.previewError ?? "预览生成失败，请点击重试";
        setPreviewErrors((items) => ({ ...items, [result.id]: message }));
        notify({ kind: "error", text: `字幕与切片已保存，但预览生成失败：${message}` });
      }
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const save = async () => {
    if (!selected) return;
    try {
      const prepared = await prepareSubtitleSyncPrecisely(selected);
      if (!prepared.canSave) {
        patchCandidate(prepared.nextCandidate);
        reportSubtitleSync(selected, prepared);
        notify({ kind: "error", text: "字幕还没有完全对应到原始逐字稿，暂不能保存切片。" });
        return;
      }
      const result = await window.workbench.saveCandidateAndPreview(prepared.nextCandidate);
      setCandidates((items) =>
        items.map((item) => (item.id === result.id ? result : item)),
      );
      reportSubtitleSync(result, prepared);
      if (result.previewPath) {
        notify({ kind: "success", text: "剪辑方案已保存，预览已更新" });
      } else {
        const message = result.previewError ?? "预览生成失败，请点击重试";
        setPreviewErrors((items) => ({ ...items, [result.id]: message }));
        notify({ kind: "error", text: `剪辑方案已保存，但预览生成失败：${message}` });
      }
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const restoreHistoryVersion = async (version: CandidateEditVersion) => {
    if (!selected) return;
    const latest = selected.editHistory?.at(-1);
    if (
      latest
      && !candidateMatchesEditVersion(selected, latest)
      && !window.confirm("当前有未保存修改，恢复历史版本会放弃这些修改，是否继续？")
    ) {
      return;
    }
    const restored = applyCandidateEditVersion(selected, version);
    try {
      const result = await window.workbench.saveCandidateAndPreview(restored);
      setCandidates((items) =>
        items.map((item) => (item.id === result.id ? result : item)),
      );
      setHistoryOpen((items) => ({ ...items, [result.id]: false }));
      if (result.previewPath) {
        notify({ kind: "success", text: `已恢复到版本 ${version.version}，预览已更新` });
      } else {
        const message = result.previewError ?? "预览生成失败，请点击重试";
        setPreviewErrors((items) => ({ ...items, [result.id]: message }));
        notify({ kind: "error", text: `版本已恢复，但预览生成失败：${message}` });
      }
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const undoCandidateEdit = async () => {
    if (!selected) return;
    const history = selected.editHistory ?? [];
    const latest = history.at(-1);
    if (latest && !candidateMatchesEditVersion(selected, latest)) {
      // First undo only discards the current unsaved draft and keeps the
      // already generated preview for the last saved state.
      patchCandidate({
        ...applyCandidateEditVersion(selected, latest),
        previewPath: selected.previewPath,
      });
      notify({ kind: "success", text: "已撤回未保存修改" });
      return;
    }
    if (history.length < 2) {
      notify({ kind: "info", text: "当前还没有可撤回的历史版本" });
      return;
    }
    await restoreHistoryVersion(history[history.length - 2]);
  };

  const review = async (decision: "approved" | "rejected") => {
    if (!selected) return;
    try {
      const prepared = await prepareSubtitleSyncPrecisely(selected);
      if (!prepared.canSave) {
        patchCandidate(prepared.nextCandidate);
        reportSubtitleSync(selected, prepared);
        notify({ kind: "error", text: "字幕还没有完全对应到原始逐字稿，暂不能提交审核。" });
        return;
      }
      const saved = decision === "approved"
        ? await window.workbench.saveCandidateAndPreview(prepared.nextCandidate)
        : await window.workbench.saveCandidate(prepared.nextCandidate);
      const result = await window.workbench.reviewCandidate({
        candidateId: selected.id,
        decision,
        reason: decision === "rejected" ? rejectReason : undefined,
        note: rejectNote || undefined,
      });
      setCandidates((items) =>
        items.map((item) => (item.id === result.id ? result : item)),
      );
      setRejecting(false);
      setRejectNote("");
      if (decision === "approved" && !saved.previewPath) {
        setPreviewErrors((items) => ({
          ...items,
          [result.id]: saved.previewError ?? "预览生成失败，请点击重试",
        }));
      }
      notify({
        kind: "success",
        text:
          decision === "approved" ? "已通过，可生成发布包" : "已记录驳回原因",
      });
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const deleteRejectedCandidate = async () => {
    if (!selected || selected.decision !== "rejected") return;
    if (!window.confirm(`确认删除已驳回候选“${selected.title}”？预览和审核记录也会删除。`)) return;
    try {
      await window.workbench.deleteCandidate(selected.id);
      const remaining = candidates.filter((item) => item.id !== selected.id);
      setCandidates(remaining);
      setSelectedId(remaining[0]?.id ?? "");
      notify({ kind: "success", text: "已删除驳回候选" });
      await refresh();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const deleteRejectedTask = async () => {
    if (!task || (candidates.length > 0 && candidates.some((item) => item.decision !== "rejected"))) return;
    if (!window.confirm(`确认删除整场任务“${task.name}”？直播回放、逐字稿、预览和任务记录都会删除，不能撤销。`)) return;
    try {
      await window.workbench.deleteTask(task.id);
      notify({ kind: "success", text: "已删除驳回任务及本机素材" });
      await refresh();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const acknowledge = async (index: number) => {
    if (!selected) return;
    const result = await window.workbench.acknowledgeRisk({
      candidateId: selected.id,
      index,
    });
    setCandidates((items) =>
      items.map((item) => (item.id === result.id ? result : item)),
    );
  };
  const exportClip = async () => {
    if (!selected) return;
    setExporting(true);
    try {
      const prepared = await prepareSubtitleSyncPrecisely(selected);
      if (!prepared.canSave) {
        patchCandidate(prepared.nextCandidate);
        reportSubtitleSync(selected, prepared);
        notify({ kind: "error", text: "字幕还没有完全对应到原始逐字稿，暂不能导出。" });
        return;
      }
      const saved = await window.workbench.saveCandidate(prepared.nextCandidate);
      setCandidates((items) =>
        items.map((item) => (item.id === saved.id ? saved : item)),
      );
      const result: ExportResult = await window.workbench.exportCandidate(
        selected.id,
      );
      notify({ kind: "success", text: "抖音发布包已生成" });
      await window.workbench.openPath(result.outputDirectory);
      await refresh();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setExporting(false);
    }
  };
  const exportApprovedBatch = async () => {
    const ids = candidates
      .filter((candidate) => candidate.decision === "approved")
      .map((candidate) => candidate.id);
    if (ids.length < 2) return;
    setExporting(true);
    try {
      const result = await window.workbench.exportCandidates(ids);
      notify({ kind: "success", text: `已批量生成 ${result.candidateIds.length} 条发布包` });
      await window.workbench.openPath(result.zipPath);
      await refresh();
    } catch (error) {
      notify({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setExporting(false);
    }
  };
  const contextIsIncluded = (
    context: Pick<TopicContextSegment, "sourceStart" | "sourceEnd">,
    segments: Candidate["renderPlan"]["segments"],
  ) => segments.some(
    (segment) => context.sourceStart < segment.sourceEnd && context.sourceEnd > segment.sourceStart,
  );
  const contextGroupIncludedCount = (
    group: ContextSegmentGroup,
    segments: Candidate["renderPlan"]["segments"],
  ) => group.segments.filter((context) => contextIsIncluded(context, segments)).length;
  const contextGroupSelectionRange = (
    group: ContextSegmentGroup,
    segments: Candidate["renderPlan"]["segments"],
  ) => {
    const overlapping = segments.filter((segment) =>
      group.segments.some(
        (context) => context.sourceStart < segment.sourceEnd && context.sourceEnd > segment.sourceStart,
      ),
    );
    return overlapping.length
      ? {
          sourceStart: Math.min(...overlapping.map((segment) => segment.sourceStart)),
          sourceEnd: Math.max(...overlapping.map((segment) => segment.sourceEnd)),
        }
      : { sourceStart: group.sourceStart, sourceEnd: group.sourceEnd };
  };
  const contextGroupTextForRange = (
    group: ContextSegmentGroup,
    sourceStart: number,
    sourceEnd: number,
  ) => group.segments
    .filter((context) => context.sourceStart < sourceEnd && context.sourceEnd > sourceStart)
    .map((context) => context.text.trim())
    .filter(Boolean)
    .join(" ") || group.text;
  const contextGroupTextSelection = (group: ContextSegmentGroup) => {
    const selection = contextTextSelections[group.relation];
    if (!selection || selection.end <= selection.start) return undefined;
    const selectedIds = new Set(
      group.textRanges
        .filter((range) => range.start < selection.end && range.end > selection.start)
        .map((range) => range.contextId),
    );
    const segments = group.segments.filter((item) => selectedIds.has(item.id));
    if (!segments.length) return undefined;
    const sourceStart = Math.min(...segments.map((item) => item.sourceStart));
    const sourceEnd = Math.max(...segments.map((item) => item.sourceEnd));
    return {
      segments,
      sourceStart,
      sourceEnd,
      text: contextGroupTextForRange(group, sourceStart, sourceEnd),
      selectedText: group.text.slice(selection.start, selection.end).trim(),
    };
  };
  const recordContextTextSelection = (
    relation: ContextGroupRelation,
    target: HTMLTextAreaElement,
  ) => {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    setContextTextSelections((items) => ({
      ...items,
      [relation]: { start, end },
    }));
  };
  const contextRangeIsCovered = (
    segments: Candidate["renderPlan"]["segments"],
    sourceStart: number,
    sourceEnd: number,
  ) => {
    let cursor = sourceStart;
    for (const segment of [...segments]
      .filter((item) => item.sourceStart < sourceEnd && item.sourceEnd > sourceStart)
      .sort((left, right) => left.sourceStart - right.sourceStart)) {
      if (segment.sourceStart > cursor + 0.001) return false;
      cursor = Math.max(cursor, segment.sourceEnd);
      if (cursor >= sourceEnd - 0.001) return true;
    }
    return cursor >= sourceEnd - 0.001;
  };
  const removeContextRange = (
    segments: Candidate["renderPlan"]["segments"],
    group: ContextSegmentGroup,
    sourceStart: number,
    sourceEnd: number,
  ) => segments.flatMap((segment) => {
    if (segment.sourceEnd <= sourceStart || segment.sourceStart >= sourceEnd) {
      return [segment];
    }
    const belongsToGroup = group.segments.some(
      (context) => context.sourceStart < segment.sourceEnd && context.sourceEnd > segment.sourceStart,
    );
    const textForRange = (start: number, end: number) =>
      belongsToGroup ? contextGroupTextForRange(group, start, end) : segment.text;
    const pieces: Candidate["renderPlan"]["segments"] = [];
    if (segment.sourceStart < sourceStart) {
      pieces.push({
        ...segment,
        sourceEnd: sourceStart,
        text: textForRange(segment.sourceStart, sourceStart),
      });
    }
    if (segment.sourceEnd > sourceEnd) {
      pieces.push({
        ...segment,
        id: pieces.length ? crypto.randomUUID() : segment.id,
        sourceStart: sourceEnd,
        text: textForRange(sourceEnd, segment.sourceEnd),
      });
    }
    return pieces;
  });
  const syncContextEdit = (
    segments: Candidate["renderPlan"]["segments"],
    contextSegments: TopicContextSegment[],
  ) => {
    const ordered = segments.map((segment, index) => ({ ...segment, order: index }));
    const subtitleText = ordered.map((segment) => segment.text).join(" ");
    patchCandidate({
      duration: ordered.reduce(
        (sum, segment) => sum + Math.max(0, segment.sourceEnd - segment.sourceStart),
        0,
      ),
      transcriptText: subtitleText,
      contextSegments: contextSegments.map((context) => ({
        ...context,
        included: contextIsIncluded(context, ordered),
      })),
      renderPlan: {
        ...selected!.renderPlan,
        segments: ordered,
        subtitleText,
      },
    });
  };
  const toggleContextSegment = (context: TopicContextSegment) => {
    if (!selected) return;
    const current = selected.renderPlan.segments;
    const included = contextIsIncluded(context, current);
    let segments: Candidate["renderPlan"]["segments"];
    if (included) {
      segments = current.filter(
        (segment) => !(context.sourceStart < segment.sourceEnd && context.sourceEnd > segment.sourceStart),
      );
      if (!segments.length) {
        notify({ kind: "error", text: "至少保留一个入片段落" });
        return;
      }
    } else {
      const next = {
        id: crypto.randomUUID(),
        sourceStart: context.sourceStart,
        sourceEnd: context.sourceEnd,
        text: context.text,
        topicId: selected.topicId,
        order: current.length,
      };
      // Keep the existing opening hook at the front, then place newly added
      // context in source order so adding a lead-in does not destroy the hook.
      const opening = current[0];
      const rest = [...current.slice(1), next].sort(
        (left, right) => left.sourceStart - right.sourceStart,
      );
      segments = opening ? [opening, ...rest] : [next];
    }
    syncContextEdit(
      segments,
      (selected.contextSegments ?? []).map((item) => ({
        ...item,
        included: contextIsIncluded(item, segments),
      })),
    );
  };
  const toggleContextGroup = (group: ContextSegmentGroup) => {
    if (!selected) return;
    const current = selected.renderPlan.segments;
    const textSelection = contextGroupTextSelection(group);
    const range = textSelection
      ? { sourceStart: textSelection.sourceStart, sourceEnd: textSelection.sourceEnd }
      : { sourceStart: group.sourceStart, sourceEnd: group.sourceEnd };
    const covered = contextRangeIsCovered(
      current,
      range.sourceStart,
      range.sourceEnd,
    );
    let segments = removeContextRange(
      current,
      group,
      range.sourceStart,
      range.sourceEnd,
    );
    if (!covered) {
      const next = {
        id: crypto.randomUUID(),
        sourceStart: range.sourceStart,
        sourceEnd: range.sourceEnd,
        text: textSelection?.text || group.text,
        topicId: selected.topicId,
        order: current.length,
      };
      const opening = segments[0];
      const rest = [...segments.slice(1), next].sort(
        (left, right) => left.sourceStart - right.sourceStart,
      );
      segments = opening ? [opening, ...rest] : [next];
    } else if (!segments.length) {
      notify({ kind: "error", text: "至少保留一个入片段落" });
      return;
    }
    syncContextEdit(
      segments,
      (selected.contextSegments ?? []).map((item) => ({
        ...item,
        included: contextIsIncluded(item, segments),
      })),
    );
  };
  const editContextText = (context: TopicContextSegment, text: string) => {
    if (!selected) return;
    const contextSegments = (selected.contextSegments ?? []).map((item) =>
      item.id === context.id ? { ...item, text } : item,
    );
    const segments = selected.renderPlan.segments.map((segment) => {
      if (
        segment.sourceStart < context.sourceEnd
        && segment.sourceEnd > context.sourceStart
      ) {
        return { ...segment, text };
      }
      return segment;
    });
    syncContextEdit(segments, contextSegments);
  };
  const editContextTime = (
    context: TopicContextSegment,
    field: "sourceStart" | "sourceEnd",
    value: number,
  ) => {
    if (!selected || !Number.isFinite(value)) return;
    const contextSegments = (selected.contextSegments ?? []).map((item) =>
      item.id === context.id ? { ...item, [field]: value } : item,
    );
    const segments = selected.renderPlan.segments.map((segment) => {
      if (
        contextIsIncluded(context, selected.renderPlan.segments)
        && segment.sourceStart < context.sourceEnd
        && segment.sourceEnd > context.sourceStart
      ) {
        return { ...segment, [field]: value };
      }
      return segment;
    });
    syncContextEdit(segments, contextSegments);
  };
  const editContextGroupTime = (
    group: ContextSegmentGroup,
    field: "sourceStart" | "sourceEnd",
    value: number,
  ) => {
    if (!selected || !Number.isFinite(value)) return;
    const current = selected.renderPlan.segments;
    const textSelection = contextGroupTextSelection(group);
    if (textSelection) {
      const targetStart = textSelection.sourceStart;
      const targetEnd = textSelection.sourceEnd;
      const nextStart = field === "sourceStart" ? value : targetStart;
      const nextEnd = field === "sourceEnd" ? value : targetEnd;
      if (nextStart >= nextEnd) {
        notify({ kind: "error", text: "入点必须早于出点" });
        return;
      }
      const remaining = removeContextRange(
        current,
        group,
        targetStart,
        targetEnd,
      );
      const next = {
        id: crypto.randomUUID(),
        sourceStart: nextStart,
        sourceEnd: nextEnd,
        text: contextGroupTextForRange(group, nextStart, nextEnd),
        topicId: selected.topicId,
        order: current.length,
      };
      const opening = remaining[0];
      const rest = [...remaining.slice(1), next].sort(
        (left, right) => left.sourceStart - right.sourceStart,
      );
      const segments = opening ? [opening, ...rest] : [next];
      syncContextEdit(
        segments,
        (selected.contextSegments ?? []).map((item) => ({
          ...item,
          included: contextIsIncluded(item, segments),
        })),
      );
      return;
    }
    const matchesGroup = (segment: Candidate["renderPlan"]["segments"][number]) =>
      group.segments.some(
        (context) => context.sourceStart < segment.sourceEnd && context.sourceEnd > segment.sourceStart,
      );
    const existingOverlapping = current.filter(matchesGroup);
    let segments = current;
    let createdGroupSegmentId: string | undefined;
    if (!existingOverlapping.length) {
      const range = contextGroupSelectionRange(group, current);
      createdGroupSegmentId = crypto.randomUUID();
      const next = {
        id: createdGroupSegmentId,
        sourceStart: range.sourceStart,
        sourceEnd: range.sourceEnd,
        text: contextGroupTextForRange(group, range.sourceStart, range.sourceEnd),
        topicId: selected.topicId,
        order: current.length,
      };
      const opening = current[0];
      const rest = [...current.slice(1), next].sort(
        (left, right) => left.sourceStart - right.sourceStart,
      );
      segments = opening ? [opening, ...rest] : [next];
    }
    const currentRange = contextGroupSelectionRange(group, segments);
    if (
      (field === "sourceStart" && value >= currentRange.sourceEnd)
      || (field === "sourceEnd" && value <= currentRange.sourceStart)
    ) {
      notify({ kind: "error", text: "入点必须早于出点" });
      return;
    }
    const overlapping = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => matchesGroup(segment));
    const boundaryIndex = field === "sourceStart"
      ? overlapping.reduce((best, item) =>
          item.segment.sourceStart < best.segment.sourceStart ? item : best,
        ).index
      : overlapping.reduce((best, item) =>
          item.segment.sourceEnd > best.segment.sourceEnd ? item : best,
        ).index;
    const nextStart = field === "sourceStart" ? value : currentRange.sourceStart;
    const nextEnd = field === "sourceEnd" ? value : currentRange.sourceEnd;
    segments = segments.map((segment, index) => {
      if (index !== boundaryIndex) return segment;
      return {
        ...segment,
        [field]: value,
        ...(createdGroupSegmentId && segment.id === createdGroupSegmentId
          ? { text: contextGroupTextForRange(group, nextStart, nextEnd) }
          : {}),
      };
    });
    syncContextEdit(
      segments,
      (selected.contextSegments ?? []).map((item) => ({
        ...item,
        included: contextIsIncluded(item, segments),
      })),
    );
  };
  const renderContextSegmentCard = (context: TopicContextSegment) => {
    const included = contextIsIncluded(context, selected!.renderPlan.segments);
    const label = context.relation === "before"
      ? "前文"
      : context.relation === "after"
        ? "后文"
        : included
          ? "当前入片"
          : "关联段落";
    return (
      <div
        className={`context-card context-detail-card ${included ? "included" : ""}`}
        key={context.id}
      >
        <div className="context-card-head">
          <div>
            <span className={`context-badge ${context.relation}`}>
              {label}
            </span>
            <small>
              {formatDuration(context.sourceStart)}–{formatDuration(context.sourceEnd)}
            </small>
          </div>
          <button
            className={`context-toggle ${included ? "active" : ""}`}
            type="button"
            onClick={() => toggleContextSegment(context)}
          >
            {included ? "移出成片" : "加入成片"}
          </button>
        </div>
        <textarea
          rows={2}
          value={context.text}
          onChange={(event) => editContextText(context, event.target.value)}
        />
          <div className="time-row">
            <label>
              入点
              <TimeInput
                value={context.sourceStart}
                onCommit={(value) => editContextTime(context, "sourceStart", value)}
              />
            </label>
            <label>
              出点
              <TimeInput
                value={context.sourceEnd}
                onCommit={(value) => editContextTime(context, "sourceEnd", value)}
              />
            </label>
          </div>
      </div>
    );
  };
  const selectAdjacent = useCallback(
    (direction: -1 | 1) => {
      if (!selected) return;
      const index = visible.findIndex((item) => item.id === selected.id);
      const next = visible[index + direction];
      if (next) setSelectedId(next.id);
    },
    [selected, visible],
  );
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          (event.target as HTMLElement)?.tagName,
        )
      )
        return;
      if (event.key === "ArrowRight") selectAdjacent(1);
      if (event.key === "ArrowLeft") selectAdjacent(-1);
      if (event.key.toLowerCase() === "a") void review("approved");
      if (event.key.toLowerCase() === "x") setRejecting(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  if (!reviewable.length)
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <span className="eyebrow">REVIEW FEED</span>
            <h1>候选审核</h1>
          </div>
        </header>
        <div className="empty-hero">
          <div className="empty-graphic">
            <Icon name="play" size={42} />
          </div>
          <h2>还没有可审核的候选</h2>
          <p>任务完成分析与预览后，会自动出现在这里。</p>
        </div>
      </div>
    );
  return (
    <div className="review-page">
      <div className="review-topbar">
        <div>
          <span>审核任务</span>
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            {reviewable.map((item) => (
              <option key={item.id} value={item.id}>
                {accounts.find((a) => a.id === item.accountId)?.name} ·{" "}
                {item.name}
              </option>
            ))}
          </select>
          {task?.checkpoint?.modelCall ? (
            <small
              className={`model-call-status ${
                task.checkpoint.modelCall.status === "success" ? "success" : "error"
              }`}
              title={task.checkpoint.modelCall.error}
            >
              {task.checkpoint.modelCall.status === "success"
                ? `DeepSeek 已调用 · ${task.checkpoint.modelCall.model}${
                    task.checkpoint.modelCall.usage?.totalTokens
                      ? ` · ${task.checkpoint.modelCall.usage.totalTokens} tokens`
                      : ""
                  }${
                    task.checkpoint.modelCall.callCount &&
                    task.checkpoint.modelCall.callCount > 1
                      ? ` · ${task.checkpoint.modelCall.callCount} 次请求`
                      : ""
                  }`
                : "DeepSeek 调用失败"}
            </small>
          ) : null}
        </div>
        <div className="review-topbar-actions">
          <div className="shortcut-hints">
            <kbd>←</kbd>
            <kbd>→</kbd> 切换 <kbd>A</kbd> 通过 <kbd>X</kbd> 驳回
          </div>
          {candidates.length === 0 || candidates.every((item) => item.decision === "rejected") ? (
            <button className="button danger small" onClick={() => void deleteRejectedTask()}>
              删除整场任务
            </button>
          ) : null}
        </div>
      </div>
      <div className="review-layout">
        <aside className="candidate-rail">
          <div className="rail-heading">
            <strong>候选片段</strong>
            <span>
              {visible.length}/{candidates.length}
            </span>
          </div>
          {visible.map((candidate) => (
            <button
              key={candidate.id}
              className={`candidate-item ${selected?.id === candidate.id ? "active" : ""}`}
              onClick={() => setSelectedId(candidate.id)}
            >
              <span className="candidate-rank">{candidate.rank}</span>
              <div>
                <strong>{candidate.title}</strong>
                <small>
                  {formatDuration(candidate.duration)} ·{" "}
                  {candidate.riskFlags.length
                    ? `${candidate.riskFlags.length} 项风险`
                    : "风险正常"}
                </small>
              </div>
              <i className={`decision-dot ${candidate.decision}`} />
            </button>
          ))}
          {candidates.some((item) => item.tier === "more") && (
            <button
              className="show-more"
              onClick={() => setShowMore((value) => !value)}
            >
              {showMore
                ? "收起更多候选"
                : `展开更多候选（${candidates.filter((item) => item.tier === "more").length}）`}
            </button>
          )}
        </aside>
        {selected && (
          <>
            <section className="video-stage">
              <div className="phone-frame">
                {selected.previewPath ? (
                  <video
                    // The renderer replaces the preview at the same path after
                    // a subtitle edit. Remount on the render fingerprint so
                    // Chromium cannot keep playing the previous media buffer.
                    key={`${selected.previewPath}:${selected.previewPlanFingerprint ?? selected.updatedAt}`}
                    src={toFileUrl(selected.previewPath, selected.updatedAt)}
                    controls
                    autoPlay
                  />
                ) : (
                  <div className="preview-placeholder">
                    <Icon name="play" size={34} />
                    <strong>
                      {previewingId === selected.id
                        ? "正在生成预览…"
                        : "预览暂未生成"}
                    </strong>
                    <span>
                      {previewErrors[selected.id] || selected.previewError
                        ? "生成失败，可重试或先查看原片时间码"
                        : "首次打开更多候选时会自动生成，稍等片刻即可播放"}
                    </span>
                    {(previewErrors[selected.id] || selected.previewError) && (
                      <small className="preview-error-detail">
                        {previewErrors[selected.id] || selected.previewError}
                      </small>
                    )}
                    {(previewErrors[selected.id] || selected.previewError) && (
                      <button
                        className="button secondary"
                        onClick={() => void regeneratePreview(selected.id)}
                      >
                        重新生成预览
                      </button>
                    )}
                  </div>
                )}
              </div>
              {selected.renderPlan.effectPreset && (
                <div className="effect-note">
                  <span>已处理</span> 开头句优先 · 保留原画面与原贴片 · 片段淡入淡出
                </div>
              )}
              <div className="review-primary-actions">
                <button
                  className="reject-button"
                  onClick={() => setRejecting(true)}
                >
                  <Icon name="close" />
                  驳回 <span>X</span>
                </button>
                <button
                  className="approve-button"
                  onClick={() => void review("approved")}
                >
                  <Icon name="check" />
                  通过 <span>A</span>
                </button>
              </div>
              {selected.decision === "approved" && (
                <div className="post-approval review-post-approval">
                  {publicationStatus && (
                    <div className={`review-publish-status ${publicationStatus.kind}`}>
                      <div>
                        <span>发布状态</span>
                        <strong>{publicationStatus.label}</strong>
                      </div>
                      <small>{publicationStatus.detail}</small>
                    </div>
                  )}
                  <button
                    className="button primary"
                    disabled={exporting}
                    onClick={() => void exportClip()}
                  >
                    {exporting ? "正在生成抖音发布包…" : "生成抖音发布包"}
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => setPerformanceCandidate(selected)}
                  >
                    登记发布数据
                  </button>
                  {candidates.filter((candidate) => candidate.decision === "approved").length > 1 && (
                    <button
                      className="button secondary"
                      disabled={exporting}
                      onClick={() => void exportApprovedBatch()}
                    >
                      批量导出已通过候选
                    </button>
                  )}
                </div>
              )}
            </section>
            <aside className="edit-panel">
              <div className="edit-scroll">
                <div className="edit-panel-head">
                  <div>
                    <span className={`tier-label ${selected.tier}`}>
                      {selected.tier === "featured" ? "精选候选" : "更多候选"}
                    </span>
                    <h2>{selected.title}</h2>
                  </div>
                  <div className="edit-panel-head-actions">
                    <button className="icon-button" onClick={() => void save()} title="保存修改">
                      <Icon name="check" />
                    </button>
                    {selected.decision === "rejected" && (
                      <button
                        className="button danger small"
                        onClick={() => void deleteRejectedCandidate()}
                      >
                        删除候选
                      </button>
                    )}
                  </div>
                </div>
                <Field label="标题">
                  <input
                    value={selected.title}
                    onChange={(e) =>
                      patchCandidate({
                        title: e.target.value,
                        renderPlan: {
                          ...selected.renderPlan,
                          title: e.target.value,
                        },
                      })
                    }
                  />
                </Field>
                <Field
                  label="开头钩子（真实音频前置）"
                  hint="系统会把匹配到的原始时间段放到片头；这里的文字是钩子说明/字幕，不会单独生成新音频。"
                >
                  <textarea
                    rows={2}
                    value={selected.hookText}
                    onChange={(e) =>
                      patchCandidate({
                        hookText: e.target.value,
                        renderPlan: {
                          ...selected.renderPlan,
                          hookText: e.target.value,
                        },
                      })
                    }
                  />
                </Field>
                {selected.riskFlags.length > 0 && (
                  <div className="risk-box">
                    <div className="risk-title">
                      <Icon name="warning" />
                      <strong>内容风险确认</strong>
                    </div>
                    {selected.riskFlags.map((risk, index) => (
                      <div
                        className={`risk-item risk-${risk.level}`}
                        key={`${risk.type}-${index}`}
                      >
                        <div>
                          <span>
                            {risk.level === "high" ? "高风险" : "需留意"}
                          </span>
                          <strong>{risk.reason}</strong>
                        </div>
                        {(risk.contextBefore || risk.contextAfter) && (
                          <details>
                            <summary>查看前后文</summary>
                            <p>{risk.contextBefore}</p>
                            <p>{risk.contextAfter}</p>
                          </details>
                        )}
                        {risk.level === "high" && (
                          <button
                            disabled={risk.acknowledged}
                            onClick={() => void acknowledge(index)}
                          >
                            {risk.acknowledged ? "已确认" : "确认理解风险"}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="segment-heading">
                  <strong>话题前后文</strong>
                  <span>
                    {account && (usesAdmissionsReviewPreset(account.selectionPrinciples)
                      ? "前后各延展 90 秒"
                      : "前后各延展 60 秒")}
                    ；已按前文/当前入片/后文聚合，可对照原话、选范围并加入成片
                  </span>
                </div>
                {contextGroups.length ? (
                  <div className="context-list context-group-list">
                    {contextGroups.map((group) => {
                      const includedCount = contextGroupIncludedCount(
                        group,
                        selected.renderPlan.segments,
                      );
                      const included = includedCount > 0;
                      const textSelection = contextGroupTextSelection(group);
                      const selectionRange = textSelection
                        ? {
                            sourceStart: textSelection.sourceStart,
                            sourceEnd: textSelection.sourceEnd,
                          }
                        : contextGroupSelectionRange(group, selected.renderPlan.segments);
                      const groupCovered = contextRangeIsCovered(
                        selected.renderPlan.segments,
                        group.sourceStart,
                        group.sourceEnd,
                      );
                      const selectionCovered = textSelection
                        ? contextRangeIsCovered(
                            selected.renderPlan.segments,
                            textSelection.sourceStart,
                            textSelection.sourceEnd,
                          )
                        : false;
                      const actionCovered = textSelection ? selectionCovered : groupCovered;
                      const label = group.relation === "before"
                        ? "前文"
                        : group.relation === "after"
                          ? "后文"
                          : included
                            ? "当前入片"
                            : "关联段落";
                      return (
                        <div
                          className={`context-card context-group-card ${included ? "included" : ""}`}
                          key={`context-group-${group.relation}`}
                        >
                          <div className="context-card-head">
                            <div>
                              <span className={`context-badge ${group.relation}`}>
                                {label}
                              </span>
                              <small>
                                {formatDuration(selectionRange.sourceStart)}–{formatDuration(selectionRange.sourceEnd)}
                                {` · ${includedCount}/${group.segments.length} 段已入片`}
                              </small>
                            </div>
                            <button
                              className={`context-toggle ${actionCovered ? "active" : ""}`}
                              type="button"
                              onClick={() => toggleContextGroup(group)}
                            >
                              {textSelection
                                ? (selectionCovered ? "移出选中" : "加入选中")
                                : (groupCovered ? "移出整段" : "加入整段")}
                            </button>
                          </div>
                          <textarea
                            className="context-group-summary context-group-textarea"
                            rows={7}
                            readOnly
                            value={group.text || "当前区域没有可显示文字"}
                            aria-label={`${label}文字，可框选范围`}
                            onSelect={(event) =>
                              recordContextTextSelection(group.relation, event.currentTarget)
                            }
                            onMouseUp={(event) =>
                              recordContextTextSelection(group.relation, event.currentTarget)
                            }
                            onKeyUp={(event) =>
                              recordContextTextSelection(group.relation, event.currentTarget)
                            }
                          />
                          <small className="context-selection-note">
                            {textSelection
                              ? `已框选 ${textSelection.selectedText.length} 个字，点击按钮只处理选中范围`
                              : "可在文字框内拖选一部分文字，再点击“加入选中”或“移出选中”"}
                          </small>
                          <div className="time-row">
                            <label>
                              入点
                              <TimeInput
                                value={selectionRange.sourceStart}
                                onCommit={(value) =>
                                  editContextGroupTime(group, "sourceStart", value)
                                }
                              />
                            </label>
                            <label>
                              出点
                              <TimeInput
                                value={selectionRange.sourceEnd}
                                onCommit={(value) =>
                                  editContextGroupTime(group, "sourceEnd", value)
                                }
                              />
                            </label>
                          </div>
                          <details className="context-group-details">
                            <summary>
                              展开逐字段（{group.segments.length} 段，可单独加入、移出和微调）
                            </summary>
                            <div className="context-group-segments">
                              {group.segments.map(renderContextSegmentCard)}
                            </div>
                          </details>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="context-empty">
                    当前候选没有加载到逐字稿前后文，请重新打开审核页或按新规则重筛。
                  </div>
                )}
                <div className="edit-section-label">
                  <strong>成片字幕</strong>
                  <span>这里的文字会直接决定最终字幕和音频片段顺序</span>
                </div>
                <Field
                  className="final-subtitle-field"
                  label="最终字幕"
            hint="按换行或句号分段后，可删除、调换顺序，也可以在句中删掉少量无用字；局部删改时字幕和对应音频会一起剪除。新增内容必须来自上方逐字稿前后文。点击“同步并保存切片”后，预览会按真实片段时间重新生成；只改草稿未保存时，预览仍代表上次已保存版本。"
                >
                  <textarea
                    rows={10}
                    aria-label="最终字幕，可编辑文字并调整顺序"
                    value={selected.renderPlan.subtitleText}
                    onChange={(e) => {
                      patchCandidate({
                        renderPlan: {
                          ...selected.renderPlan,
                          subtitleText: e.target.value,
                        },
                      });
                      setSubtitleSyncNotice(selected.id, {
                        kind: "info",
                        text: "字幕已修改；移开输入框会预匹配，点击“同步并保存切片”会更新音视频并重建预览。",
                      });
                    }}
                    onBlur={(event) => void syncSubtitleDraft(event.currentTarget.value)}
                  />
                  <div className="subtitle-sync-actions">
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={wordAligningId === selected.id}
                      onClick={() => void syncSubtitleAndSave()}
                    >
                      {wordAligningId === selected.id ? "正在精确定位…" : "同步并保存切片"}
                    </button>
                    {subtitleSyncNoticeFor(selected.id) ? (
                      <span
                        className={`subtitle-sync-status ${subtitleSyncNoticeFor(selected.id)?.kind}`}
                      >
                        {subtitleSyncNoticeFor(selected.id)?.text}
                      </span>
                    ) : null}
                  </div>
                </Field>
                <div className="edit-history-toolbar">
                  <button
                    className="button ghost small"
                    type="button"
                    disabled={!(selected.editHistory?.length)}
                    onClick={() => void undoCandidateEdit()}
                  >
                    撤回
                  </button>
                  <button
                    className="button ghost small"
                    type="button"
                    onClick={() =>
                      setHistoryOpen((items) => ({
                        ...items,
                        [selected.id]: !items[selected.id],
                      }))
                    }
                  >
                    历史版本（{selected.editHistory?.length ?? 0}）
                  </button>
                </div>
                {historyOpen[selected.id] ? (
                  <div className="edit-history-list">
                    {(selected.editHistory ?? []).length ? (
                      [...(selected.editHistory ?? [])].reverse().map((version) => {
                        const isCurrent = candidateMatchesEditVersion(selected, version);
                        const historyItemKey = `${selected.id}:${version.version}:${version.savedAt}`;
                        const expanded = Boolean(historyExpanded[historyItemKey]);
                        const fullSubtitle = version.renderPlan.subtitleText.trim();
                        const subtitlePreviewSource = fullSubtitle.replace(/\s+/gu, " ");
                        const subtitlePreview = subtitlePreviewSource.length > 110
                          ? `${subtitlePreviewSource.slice(0, 91)}…${subtitlePreviewSource.slice(-18)}`
                          : subtitlePreviewSource;
                        return (
                          <div
                            className={`edit-history-item ${isCurrent ? "current" : ""}`}
                            key={`${version.version}-${version.savedAt}`}
                          >
                            <div className="edit-history-main">
                              <strong>{version.label}</strong>
                              <small>
                                {new Date(version.savedAt).toLocaleString("zh-CN")} · {formatDuration(version.duration)} · {version.renderPlan.segments.length} 段
                              </small>
                              <div className="edit-history-copy">
                                <div><span>标题</span>{version.title.trim() || "—"}</div>
                                <div><span>钩子</span>{version.hookText.trim() || "—"}</div>
                                <div className={`history-text-block ${expanded ? "expanded" : ""}`}>
                                  <span>字幕</span>{expanded ? fullSubtitle || "—" : subtitlePreview || "—"}
                                </div>
                                {expanded ? (
                                  <div className="history-text-block expanded">
                                    <span>逐字稿</span>{version.transcriptText.trim() || "—"}
                                  </div>
                                ) : null}
                                <button
                                  className="history-text-toggle"
                                  type="button"
                                  onClick={() =>
                                    setHistoryExpanded((items) => ({
                                      ...items,
                                      [historyItemKey]: !items[historyItemKey],
                                    }))
                                  }
                                >
                                  {expanded ? "收起文字" : "展开文字"}
                                </button>
                              </div>
                            </div>
                            <button
                              className="context-toggle"
                              type="button"
                              disabled={isCurrent}
                              onClick={() => void restoreHistoryVersion(version)}
                            >
                              {isCurrent ? "当前版本" : "恢复"}
                            </button>
                          </div>
                        );
                      })
                    ) : (
                      <span>保存修改后，这里会记录版本。</span>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="edit-footer">
                <button
                  className="button secondary"
                  onClick={() => void save()}
                >
                  保存修改
                </button>
              </div>
            </aside>
          </>
        )}
      </div>
      {rejecting && (
        <Modal title="驳回候选" onClose={() => setRejecting(false)}>
          <div className="modal-body">
            <p className="modal-intro">
              选择一个最主要的原因，系统会把它加入该账号的后续偏好。
            </p>
            <div className="reason-grid">
              {(
                Object.entries(REJECTION_LABELS) as [RejectionReason, string][]
              ).map(([key, label]) => (
                <button
                  className={rejectReason === key ? "active" : ""}
                  onClick={() => setRejectReason(key)}
                  key={key}
                >
                  {label}
                </button>
              ))}
            </div>
            <Field label="补充说明（可选）">
              <textarea
                rows={3}
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
              />
            </Field>
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setRejecting(false)}
            >
              取消
            </button>
            <button
              className="button danger"
              onClick={() => void review("rejected")}
            >
              确认驳回
            </button>
          </div>
        </Modal>
      )}
      {performanceCandidate && (
        <PerformanceModal
          candidate={performanceCandidate}
          accountId={task!.accountId}
          onClose={() => setPerformanceCandidate(null)}
          onSaved={() => void loadPerformance(performanceCandidate.id)}
          notify={notify}
        />
      )}
    </div>
  );
}

function PerformanceModal({
  candidate,
  accountId,
  onClose,
  onSaved,
  notify,
}: {
  candidate: Candidate;
  accountId: string;
  onClose: () => void;
  onSaved?: () => void;
  notify: (toast: Toast) => void;
}) {
  const [form, setForm] = useState({
    platform: "douyin" as const,
    publishedAt: new Date().toISOString().slice(0, 16),
    publicationUrl: "",
    window: "published" as const,
    views: 0,
    completionRate: 0,
    likes: 0,
    comments: 0,
    shares: 0,
  });
  const save = async () => {
    await window.workbench.savePerformance({
      ...form,
      accountId,
      candidateId: candidate.id,
      publishedAt: new Date(form.publishedAt).toISOString(),
    });
    notify({
      kind: "success",
      text:
        form.window === "published"
          ? "发布已登记，将在 T+3/T+7 提醒回填"
          : "发布表现已登记，并计入账号近期基线",
    });
    onSaved?.();
    onClose();
  };
  return (
    <Modal title="登记发布表现" onClose={onClose}>
      <div className="modal-body">
        <Field label="发布平台">
          <select
            value={form.platform}
            onChange={(e) =>
              setForm({
                ...form,
                platform: e.target.value as typeof form.platform,
              })
            }
          >
            <option value="douyin">抖音</option>
            <option value="wechat_channels">视频号</option>
            <option value="xiaohongshu">小红书</option>
          </select>
        </Field>
        <Field label="发布链接">
          <input
            value={form.publicationUrl}
            onChange={(e) =>
              setForm({ ...form, publicationUrl: e.target.value })
            }
          />
        </Field>
        <div className="form-grid two">
          <Field label="发布时间">
            <input
              type="datetime-local"
              value={form.publishedAt}
              onChange={(e) =>
                setForm({ ...form, publishedAt: e.target.value })
              }
            />
          </Field>
          <Field label="数据窗口">
            <select
              value={form.window}
              onChange={(e) =>
                setForm({
                  ...form,
                  window: e.target.value as typeof form.window,
                })
              }
            >
              <option value="published">刚发布，安排提醒</option>
              <option value="day3">发布后第 3 天</option>
              <option value="day7">发布后第 7 天</option>
            </select>
          </Field>
        </div>
        {form.window !== "published" && (
          <div className="form-grid three">
            <Field label="播放量">
              <input
                type="number"
                value={form.views}
                onChange={(e) =>
                  setForm({ ...form, views: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="完播率（0–1）">
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={form.completionRate}
                onChange={(e) =>
                  setForm({ ...form, completionRate: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="点赞">
              <input
                type="number"
                value={form.likes}
                onChange={(e) =>
                  setForm({ ...form, likes: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="评论">
              <input
                type="number"
                value={form.comments}
                onChange={(e) =>
                  setForm({ ...form, comments: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="分享">
              <input
                type="number"
                value={form.shares}
                onChange={(e) =>
                  setForm({ ...form, shares: Number(e.target.value) })
                }
              />
            </Field>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          取消
        </button>
        <button className="button primary" onClick={() => void save()}>
          保存数据
        </button>
      </div>
    </Modal>
  );
}

function SettingsView({
  notify,
  onSettingsSaved,
}: {
  notify: (toast: Toast) => void;
  onSettingsSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");
  const [feishuStatus, setFeishuStatus] = useState<FeishuConnectionInfo | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState("");
  const [testingModel, setTestingModel] = useState(false);
  useEffect(() => {
    void Promise.all([
      window.workbench.getSettings(),
      window.workbench.getFeishuStatus(),
    ]).then(([savedSettings, status]) => {
      setSettings(savedSettings);
      setFeishuStatus(status);
    });
  }, []);
  if (!settings)
    return (
      <div className="page">
        <div className="loading">正在读取本地设置…</div>
      </div>
    );
  const chooseDir = async (key: "workspacePath" | "feishuSyncPath") => {
    const paths = await window.workbench.selectFiles({ type: "directory" });
    if (paths[0]) setSettings({ ...settings, [key]: paths[0] });
  };
  const chooseBinary = async (key: "ffmpegPath" | "ffprobePath") => {
    const paths = await window.workbench.selectFiles({ type: "binary" });
    if (paths[0]) setSettings({ ...settings, [key]: paths[0] });
  };
  const save = async () => {
    try {
      setSettings(
        await window.workbench.saveSettings({
          ...settings,
          apiKey: apiKey || undefined,
          feishuAppSecret: feishuAppSecret || undefined,
        }),
      );
      setApiKey("");
      setFeishuAppSecret("");
      setFeishuStatus(await window.workbench.getFeishuStatus());
      notify({ kind: "success", text: "本地设置已保存" });
      await onSettingsSaved();
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const connectFeishu = async () => {
    try {
      const saved = await window.workbench.saveSettings({
        ...settings,
        feishuAppSecret: feishuAppSecret || undefined,
      });
      setSettings(saved);
      setFeishuAppSecret("");
      const status = await window.workbench.connectFeishu();
      setFeishuStatus(status);
      notify({ kind: "success", text: status.message });
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      setFeishuStatus(await window.workbench.getFeishuStatus());
    }
  };
  const disconnectFeishu = async () => {
    try {
      setFeishuStatus(await window.workbench.disconnectFeishu());
      notify({ kind: "info", text: "已断开飞书授权；本地业务数据没有删除" });
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const testFeishuFolder = async () => {
    try {
      const saved = await window.workbench.saveSettings(settings);
      setSettings(saved);
      const result = await window.workbench.testFeishuUpdateFolder();
      const updated = await window.workbench.saveSettings({
        ...saved,
        feishuUpdateFolderToken: result.folderToken,
      });
      setSettings(updated);
      setFeishuStatus(await window.workbench.getFeishuStatus());
      notify({ kind: "success", text: "飞书更新文件夹已验证，可以用于发布和检查更新" });
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const backup = async () => {
    try {
      const destination = await window.workbench.backupNow();
      notify({ kind: "success", text: `已备份到 ${destination}` });
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const checkUpdate = async () => {
    const result = await window.workbench.checkForUpdate();
    setUpdateInfo(result);
    notify({ kind: result.available ? "info" : "success", text: result.message });
  };
  const testModel = async () => {
    setTestingModel(true);
    try {
      const connectionInput: ModelConnectionInput = {
        apiKey: apiKey.trim() || undefined,
        baseUrl: settings.deepseekBaseUrl.trim() || undefined,
        model: settings.deepseekModel.trim() || undefined,
      };
      const result: ModelHealth = await window.workbench.testModelConnection(
        connectionInput,
      );
      const usage = result.usage?.totalTokens
        ? ` · 本次 ${result.usage.totalTokens} tokens`
        : "";
      notify({
        kind: result.ok ? "success" : "error",
        text: result.ok
          ? `DeepSeek API 已连通（${result.model}，${result.latencyMs} ms${usage}）`
          : `DeepSeek API 未连通：${result.message}`,
      });
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingModel(false);
    }
  };
  const installUpdate = async () => {
    const request = updateInstallRequest(updateInfo);
    if (!request || installingUpdate) return;
    setInstallingUpdate(true);
    try {
      await window.workbench.installUpdate(request);
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstallingUpdate(false);
    }
  };
  const publishUpdate = async () => {
    try {
      // Persist the selected Feishu directory before opening the publish
      // confirmation, so a just-selected path cannot be missed.
      const saved = await window.workbench.saveSettings(settings);
      setSettings(saved);
      const result: UpdatePublishResult = await window.workbench.publishUpdate(
        releaseNotes,
      );
      const warning = result.warnings.length
        ? `；提醒：${result.warnings.join("；")}`
        : "";
      notify({
        kind: "success",
        text: result.source === "feishu"
          ? `已发布到飞书云盘：${result.version}（${result.files.length} 个文件${warning}）`
          : `已写入本地同步目录：${result.version}（${result.files.length} 个文件${warning}）`,
      });
      setReleaseNotes("");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      notify({
        kind: text.includes("已取消") ? "info" : "error",
        text,
      });
    }
  };
  return (
    <div className="page settings-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">LOCAL SETTINGS</span>
          <h1>本地设置</h1>
          <p>密钥与视频都留在这台电脑；备份中不会包含 API Key。</p>
        </div>
        <button className="button primary" onClick={() => void save()}>
          保存设置
        </button>
      </header>
      <div className="settings-grid">
        <section className="panel settings-card">
          <div className="settings-icon">
            <Icon name="spark" />
          </div>
          <div className="settings-content">
            <h2>DeepSeek</h2>
            <p>
              用于话题识别、候选排序和抖音发布文案。当前接口接收逐字稿与账号资料，
              不会直接读取本机视频画面。
            </p>
            <Field
              label={`API Key ${settings.hasApiKey ? "· 已配置" : "· 未配置"}`}
            >
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  settings.hasApiKey ? "留空则保持现有 Key" : "sk-..."
                }
              />
            </Field>
            <div className="form-grid two">
              <Field label="API 地址">
                <input
                  value={settings.deepseekBaseUrl}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      deepseekBaseUrl: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="模型（固定）" hint="内容筛选固定使用 DeepSeek V4.1 Flash">
                <input
                  value={settings.deepseekModel}
                  readOnly
                />
              </Field>
            </div>
            <div className="post-approval model-test-row">
              <button
                className="button secondary"
                disabled={testingModel}
                onClick={() => void testModel()}
              >
                {testingModel ? "测试中…" : "测试 API 连接"}
              </button>
              <small className="settings-note">
                内容筛选固定请求 V4.1 Flash；点击测试会验证当前 Key 和 API 地址。
              </small>
            </div>
          </div>
        </section>
        <section className="panel settings-card">
          <div className="settings-icon">
            <Icon name="folder" />
          </div>
          <div className="settings-content">
            <h2>文件与飞书同步</h2>
            <p>
              原片在本地保留 {settings.retentionDays}{" "}
              天；业务数据库仍只保存在这台电脑。
            </p>
            <Field label="本地工作目录">
              <div className="input-action">
                <input value={settings.workspacePath} readOnly />
                <button onClick={() => void chooseDir("workspacePath")}>
                  选择
                </button>
              </div>
            </Field>
            <Field
              label="本地同步目录（旧版，可选）"
              hint="仅兼容旧版本地同步/备份；新的飞书云端更新不需要选择 Windows 文件夹。"
            >
              <div className="input-action">
                <input
                  value={settings.feishuSyncPath}
                  readOnly
                  placeholder="尚未选择"
                />
                <button onClick={() => void chooseDir("feishuSyncPath")}>
                  选择
                </button>
              </div>
            </Field>
            <div className="settings-subsection">
              <h3>飞书授权与云端能力</h3>
              <p>授权后可读取素材、导出标注稿或发布软件更新。模型选片会按设置发送逐字稿及相关文字上下文。</p>
              <small className="settings-note">要读取飞书妙记，请在飞书自建应用中开通用户权限：妙记基础读取（minutes:minutes.basic:read）、妙记媒体导出（minutes:minutes.media:export）和妙记逐字稿导出（minutes:minutes.transcript:export）；不要开通旧版 minutes:minute:download；权限变更后请断开并重新连接授权。</small>
              <Field label="飞书自建应用 App ID" hint="在飞书开放平台的“凭证与基础信息”中获取。">
                <input
                  value={settings.feishuAppId}
                  onChange={(event) =>
                    setSettings({ ...settings, feishuAppId: event.target.value })
                  }
                  placeholder="cli_..."
                />
              </Field>
              <Field
                label="飞书自建应用 App Secret"
                hint="只保存在本机系统加密存储中，不会写入业务数据库或发布包。"
              >
                <input
                  type="password"
                  value={feishuAppSecret}
                  onChange={(event) => setFeishuAppSecret(event.target.value)}
                  placeholder="留空则保持已保存的 Secret"
                />
              </Field>
              <div className="post-approval">
                <button className="button secondary" onClick={() => void connectFeishu()}>
                  连接并授权飞书
                </button>
                {feishuStatus?.connected ? (
                  <button className="button ghost" onClick={() => void disconnectFeishu()}>
                    断开授权
                  </button>
                ) : null}
              </div>
              {feishuStatus ? (
                <small className="settings-note">{feishuStatus.message}</small>
              ) : null}
              <Field
                label="更新文件夹链接或 token"
                hint="这里只用于软件版本更新；导入素材时不需要把视频和逐字稿放进这里。"
              >
                <input
                  value={settings.feishuUpdateFolderToken}
                  onChange={(event) =>
                    setSettings({ ...settings, feishuUpdateFolderToken: event.target.value })
                  }
                  placeholder="https://feishu.cn/drive/folder/..."
                />
              </Field>
              <button
                className="button secondary"
                disabled={!feishuStatus?.connected}
                onClick={() => void testFeishuFolder()}
              >
                验证更新文件夹
              </button>
            </div>
            <Field label="原片保留天数">
              <input
                type="number"
                min={7}
                max={180}
                value={settings.retentionDays}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    retentionDays: Number(e.target.value),
                  })
                }
              />
            </Field>
            <button className="button secondary" onClick={() => void backup()}>
              <Icon name="upload" />
              立即备份数据库
            </button>
          </div>
        </section>
        <section className="panel settings-card full">
          <div className="settings-icon">
            <Icon name="settings" />
          </div>
          <div className="settings-content">
            <h2>媒体引擎</h2>
            <p>安装包默认内置 FFmpeg；只有在排查兼容问题时才需要修改。</p>
            <div className="form-grid two">
              <Field label="FFmpeg">
                <div className="input-action">
                  <input value={settings.ffmpegPath} readOnly />
                  <button onClick={() => void chooseBinary("ffmpegPath")}>
                    更换
                  </button>
                </div>
              </Field>
              <Field label="FFprobe">
                <div className="input-action">
                  <input value={settings.ffprobePath} readOnly />
                  <button onClick={() => void chooseBinary("ffprobePath")}>
                    更换
                  </button>
                </div>
              </Field>
            </div>
          </div>
        </section>
        <section className="panel settings-card full">
          <div className="settings-icon">
            <Icon name="refresh" />
          </div>
          <div className="settings-content">
            <h2>版本更新</h2>
            <p>
              {settings.feishuUpdateFolderToken
                ? "工作台会从飞书云盘更新文件夹读取 latest.json，并按当前系统下载对应安装包。"
                : "连接飞书并验证更新文件夹后，工作台会自动检查 Windows 和 Mac 安装包。"}
            </p>
            <Field label="本地更新清单路径（兼容旧版，可选）" hint="只有未配置飞书云端更新文件夹时才会使用。">
              <input
                value={settings.updateManifestPath ?? ""}
                onChange={(e) => setSettings({ ...settings, updateManifestPath: e.target.value })}
                placeholder="留空则使用飞书云端更新"
              />
            </Field>
            <div className="post-approval">
              <button className="button secondary" onClick={() => void checkUpdate()}>
                检查更新
              </button>
              {updateInfo?.available && updateInstallRequest(updateInfo) && (
                <button
                  className="button primary"
                  disabled={installingUpdate}
                  onClick={() => void installUpdate()}
                >
                  {installingUpdate ? "正在下载更新…" : `安装 ${updateInfo.version}`}
                </button>
              )}
            </div>
            {updateInfo && <small className="settings-note">{updateInfo.message}{updateInfo.notes ? ` · ${updateInfo.notes}` : ""}</small>}
            <div className="update-publish-box">
              <Field
                label="本次发布说明"
                hint="程序会自动识别 release 文件夹里的最高版本安装包，并先弹窗让你确认目标目录。"
              >
                <textarea
                  rows={3}
                  value={releaseNotes}
                  onChange={(event) => setReleaseNotes(event.target.value)}
                  placeholder="例如：修复字幕预览不同步，并加入飞书一键发布"
                />
              </Field>
              <button className="button primary" onClick={() => void publishUpdate()}>
                <Icon name="upload" />
                {settings.feishuUpdateFolderToken ? "生成并发布到飞书云盘" : "生成并写入本地目录"}
              </button>
              <small className="settings-note">
                {settings.feishuUpdateFolderToken
                  ? "只需在发布电脑操作一次；其他同事的工作台会从飞书云盘读取并下载对应版本。"
                  : "当前使用旧版本地目录发布；配置飞书云端更新后可取消本地目录。"}
              </small>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
