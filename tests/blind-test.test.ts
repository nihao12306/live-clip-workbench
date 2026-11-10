import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBlindTestSnapshot,
  createBlankBlindTestSession,
  computeBlindTestMetrics,
} from "../src/shared/blind-test";
import type { BlindTestSession } from "../src/shared/types";
import { DatabaseService } from "../src/main/database";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function completedSession(
  sessionNumber: number,
  publishability: BlindTestSession["publishability"],
  manualMinutes = 10,
): BlindTestSession {
  return {
    ...createBlankBlindTestSession(sessionNumber),
    candidates: [{ title: `候选 ${sessionNumber}` }],
    manualMinutes,
    processingMinutes: 3,
    publishability,
  };
}

describe("20 场真实盲测指标", () => {
  it("空白 20 行不被误计为无问题", () => {
    const metrics = computeBlindTestMetrics([]);
    expect(metrics.completedSessions).toBe(0);
    expect(metrics.issueCounts.none).toBe(0);
  });

  it("完成 20 场且轻改率达到 70%、人工平均不超过 12 分钟时通过", () => {
    const sessions = [
      ...Array.from({ length: 14 }, (_, index) =>
        completedSession(index + 1, "light_edit_publishable", 11),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        completedSession(index + 15, "major_edit_required", 11),
      ),
    ];
    const metrics = computeBlindTestMetrics(sessions);

    expect(metrics.completedSessions).toBe(20);
    expect(metrics.lightEditPublishRate).toBe(0.7);
    expect(metrics.lightEditTargetStatus).toBe("passed");
    expect(metrics.manualMinutesTargetStatus).toBe("passed");
    expect(metrics.overallStatus).toBe("passed");
  });

  it("未完成 20 场时不提前判定通过，即使当前比例已经达标", () => {
    const metrics = computeBlindTestMetrics([
      completedSession(1, "light_edit_publishable", 8),
      completedSession(2, "light_edit_publishable", 8),
    ]);

    expect(metrics.completedSessions).toBe(2);
    expect(metrics.remainingSessions).toBe(18);
    expect(metrics.lightEditPublishRate).toBe(1);
    expect(metrics.lightEditTargetStatus).toBe("pending");
    expect(metrics.manualMinutesTargetStatus).toBe("pending");
    expect(metrics.overallStatus).toBe("pending");
    expect(metrics.issueCounts.none).toBe(2);
  });

  it("记录 13/20 轻改可发布或人工平均超过 12 分钟时未达标", () => {
    const sessions = [
      ...Array.from({ length: 13 }, (_, index) =>
        completedSession(index + 1, "light_edit_publishable", 13),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        completedSession(index + 14, "not_publishable", 13),
      ),
    ];
    const metrics = computeBlindTestMetrics(sessions);

    expect(metrics.lightEditPublishRate).toBe(0.65);
    expect(metrics.lightEditTargetStatus).toBe("failed");
    expect(metrics.manualMinutesTargetStatus).toBe("failed");
    expect(metrics.overallStatus).toBe("failed");
  });
});

describe("盲测记录持久化", () => {
  it("保存同一场次会更新原记录并在重启后保留汇总", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-blind-test-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workbench.sqlite");
    const first = new DatabaseService(databasePath);
    await first.initialize();
    first.saveBlindTestSession({
      sessionNumber: 1,
      candidates: [{ title: "第一版候选" }],
      candidateNote: "",
      manualMinutes: 9,
      processingMinutes: 2,
      publishability: "light_edit_publishable",
      issueType: "none",
      notes: "初次记录",
    });
    first.saveBlindTestSession({
      sessionNumber: 1,
      candidates: [{ title: "更新后的候选" }],
      manualMinutes: 10,
      processingMinutes: 2.5,
      publishability: "major_edit_required",
      issueType: "timing",
      notes: "更新判断",
    });
    expect(first.listBlindTestSessions()).toHaveLength(1);
    first.close();

    const second = new DatabaseService(databasePath);
    await second.initialize();
    const snapshot = buildBlindTestSnapshot(second.listBlindTestSessions());
    expect(snapshot.sessions[0]?.candidates[0]?.title).toBe("更新后的候选");
    expect(snapshot.metrics.publishabilityEvaluated).toBe(1);
    expect(snapshot.metrics.issueCounts.timing).toBe(1);
    second.close();
  });
});
