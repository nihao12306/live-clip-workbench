import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../src/main/database";
import type { ModelAdapter } from "../src/main/model-adapter";
import { SourceAdapterRegistry } from "../src/main/source-adapters";
import { repairCandidateOpening, TaskProcessor } from "../src/main/task-processor";
import type { Candidate, ClipTask } from "../src/shared/types";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("recoverable task pipeline", () => {
  it("repairs a shortened legacy plan without overriding deliberate reorder", () => {
    const currentSegments = [
      {
        id: "setup",
        sourceStart: 0,
        sourceEnd: 5,
        text: "我觉得甘肃的学生不适合中科大这个学校，你卷不过的，选不过的，",
        topicId: "study",
        order: 0,
      },
      {
        id: "conclusion",
        sourceStart: 10,
        sourceEnd: 18,
        text: "我我我我怎么觉得甘肃的孩子去了中科大有很大的被淘汰的风险，甚至退学的风险。",
        topicId: "study",
        order: 1,
      },
    ];
    const renderPlan = {
      version: 1,
      sourceVideoPath: "video.mp4",
      segments: currentSegments,
      hookText: "高考弱省考生进中科大，可能卷不过被淘汰；选能匹配你80分努力的学校。",
      title: "甘肃390名报中科大，为什么主播劝退？",
      subtitleText: "甘肃学生不适合中科大。\n甘肃孩子有被淘汰风险。",
      cropPreset: "source",
      subtitleTemplate: "bottom",
      transitionSeconds: 0,
      templateVersion: "test",
    } as Candidate["renderPlan"];
    const candidate = {
      renderPlan,
      originalRenderPlan: {
        ...renderPlan,
        segments: [
          { ...currentSegments[0], id: "older", sourceStart: -5, sourceEnd: -1 },
          ...currentSegments,
        ],
      },
      hookText: renderPlan.hookText,
      title: renderPlan.title,
      previewPath: "old-preview.mp4",
    } as Candidate;

    const repaired = repairCandidateOpening(candidate);
    expect(repaired.renderPlan.segments.map((segment) => segment.id)).toEqual([
      "conclusion",
      "setup",
    ]);
    expect(repaired.previewPath).toBeUndefined();
    expect(repaired.renderPlan.subtitleText).toBe("甘肃孩子有被淘汰风险。\n甘肃学生不适合中科大。");
  });

  it("creates featured candidates and stores low-confidence transcript state", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-pipeline-"));
    tempDirs.push(directory);
    const db = new DatabaseService(path.join(directory, "db.sqlite"));
    await db.initialize();
    const account = db.saveAccount({ name: "林老师", minClipSeconds: 15, maxClipSeconds: 90 });
    const videoPath = path.join(directory, "video.mp4");
    const transcriptPath = path.join(directory, "transcript.txt");
    fs.writeFileSync(videoPath, "fake-video");
    fs.writeFileSync(transcriptPath, "很多家长以为补课越多越好。其实真正影响孩子的，是学习目标和反馈。没有目标的努力，只是在重复消耗。家长要先看孩子当前分数和学科短板，再决定是否补课；如果目标是提高成绩，就应该先做一次测评并按反馈调整方法。", "utf8");
    const now = new Date().toISOString();
    const task: ClipTask = { id: "task-1", accountId: account.id, name: "直播", sourceType: "file", sourceVideoPath: videoPath, transcriptPath, status: "imported", progress: 0, statusMessage: "", workDir: directory, createdAt: now, updatedAt: now };
    db.saveTask(task);

    const media = {
      probe: async () => ({ duration: 60, width: 1080, height: 1920 }),
      createPreview: async (_candidate: unknown, _account: unknown, output: string) => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, "preview"); return output; }
    };
    const model: ModelAdapter = {
      analyze: async (input) => [{ topicId: "study", title: "家长如何判断补课是否值得", hookText: "补课多少不是关键，要看分数、短板和反馈", segmentIds: input.transcript.map(item => item.id), riskFlags: [], internalScore: 91 }],
      generatePlatformCopy: async () => ({ title: "", body: "", hashtags: [], pinnedComment: "", coverText: "" })
    };
    const processor = new TaskProcessor(db, media as never, model, new SourceAdapterRegistry());
    await processor.run(task.id);
    const saved = db.getTask(task.id)!;
    const candidates = db.listCandidates(task.id);
    expect(saved.status).toBe("awaiting_review");
    expect(saved.transcriptConfidence).toBe("estimated");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].tier).toBe("featured");
    expect(fs.existsSync(candidates[0].previewPath!)).toBe(true);
    db.close();
  });

  it("pauses an active analysis and resumes from the saved checkpoint", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-pause-"));
    tempDirs.push(directory);
    const db = new DatabaseService(path.join(directory, "db.sqlite"));
    await db.initialize();
    const account = db.saveAccount({ name: "可暂停任务", minClipSeconds: 15, maxClipSeconds: 90 });
    const videoPath = path.join(directory, "video.mp4");
    const transcriptPath = path.join(directory, "transcript.txt");
    fs.writeFileSync(videoPath, "fake-video");
    fs.writeFileSync(
      transcriptPath,
      "很多家长以为补课越多越好。其实真正影响孩子的，是学习目标和反馈。没有目标的努力，只是在重复消耗。家长要先看孩子当前分数和学科短板，再决定是否补课；如果目标是提高成绩，就应该先做一次测评并按反馈调整方法。",
      "utf8",
    );
    const now = new Date().toISOString();
    db.saveTask({
      id: "task-pause",
      accountId: account.id,
      name: "可暂停任务",
      sourceType: "file",
      sourceVideoPath: videoPath,
      transcriptPath,
      status: "imported",
      progress: 0,
      statusMessage: "",
      workDir: directory,
      createdAt: now,
      updatedAt: now,
    });
    const media = {
      probe: async () => ({ duration: 60, width: 1080, height: 1920 }),
      createPreview: async (_candidate: unknown, _account: unknown, output: string) => {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, "preview");
        return output;
      },
    };
    let analyzeCalls = 0;
    const model: ModelAdapter = {
      analyze: async (input, _feedback, signal) => {
        analyzeCalls += 1;
        const candidate = {
          topicId: "study",
          title: "家长如何判断补课是否值得",
          hookText: "补课多少不是关键，要看分数、短板和反馈",
          segmentIds: input.transcript.map((item) => item.id),
          riskFlags: [],
          internalScore: 91,
        };
        if (analyzeCalls === 1 && signal) {
          return new Promise<typeof candidate[]>((resolve) => {
            signal.addEventListener("abort", () => resolve([candidate]), { once: true });
          });
        }
        return [candidate];
      },
      generatePlatformCopy: async () => ({ title: "", body: "", hashtags: [], pinnedComment: "", coverText: "" }),
    };
    const processor = new TaskProcessor(db, media as never, model, new SourceAdapterRegistry());
    const firstRun = processor.run("task-pause");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (analyzeCalls === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(analyzeCalls).toBe(1);
    await processor.pauseTask("task-pause");
    await firstRun;
    expect(db.getTask("task-pause")?.status).toBe("paused");
    expect(db.getTask("task-pause")?.statusMessage).toContain("可点击继续");

    await processor.run("task-pause");
    expect(db.getTask("task-pause")?.status).toBe("awaiting_review");
    expect(analyzeCalls).toBe(2);
    db.close();
  });

  it("keeps a mature topic when a timecoded transcript has many fine-grained segments", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-topic-window-"));
    tempDirs.push(directory);
    const db = new DatabaseService(path.join(directory, "db.sqlite"));
    await db.initialize();
    const account = db.saveAccount({ name: "长逐字稿", minClipSeconds: 15, maxClipSeconds: 90 });
    const videoPath = path.join(directory, "video.mp4");
    const transcriptPath = path.join(directory, "transcript.srt");
    fs.writeFileSync(videoPath, "fake-video");
    const topicText = "家长需要先明确孩子的学习目标，再根据分数和学科短板调整方法；如果目标是提分，就应该先做测评并看反馈，不能只看补课数量。真正有效的补课，要把目标、依据和下一步安排说清楚，最后再比较课程和老师，才能判断是否值得。";
    const srt = Array.from({ length: 40 }, (_, index) => {
      const start = index;
      const end = index + 1;
      const stamp = (value: number) => `00:00:${String(value).padStart(2, "0")},000`;
      return `${index + 1}\n${stamp(start)} --> ${stamp(end)}\n${topicText}\n`;
    }).join("\n");
    fs.writeFileSync(transcriptPath, srt, "utf8");
    const now = new Date().toISOString();
    db.saveTask({
      id: "task-fine-grained-topic",
      accountId: account.id,
      name: "长逐字稿话题",
      sourceType: "file",
      sourceVideoPath: videoPath,
      transcriptPath,
      status: "imported",
      progress: 0,
      statusMessage: "",
      workDir: directory,
      createdAt: now,
      updatedAt: now,
    });
    const media = {
      probe: async () => ({ duration: 40, width: 1080, height: 1920 }),
      createPreview: async (_candidate: unknown, _account: unknown, output: string) => {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, "preview");
        return output;
      },
    };
    const model: ModelAdapter = {
      analyze: async (input) => [
        {
          topicId: "study-goals",
          title: "家长如何根据分数和目标选择补课",
          hookText: "不能只看补课数量，要看目标、短板和反馈",
          segmentIds: input.transcript.map((item) => item.id),
          riskFlags: [],
          internalScore: 91,
        },
      ],
      generatePlatformCopy: async () => ({
        title: "",
        body: "",
        hashtags: [],
        pinnedComment: "",
        coverText: "",
      }),
    };
    const processor = new TaskProcessor(db, media as never, model, new SourceAdapterRegistry());
    await processor.run("task-fine-grained-topic");
    expect(db.getTask("task-fine-grained-topic")?.status).toBe("awaiting_review");
    expect(db.listCandidates("task-fine-grained-topic")).toHaveLength(1);
    expect(db.listCandidates("task-fine-grained-topic")[0]?.renderPlan.segments).toHaveLength(1);
    db.close();
  });

  it("does not guess an in-sentence filler cut from one coarse unpunctuated cue", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-filler-cut-"));
    tempDirs.push(directory);
    const db = new DatabaseService(path.join(directory, "db.sqlite"));
    await db.initialize();
    const account = db.saveAccount({ name: "严格口癖", minClipSeconds: 15, maxClipSeconds: 90 });
    const videoPath = path.join(directory, "video.mp4");
    const transcriptPath = path.join(directory, "transcript.srt");
    fs.writeFileSync(videoPath, "fake-video");
    fs.writeFileSync(
      transcriptPath,
      "1\n00:00:00,000 --> 00:00:40,000\n很多家长以为补课越多越好。然后这个，真正影响孩子的是学习目标和反馈。需要根据分数和学科短板调整方法。如果目标是提分，就应该先做测评再决定是否补课，还要根据反馈调整方法，不能只看补课数量，最后再比较课程和老师。\n",
      "utf8",
    );
    const now = new Date().toISOString();
    db.saveTask({
      id: "task-filler-cut",
      accountId: account.id,
      name: "严格口癖测试",
      sourceType: "file",
      sourceVideoPath: videoPath,
      transcriptPath,
      status: "imported",
      progress: 0,
      statusMessage: "",
      workDir: directory,
      createdAt: now,
      updatedAt: now,
    });
    const media = {
      probe: async () => ({ duration: 60, width: 1080, height: 1920 }),
      createPreview: async (_candidate: unknown, _account: unknown, output: string) => {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, "preview");
        return output;
      },
    };
    const model: ModelAdapter = {
      analyze: async (input) => [{
        topicId: "study",
        title: "家长如何根据分数选择补课",
        hookText: "补课效果不能只看数量，要看目标、短板和反馈",
        segmentIds: input.transcript.map((item) => item.id),
        riskFlags: [],
        internalScore: 92,
      }],
      generatePlatformCopy: async () => ({ title: "", body: "", hashtags: [], pinnedComment: "", coverText: "" }),
    };
    const processor = new TaskProcessor(db, media as never, model, new SourceAdapterRegistry());
    await processor.run("task-filler-cut");
    const segments = db.listCandidates("task-filler-cut")[0]?.renderPlan.segments ?? [];
    expect(segments).toHaveLength(1);
    expect(segments[0]?.sourceStart).toBe(0);
    expect(segments[0]?.sourceEnd).toBe(40);
    expect(db.listCandidates("task-filler-cut")[0]?.transcriptText).toContain("然后这个");
    db.close();
  });

  it("keeps score, major-group and city sub-angles in one school topic", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-related-angles-"));
    tempDirs.push(directory);
    const db = new DatabaseService(path.join(directory, "db.sqlite"));
    await db.initialize();
    const account = db.saveAccount({
      name: "示例账号甲",
      minClipSeconds: 30,
      maxClipSeconds: 300,
      selectionPrinciples: "升学决策选题预设",
    });
    const videoPath = path.join(directory, "video.mp4");
    const transcriptPath = path.join(directory, "transcript.srt");
    fs.writeFileSync(videoPath, "fake-video");
    const cues = [
      [0, 12, "示例大学今年变化比较大，因为560到580分的孩子正在做选择，所以可以重点关注。"],
      [25, 38, "今年专业组拆得更细，人工智能、计算机和统计数学放在一起。"],
      [52, 66, "物理类专业组更友好，历史类法学和行政管理放在一起，要谨慎。"],
      [80, 94, "如果更看重城市和就业，还要把广州和汕头的位置一起比较，再决定是否填报，所以建议家长结合目标谨慎选择。"],
    ];
    const stamp = (value: number) => {
      const minutes = Math.floor((value as number) / 60);
      const seconds = (value as number) % 60;
      return `00:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},000`;
    };
    fs.writeFileSync(
      transcriptPath,
      cues.map(([start, end, text], index) => `${index + 1}\n${stamp(start as number)} --> ${stamp(end as number)}\n${text}\n`).join("\n"),
      "utf8",
    );
    const now = new Date().toISOString();
    db.saveTask({
      id: "task-related-angles",
      accountId: account.id,
      name: "示例大学相关子角度",
      sourceType: "file",
      sourceVideoPath: videoPath,
      transcriptPath,
      status: "imported",
      progress: 0,
      statusMessage: "",
      workDir: directory,
      createdAt: now,
      updatedAt: now,
    });
    const media = {
      probe: async () => ({ duration: 100, width: 1080, height: 1920 }),
      createPreview: async (_candidate: unknown, _account: unknown, output: string) => {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, "preview");
        return output;
      },
    };
    const model: ModelAdapter = {
      analyze: async (input) => [{
        topicId: "shantou",
        title: "560至580分示例大学专业组和城市怎么选",
        hookText: "示例大学专业组拆细了，但城市和科类仍要一起判断",
        segmentIds: input.transcript.map((item) => item.id),
        riskFlags: [],
        internalScore: 90,
        principleScore: 34,
      }],
      generatePlatformCopy: async () => ({ title: "", body: "", hashtags: [], pinnedComment: "", coverText: "" }),
    };
    const processor = new TaskProcessor(db, media as never, model, new SourceAdapterRegistry());
    await processor.run("task-related-angles");
    const candidate = db.listCandidates("task-related-angles")[0];
    expect(candidate).toBeTruthy();
    expect(candidate?.transcriptText).toContain("560到580");
    expect(candidate?.transcriptText).toContain("城市");
    db.close();
  });

  it("hard-excludes candidates that contain an account blocked term", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-policy-"));
    tempDirs.push(directory);
    const db = new DatabaseService(path.join(directory, "db.sqlite"));
    await db.initialize();
    const account = db.saveAccount({
      name: "测试账号",
      sensitiveWords: ["哈工"],
      minClipSeconds: 15,
      maxClipSeconds: 90,
    });
    const videoPath = path.join(directory, "video.mp4");
    const transcriptPath = path.join(directory, "transcript.txt");
    fs.writeFileSync(videoPath, "fake-video");
    fs.writeFileSync(
      transcriptPath,
      "很多家长以为学校选择只看分数。哈工相关内容不在本账号讨论范围，应该直接排除。家长需要结合孩子的目标和反馈做判断。",
      "utf8",
    );
    const now = new Date().toISOString();
    db.saveTask({
      id: "task-policy",
      accountId: account.id,
      name: "屏蔽词测试",
      sourceType: "file",
      sourceVideoPath: videoPath,
      transcriptPath,
      status: "imported",
      progress: 0,
      statusMessage: "",
      workDir: directory,
      createdAt: now,
      updatedAt: now,
    });
    const media = {
      probe: async () => ({ duration: 60, width: 1080, height: 1920 }),
      createPreview: async () => "",
    };
    const model: ModelAdapter = {
      analyze: async (input) => [
        {
          topicId: "blocked",
          title: "学校选择应该看什么",
          hookText: "学校选择应该看什么",
          segmentIds: input.transcript.map((item) => item.id),
          riskFlags: [],
          internalScore: 90,
        },
      ],
      generatePlatformCopy: async () => ({
        title: "",
        body: "",
        hashtags: [],
        pinnedComment: "",
        coverText: "",
      }),
    };
    const processor = new TaskProcessor(
      db,
      media as never,
      model,
      new SourceAdapterRegistry(),
    );
    await expect(processor.run("task-policy")).rejects.toThrow("屏蔽词");
    expect(db.listCandidates("task-policy")).toHaveLength(0);
    expect(db.getTask("task-policy")?.status).toBe("failed");
    db.close();
  });

  it("resumes from the persisted validation checkpoint after an analysis crash", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-resume-"));
    tempDirs.push(directory);
    const db = new DatabaseService(path.join(directory, "db.sqlite"));
    await db.initialize();
    const account = db.saveAccount({ name: "恢复测试", minClipSeconds: 15, maxClipSeconds: 90 });
    const videoPath = path.join(directory, "video.mp4");
    const transcriptPath = path.join(directory, "transcript.txt");
    fs.writeFileSync(videoPath, "fake-video");
    fs.writeFileSync(transcriptPath, "很多家长以为补课越多越好。其实真正影响孩子的是目标和反馈。没有目标的努力，只是在重复消耗。家长要先看分数和学科短板，再决定是否补课；如果目标是提分，就应该先做测评并根据反馈调整方法，最后再比较课程和老师。", "utf8");
    const now = new Date().toISOString();
    db.saveTask({ id: "task-resume", accountId: account.id, name: "恢复", sourceType: "file", sourceVideoPath: videoPath, transcriptPath, status: "imported", progress: 0, statusMessage: "", workDir: directory, createdAt: now, updatedAt: now });
    const media = {
      probe: async () => ({ duration: 60, width: 1080, height: 1920 }),
      createPreview: async (_candidate: unknown, _account: unknown, output: string) => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, "preview"); return output; },
    };
    let attempts = 0;
    const model: ModelAdapter = {
      analyze: async (input) => {
        attempts += 1;
        if (attempts === 1) throw new Error("模拟分析崩溃");
        return [{ topicId: "study", title: "家长如何根据分数选择补课", hookText: "补课效果不能只看数量，要看目标和反馈", segmentIds: input.transcript.map((item) => item.id), riskFlags: [], internalScore: 91 }];
      },
      generatePlatformCopy: async () => ({ title: "", body: "", hashtags: [], pinnedComment: "", coverText: "" }),
    };
    const processor = new TaskProcessor(db, media as never, model, new SourceAdapterRegistry());
    await expect(processor.run("task-resume")).rejects.toThrow("模拟分析崩溃");
    expect(db.getTask("task-resume")?.checkpoint?.stage).toBe("validated");
    await processor.run("task-resume");
    expect(attempts).toBe(2);
    expect(db.getTask("task-resume")?.status).toBe("awaiting_review");
    expect(db.listCandidates("task-resume")[0]?.originalRenderPlan).toBeTruthy();
    db.close();
  });
});
