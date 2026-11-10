import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  AccountProfile,
  Candidate,
  EffectPreset,
  OverlayPreset,
  Platform,
  RenderPlan,
} from "../shared/types";
import { DEFAULT_PLATFORM_SAFE_AREAS } from "../shared/constants";
import { normalizeSubtitleForMatch, splitSubtitleUnits } from "../shared/subtitle-sync";

export interface PreviewSubtitleTimelineSegment {
  text: string;
  start: number;
  end: number;
  groupId?: string;
  subtitleUnitIndex?: number;
}

export interface PreviewSubtitleEvent {
  text: string;
  start: number;
  end: number;
}

function previewSubtitleUnits(text: string): string[] {
  return text
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/u)
    .flatMap((line) => line.split(/(?<=[。！？!?；;，,])\s*/u))
    .map((item) => item.trim())
    .filter(Boolean);
}

function longestCommonSubsequenceLength(left: string, right: string): number {
  if (!left || !right) return 0;
  const previous = new Array<number>(right.length + 1).fill(0);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const saved = previous[rightIndex + 1];
      if (left[leftIndex] === right[rightIndex]) {
        previous[rightIndex + 1] = diagonal + 1;
      } else {
        previous[rightIndex + 1] = Math.max(
          previous[rightIndex + 1],
          previous[rightIndex],
        );
      }
      diagonal = saved;
    }
  }
  return previous[right.length];
}

function previewTextMatchScore(target: string, source: string): number {
  const normalizedTarget = normalizeSubtitleForMatch(target);
  const normalizedSource = normalizeSubtitleForMatch(source);
  if (!normalizedTarget || !normalizedSource) return 0;
  if (normalizedSource.includes(normalizedTarget)) {
    return 0.72 + Math.min(1, normalizedTarget.length / normalizedSource.length) * 0.28;
  }
  const common = longestCommonSubsequenceLength(normalizedTarget, normalizedSource);
  return common / normalizedTarget.length * 0.78
    + common / normalizedSource.length * 0.22;
}

