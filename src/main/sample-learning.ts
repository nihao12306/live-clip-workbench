import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AccountProfile,
  SampleLearningItem,
  SampleLearningProfile,
  SampleLearningReport,
  SampleLearningSource,
  SampleLearningState,
  TranscriptSegment,
} from "../shared/types";
import { parseTranscriptFile, parseSrtOrVtt } from "./transcript";

const DEFAULT_SAMPLE_MODEL = "faster-whisper-base";

type MediaProbe = {
  format?: { duration?: string };
  streams?: Array<{
    index?: number;
    codec_type?: string;
    codec_name?: string;
    codec_long_name?: string;
  }>;
};

function unpacked(binaryPath: string): string {
  return binaryPath.replace("app.asar", "app.asar.unpacked");
}

async function run(
  binary: string,
  args: string[],
  timeoutMs: number,
  envOverrides?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`样片读取超时：${stderr.slice(-800)}`));
      }, timeoutMs);
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`样片读取失败 (${code})：${stderr.slice(-1200)}`));
    });
  });
}

function environmentPath(...parts: string[]): string {
  return path.join(...parts);
}

function resourcePath(...parts: string[]): string {
  return environmentPath(process.resourcesPath ?? "", "app.asar.unpacked", ...parts);
}

function commandExists(command: string): boolean {
  try {
    return fsSync.existsSync(command);
  } catch {
    return false;
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/\uFEFF/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sidecarCandidates(videoPath: string): string[] {
  const stem = path.join(path.dirname(videoPath), path.basename(videoPath, path.extname(videoPath)));
  return [
    `${stem}.srt`,
    `${stem}.vtt`,
    `${stem}.txt`,
    `${stem}.docx`,
    `${stem}.json`,
  ];
}

function dedupeText(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  return normalized
    .split(/\s+/u)
    .reduce<string[]>((chunks, chunk) => {
      if (chunks[chunks.length - 1] === chunk) return chunks;
      chunks.push(chunk);
      return chunks;
    }, [])
    .join(" ");
}

function segmentsToText(segments: TranscriptSegment[]): string {
  return dedupeText(segments.map((segment) => segment.text).join(" "));
}

type SignalRule = { pattern: RegExp; label: string };

function collectSignals(text: string, rules: SignalRule[]): string[] {
  return rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label);
}

function uniqueSignals(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Derive a compact, explainable profile from sample text. This deliberately
 * emits pattern labels instead of copying source sentences or facts.
 */
export function buildSampleLearningProfile(
  items: Array<{ path: string; text: string }>,
  sampleProfiles: AccountProfile["sampleProfiles"] = [],
  sampleCount = items.length,
  fillerWords: string[] = [],
): SampleLearningProfile {
  const learnedItems = items.filter((item) => item.text.trim());
  const allText = learnedItems.map((item) => item.text).join("\n");
  const openingText = learnedItems
    .map((item) => normalizeText(item.text).slice(0, 240))
    .join(" ");
  const hookPatterns = uniqueSignals(collectSignals(openingText, [
    { pattern: /很多人|大家|家长|考生|不少人|原本以为/u, label: "从具体人群或常见误区切入" },
    { pattern: /今年|变化|最新|政策|调整/u, label: "前置当年变化或政策信号" },
    { pattern: /\d{3,4}\s*(?:分|到|至|—|-)|分数|位次|特控线/u, label: "尽早限定分数段、位次或人群条件" },
    { pattern: /要不要|怎么选|如何选|值不值得|适不适合|能不能/u, label: "直接提出一个选择问题" },
    { pattern: /其实|真正|关键|不能只看|不是.{0,8}而是/u, label: "先给反常识判断或核心结论" },
  ]));
  const structurePatterns = uniqueSignals(collectSignals(allText, [
    { pattern: /因为|原因|之所以|机制|关键/u, label: "结论之后解释原因或运行机制" },
    { pattern: /分数|位次|数据|比例|学校|专业|政策|录取|案例|保研|就业/u, label: "用具体事实、数据、学校或案例支撑" },
    { pattern: /但是|不过|不等于|不能只看|前提|边界|风险|谨慎/u, label: "保留边界、反例和风险提醒" },
    { pattern: /如果|适合|不适合|取决于|更看重|目标是|对于/u, label: "按不同人群、目标或偏好给条件化建议" },
    { pattern: /还是|取舍|比较|对比|一方面|另一方面|只能|优先/u, label: "围绕一个选择和一个主矛盾展开" },
  ]));
  const audienceSignals = uniqueSignals(collectSignals(allText, [
    { pattern: /广东|广州|深圳|佛山|东莞|惠州|湾区|城市|地域/u, label: "地区或城市具体" },
    { pattern: /\d{3,4}\s*(?:分|到|至|—|-)|位次|特控线/u, label: "分数段、位次或批次具体" },
    { pattern: /物理类|历史类|物理|历史|选科|科类/u, label: "科类或选科具体" },
    { pattern: /家长|孩子|考生|学生|家庭/u, label: "明确家长、孩子或考生角色" },
    { pattern: /就业|升学|读研|保研|职业|工作/u, label: "绑定就业、升学或职业目标" },
    { pattern: /学费|预算|成本|留在|离开|城市/u, label: "纳入家庭预算或城市偏好" },
  ]));
  const evidenceSignals = uniqueSignals(collectSignals(allText, [
    { pattern: /分数|位次|录取线|排名/u, label: "分数与位次" },
    { pattern: /学校|大学|专业组|科类|专业/u, label: "学校、专业和专业组" },
    { pattern: /政策|招生|录取|扩招|时间|年份|调整/u, label: "政策、招生和年度变化" },
    { pattern: /就业|招聘|保研|升学|读研|职业/u, label: "就业、升学和职业路径" },
    { pattern: /数据|比例|案例|比如|例如/u, label: "数据、比例和案例" },
  ]));
  const toneSignals = uniqueSignals(collectSignals(allText, [
    { pattern: /但是|不过|不等于|前提|条件|取决于|适合|不适合/u, label: "理性克制，保留条件和边界" },
    { pattern: /很多人|大家以为|误区|其实|不能只看|不是.{0,8}而是/u, label: "善用纠偏和反常识表达" },
    { pattern: /分数|位次|政策|专业组|数据|案例/u, label: "信息密度优先，少做泛泛评价" },
    { pattern: /建议|应该|需要|可以|下一步|核对/u, label: "观点最终落到行动建议" },
  ]));
  const recommendationPatterns = uniqueSignals(collectSignals(allText, [
    { pattern: /适合谁|适合|不适合/u, label: "明确适合谁、不适合谁" },
    { pattern: /如果|取决于|更看重|目标是|对于|前提/u, label: "根据目标和偏好分条件给建议" },
    { pattern: /建议|应该|需要|可以考虑|下一步|核对|填报|排序/u, label: "给出下一步核对、填报或选择动作" },
  ]));
  const avoidPatterns = [
    "不复制样片原句、学校事实或数据",
    "避免泛泛评价、无条件承诺和绝对化结论",
    "删除寒暄、日期更新、独立口癖和重复赘述",
  ];
  if (fillerWords.length) {
    avoidPatterns.push(`清理账号配置的口癖：${fillerWords.slice(0, 8).join("、")}`);
  }
  const measuredProfiles = (sampleProfiles ?? []).filter(
    (item) => item.views !== undefined || item.completionRate !== undefined,
  );
  const performanceSignals = measuredProfiles.length
    ? [
      `已有 ${measuredProfiles.length} 条样片表现数据，优先参考高表现样片的结构`,
      ...(measuredProfiles.some((item) => item.views !== undefined) ? ["播放量用于判断选题吸引力"] : []),
      ...(measuredProfiles.some((item) => item.completionRate !== undefined) ? ["完播率用于判断内容完整性"] : []),
    ]
    : [];
  const summary = learnedItems.length
    ? [
      `基于 ${learnedItems.length}/${Math.max(sampleCount, learnedItems.length)} 条样片文字生成`,
      audienceSignals.length ? `受众：${audienceSignals.slice(0, 3).join("、")}` : "受众需要进一步具体化",
      structurePatterns.length ? `结构：${structurePatterns.slice(0, 4).join("、")}` : "结构信号不足",
      toneSignals.length ? `表达：${toneSignals.slice(0, 3).join("、")}` : "表达信号不足",
    ].join("；")
    : "当前没有读取到可用样片文字，暂不生成可靠的结构化风格画像";
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sampleCount,
    learnedSampleCount: learnedItems.length,
    summary,
    hookPatterns,
    structurePatterns,
    audienceSignals,
    evidenceSignals,
    toneSignals,
    recommendationPatterns,
    avoidPatterns,
    performanceSignals,
  };
}

export function buildSampleLearningProfileFromTranscript(
  transcript: string,
  sampleProfiles: AccountProfile["sampleProfiles"] = [],
  sampleCount = 0,
  fillerWords: string[] = [],
): SampleLearningProfile {
  const normalized = normalizeText(transcript);
  const markers = [...normalized.matchAll(/【样片：([^】]+)】/gu)];
  const items = markers.length
    ? markers.map((marker, index) => {
      const start = (marker.index ?? 0) + marker[0].length;
      const end = markers[index + 1]?.index ?? normalized.length;
      return { path: marker[1] ?? `sample-${index + 1}`, text: normalized.slice(start, end).trim() };
    }).filter((item) => item.text)
    : normalized ? [{ path: "manual-reference", text: normalized }] : [];
  return buildSampleLearningProfile(
    items,
    sampleProfiles,
    Math.max(sampleCount, items.length),
    fillerWords,
  );
}

async function readSidecar(videoPath: string, duration: number): Promise<string | undefined> {
  for (const candidate of sidecarCandidates(videoPath)) {
    if (!commandExists(candidate)) continue;
    try {
      const extension = path.extname(candidate).toLowerCase();
      if (extension === ".json") {
        const raw = JSON.parse(await fs.readFile(candidate, "utf8")) as unknown;
        const text = typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw.map((item) => typeof item === "string" ? item : (item as { text?: string }).text ?? "").join(" ")
            : typeof raw === "object" && raw !== null && "transcript" in raw
              ? String((raw as { transcript?: unknown }).transcript ?? "")
              : "";
        if (dedupeText(text)) return dedupeText(text);
        continue;
      }
      const segments = await parseTranscriptFile(candidate, duration);
      const text = segmentsToText(segments);
      if (text) return text;
    } catch {
      // A broken sidecar should not stop the remaining sample-learning sources.
    }
  }
  return undefined;
}

async function readEmbeddedSubtitles(
  videoPath: string,
  ffprobePath: string,
  ffmpegPath: string,
): Promise<string | undefined> {
  let probe: MediaProbe;
  try {
    probe = JSON.parse(await run(unpacked(ffprobePath), [
      "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", videoPath,
    ], 30_000)) as MediaProbe;
  } catch {
    return undefined;
  }
  const subtitle = probe.streams?.find((stream) => stream.codec_type === "subtitle");
  if (!subtitle || typeof subtitle.index !== "number") return undefined;
  const temp = path.join(os.tmpdir(), `live-clip-sample-${crypto.randomUUID()}.srt`);
  try {
    await run(unpacked(ffmpegPath), [
      "-v", "error", "-y", "-i", videoPath, "-map", `0:${subtitle.index}`, "-c:s", "srt", temp,
    ], 60_000);
    const parsed = parseSrtOrVtt(await fs.readFile(temp, "utf8"));
    return segmentsToText(parsed) || undefined;
  } catch {
    return undefined;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function localWhisperCandidates(): Array<{ python: string; model: string; tools: string }> {
  const configured = process.env.LIVE_CLIP_PYTHON;
  const pythonCandidates = [configured].filter((item): item is string => Boolean(item));
  const toolsCandidates = [
    process.env.LIVE_CLIP_MEDIA_TOOLS ?? "",
    resourcePath("media-tools"),
  ].filter((item): item is string => Boolean(item));
  const modelCandidates = [
    process.env.LIVE_CLIP_WHISPER_MODEL ?? "",
    resourcePath("media-models", DEFAULT_SAMPLE_MODEL),
  ].filter((item): item is string => Boolean(item));
  const configuredModels = modelCandidates.filter((model) => commandExists(path.join(model, "model.bin")));
  return pythonCandidates.flatMap((python) =>
    toolsCandidates.flatMap((tools) => configuredModels.map((model) => ({ python, model, tools }))),
  );
}

export function hasLocalWhisperRuntime(): boolean {
  return localWhisperCandidates().some(
    (candidate) => commandExists(candidate.python) && commandExists(path.join(candidate.model, "model.bin")),
  );
}

function parseWhisperJsonLines(value: string, videoPaths: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of value.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as { index?: number; text?: string };
      const videoPath = typeof parsed.index === "number" ? videoPaths[parsed.index] : undefined;
      if (videoPath && parsed.text) result.set(videoPath, dedupeText(parsed.text));
    } catch {
      // Python/runtime warnings are ignored; JSON lines are the contract.
    }
  }
  return result;
}

async function transcribeWithLocalWhisper(videoPaths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!videoPaths.length) return result;
  for (const candidate of localWhisperCandidates()) {
    if (!commandExists(candidate.python) || !commandExists(path.join(candidate.model, "model.bin"))) continue;
    const script = [
      "import json,sys",
      "from faster_whisper import WhisperModel",
      "model=WhisperModel(sys.argv[1], device='cpu', compute_type='int8')",
      "for index,video in enumerate(sys.argv[2:]):",
      "  try:",
      "    segments,info=model.transcribe(video, language='zh', vad_filter=True, beam_size=3, condition_on_previous_text=False)",
      "    text=' '.join(s.text.strip() for s in segments if s.text.strip())",
      "    print(json.dumps({'index':index,'text':text}, ensure_ascii=True), flush=True)",
      "  except Exception as exc:",
      "    print(json.dumps({'index':index,'text':'','error':str(exc)}, ensure_ascii=True), flush=True)",
    ].join("\n");
    try {
      const output = await run(
        candidate.python,
        ["-c", script, candidate.model, ...videoPaths],
        20 * 60_000,
        {
          ...(commandExists(candidate.tools) ? { PYTHONPATH: candidate.tools } : {}),
          ...(process.env.LIVE_CLIP_MEDIA_MODELS ? { HF_HOME: process.env.LIVE_CLIP_MEDIA_MODELS } : {}),
        },
      );
      return parseWhisperJsonLines(output, videoPaths);
    } catch {
      // Continue to the next possible local runtime, if one is added later.
    }
  }
  return result;
}

