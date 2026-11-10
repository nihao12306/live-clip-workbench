import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildPreviewSubtitleEvents,
  MediaService,
  resolveBundledFfmpeg,
} from "../src/main/media";
import { DEFAULT_CROP_PRESET, DEFAULT_SUBTITLE_TEMPLATE } from "../src/shared/constants";
import type { AccountProfile, Candidate } from "../src/shared/types";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-media-"));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("FFmpeg media pipeline", () => {
  it("aligns preview subtitles to real concatenated segment durations", () => {
    const events = buildPreviewSubtitleEvents("第一句。\n第二句。", [
      { text: "第一句。", start: 0, end: 1 },
      { text: "第二句。", start: 1, end: 4.5 },
    ]);

    expect(events).toEqual([
      { text: "第一句。", start: 0, end: 1 },
      { text: "第二句。", start: 1, end: 4.5 },
    ]);
  });

  it("splits several subtitle phrases inside one source segment", () => {
    const events = buildPreviewSubtitleEvents("第一句，补充。第二句。", [
      { text: "第一句，补充。第二句。", start: 2, end: 6 },
    ]);

    expect(events).toHaveLength(3);
    expect(events[0]?.start).toBe(2);
    expect(events.at(-1)?.end).toBe(6);
    expect(events[0]?.end).toBeLessThanOrEqual(events[1]?.start ?? 0);
  });

  it("keeps one subtitle event across audio fragments created by an in-sentence cut", () => {
    const events = buildPreviewSubtitleEvents("这是一个重要功能。", [
      { text: "这是一个", start: 0, end: 1, groupId: "edited-sentence" },
      { text: "重要功能。", start: 1, end: 2, groupId: "edited-sentence" },
    ]);

    expect(events).toEqual([
      { text: "这是一个重要功能。", start: 0, end: 2 },
    ]);
  });

  it("keeps edited subtitle phrases inside their saved audio group", () => {
    const events = buildPreviewSubtitleEvents(
      "第一组里删掉几个字，仍然属于第一组。\n第二组内容。",
      [
        { text: "第一组里删掉几个字", start: 0, end: 1, groupId: "topic:subtitle:0" },
        { text: "仍然属于第一组", start: 1, end: 2, groupId: "topic:subtitle:0" },
        { text: "第二组内容", start: 2, end: 6, groupId: "topic:subtitle:1" },
      ],
    );

    expect(events).toHaveLength(3);
    expect(events.slice(0, 2).every((event) => event.start >= 0 && event.end <= 2)).toBe(true);
    expect(events.at(-1)).toEqual({ text: "第二组内容。", start: 2, end: 6 });
  });

  it("uses the persisted subtitle unit index when a group is split", () => {
    const events = buildPreviewSubtitleEvents(
      "第一组，删改后仍在第一组。\n第二组。",
      [
        { text: "第一组", start: 0, end: 0.8, subtitleUnitIndex: 0 },
        { text: "删改后仍在第一组", start: 0.8, end: 2, subtitleUnitIndex: 0 },
        { text: "第二组", start: 2, end: 3, subtitleUnitIndex: 1 },
      ],
    );

    expect(events).toHaveLength(3);
    expect(events.slice(0, 2).every((event) => event.end <= 2)).toBe(true);
    expect(events.at(-1)).toEqual({ text: "第二组。", start: 2, end: 3 });
  });

  it("creates a preview, rendered vertical video and cover", async () => {
    const binaries = resolveBundledFfmpeg();
    const source = path.join(directory, "source.mp4");
    const generated = spawnSync(binaries.ffmpeg, [
      "-y", "-f", "lavfi", "-i", "color=c=0x24303a:s=540x960:d=5:r=30",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=5",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source
    ], { windowsHide: true, encoding: "utf8" });
    expect(generated.status, generated.stderr).toBe(0);
    const now = new Date().toISOString();
    const account: AccountProfile = {
      id: "a", name: "测试老师", vertical: "教育", audience: "家长", persona: "专业", stance: "理性讨论",
      forbiddenTopics: [], sensitiveWords: [], preferenceSummary: "", samplePaths: [], subtitleTemplate: DEFAULT_SUBTITLE_TEMPLATE,
      cropPreset: DEFAULT_CROP_PRESET, coverTemplate: "bold", minClipSeconds: 1, maxClipSeconds: 180, createdAt: now, updatedAt: now
    };
    const candidate: Candidate = {
      id: "c", taskId: "t", rank: 1, tier: "featured", topicId: "topic", title: "努力越多越好吗",
      hookText: "没有目标的努力，只是在重复消耗", transcriptText: "很多家长以为补课越多越好。真正重要的是目标和反馈。",
      duration: 4.3, riskFlags: [], decision: "approved", createdAt: now, updatedAt: now,
      renderPlan: {
        version: 1, sourceVideoPath: source,
        segments: [
          { id: "s1", sourceStart: 0, sourceEnd: 2, text: "很多家长以为补课越多越好。", topicId: "topic", order: 0 },
          { id: "s2", sourceStart: 2.2, sourceEnd: 4.5, text: "真正重要的是目标和反馈。", topicId: "topic", order: 1 }
        ],
        hookText: "没有目标的努力，只是在重复消耗", title: "努力越多越好吗", subtitleText: "很多家长以为补课越多越好。真正重要的是目标和反馈。",
        cropPreset: DEFAULT_CROP_PRESET, subtitleTemplate: DEFAULT_SUBTITLE_TEMPLATE, transitionSeconds: .08, templateVersion: "v1",
        overlayPreset: { topPercent: 0.12, heightPercent: 0.16, color: "#3f4143", confidence: 1 },
        effectPreset: { name: "light", pushInPercent: 0.014, transitionSeconds: 0.14 }
      }
    };
    const media = new MediaService(() => binaries.ffmpeg, () => binaries.ffprobe);
    const preview = path.join(directory, "preview.mp4");
    const rendered = path.join(directory, "rendered.mp4");
    const cover = path.join(directory, "cover.jpg");
    await media.createPreview(candidate, account, preview);
    await media.render(candidate, account, "douyin", rendered);
    await media.createCover(candidate, account, cover, candidate.hookText);
    expect(fs.statSync(preview).size).toBeGreaterThan(1000);
    expect(fs.statSync(rendered).size).toBeGreaterThan(1000);
    expect(fs.statSync(cover).size).toBeGreaterThan(1000);
    const info = await media.probe(rendered);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.duration).toBeGreaterThan(4);
  }, 120_000);

  it("normalizes floating-point fade timestamps before invoking FFmpeg", async () => {
    const binaries = resolveBundledFfmpeg();
    const source = path.join(directory, "floating-point-source.mp4");
    const generated = spawnSync(binaries.ffmpeg, [
      "-y", "-f", "lavfi", "-i", "color=c=0x24303a:s=540x960:d=1:r=30",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ], { windowsHide: true, encoding: "utf8" });
    expect(generated.status, generated.stderr).toBe(0);
    const now = new Date().toISOString();
    const account: AccountProfile = {
      id: "floating", name: "边界测试", vertical: "教育", audience: "家长", persona: "专业", stance: "理性讨论",
      forbiddenTopics: [], sensitiveWords: [], preferenceSummary: "", samplePaths: [], subtitleTemplate: DEFAULT_SUBTITLE_TEMPLATE,
      cropPreset: DEFAULT_CROP_PRESET, coverTemplate: "bold", minClipSeconds: 0.1, maxClipSeconds: 10, createdAt: now, updatedAt: now,
    };
    const candidate: Candidate = {
      id: "floating-candidate", taskId: "floating-task", rank: 1, tier: "featured", topicId: "topic",
      title: "家长需要看学习目标", hookText: "先看学习目标", transcriptText: "家长需要先明确孩子的学习目标，再根据反馈调整方法。",
      duration: 0.14000000000000012, riskFlags: [], decision: "approved", createdAt: now, updatedAt: now,
      renderPlan: {
        version: 1, sourceVideoPath: source,
        segments: [{ id: "floating-segment", sourceStart: 0, sourceEnd: 0.14000000000000012, text: "家长需要先明确孩子的学习目标，再根据反馈调整方法。", topicId: "topic", order: 0 }],
        hookText: "先看学习目标", title: "家长需要看学习目标", subtitleText: "家长需要先明确孩子的学习目标，再根据反馈调整方法。",
        cropPreset: DEFAULT_CROP_PRESET, subtitleTemplate: DEFAULT_SUBTITLE_TEMPLATE, transitionSeconds: 0.14, templateVersion: "v1",
        effectPreset: { name: "light", pushInPercent: 0.014, transitionSeconds: 0.14 },
      },
    };
    const media = new MediaService(() => binaries.ffmpeg, () => binaries.ffprobe);
    const preview = path.join(directory, "floating-point-preview.mp4");
    await media.createPreview(candidate, account, preview);
    expect(fs.statSync(preview).size).toBeGreaterThan(1000);
  }, 120_000);
});