function allocatePreviewSubtitleEvents(
  text: string,
  start: number,
  end: number,
): PreviewSubtitleEvent[] {
  const units = previewSubtitleUnits(text);
  if (!units.length) return [];
  if (units.length === 1) return [{ text: units[0]!, start, end }];
  const weights = units.map((unit) => Math.max(1, normalizeSubtitleForMatch(unit).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = start;
  return units.map((unit, index) => {
    const slice = (end - start) * ((weights[index] ?? 1) / totalWeight);
    const next = index === units.length - 1 ? end : cursor + slice;
    const event = { text: unit, start: cursor, end: next };
    cursor = next;
    return event;
  });
}

function buildMappedPreviewSubtitleEvents(
  subtitleText: string,
  timeline: PreviewSubtitleTimelineSegment[],
): PreviewSubtitleEvent[] | undefined {
  const logicalUnits = splitSubtitleUnits(subtitleText);
  if (!logicalUnits.length) return [];

  const indexedSegments = timeline.filter(
    (segment) => segment.subtitleUnitIndex !== undefined,
  );
  if (indexedSegments.length === timeline.length) {
    const events: PreviewSubtitleEvent[] = [];
    for (const [unitIndex, unit] of logicalUnits.entries()) {
      const segments = timeline.filter(
        (segment) => segment.subtitleUnitIndex === unitIndex,
      );
      if (!segments.length) return undefined;
      events.push(...allocatePreviewSubtitleEvents(
        unit,
        segments[0]!.start,
        segments.at(-1)!.end,
      ));
    }
    return events;
  }

  // Candidates saved before subtitleUnitIndex existed still carry contiguous
  // subtitle groups after a partial in-sentence edit. Use those groups as a
  // deterministic legacy mapping instead of fuzzy-matching each comma phrase
  // against every later audio fragment.
  const hasEditedGroups = timeline.some((segment) =>
    segment.groupId?.includes(":subtitle:"),
  );
  if (!hasEditedGroups) return undefined;
  const groups: PreviewSubtitleTimelineSegment[][] = [];
  for (const segment of timeline) {
    const previous = groups.at(-1);
    if (previous && previous[0]?.groupId === segment.groupId) {
      previous.push(segment);
    } else {
      groups.push([segment]);
    }
  }
  if (groups.length !== logicalUnits.length) return undefined;
  return logicalUnits.flatMap((unit, index) => {
    const group = groups[index]!;
    return allocatePreviewSubtitleEvents(unit, group[0]!.start, group.at(-1)!.end);
  });
}

/**
 * Places preview subtitle events on the same concatenated timeline used by
 * renderCore. A caption is matched to its source render segment; multiple
 * captions inside one segment share that segment's real duration.
 */
export function buildPreviewSubtitleEvents(
  subtitleText: string,
  timeline: PreviewSubtitleTimelineSegment[],
): PreviewSubtitleEvent[] {
  const units = previewSubtitleUnits(subtitleText);
  if (!units.length || !timeline.length) return [];

  const mappedEvents = buildMappedPreviewSubtitleEvents(subtitleText, timeline);
  if (mappedEvents) return mappedEvents;

  const assignments = timeline.map(() => [] as Array<{ text: string; unitIndex: number }>);
  let currentSegment = 0;
  const cursors = timeline.map(() => 0);
  const normalizedSources = timeline.map((segment) => normalizeSubtitleForMatch(segment.text));

  for (const [unitIndex, unit] of units.entries()) {
    if (currentSegment >= timeline.length) currentSegment = timeline.length - 1;
    let bestIndex = currentSegment;
    let bestScore = -1;
    const currentSource = normalizedSources[currentSegment] ?? "";
    const currentTarget = normalizeSubtitleForMatch(unit);
    const currentRemainder = currentSource.slice(cursors[currentSegment] ?? 0);
    if (currentTarget && currentRemainder.includes(currentTarget)) {
      bestIndex = currentSegment;
      bestScore = 1;
    } else {
      for (let index = currentSegment; index < timeline.length; index += 1) {
        const score = previewTextMatchScore(unit, timeline[index]?.text ?? "");
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      // A short or manually rewritten phrase may score weakly everywhere. It
      // still belongs to the current audio segment until a later segment has
      // a materially stronger match.
      const currentScore = previewTextMatchScore(unit, timeline[currentSegment]?.text ?? "");
      const futureScore = previewTextMatchScore(unit, timeline[bestIndex]?.text ?? "");
      if (bestIndex > currentSegment && futureScore < currentScore + 0.12) {
        bestIndex = currentSegment;
      }
    }
    assignments[bestIndex]?.push({ text: unit, unitIndex });
    const source = normalizedSources[bestIndex] ?? "";
    const target = normalizeSubtitleForMatch(unit);
    const cursor = cursors[bestIndex] ?? 0;
    const foundAt = target ? source.indexOf(target, cursor) : -1;
    cursors[bestIndex] = foundAt >= 0 ? foundAt + target.length : cursor + target.length;
    currentSegment = Math.max(currentSegment, bestIndex);
  }

  const events: PreviewSubtitleEvent[] = [];
  const groupBounds = new Map<string, { first: number; last: number }>();
  timeline.forEach((segment, segmentIndex) => {
    if (!segment.groupId) return;
    const current = groupBounds.get(segment.groupId);
    groupBounds.set(segment.groupId, {
      first: current ? Math.min(current.first, segmentIndex) : segmentIndex,
      last: current ? Math.max(current.last, segmentIndex) : segmentIndex,
    });
  });
  timeline.forEach((segment, segmentIndex) => {
    const items = assignments[segmentIndex] ?? [];
    if (!items.length) return;
    if (items.length === 1) {
      const item = items[0]!;
      const bounds = segment.groupId ? groupBounds.get(segment.groupId) : undefined;
      const groupItems = bounds
        ? assignments.slice(bounds.first, bounds.last + 1).flat()
        : [];
      if (bounds && groupItems.length === 1 && groupItems[0]?.unitIndex === item.unitIndex) {
        events.push({
          text: item.text,
          start: timeline[bounds.first]?.start ?? segment.start,
          end: timeline[bounds.last]?.end ?? segment.end,
        });
      } else {
        events.push({ text: item.text, start: segment.start, end: segment.end });
      }
      return;
    }
    const weights = items.map((item) => Math.max(1, normalizeSubtitleForMatch(item.text).length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = segment.start;
    items.forEach((item, index) => {
      const slice = (segment.end - segment.start) * ((weights[index] ?? 1) / totalWeight);
      const end = index === items.length - 1 ? segment.end : cursor + slice;
      events.push({ text: item.text, start: cursor, end });
      cursor = end;
    });
  });
  return events;
}

function unpacked(binaryPath: string): string {
  return binaryPath.includes("app.asar.unpacked")
    ? binaryPath
    : binaryPath.replace("app.asar", "app.asar.unpacked");
}

function escapeFilterPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function escapeAss(value: string): string {
  return value.replace(/[{}]/g, "").replace(/\n/g, "\\N");
}

// Phone recordings may carry a rotate/display-matrix tag. Normalize the
// pixels with FFmpeg's autorotation and strip the tag from every generated
// artifact, otherwise some players apply the rotation a second time and the
// preview can appear tilted or sideways.
const NORMALIZED_VIDEO_METADATA_ARGS = [
  "-map_metadata", "-1",
  "-metadata:s:v:0", "rotate=0",
];

function assTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor((safe % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function colorToAss(hex: string): string {
  const value = hex.replace("#", "").padEnd(6, "F");
  return `&H00${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`;
}

async function run(
  binary: string,
  args: string[],
  timeoutMs = 0,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abortChild);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abortChild = () => {
      child.kill();
      fail(new Error("任务已停止"));
    };
    if (signal?.aborted) {
      abortChild();
      return;
    }
    signal?.addEventListener("abort", abortChild, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        fail(new Error(`媒体处理超时：${stderr.slice(-1000)}`));
      }, timeoutMs);
    }
    child.once("error", (error) => fail(error));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve(stdout);
      else reject(new Error(`FFmpeg 失败 (${code})：${stderr.slice(-1800)}`));
    });
  });
}

