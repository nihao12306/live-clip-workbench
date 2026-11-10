import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../src/main/database";
import type { Candidate, ClipTask } from "../src/shared/types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("DatabaseService", () => {
  it("persists accounts, tasks and restart recovery", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-db-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workbench.sqlite");
    const first = new DatabaseService(databasePath);
    await first.initialize();
    const account = first.saveAccount({ name: "测试老师", audience: "高中家长", persona: "直接专业" });
    const now = new Date().toISOString();
    const task: ClipTask = {
      id: crypto.randomUUID(), accountId: account.id, name: "测试直播", sourceType: "file",
      status: "analyzing", progress: 20, statusMessage: "处理中", workDir: directory, createdAt: now, updatedAt: now
    };
    first.saveTask(task);
    first.close();

    const second = new DatabaseService(databasePath);
    await second.initialize();
    expect(second.listAccounts()[0].name).toBe("测试老师");
    expect(second.recoverInterruptedTasks()).toHaveLength(1);
    expect(second.getTask(task.id)?.status).toBe("imported");
    second.close();
  });

  it("computes a relative performance score from recent local baseline", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-performance-"));
    tempDirs.push(directory);
    const db = new DatabaseService(path.join(directory, "db.sqlite"));
    await db.initialize();
    const base = { accountId: "a", candidateId: "c", platform: "douyin" as const, publishedAt: new Date().toISOString(), publicationUrl: "https://example.com", window: "day3" as const };
    db.savePerformance({ ...base, id: "p1", createdAt: "2026-01-01", views: 1000, completionRate: .2, likes: 10, comments: 2, shares: 1 });
    const result = db.savePerformance({ ...base, id: "p2", createdAt: "2026-01-02", views: 1000, completionRate: .4, likes: 30, comments: 5, shares: 4 });
    expect(result.relativeScore).toBeGreaterThan(1);
    db.close();
  });

  it("marks missing T+3/T+7 publication windows as due", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-reminders-"));
    tempDirs.push(directory);
    const db = new DatabaseService(path.join(directory, "db.sqlite"));
    await db.initialize();
    const publishedAt = new Date(Date.now() - 4 * 86_400_000).toISOString();
    db.savePerformance({
      id: "pub", accountId: "a", candidateId: "c", platform: "douyin", publishedAt,
      publicationUrl: "https://example.com", window: "published", views: 0, completionRate: 0,
      likes: 0, comments: 0, shares: 0, createdAt: publishedAt
    });
    const snapshot = db.snapshot();
    expect(snapshot.remindersDue).toBe(1);
    expect(snapshot.dueReminders[0]).toMatchObject({
      id: "pub:day3",
      accountId: "a",
      candidateId: "c",
      platform: "douyin",
      window: "day3",
      candidateTitle: "未命名切片",
      accountName: "账号已删除",
      taskName: "任务已删除",
    });
    db.savePerformance({
      id: "day3", accountId: "a", candidateId: "c", platform: "douyin", publishedAt,
      publicationUrl: "https://example.com", window: "day3", views: 100, completionRate: .3,
      likes: 2, comments: 1, shares: 0, createdAt: new Date().toISOString()
    });
    expect(db.snapshot().remindersDue).toBe(0);
    db.close();
  });

  it("persists editable candidate history across saves and restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-history-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "db.sqlite");
    const db = new DatabaseService(databasePath);
    await db.initialize();
    const account = db.saveAccount({ name: "历史测试老师" });
    const now = new Date().toISOString();
    const task: ClipTask = {
      id: crypto.randomUUID(), accountId: account.id, name: "历史测试直播", sourceType: "file",
      status: "awaiting_review", progress: 100, statusMessage: "待审核", workDir: directory,
      createdAt: now, updatedAt: now,
    };
    db.saveTask(task);
    const renderPlan = {
      version: 1 as const, sourceVideoPath: path.join(directory, "source.mp4"),
      segments: [{ id: "segment", sourceStart: 0, sourceEnd: 20, text: "原始内容。", topicId: "topic", order: 0 }],
      hookText: "原始内容", title: "原始标题", subtitleText: "原始内容。",
      cropPreset: { topPercent: 0, rightPercent: 0, bottomPercent: 0, leftPercent: 0 },
      subtitleTemplate: { fontFamily: "Microsoft YaHei", fontSize: 58, primaryColor: "#fff", highlightColor: "#d8ff4f", outlineColor: "#101318", bottomMargin: 260 },
      transitionSeconds: 0.14, templateVersion: "test",
    };
    const candidate: Candidate = {
      id: crypto.randomUUID(), taskId: task.id, rank: 1, tier: "featured", topicId: "topic",
      title: "原始标题", hookText: "原始内容", transcriptText: "原始内容。", duration: 20,
      renderPlan, originalRenderPlan: renderPlan, riskFlags: [], decision: "pending",
      createdAt: now, updatedAt: now,
    };
    const first = db.saveCandidate(candidate);
    const edited: Candidate = {
      ...first,
      title: "修改后的标题",
      renderPlan: { ...first.renderPlan, title: "修改后的标题", subtitleText: "修改后的内容。" },
    };
    const second = db.saveCandidate(edited);
    expect(second.editHistory).toHaveLength(2);
    expect(second.editHistory?.[0]?.title).toBe("原始标题");
    db.close();

    const restarted = new DatabaseService(databasePath);
    await restarted.initialize();
    expect(restarted.getCandidate(candidate.id)?.editHistory).toHaveLength(2);
    restarted.close();
  });

  it("deletes rejected candidates and their task records", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-delete-"));
    tempDirs.push(directory);
    const db = new DatabaseService(path.join(directory, "db.sqlite"));
    await db.initialize();
    const account = db.saveAccount({ name: "删除测试老师" });
    const now = new Date().toISOString();
    const task: ClipTask = {
      id: crypto.randomUUID(), accountId: account.id, name: "待清理直播", sourceType: "file",
      status: "awaiting_review", progress: 100, statusMessage: "待审核", workDir: directory,
      createdAt: now, updatedAt: now, checkpoint: { stage: "previews", candidateIds: [], updatedAt: now },
    };
    db.saveTask(task);
    const renderPlan = {
      version: 1 as const, sourceVideoPath: path.join(directory, "source.mp4"),
      segments: [{ id: "segment", sourceStart: 0, sourceEnd: 20, text: "这是一个完整的话题内容。", topicId: "topic", order: 0 }],
      hookText: "这是一个完整的话题内容", title: "完整话题内容", subtitleText: "这是一个完整的话题内容。",
      cropPreset: { topPercent: 0, rightPercent: 0, bottomPercent: 0, leftPercent: 0 },
      subtitleTemplate: { fontFamily: "Microsoft YaHei", fontSize: 58, primaryColor: "#fff", highlightColor: "#d8ff4f", outlineColor: "#101318", bottomMargin: 260 },
      transitionSeconds: 0.14, templateVersion: "test",
    };
    const candidate: Candidate = {
      id: crypto.randomUUID(), taskId: task.id, rank: 1, tier: "featured", topicId: "topic",
      title: "完整话题内容", hookText: "这是一个完整的话题内容", transcriptText: "这是一个完整的话题内容。",
      duration: 20, previewPath: path.join(directory, "preview.mp4"), renderPlan,
      originalRenderPlan: renderPlan, riskFlags: [], decision: "rejected", rejectionReason: "rough_edit",
      createdAt: now, updatedAt: now,
    };
    db.saveCandidate(candidate);
    task.checkpoint!.candidateIds = [candidate.id];
    db.saveTask(task);
    expect(db.deleteCandidate(candidate.id)?.id).toBe(candidate.id);
    expect(db.getCandidate(candidate.id)).toBeUndefined();
    expect(db.getTask(task.id)?.checkpoint?.candidateIds).toEqual([]);
    expect(db.deleteTask(task.id)?.id).toBe(task.id);
    expect(db.getTask(task.id)).toBeUndefined();
    db.close();
  });
});