function buildLearningText(
  items: Array<{ path: string; text: string }>,
  existing?: string,
): string {
  const learned = items
    .filter((item) => item.text.trim())
    .map((item) => `【样片：${path.basename(item.path)}】\n${item.text.trim()}`)
    .join("\n\n");
  const existingText = normalizeText(existing ?? "");
  const firstLearnedMarker = existingText.search(/【样片：[^】]+】/u);
  // Everything before the first generated sample block is treated as manual
  // guidance. Generated blocks are
  // rebuilt from the current files so re-reading cannot duplicate stale text.
  const manual = firstLearnedMarker >= 0
    ? existingText.slice(0, firstLearnedMarker).trim()
    : existingText;
  return [manual, learned].filter(Boolean).join("\n\n").slice(0, 48_000);
}

export class SampleLearningService {
  constructor(
    private readonly ffmpegPath: () => string,
    private readonly ffprobePath: () => string,
  ) {}

  async learn(account: AccountProfile, samplePaths = account.samplePaths): Promise<SampleLearningReport> {
    const items: SampleLearningItem[] = [];
    const learnedText: Array<{ path: string; text: string }> = [];
    const pendingWhisper: string[] = [];
    for (const videoPath of [...new Set(samplePaths.filter(Boolean))]) {
      try {
        const probeOutput = await run(unpacked(this.ffprobePath()), [
          "-v", "quiet", "-print_format", "json", "-show_format", videoPath,
        ], 30_000);
        const duration = Number((JSON.parse(probeOutput) as MediaProbe).format?.duration ?? 0);
        const sidecar = await readSidecar(videoPath, duration);
        if (sidecar) {
          learnedText.push({ path: videoPath, text: sidecar });
          items.push({ path: videoPath, source: "sidecar_transcript", status: "learned", textLength: sidecar.length, message: "读取同名逐字稿/字幕文件" });
          continue;
        }
        const embedded = await readEmbeddedSubtitles(videoPath, this.ffprobePath(), this.ffmpegPath());
        if (embedded) {
          learnedText.push({ path: videoPath, text: embedded });
          items.push({ path: videoPath, source: "embedded_subtitle", status: "learned", textLength: embedded.length, message: "读取视频内嵌字幕" });
          continue;
        }
        pendingWhisper.push(videoPath);
      } catch (error) {
        items.push({ path: videoPath, source: "unavailable", status: "failed", textLength: 0, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (pendingWhisper.length) {
      const whisperResults = await transcribeWithLocalWhisper(pendingWhisper);
      for (const videoPath of pendingWhisper) {
        const whisper = whisperResults.get(videoPath);
        if (whisper) {
          const cleanedWhisper = dedupeText(whisper);
          learnedText.push({ path: videoPath, text: cleanedWhisper });
          items.push({ path: videoPath, source: "local_whisper", status: "learned", textLength: cleanedWhisper.length, message: "本机 Whisper 中文转写" });
        } else {
          items.push({ path: videoPath, source: "unavailable", status: "skipped", textLength: 0, message: "未找到逐字稿、内嵌字幕或可用的本地转写模型" });
        }
      }
    }
    const transcript = buildLearningText(learnedText, account.sampleTranscript);
    const profileItems = learnedText.length
      ? learnedText
      : account.sampleTranscript?.trim()
        ? [{ path: "manual-reference", text: account.sampleTranscript }]
        : [];
    const state: SampleLearningState = {
      learnedAt: new Date().toISOString(),
      model: hasLocalWhisperRuntime()
        ? "本机样片学习：同名逐字稿/内嵌字幕 + faster-whisper-base"
        : "本机样片学习：同名逐字稿/内嵌字幕（未检测到本地 Whisper）",
      transcriptChars: transcript.length,
      items,
      profile: buildSampleLearningProfile(
        profileItems,
        account.sampleProfiles,
        Math.max(samplePaths.length, profileItems.length),
        account.fillerWords,
      ),
    };
    return { accountId: account.id, state, transcript };
  }
}
