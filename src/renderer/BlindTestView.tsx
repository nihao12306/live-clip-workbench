import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BlindTestCandidateRef,
  BlindTestSession,
  BlindTestSnapshot,
  Candidate,
  ClipTask,
  SaveBlindTestSessionInput,
} from "../shared/types";
import {
  BLIND_TEST_ISSUE_LABELS,
  BLIND_TEST_ISSUE_TYPES,
  BLIND_TEST_PUBLISHABILITY_LABELS,
  createBlankBlindTestSession,
  isBlindTestSessionComplete,
  sessionHasCandidate,
} from "../shared/blind-test";
import {
  BLIND_TEST_TOTAL_SESSIONS,
  type BlindTestIssueType,
  type BlindTestPublishability,
} from "../shared/types";

type Toast = { kind: "success" | "error" | "info"; text: string };

const PUBLISHABILITY_OPTIONS = Object.keys(
  BLIND_TEST_PUBLISHABILITY_LABELS,
) as BlindTestPublishability[];

function formatMinutes(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)} 分钟`;
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function statusLabel(status: "pending" | "passed" | "failed"): string {
  return status === "passed" ? "达标" : status === "failed" ? "未达标" : "待完成";
}

function candidateSummary(session: BlindTestSession): string {
  const titles = [
    ...session.candidates.map((candidate) => candidate.title),
    ...(session.candidateNote?.trim() ? [session.candidateNote.trim()] : []),
  ];
  return titles.length ? titles.join("、") : "未记录候选";
}

function cloneCandidate(candidate: Candidate): BlindTestCandidateRef {
  return {
    id: candidate.id,
    taskId: candidate.taskId,
    title: candidate.title,
    rank: candidate.rank,
  };
}

function GateBadge({ status }: { status: "pending" | "passed" | "failed" }) {
  return <span className={`blind-gate-badge ${status}`}>{statusLabel(status)}</span>;
}

function MetricCard({
  label,
  value,
  hint,
  status,
  accent = false,
}: {
  label: string;
  value: string;
  hint: string;
  status?: "pending" | "passed" | "failed";
  accent?: boolean;
}) {
  return (
    <div className={`blind-metric-card ${accent ? "accent" : ""}`}>
      <div className="blind-metric-card-top">
        <span>{label}</span>
        {status && <GateBadge status={status} />}
      </div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

export function BlindTestView({
  tasks,
  notify,
}: {
  tasks: ClipTask[];
  notify: (toast: Toast) => void;
}) {
  const [snapshot, setSnapshot] = useState<BlindTestSnapshot>();
  const [drafts, setDrafts] = useState<Record<number, BlindTestSession>>({});
  const [expanded, setExpanded] = useState<number>(1);
  const [candidateOptions, setCandidateOptions] = useState<Record<string, Candidate[]>>({});
  const [loadingCandidates, setLoadingCandidates] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<number>();
  const [copying, setCopying] = useState(false);

  const loadSnapshot = useCallback(async (initializeDrafts = false) => {
    try {
      const next = await window.workbench.getBlindTestSnapshot();
      setSnapshot(next);
      if (initializeDrafts) {
        setDrafts(
          Object.fromEntries(
            next.sessions.map((session) => [session.sessionNumber, session]),
          ),
        );
      }
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }, [notify]);

  useEffect(() => {
    void loadSnapshot(true);
  }, [loadSnapshot]);

  const ensureCandidates = useCallback(
    (taskId: string) => {
      if (candidateOptions[taskId] || loadingCandidates[taskId]) return;
      setLoadingCandidates((current) => ({ ...current, [taskId]: true }));
      void window.workbench
        .listCandidates(taskId)
        .then((items) => {
          setCandidateOptions((current) => ({ ...current, [taskId]: items }));
        })
        .catch((error) => {
          notify({
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          setLoadingCandidates((current) => ({ ...current, [taskId]: false }));
        });
    },
    [candidateOptions, loadingCandidates, notify],
  );

  useEffect(() => {
    for (const session of Object.values(drafts)) {
      if (session.taskId) ensureCandidates(session.taskId);
    }
  }, [drafts, ensureCandidates]);

  const taskOptions = useMemo(
    () => [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [tasks],
  );

  const updateDraft = (
    sessionNumber: number,
    patch: Partial<BlindTestSession>,
  ) => {
    setDrafts((current) => {
      const existing = current[sessionNumber] ?? createBlankBlindTestSession(sessionNumber);
      return {
        ...current,
        [sessionNumber]: { ...existing, ...patch },
      };
    });
  };

  const selectTask = (sessionNumber: number, taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    updateDraft(sessionNumber, {
      taskId: taskId || undefined,
      taskName: task?.name,
      candidates: [],
    });
    if (taskId) ensureCandidates(taskId);
  };

  const toggleCandidate = (session: BlindTestSession, candidate: Candidate) => {
    const selected = session.candidates.some((item) => item.id === candidate.id);
    updateDraft(session.sessionNumber, {
      candidates: selected
        ? session.candidates.filter((item) => item.id !== candidate.id)
        : [...session.candidates, cloneCandidate(candidate)],
    });
  };

  const saveSession = async (session: BlindTestSession) => {
    setSaving(session.sessionNumber);
    try {
      const input: SaveBlindTestSessionInput = session;
      const saved = await window.workbench.saveBlindTestSession(input);
      setDrafts((current) => ({ ...current, [session.sessionNumber]: saved }));
      await loadSnapshot();
      notify({ kind: "success", text: `第 ${session.sessionNumber} 场盲测已保存` });
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(undefined);
    }
  };

  const copySummary = async () => {
    if (!snapshot) return;
    const { metrics } = snapshot;
    const text = [
      "live-clip-workbench｜20场真实盲测汇总",
      `完成场次：${metrics.completedSessions}/${metrics.totalSessions}`,
      `轻改发布率：${formatRate(metrics.lightEditPublishRate)}（${metrics.lightEditPublishable}/${metrics.publishabilityEvaluated}，目标 70%，${statusLabel(metrics.lightEditTargetStatus)}）`,
      `平均人工操作：${formatMinutes(metrics.averageManualMinutes)}（目标 ≤ 12 分钟，${statusLabel(metrics.manualMinutesTargetStatus)}）`,
      `平均处理时长：${formatMinutes(metrics.averageProcessingMinutes)}`,
      `总体验收：${statusLabel(metrics.overallStatus)}`,
    ].join("\n");
    setCopying(true);
    try {
      await navigator.clipboard.writeText(text);
      notify({ kind: "success", text: "盲测汇总已复制到剪贴板" });
    } catch (error) {
      notify({
        kind: "error",
        text: error instanceof Error ? error.message : "复制失败，请手动查看汇总",
      });
    } finally {
      setCopying(false);
    }
  };

  if (!snapshot) {
    return <div className="page"><div className="loading">正在读取盲测记录…</div></div>;
  }

  const { metrics } = snapshot;
  const progress = Math.round((metrics.completedSessions / metrics.totalSessions) * 100);

  return (
    <div className="page blind-test-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">REAL-WORLD VALIDATION · 20 SESSIONS</span>
          <h1>20 场真实盲测</h1>
          <p>按同一套记录口径完成 20 场，系统自动判断轻改发布率与 12 分钟目标。</p>
        </div>
        <div className="header-actions">
          <button className="button secondary" onClick={() => void copySummary()} disabled={copying}>
            {copying ? "复制中…" : "复制汇总"}
          </button>
          <button className="button ghost" onClick={() => void loadSnapshot()}>
            刷新
          </button>
        </div>
      </header>

      <section className="blind-protocol panel">
        <div className="blind-protocol-icon">20</div>
        <div>
          <strong>执行口径</strong>
          <p>
            每场先按正常工作流处理，再记录结果；“轻改可发布”才计入 70% 分子。
            12 分钟按人工主动操作时长的 20 场平均值判断，机器处理时长单独展示。
          </p>
        </div>
        <div className="blind-progress-block">
          <span>{metrics.completedSessions}/{metrics.totalSessions} 场完成</span>
          <div className="blind-progress"><i style={{ width: `${progress}%` }} /></div>
        </div>
      </section>

      <section className="blind-metrics-grid">
        <MetricCard
          label="轻改发布率"
          value={formatRate(metrics.lightEditPublishRate)}
          hint={`${metrics.lightEditPublishable}/${metrics.publishabilityEvaluated || 0} 场已评估 · 目标 ≥ 70%`}
          status={metrics.lightEditTargetStatus}
          accent
        />
        <MetricCard
          label="平均人工操作"
          value={formatMinutes(metrics.averageManualMinutes)}
          hint={`${metrics.manualDurationCount} 场有时长 · 目标 ≤ 12 分钟`}
          status={metrics.manualMinutesTargetStatus}
        />
        <MetricCard
          label="平均处理时长"
          value={formatMinutes(metrics.averageProcessingMinutes)}
          hint={`${metrics.processingDurationCount} 场有机器处理时长`}
        />
        <MetricCard
          label="总体验收"
          value={statusLabel(metrics.overallStatus)}
          hint={`还需完成 ${metrics.remainingSessions} 场`}
          status={metrics.overallStatus}
        />
      </section>

      <section className="panel blind-issue-panel">
        <div className="panel-heading">
          <div>
            <h2>问题类型分布</h2>
            <p>每场选择一个主要问题类型；无问题也要明确记录。</p>
          </div>
        </div>
        <div className="blind-issue-list">
          {BLIND_TEST_ISSUE_TYPES.map((type) => (
            <div className="blind-issue-chip" key={type}>
              <span className={`blind-issue-dot ${type}`} />
              <span>{BLIND_TEST_ISSUE_LABELS[type]}</span>
              <strong>{metrics.issueCounts[type]}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="panel blind-session-panel">
        <div className="panel-heading">
          <div>
            <h2>场次记录</h2>
            <p>可先保存半成品，完成候选、两项时长和发布可用性后才计入最终验收。</p>
          </div>
          <span className="blind-save-hint">保存按钮只保存当前场</span>
        </div>
        <div className="blind-session-list">
          {snapshot.sessions.map((savedSession) => {
            const session = drafts[savedSession.sessionNumber] ?? savedSession;
            const isOpen = expanded === session.sessionNumber;
            const options = session.taskId ? candidateOptions[session.taskId] ?? [] : [];
            const hasLoadingCandidates = Boolean(session.taskId && loadingCandidates[session.taskId]);
            const complete = isBlindTestSessionComplete(session);
            return (
              <article
                className={`blind-session-row ${isOpen ? "open" : ""} ${complete ? "complete" : ""}`}
                key={session.sessionNumber}
              >
                <div className="blind-session-summary">
                  <div className="blind-session-number">{String(session.sessionNumber).padStart(2, "0")}</div>
                  <div className="blind-session-candidate">
                    <strong title={candidateSummary(session)}>{candidateSummary(session)}</strong>
                    <small>{session.taskName || "尚未关联处理任务"}</small>
                  </div>
                  <label className="blind-compact-field">
                    <span>人工操作</span>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={session.manualMinutes ?? ""}
                      placeholder="分钟"
                      onChange={(event) => updateDraft(session.sessionNumber, {
                        manualMinutes: event.target.value === "" ? undefined : Number(event.target.value),
                      })}
                    />
                  </label>
                  <label className="blind-compact-field">
                    <span>处理时长</span>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={session.processingMinutes ?? ""}
                      placeholder="分钟"
                      onChange={(event) => updateDraft(session.sessionNumber, {
                        processingMinutes: event.target.value === "" ? undefined : Number(event.target.value),
                      })}
                    />
                  </label>
                  <label className="blind-compact-field blind-select-field">
                    <span>发布可用</span>
                    <select
                      value={session.publishability}
                      onChange={(event) => updateDraft(session.sessionNumber, {
                        publishability: event.target.value as BlindTestPublishability,
                      })}
                    >
                      {PUBLISHABILITY_OPTIONS.map((option) => (
                        <option value={option} key={option}>{BLIND_TEST_PUBLISHABILITY_LABELS[option]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="blind-compact-field blind-select-field">
                    <span>问题类型</span>
                    <select
                      value={session.issueType}
                      onChange={(event) => updateDraft(session.sessionNumber, {
                        issueType: event.target.value as BlindTestIssueType,
                      })}
                    >
                      {BLIND_TEST_ISSUE_TYPES.map((option) => (
                        <option value={option} key={option}>{BLIND_TEST_ISSUE_LABELS[option]}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button ghost small blind-expand-button"
                    onClick={() => setExpanded(isOpen ? 0 : session.sessionNumber)}
                  >
                    {isOpen ? "收起" : "编辑候选"}
                  </button>
                  <button
                    className="button primary small blind-save-button"
                    disabled={saving === session.sessionNumber}
                    onClick={() => void saveSession(session)}
                  >
                    {saving === session.sessionNumber ? "保存中…" : "保存"}
                  </button>
                </div>
                {isOpen && (
                  <div className="blind-session-details">
                    <div className="blind-detail-grid">
                      <label className="field">
                        <span className="field-label">关联处理任务</span>
                        <select
                          value={session.taskId ?? ""}
                          onChange={(event) => selectTask(session.sessionNumber, event.target.value)}
                        >
                          <option value="">不关联任务 / 手工录入</option>
                          {taskOptions.map((task) => (
                            <option value={task.id} key={task.id}>
                              {task.name} · {task.status === "awaiting_review" || task.status === "exported" ? "已有候选" : "尚未完成"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span className="field-label">候选摘要（没有现成候选时填写）</span>
                        <input
                          value={session.candidateNote ?? ""}
                          placeholder="例如：关于专业选择的 90 秒回答"
                          onChange={(event) => updateDraft(session.sessionNumber, {
                            candidateNote: event.target.value,
                          })}
                        />
                      </label>
                    </div>
                    <div className="blind-candidate-picker">
                      <div className="blind-detail-heading">
                        <div>
                          <strong>从已有候选中勾选</strong>
                          <span>{session.candidates.length} 条已选</span>
                        </div>
                        {session.taskId && <small>{hasLoadingCandidates ? "正在读取候选…" : "候选标题会保存快照"}</small>}
                      </div>
                      {session.taskId && options.length > 0 ? (
                        <div className="blind-candidate-options">
                          {options.map((candidate) => {
                            const checked = session.candidates.some((item) => item.id === candidate.id);
                            return (
                              <label className={`blind-candidate-option ${checked ? "selected" : ""}`} key={candidate.id}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleCandidate(session, candidate)}
                                />
                                <span className="blind-option-rank">#{candidate.rank}</span>
                                <span>{candidate.title}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="blind-empty-note">
                          {session.taskId
                            ? hasLoadingCandidates ? "正在读取这个任务的候选。" : "这个任务暂无可选候选，请用上面的候选摘要记录。"
                            : "选择处理任务后可从候选中勾选，也可以直接填写候选摘要。"}
                        </p>
                      )}
                    </div>
                    <label className="field blind-notes-field">
                      <span className="field-label">备注</span>
                      <textarea
                        rows={2}
                        value={session.notes}
                        placeholder="记录阻塞点、人工改动或发布判断依据"
                        onChange={(event) => updateDraft(session.sessionNumber, { notes: event.target.value })}
                      />
                    </label>
                    <div className="blind-detail-footer">
                      <span>
                        {sessionHasCandidate(session) ? "已记录候选" : "尚未记录候选"}
                        {session.testedAt ? ` · 最近保存 ${new Date(session.testedAt).toLocaleString("zh-CN")}` : ""}
                      </span>
                      <span>{complete ? "核心字段完整，将计入验收" : "核心字段未完整，不计入最终验收"}</span>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