async function runBuffer(
  binary: string,
  args: string[],
  timeoutMs = 0,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abortChild);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abortChild = () => {
      child.kill();
      fail(new Error("任务已停止"));
    };
    if (signal?.aborted) {
      abortChild();
      return;
    }
    signal?.addEventListener("abort", abortChild, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        fail(new Error(`FFmpeg frame capture timeout: ${stderr.join("").slice(-800)}`));
      }, timeoutMs);
    }
    child.once("error", (error) => fail(error));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`FFmpeg frame capture failed (${code}): ${stderr.join("").slice(-1200)}`));
    });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// FFmpeg does not accept JavaScript's scientific-notation output for filter
// timestamps. Floating-point subtraction can otherwise turn an intended zero
// (for example, duration - transition) into `5.55e-16`.
function ffmpegNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const normalized = Math.abs(value) < 1e-7 ? 0 : value;
  return normalized.toFixed(6).replace(/\.?0+$/, "");
}

function normalizeHexColor(value: string | undefined, fallback = "3f4143"): string {
  const match = value?.trim().match(/^#?([0-9a-f]{6})$/i);
  return match?.[1].toLowerCase() ?? fallback;
}

function ffmpegColor(value: string | undefined): string {
  return `0x${normalizeHexColor(value)}@1`;
}

function rowStats(frame: Buffer, width: number, row: number): { luminance: number; variance: number } {
  let total = 0;
  let totalSquared = 0;
  const start = row * width * 3;
  for (let x = 0; x < width; x += 1) {
    const offset = start + x * 3;
    const luminance = (frame[offset] * 0.2126 + frame[offset + 1] * 0.7152 + frame[offset + 2] * 0.0722) / 255;
    total += luminance;
    totalSquared += luminance * luminance;
  }
  const mean = total / width;
  return { luminance: mean, variance: Math.max(0, totalSquared / width - mean * mean) };
}

function rowEdge(frame: Buffer, width: number, upperRow: number, lowerRow: number): number {
  let total = 0;
  const upper = upperRow * width * 3;
  const lower = lowerRow * width * 3;
  for (let x = 0; x < width * 3; x += 1) {
    total += Math.abs(frame[upper + x] - frame[lower + x]) / 255;
  }
  return total / (width * 3);
}

function averageRows(frame: Buffer, width: number, from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  for (let row = from; row < to; row += 1) total += rowStats(frame, width, row).variance;
  return total / (to - from);
}

function averageLuminance(frame: Buffer, width: number, from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  for (let row = from; row < to; row += 1) total += rowStats(frame, width, row).luminance;
  return total / (to - from);
}

function detectOverlayBoundary(
  frame: Buffer,
  width: number,
  height: number,
): { topRow: number; bottomRow: number; score: number } {
  // Search for a persistent band rather than only the first horizontal edge.
  // The reference clips commonly have a small breathing room above the dark
  // panel, while live platforms often place the patch flush with the top.
  const maxTop = Math.floor(height * 0.38);
  const maxBottom = Math.floor(height * 0.60);
  const minHeight = Math.floor(height * 0.14);
  let best = {
    topRow: 0,
    bottomRow: Math.floor(height * 0.30),
    score: 0,
  };
  for (let top = 0; top <= maxTop; top += 1) {
    for (let bottom = top + minHeight; bottom <= maxBottom; bottom += 1) {
      const beforeFrom = Math.max(0, top - Math.floor(height * 0.10));
      const beforeTo = top;
      const afterFrom = bottom;
      const afterTo = Math.min(height, bottom + Math.floor(height * 0.12));
      const panelLuminance = averageLuminance(frame, width, top, bottom);
      const beforeLuminance = averageLuminance(frame, width, beforeFrom, beforeTo);
      const afterLuminance = averageLuminance(frame, width, afterFrom, afterTo);
      const panelDetail = averageRows(frame, width, top, bottom);
      const afterDetail = averageRows(frame, width, afterFrom, afterTo);
      const startEdge = top > 0 ? rowEdge(frame, width, top - 1, top) : 0.08;
      const endEdge = rowEdge(frame, width, bottom - 1, bottom);
      const contrast =
        clamp(Math.abs(panelLuminance - beforeLuminance) * 1.5, 0, 1) * 0.20 +
        clamp(Math.abs(panelLuminance - afterLuminance) * 1.5, 0, 1) * 0.32;
      const lowerDetailGain = clamp(
        (afterDetail - panelDetail) / Math.max(0.001, afterDetail + panelDetail),
        0,
        1,
      );
      const heightPrior = 1 - Math.abs((bottom - top) / height - 0.22) * 1.8;
      const score = clamp(
        startEdge * 0.14 + endEdge * 0.46 + contrast + lowerDetailGain * 0.12,
        0,
        1,
      ) * clamp(heightPrior, 0.35, 1);
      if (score > best.score) best = { topRow: top, bottomRow: bottom, score };
    }
  }
  return best;
}

function averagePanelColor(
  frame: Buffer,
  width: number,
  height: number,
  topPercent: number,
  heightPercent: number,
): string {
  const start = Math.max(0, Math.min(height - 1, Math.floor(height * topPercent)));
  const end = Math.max(start + 1, Math.min(height, Math.floor(height * (topPercent + heightPercent))));
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let row = start; row < end; row += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (row * width + x) * 3;
      const r = frame[offset];
      const g = frame[offset + 1];
      const b = frame[offset + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
      // The reference clips use a restrained dark panel. Ignore bright text and
      // saturated artwork so the replacement follows the account's visual tone.
      if (luminance < 185 && max - min < 48) {
        red += r;
        green += g;
        blue += b;
        count += 1;
      }
    }
  }
  if (!count) return "#3f4143";
  const base = [63, 65, 67];
  // The reference clips use a dark neutral title panel. Blend the sampled
  // tone toward that base so a bright wall or gray slide cannot become a
  // distracting light block after the live overlay is replaced.
  return `#${[red, green, blue]
    .map((channel, index) => Math.round((channel / count) * 0.42 + base[index] * 0.58).toString(16).padStart(2, "0"))
    .join("")}`;
}

