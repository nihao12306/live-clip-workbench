import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Candidate, TranscriptWordTiming } from "../shared/types";
import { prepareCandidateSubtitleSync } from "../shared/subtitle-sync";

interface LocalWhisperRuntime {
  python: string;
  model: string;
  tools: string;
}

const ALIGNMENT_PADDING_SECONDS = 2;
const ALIGNMENT_MERGE_GAP_SECONDS = 4;
const ALIGNMENT_TIMEOUT_MS = 8 * 60_000;

function resourcePath(...parts: string[]): string {
  return path.join(process.resourcesPath ?? process.cwd(), ...parts);
}

function localWhisperRuntimes(): LocalWhisperRuntime[] {
  const configuredPython = process.env.LIVE_CLIP_PYTHON;
  const pythonCandidates = [
    configuredPython ?? "",
    resourcePath("media-runtime", "python", "python.exe"),
  ].filter(Boolean);
  const toolsCandidates = [
    process.env.LIVE_CLIP_MEDIA_TOOLS ?? "",
    resourcePath("media-tools"),
  ].filter(Boolean);
  const modelCandidates = [
    process.env.LIVE_CLIP_WHISPER_MODEL ?? "",
    resourcePath("media-models", "faster-whisper-base"),
  ].filter((model) => model && fs.existsSync(path.join(model, "model.bin")));
  return pythonCandidates.flatMap((python) =>
    toolsCandidates.flatMap((tools) =>
      modelCandidates.map((model) => ({ python, model, tools })),
    ),
  ).filter((candidate) => fs.existsSync(candidate.python));
}

function alignmentRanges(candidate: Candidate): Array<{ start: number; end: number }> {
  const prepared = prepareCandidateSubtitleSync(candidate);
  const source = prepared.result.segments.length
    ? prepared.result.segments
    : candidate.renderPlan.segments;
  const ordered = source
    .map((segment) => ({
      start: Math.max(0, segment.sourceStart - ALIGNMENT_PADDING_SECONDS),
      end: segment.sourceEnd + ALIGNMENT_PADDING_SECONDS,
    }))
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.start - previous.end <= ALIGNMENT_MERGE_GAP_SECONDS) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function runWhisper(
  runtime: LocalWhisperRuntime,
  videoPath: string,
  ranges: Array<{ start: number; end: number }>,
): Promise<TranscriptWordTiming[]> {
  const clipTimestamps = ranges
    .flatMap((range) => [range.start.toFixed(3), range.end.toFixed(3)])
    .join(",");
  const script = [
    "import json,sys",
    "from faster_whisper import WhisperModel",
    "model=WhisperModel(sys.argv[1], device='cpu', compute_type='int8')",
    "segments,info=model.transcribe(sys.argv[2], language='zh', word_timestamps=True, vad_filter=False, beam_size=3, condition_on_previous_text=False, clip_timestamps=sys.argv[3])",
    "words=[]",
    "for segment in segments:",
    "  for word in (segment.words or []):",
    "    if word.start is not None and word.end is not None and word.end > word.start and word.word.strip():",
    "      words.append({'start':word.start,'end':word.end,'text':word.word.strip(),'probability':word.probability})",
    "print(json.dumps(words, ensure_ascii=False), flush=True)",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(
      runtime.python,
      ["-X", "utf8", "-c", script, runtime.model, videoPath, clipTimestamps],
      {
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          ...(fs.existsSync(runtime.tools) ? { PYTHONPATH: runtime.tools } : {}),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("精确字幕定位超时，请稍后重试"));
    }, ALIGNMENT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`精确字幕定位失败：${stderr.trim().slice(-500) || `进程退出码 ${code}`}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as TranscriptWordTiming[];
        resolve(parsed.filter((word) =>
          Number.isFinite(word.start)
          && Number.isFinite(word.end)
          && word.end > word.start
          && word.text.trim(),
        ));
      } catch {
        reject(new Error("精确字幕定位没有返回有效的词级时间码"));
      }
    });
  });
}

export async function ensureCandidateWordTimings(candidate: Candidate): Promise<Candidate> {
  const prepared = prepareCandidateSubtitleSync(candidate);
  if (!prepared.result.needsWordAlignment) return candidate;
  const ranges = alignmentRanges(candidate);
  if (!ranges.length) return candidate;
  let lastError: unknown;
  for (const runtime of localWhisperRuntimes()) {
    try {
      const wordTimings = await runWhisper(
        runtime,
        candidate.renderPlan.sourceVideoPath,
        ranges,
      );
      if (!wordTimings.length) throw new Error("没有识别到可用语音");
      const aligned = { ...candidate, wordTimings };
      const verified = prepareCandidateSubtitleSync(aligned);
      if (verified.result.needsWordAlignment) {
        const unsafe = verified.result.segments
          .filter((segment) => segment.subtitleGroupId && segment.timingPrecision !== "word")
          .map((segment) => segment.text)
          .slice(0, 3)
          .join("、");
        throw new Error(`词级时间码与当前逐字稿无法稳定对应${unsafe ? `：${unsafe}` : ""}`);
      }
      return aligned;
    } catch (error) {
      lastError = error;
    }
  }
  if (!localWhisperRuntimes().length) {
    throw new Error("当前素材只有粗时间码，本机又未找到精确语音定位组件，不能安全地按字切音频");
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("无法完成精确字幕定位");
}
