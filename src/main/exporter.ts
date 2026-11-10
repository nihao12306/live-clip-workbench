import fs from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import type { Candidate, ExportResult, Platform, PlatformPackage } from "../shared/types";
import {
  candidatePolicyTexts,
  findPolicyMatches,
  policyMatchMessage,
} from "./content-policy";
import { DatabaseService } from "./database";
import { MediaService } from "./media";
import type { ModelAdapter } from "./model-adapter";
import { SettingsService } from "./settings";
import { assertSelectionPrinciples } from "./selection-principles";
import { assertContentDensity } from "./content-density";

// The workbench now produces one canonical package. Douyin is the reference
// version; users can upload that same MP4 and copy to other platforms later.
const PLATFORMS: Platform[] = ["douyin"];
const PLATFORM_DIR: Record<Platform, string> = {
  douyin: "抖音",
  wechat_channels: "视频号",
  xiaohongshu: "小红书"
};

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, " ").trim().slice(0, 72) || "未命名";
}

async function zipDirectory(sourceDir: string, outputPath: string): Promise<string> {
  const fsSync = require("node:fs") as typeof import("node:fs");
  return new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 7 } });
    output.on("close", () => resolve(outputPath));
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

async function zipDirectories(
  entries: Array<{ directory: string; name: string }>,
  outputPath: string,
): Promise<string> {
  const fsSync = require("node:fs") as typeof import("node:fs");
  return new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 7 } });
    output.on("close", () => resolve(outputPath));
    archive.on("error", reject);
    archive.pipe(output);
    for (const entry of entries) archive.directory(entry.directory, entry.name);
    void archive.finalize();
  });
}