export class MediaService {
  constructor(
    private readonly ffmpegPath: () => string,
    private readonly ffprobePath: () => string
  ) {}

  private ffmpeg(): string {
    return unpacked(this.ffmpegPath());
  }

  private ffprobe(): string {
    return unpacked(this.ffprobePath());
  }

  async verify(): Promise<void> {
    await run(this.ffmpeg(), ["-version"], 10_000);
    await run(this.ffprobe(), ["-version"], 10_000);
  }

  async probe(filePath: string, signal?: AbortSignal): Promise<{ duration: number; width: number; height: number }> {
    const output = await run(this.ffprobe(), [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath
    ], 30_000, signal);
    const parsed = JSON.parse(output) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    return {
      duration: Number(parsed.format?.duration ?? 0),
      width: video?.width ?? 1080,
      height: video?.height ?? 1920
    };
  }

  private async captureFrame(
    filePath: string,
    timestamp: number,
    width = 96,
    height = 170,
  ): Promise<Buffer> {
    return runBuffer(
      this.ffmpeg(),
      [
        "-v",
        "error",
        "-autorotate", "1",
        "-ss",
        ffmpegNumber(Math.max(0, timestamp)),
        "-i",
        filePath,
        "-an",
        "-vf",
        `scale=${width}:${height}`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      30_000,
    );
  }

  private async chooseCoverTimestamp(plan: RenderPlan): Promise<number> {
    const candidates = plan.segments.flatMap((segment) => {
      const duration = Math.max(0.2, segment.sourceEnd - segment.sourceStart);
      return [0.2, 0.5, 0.8].map(
        (ratio) => segment.sourceStart + Math.min(duration * ratio, duration - 0.05),
      );
    });
    let best = candidates[0] ?? 0;
    let bestScore = -Infinity;
    for (const timestamp of candidates.slice(0, 12)) {
      try {
        const frame = await this.captureFrame(plan.sourceVideoPath, timestamp);
        if (frame.length < 96 * 170 * 3) continue;
        const detail = averageRows(frame, 96, 24, 146);
        const luminance = averageLuminance(frame, 96, 24, 146);
        // Prefer a well-lit, detailed frame; this is a deterministic local
        // fallback when a face detector is unavailable.
        const score = detail * 3 - Math.abs(luminance - 0.52) * 0.35;
        if (score > bestScore) {
          best = timestamp;
          bestScore = score;
        }
      } catch {
        // Keep the first valid timestamp if an individual seek fails.
      }
    }
    return best;
  }

  /**
   * Estimates the top live overlay from a few frames and borrows the panel
   * tone from the account's existing sample clips. It intentionally returns a
   * confidence value: ordinary horizontal scene changes should not be covered
   * when the evidence is weak.
   */
  async detectOverlayPreset(
    videoPath: string,
    referencePaths: string[] = [],
  ): Promise<OverlayPreset | undefined> {
    const info = await this.probe(videoPath);
    if (!info.duration || info.width < 2 || info.height < 2) return undefined;
    const sampleTimes = [
      Math.min(0.8, info.duration / 4),
      Math.max(0, info.duration / 2),
      Math.max(0, info.duration - Math.min(0.8, info.duration / 5)),
    ];
    const boundaries: Array<{ topRow: number; bottomRow: number; score: number }> = [];
    for (const timestamp of [...new Set(sampleTimes.map((value) => Math.round(value * 10) / 10))]) {
      try {
        const frame = await this.captureFrame(videoPath, timestamp);
        if (frame.length < 96 * 170 * 3) continue;
        boundaries.push(detectOverlayBoundary(frame, 96, 170));
      } catch {
        // A single bad seek should not block the task; the remaining samples
        // still provide enough evidence for a useful preset.
      }
    }
    if (!boundaries.length) return undefined;
    const sortedTopRows = boundaries.map((item) => item.topRow).sort((a, b) => a - b);
    const sortedBottomRows = boundaries.map((item) => item.bottomRow).sort((a, b) => a - b);
    const topRow = sortedTopRows[Math.floor(sortedTopRows.length / 2)];
    const bottomRow = sortedBottomRows[Math.floor(sortedBottomRows.length / 2)];
    const score = boundaries.reduce((sum, item) => sum + item.score, 0) / boundaries.length;
    const topPercent = clamp(topRow / 170, 0, 0.55);
    const heightPercent = clamp((bottomRow - topRow) / 170, 0.10, 0.64);
    // A boundary that is stable across time is much more likely to be a live
    // patch than a slide transition. Keep the confidence conservative.
    const spread =
      Math.max(...sortedTopRows) - Math.min(...sortedTopRows) +
      Math.max(...sortedBottomRows) - Math.min(...sortedBottomRows);
    const stability = 1 - clamp(spread / 42, 0, 1);
    const confidence = clamp(score * 1.35 * (0.65 + stability * 0.35), 0, 1);
    if (confidence < 0.17) return undefined;

    let color = "#3f4143";
    for (const reference of referencePaths.slice(0, 3)) {
      try {
        const referenceInfo = await this.probe(reference);
        if (!referenceInfo.duration) continue;
        const frame = await this.captureFrame(
          reference,
          Math.min(2, Math.max(0, referenceInfo.duration * 0.3)),
          96,
          170,
        );
        if (frame.length >= 96 * 170 * 3) {
          color = averagePanelColor(frame, 96, 170, topPercent, heightPercent);
          break;
        }
      } catch {
        // Sample clips are optional. The neutral fallback is still valid.
      }
    }
    return { topPercent, heightPercent, color, confidence };
  }

  private async writeAss(plan: RenderPlan, outputPath: string, platform: Platform, totalDuration: number, contentOffset = 0, contentDuration = totalDuration): Promise<void> {
    const template = plan.subtitleTemplate;
    const safeArea = plan.platformSafeAreas?.[platform] ?? DEFAULT_PLATFORM_SAFE_AREAS[platform];
    const subtitleBottom = Math.max(template.bottomMargin, Math.round(safeArea.bottom * 1920));
    // Preview subtitles are layered on top of the original video frame. The
    // source frame (including any original live-stream sticker) is preserved;
    // the hook simply occupies a safe top area and the body captions stay at
    // the bottom.
    const hookDuration = contentDuration;
    let timelineCursor = contentOffset;
    const timeline = plan.segments.map((segment) => {
      const duration = Math.max(0.1, segment.sourceEnd - segment.sourceStart);
    const item = {
      text: segment.text,
      start: timelineCursor,
      end: timelineCursor + duration,
      groupId: segment.subtitleGroupId ?? segment.id,
      subtitleUnitIndex: segment.subtitleUnitIndex,
    };
      timelineCursor += duration;
      return item;
    });
    const subtitleEvents = buildPreviewSubtitleEvents(plan.subtitleText, timeline);
    const events = subtitleEvents.map(({ text, start, end }) =>
      `Dialogue: 0,${assTime(start)},${assTime(Math.min(contentOffset + contentDuration, end))},Body,,0,0,0,,${escapeAss(text)}`,
    );
    if (plan.hookText) {
      events.unshift(`Dialogue: 1,${assTime(contentOffset)},${assTime(contentOffset + hookDuration)},Hook,,0,0,0,,${escapeAss(plan.hookText)}`);
    }
    const content = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Body,${template.fontFamily},${template.fontSize},${colorToAss(template.primaryColor)},${colorToAss(template.highlightColor)},${colorToAss(template.outlineColor)},&H55000000,-1,0,0,0,100,100,1,0,1,5,1,2,70,70,${subtitleBottom},1\nStyle: Hook,${template.fontFamily},72,${colorToAss(template.primaryColor)},${colorToAss(template.highlightColor)},${colorToAss(template.outlineColor)},&H66000000,-1,0,0,0,100,100,1,0,1,6,2,8,80,80,170,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
    const hookMargin = 170;
    const adjustedContent = content.replace(",80,80,170,1\n\n[Events]", `,80,80,${hookMargin},1\n\n[Events]`);
    await fs.writeFile(outputPath, adjustedContent, "utf8");
  }

  private cropFilter(
    account: AccountProfile,
    width: number,
    height: number,
    effect?: EffectPreset,
  ): string {
    const crop = account.cropPreset;
    const croppedWidth = Math.max(2, Math.floor(width * (1 - crop.leftPercent - crop.rightPercent) / 2) * 2);
    const croppedHeight = Math.max(2, Math.floor(height * (1 - crop.topPercent - crop.bottomPercent) / 2) * 2);
    const x = Math.floor(width * crop.leftPercent);
    const y = Math.floor(height * crop.topPercent);
    const pushIn = clamp(effect?.pushInPercent ?? 0, 0, 0.03);
    const zoomWidth = Math.max(2, Math.floor((1080 / (1 + pushIn)) / 2) * 2);
    const zoomHeight = Math.max(2, Math.floor((1920 / (1 + pushIn)) / 2) * 2);
    // Keep the crop spatially stable. A time-varying sin/cos crop looks like
    // flicker on talking-head footage and becomes especially distracting when
    // many short transcript segments are concatenated.
    const motionCrop = pushIn > 0
      ? `crop=${zoomWidth}:${zoomHeight}:x=(iw-ow)/2:y=(ih-oh)/2,scale=1080:1920`
      : "crop=1080:1920:x=(iw-ow)/2:y=(ih-oh)/2";
    return `crop=${croppedWidth}:${croppedHeight}:${x}:${y},scale=1120:1992:force_original_aspect_ratio=increase,${motionCrop},setsar=1,fps=30,format=yuv420p`;
  }

  private overlayFilter(plan: RenderPlan): string | undefined {
    const preset = plan.overlayPreset;
    if (!preset || preset.confidence < 0.17) return undefined;
    const top = Math.round(clamp(preset.topPercent - 0.02, 0, 0.8) * 1920);
    const bottom = Math.round(
      clamp(preset.topPercent + preset.heightPercent + 0.06, 0.08, 0.88) * 1920,
    );
    const height = Math.max(2, bottom - top);
    return `drawbox=x=0:y=${top}:w=iw:h=${height}:color=${ffmpegColor(preset.color)}:t=fill`;
  }

  /**
   * Keep the source frame intact instead of applying the account crop or
   * painting over a detected live-stream sticker. The output canvas remains
   * vertical for publishing, but a non-vertical source is fitted and padded
   * rather than cropped. At the normal 1080x1920 source size this is a
   * lossless framing pass.
   */
  private preserveFrameFilter(width: number, height: number, preview = false): string {
    const targetWidth = preview ? 540 : 1080;
    const targetHeight = preview ? 960 : 1920;
    return [
      `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease`,
      `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`,
      "setsar=1",
      "fps=30",
      "format=yuv420p",
    ].join(",");
  }

  private async renderCore(plan: RenderPlan, account: AccountProfile, outputPath: string, preview = false, signal?: AbortSignal): Promise<{ totalDuration: number; contentOffset: number; contentDuration: number }> {
    const info = await this.probe(plan.sourceVideoPath, signal);
    const tempDir = path.join(path.dirname(outputPath), `.segments-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const files: string[] = [];
    try {
      const sources: Array<{ filePath: string; start: number; duration: number; template: boolean }> = [];
      if (!preview && account.introPath) {
        const introInfo = await this.probe(account.introPath, signal);
        sources.push({ filePath: account.introPath, start: 0, duration: introInfo.duration, template: true });
      }
      const contentOffset = sources.reduce((sum, source) => sum + source.duration, 0);
      for (const segment of plan.segments) {
        sources.push({ filePath: plan.sourceVideoPath, start: segment.sourceStart, duration: Math.max(0.1, segment.sourceEnd - segment.sourceStart), template: false });
      }
      const contentDuration = plan.segments.reduce((sum, segment) => sum + Math.max(0.1, segment.sourceEnd - segment.sourceStart), 0);
      if (!preview && account.outroPath) {
        const outroInfo = await this.probe(account.outroPath, signal);
        sources.push({ filePath: account.outroPath, start: 0, duration: outroInfo.duration, template: true });
      }
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const file = path.join(tempDir, `segment-${String(index).padStart(3, "0")}.mp4`);
        const sourceInfo = source.template ? await this.probe(source.filePath, signal) : info;
        // Both preview and final output use the original source framing. In
        // particular, do not apply the account crop or replace the source's
        // live-stream sticker with a sampled-color box.
        const sizeFilter = this.preserveFrameFilter(
          sourceInfo.width,
          sourceInfo.height,
          preview,
        );
        const transition = clamp(
          source.template
            ? 0.08
            : plan.effectPreset?.transitionSeconds ?? plan.transitionSeconds,
          0.04,
          0.28,
        );
        const fadeDuration = Math.min(transition, source.duration / 2);
        const videoFilters = [sizeFilter];
        const audioFilters: string[] = [];
        // Fading every transcript fragment to black creates a visible flash at
        // every cut. Only fade the outer edges of the complete clip; internal
        // topic cuts remain clean hard cuts.
        if (index === 0 && fadeDuration >= 0.04) {
          videoFilters.push(`fade=t=in:st=0:d=${ffmpegNumber(fadeDuration)}`);
          audioFilters.push(`afade=t=in:st=0:d=${ffmpegNumber(Math.min(0.12, fadeDuration))}`);
        }
        if (index === sources.length - 1 && fadeDuration >= 0.04) {
          videoFilters.push(`fade=t=out:st=${ffmpegNumber(Math.max(0, source.duration - fadeDuration))}:d=${ffmpegNumber(fadeDuration)}`);
          audioFilters.push(`afade=t=out:st=${ffmpegNumber(Math.max(0, source.duration - Math.min(0.12, fadeDuration)))}:d=${ffmpegNumber(Math.min(0.12, fadeDuration))}`);
        }
        // A very short audio-only fade prevents clicks and clipped consonants
        // at internal transcript cuts without introducing a visible flash.
        const audioCutFade = Math.min(0.025, source.duration / 4);
        if (sources.length > 1 && audioCutFade >= 0.01) {
          if (index > 0) {
            audioFilters.push(`afade=t=in:st=0:d=${ffmpegNumber(audioCutFade)}`);
          }
          if (index < sources.length - 1) {
            audioFilters.push(`afade=t=out:st=${ffmpegNumber(Math.max(0, source.duration - audioCutFade))}:d=${ffmpegNumber(audioCutFade)}`);
          }
        }
        audioFilters.push("aresample=48000");
        await run(this.ffmpeg(), [
          "-y", "-autorotate", "1", "-ss", ffmpegNumber(source.start), "-t", ffmpegNumber(source.duration), "-i", source.filePath,
          "-vf", videoFilters.join(","),
          "-af", audioFilters.join(","),
          "-c:v", "libx264", "-preset", preview ? "ultrafast" : "veryfast", "-crf", preview ? "30" : "20",
          "-c:a", "aac", "-b:a", preview ? "96k" : "160k", "-ar", "48000", "-ac", "2",
          ...NORMALIZED_VIDEO_METADATA_ARGS,
          file
        ], 0, signal);
        files.push(file);
      }
      const listPath = path.join(tempDir, "concat.txt");
      await fs.writeFile(listPath, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
      await run(this.ffmpeg(), [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c", "copy", "-movflags", "+faststart", outputPath
      ], 0, signal);
      return { totalDuration: sources.reduce((sum, source) => sum + source.duration, 0), contentOffset, contentDuration };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async createPreview(candidate: Candidate, account: AccountProfile, outputPath: string, signal?: AbortSignal): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const tempDir = path.join(path.dirname(outputPath), `.preview-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const corePath = path.join(tempDir, "core.mp4");
    const assPath = path.join(tempDir, "captions.ass");
    try {
      const timing = await this.renderCore(candidate.renderPlan, account, corePath, true, signal);
      await this.writeAss(
        candidate.renderPlan,
        assPath,
        "douyin",
        timing.totalDuration,
        timing.contentOffset,
        timing.contentDuration,
      );
      await run(this.ffmpeg(), [
        "-y",
        "-i",
        corePath,
        "-vf",
        `subtitles='${escapeFilterPath(assPath)}'`,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-t",
        ffmpegNumber(timing.totalDuration),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        ...NORMALIZED_VIDEO_METADATA_ARGS,
        outputPath,
      ], 0, signal);
      return outputPath;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async render(candidate: Candidate, account: AccountProfile, platform: Platform, outputPath: string, signal?: AbortSignal): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const tempDir = path.join(path.dirname(outputPath), `.render-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    const corePath = path.join(tempDir, "core.mp4");
    try {
      const timing = await this.renderCore(candidate.renderPlan, account, corePath, false, signal);
      const args = ["-y", "-i", corePath];
      let musicInput = -1;
      let logoInput = -1;
      if (account.musicPath) {
        musicInput = 1;
        args.push("-stream_loop", "-1", "-i", account.musicPath);
      }
      if (account.logoPath) {
        logoInput = musicInput > 0 ? 2 : 1;
        args.push("-i", account.logoPath);
      }
      // Final exports intentionally contain no burned-in workbench captions.
      // The review preview is the place where hook/body subtitles are shown;
      // the exported MP4 keeps the original video pixels and original sticker.
      const videoFilters = ["[0:v]null[base]"];
      if (logoInput > 0) {
        videoFilters.push(`[${logoInput}:v]scale=160:-1[logo]`, "[base][logo]overlay=W-w-48:48[vout]");
      } else {
        videoFilters.push("[base]null[vout]");
      }
      if (musicInput > 0) {
        videoFilters.push(`[${musicInput}:a]volume=0.14[bg]`, "[bg][0:a]sidechaincompress=threshold=0.025:ratio=10[duck]", "[0:a][duck]amix=inputs=2:duration=first:normalize=0[aout]");
      } else {
        videoFilters.push("[0:a]loudnorm=I=-16:LRA=11:TP=-1.5[aout]");
      }
      args.push(
        "-filter_complex", videoFilters.join(";"),
        "-map", "[vout]", "-map", "[aout]",
        "-t", ffmpegNumber(timing.totalDuration),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        ...NORMALIZED_VIDEO_METADATA_ARGS,
        outputPath
      );
      await run(this.ffmpeg(), args, 0, signal);
      return outputPath;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private systemFont(): string | undefined {
    const candidates = process.platform === "win32"
      ? ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"]
      : ["/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Light.ttc"];
    return candidates.find((candidate) => require("node:fs").existsSync(candidate));
  }

  async createCover(candidate: Candidate, account: AccountProfile, outputPath: string, coverText: string): Promise<string> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const first = candidate.renderPlan.segments[0];
    const info = await this.probe(candidate.renderPlan.sourceVideoPath);
    const base = this.preserveFrameFilter(info.width, info.height).replace(",fps=30", "");
    const font = this.systemFont();
    const sanitized = coverText.replace(/[\\':%]/g, " ").slice(0, 28);
    const coverStyle = account.coverTemplate === "clean"
      ? "drawbox=x=70:y=1320:w=940:h=330:color=black@0.35:t=fill"
      : account.coverTemplate === "academic"
        ? "drawbox=x=40:y=130:w=1000:h=340:color=0x14233a@0.88:t=fill"
        : "drawbox=x=45:y=160:w=990:h=300:color=black@0.58:t=fill";
    const coverY = account.coverTemplate === "clean" ? 1390 : account.coverTemplate === "academic" ? 220 : 230;
    const coverSize = account.coverTemplate === "clean" ? 62 : 72;
    const drawText = font
      ? `,${coverStyle},drawtext=fontfile='${escapeFilterPath(font)}':text='${sanitized}':fontcolor=white:fontsize=${coverSize}:borderw=5:bordercolor=black:x=(w-text_w)/2:y=${coverY}`
      : "";
    const coverTimestamp = await this.chooseCoverTimestamp(candidate.renderPlan).catch(
      () => first.sourceStart + Math.min(1, (first.sourceEnd - first.sourceStart) / 3),
    );
    await run(this.ffmpeg(), [
      "-y", "-autorotate", "1", "-ss", ffmpegNumber(coverTimestamp),
      "-i", candidate.renderPlan.sourceVideoPath,
      "-frames:v", "1", "-vf", `${base}${drawText}`, "-q:v", "2",
      "-map_metadata", "-1", outputPath
    ]);
    return outputPath;
  }
}

export function resolveBundledFfmpeg(): { ffmpeg: string; ffprobe: string } {
  const staticFfmpeg = require("ffmpeg-static") as string | null;
  const staticFfprobe = require("ffprobe-static") as { path?: string };
  const configuredFfmpeg = process.env.FFMPEG_PATH;
  const configuredFfprobe = process.env.FFPROBE_PATH;
  const ffprobeCandidate = staticFfprobe.path;
  const ffprobeCandidates = [
    ffprobeCandidate,
    ...(ffprobeCandidate
      ? [
          // ffprobe-static selects a folder from process.arch. A 32-bit
          // Electron build can still run the x64 helper on 64-bit Windows,
          // and older packages sometimes unpack only that sibling folder.
          path.resolve(
            path.dirname(ffprobeCandidate),
            "..",
            "x64",
            path.basename(ffprobeCandidate),
          ),
          path.resolve(
            path.dirname(ffprobeCandidate),
            "..",
            "ia32",
            path.basename(ffprobeCandidate),
          ),
        ]
      : []),
  ].filter((value): value is string => Boolean(value));
  const usableFfprobe = ffprobeCandidates
    .map((value) => unpacked(value))
    .find((value) => {
    try {
      fsSync.accessSync(value, fsSync.constants.F_OK);
      return true;
    } catch {
      return false;
    }
    });
  const bundledFfmpeg = staticFfmpeg ? unpacked(staticFfmpeg) : undefined;
  return {
    ffmpeg: configuredFfmpeg || bundledFfmpeg || path.join(os.homedir(), "ffmpeg"),
    ffprobe: configuredFfprobe || usableFfprobe || (ffprobeCandidate ? unpacked(ffprobeCandidate) : undefined) || path.join(os.homedir(), "ffprobe")
  };
}
