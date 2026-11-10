import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SampleLearningService } from "../src/main/sample-learning";
import { resolveBundledFfmpeg } from "../src/main/media";
import type { AccountProfile } from "../src/shared/types";
import { DEFAULT_CROP_PRESET, DEFAULT_SUBTITLE_TEMPLATE } from "../src/shared/constants";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-clip-sample-learning-"));
const binaries = resolveBundledFfmpeg();
const service = new SampleLearningService(
  () => binaries.ffmpeg,
  () => binaries.ffprobe,
);

beforeAll(() => {
  const source = path.join(directory, "source.mp4");
  const generated = spawnSync(
    binaries.ffmpeg,
    [
      "-y", "-f", "lavfi", "-i", "color=c=0x24303a:s=320x240:d=1:r=10",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  if (generated.status !== 0) throw new Error(generated.stderr);
});

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function account(samplePaths: string[], sampleTranscript = "", sampleLearning?: AccountProfile["sampleLearning"]): AccountProfile {
  const now = new Date().toISOString();
  return {
    id: "sample-account",
    name: "测试老师",
    vertical: "教育",
    audience: "家长",
    persona: "专业",
    stance: "理性讨论",
    forbiddenTopics: [],
    sensitiveWords: [],
    preferenceSummary: "",
    samplePaths,
    sampleTranscript,
    sampleLearning,
    subtitleTemplate: DEFAULT_SUBTITLE_TEMPLATE,
    cropPreset: DEFAULT_CROP_PRESET,
    coverTemplate: "bold",
    minClipSeconds: 30,
    maxClipSeconds: 180,
    createdAt: now,
    updatedAt: now,
  };
}

function sampleVideo(name: string): string {
  const source = path.join(directory, "source.mp4");
  const video = path.join(directory, name);
  fs.copyFileSync(source, video);
  return video;
}

describe("sample learning", () => {
  it("re-reads changed sidecar text instead of reusing stale cache", async () => {
    const video = sampleVideo("refresh.mp4");
    const sidecar = path.join(directory, "refresh.txt");
    fs.writeFileSync(sidecar, "很多家长以为学校只看分数，关键是专业组变化，建议根据孩子目标选择。", "utf8");

    const first = await service.learn(account([video]));
    expect(first.transcript).toContain("学校只看分数");
    expect(first.state.profile?.learnedSampleCount).toBe(1);
    expect(first.state.profile?.structurePatterns).toContain("用具体事实、数据、学校或案例支撑");

    fs.writeFileSync(sidecar, "第二版样片文案：要结合专业组和就业目标再做选择。", "utf8");
    const second = await service.learn(
      account([video], first.transcript, first.state),
    );
    expect(second.transcript).toContain("第二版样片文案");
    expect(second.transcript).not.toContain("学校只看分数");
  }, 120_000);

  it("rebuilds all selected samples and preserves manual context", async () => {
    const firstVideo = sampleVideo("one.mp4");
    const secondVideo = sampleVideo("two.mp4");
    fs.writeFileSync(path.join(directory, "one.txt"), "第一条样片。", "utf8");
    fs.writeFileSync(path.join(directory, "two.txt"), "第二条样片。", "utf8");

    const first = await service.learn(account([firstVideo, secondVideo]));
    const manual = "账号硬规则：只学习结构，不复制原句。";
    const second = await service.learn(
      account(
        [firstVideo, secondVideo],
        `${manual}\n\n${first.transcript}`,
        first.state,
      ),
    );
    expect(second.transcript).toContain(manual);
    expect(second.transcript).toContain("第一条样片");
    expect(second.transcript).toContain("第二条样片");
    expect(second.state.items).toHaveLength(2);
    expect(second.state.items.every((item) => item.status === "learned")).toBe(true);
    expect(second.state.profile?.summary).toContain("2/2");
  }, 120_000);
});