export class ExportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly media: MediaService,
    private readonly model: ModelAdapter,
    private readonly settings: SettingsService
  ) {}

  async exportCandidate(candidateId: string): Promise<ExportResult> {
    const candidate = this.database.getCandidate(candidateId);
    if (!candidate) throw new Error("候选不存在");
    if (candidate.decision !== "approved") throw new Error("候选尚未通过审核");
    if (candidate.riskFlags.some((risk) => risk.level === "high" && !risk.acknowledged)) {
      throw new Error("高风险内容尚未确认，不能导出");
    }
    const task = this.database.getTask(candidate.taskId);
    if (!task) throw new Error("任务不存在");
    const account = this.database.getAccount(task.accountId);
    if (!account) throw new Error("账号不存在");
    const candidateMatches = findPolicyMatches(
      account,
      candidatePolicyTexts(candidate),
    );
    if (candidateMatches.length) throw new Error(policyMatchMessage(candidateMatches));
    assertSelectionPrinciples(
      account,
      candidate.title,
      candidate.hookText,
      candidate.transcriptText,
    );
    assertContentDensity(
      candidate.title,
      candidate.hookText,
      candidate.transcriptText,
    );
    task.status = "rendering";
    task.statusMessage = `正在渲染：${candidate.title}`;
    task.progress = 0;
    this.database.saveTask(task);
    const date = new Date().toISOString().slice(0, 10);
    const root = this.settings.get().feishuSyncPath || path.join(this.settings.get().workspacePath, "exports");
    const outputDirectory = task.exportCheckpoint?.candidateId === candidateId
      ? task.exportCheckpoint.outputDirectory
      : path.join(
          root,
          safeName(account.name),
          date,
          safeName(task.name),
          `${safeName(candidate.title)}-${candidate.id.slice(0, 8)}`,
        );
    const completedPlatforms = new Set(
      task.exportCheckpoint?.candidateId === candidateId
        ? task.exportCheckpoint.completedPlatforms
        : [],
    );
    task.exportCheckpoint = {
      candidateId,
      outputDirectory,
      completedPlatforms: [...completedPlatforms],
    };
    this.database.saveTask(task);
    await fs.mkdir(outputDirectory, { recursive: true });
    const packages: PlatformPackage[] = [];
    try {
      for (let index = 0; index < PLATFORMS.length; index += 1) {
        const platform = PLATFORMS[index];
        const platformDir = path.join(outputDirectory, PLATFORM_DIR[platform]);
        await fs.mkdir(platformDir, { recursive: true });
        const existingVideo = path.join(platformDir, "video.mp4");
        const existingCover = path.join(platformDir, "cover.jpg");
        const existingMetadata = path.join(platformDir, "metadata.json");
        if (
          completedPlatforms.has(platform) &&
          await Promise.all([
            fs.access(existingVideo),
            fs.access(existingCover),
            fs.access(existingMetadata),
          ]).then(() => true, () => false)
        ) {
          try {
            packages.push(JSON.parse(await fs.readFile(existingMetadata, "utf8")) as PlatformPackage);
          } catch {
            // The presence checks above are authoritative for resume; metadata
            // can be rebuilt on a subsequent explicit export if malformed.
          }
          task.progress = Math.round(((index + 1) / PLATFORMS.length) * 100);
          this.database.saveTask(task);
          continue;
        }
        const copy = await this.model.generatePlatformCopy({
          accountName: account.name,
          title: candidate.title,
          hookText: candidate.hookText,
          transcript: candidate.transcriptText,
          platform,
          blockedTerms: [...account.forbiddenTopics, ...account.sensitiveWords],
          accountContext: {
            audience: account.audience,
            persona: account.persona,
            stance: account.stance,
            preferenceSummary: account.preferenceSummary,
            selectionPrinciples: account.selectionPrinciples,
            sampleProfiles: account.sampleProfiles,
            sampleTranscript: account.sampleTranscript,
            fillerWords: account.fillerWords,
            sampleLearningProfile: account.sampleLearning?.profile,
          },
          recentFeedback: this.database.listRecentFeedback(account.id, 12).map((feedback) => ({
            decision: feedback.decision,
            reason: feedback.rejectionReason,
            title: feedback.finalPlan.title,
            hook: feedback.finalPlan.hookText,
            note: feedback.note,
          })),
        });
        const copyMatches = findPolicyMatches(account, [
          copy.title,
          copy.body,
          copy.coverText,
          copy.pinnedComment,
          ...copy.hashtags,
        ]);
        if (copyMatches.length) throw new Error(policyMatchMessage(copyMatches));
        const videoPath = path.join(platformDir, "video.mp4");
        const coverPath = path.join(platformDir, "cover.jpg");
        await this.media.render(candidate, account, platform, videoPath);
        await this.media.createCover(candidate, account, coverPath, copy.coverText);
        const metadataPath = path.join(platformDir, "metadata.json");
        const item: PlatformPackage = {
          platform,
          videoPath,
          coverPath,
          title: copy.title,
          body: copy.body,
          hashtags: copy.hashtags,
          pinnedComment: copy.pinnedComment,
          metadataPath
        };
        await fs.writeFile(metadataPath, JSON.stringify({ ...item, taskId: task.id, candidateId, renderPlan: candidate.renderPlan }, null, 2), "utf8");
        await fs.writeFile(
          path.join(platformDir, "发布文案.txt"),
          `标题\n${copy.title}\n\n正文\n${copy.body}\n\n话题\n${copy.hashtags.map((tag) => tag.startsWith("#") ? tag : `#${tag}`).join(" ")}\n\n置顶评论\n${copy.pinnedComment}\n`,
          "utf8"
        );
        packages.push(item);
        completedPlatforms.add(platform);
        task.exportCheckpoint = {
          candidateId,
          outputDirectory,
          completedPlatforms: [...completedPlatforms],
        };
        task.progress = Math.round(((index + 1) / PLATFORMS.length) * 100);
        this.database.saveTask(task);
      }
      const zipPath = `${outputDirectory}.zip`;
      await zipDirectory(outputDirectory, zipPath);
      task.status = "exported";
      task.statusMessage = "抖音发布包已生成，其他候选仍保留";
      task.progress = 100;
      task.exportCheckpoint = undefined;
      this.database.saveTask(task);
      return { candidateId, outputDirectory, zipPath, packages };
    } catch (error) {
      task.status = "awaiting_review";
      task.statusMessage = `导出失败：${error instanceof Error ? error.message : String(error)}`;
      task.error = task.statusMessage;
      this.database.saveTask(task);
      throw error;
    }
  }

  async exportCandidates(candidateIds: string[]): Promise<import("../shared/types").BatchExportResult> {
    const ids = [...new Set(candidateIds)].filter(Boolean);
    if (!ids.length) throw new Error("没有可批量导出的候选");
    const results: ExportResult[] = [];
    for (const candidateId of ids) results.push(await this.exportCandidate(candidateId));
    const first = results[0];
    const parent = path.dirname(first.outputDirectory);
    const zipPath = path.join(parent, `批量导出-${new Date().toISOString().replaceAll(":", "-")}.zip`);
    await zipDirectories(
      results.map((result) => ({
        directory: result.outputDirectory,
        name: safeName(path.basename(result.outputDirectory)),
      })),
      zipPath,
    );
    return {
      candidateIds: results.map((result) => result.candidateId),
      zipPath,
      outputDirectories: results.map((result) => result.outputDirectory),
    };
  }
}
