import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { SourceInspection } from "../shared/types";
import type { SourceFetch } from "./source-http";
import { sourceNetworkError } from "./source-http";

export interface SourceImportProgress {
  phase: "downloading" | "retrying";
  downloadedBytes: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  attempt: number;
}

type ProgressListener = (progress: SourceImportProgress) => void;
export type CookieProvider = (url: string) => Promise<string | undefined>;

export interface FeishuMaterialFile {
  name: string;
  token: string;
  type?: string;
  url?: string;
  modifiedTime?: string;
  createdTime?: string;
}

export interface FeishuMaterialDrive {
  listFiles(folderToken: string): Promise<FeishuMaterialFile[]>;
  downloadFile(fileToken: string, destination: string, signal?: AbortSignal): Promise<string>;
}

export interface FeishuMinutesSource {
  getMinutesInfo(minuteToken: string): Promise<{
    token: string;
    title?: string;
    duration?: string;
  }>;
  downloadMinutesMedia(minuteToken: string, destination: string, signal?: AbortSignal): Promise<string>;
  downloadMinutesTranscript(minuteToken: string, destination: string, signal?: AbortSignal): Promise<string>;
}

export interface FeishuMaterialSelection {
  videoFile?: FeishuMaterialFile;
  transcriptFile?: FeishuMaterialFile;
  message: string;
}

export interface SourceAdapter {
  canHandle(url: string): boolean;
  inspect(url: string): Promise<SourceInspection>;
  import(
    url: string,
    workDir: string,
    onProgress?: ProgressListener,
    signal?: AbortSignal,
  ): Promise<{ videoPath?: string; transcriptPath?: string }>;
}

export function providerFromUrl(url: string): SourceInspection["provider"] {
  const host = new URL(url).hostname.toLowerCase();
  if (/(^|\.)(?:feishu\.cn|larksuite\.com)$/i.test(host))
    return "feishu";
  if (/(^|\.)(?:qianwen\.com|qianwen\.aliyun\.com|tongyi\.aliyun\.com|tongyi\.com)$/i.test(host)) return "qianwen";
  if (/(^|\.)tingwu\.(?:aliyun\.com|cn)$/i.test(host))
    return "tingwu";
  return "unknown";
}

const FEISHU_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const FEISHU_TRANSCRIPT_EXTENSIONS = new Set([".srt", ".vtt", ".txt", ".docx"]);

function feishuFolderTokenFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (providerFromUrl(url) !== "feishu") return undefined;
    const match = parsed.pathname.match(
      /(?:^|\/)(?:drive\/folder|folder)\/([A-Za-z0-9_-]+)/i,
    );
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function feishuMinuteTokenFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (providerFromUrl(url) !== "feishu") return undefined;
    const match = parsed.pathname.match(/(?:^|\/)minutes\/([A-Za-z0-9_-]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function materialExtension(name: string): string {
  return path.extname(name).toLowerCase();
}

function materialStem(name: string): string {
  const extension = materialExtension(name);
  return path
    .basename(name, extension)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]*(?:逐字稿|字幕|transcript|subtitle)$/i, "")
    .replace(/[\s_-]+/g, "");
}

export function chooseFeishuMaterialFiles(
  files: readonly FeishuMaterialFile[],
): FeishuMaterialSelection {
  const videos = files.filter((file) =>
    FEISHU_VIDEO_EXTENSIONS.has(materialExtension(file.name)),
  );
  const transcripts = files.filter((file) =>
    FEISHU_TRANSCRIPT_EXTENSIONS.has(materialExtension(file.name)),
  );

  if (!videos.length) {
    return {
      message: "飞书文件夹中没有视频文件，请放入 MP4、MOV、MKV、WEBM 或 M4V 文件",
    };
  }
  if (!transcripts.length) {
    return {
      message: "飞书文件夹中没有逐字稿，请放入 SRT、VTT、TXT 或 DOCX 文件",
    };
  }
  if (videos.length === 1 && transcripts.length === 1) {
    return {
      videoFile: videos[0],
      transcriptFile: transcripts[0],
      message: "已找到 1 个视频和 1 个逐字稿",
    };
  }

  const pairs = videos.flatMap((videoFile) =>
    transcripts
      .filter((transcriptFile) => materialStem(videoFile.name) === materialStem(transcriptFile.name))
      .map((transcriptFile) => ({ videoFile, transcriptFile })),
  );
  if (pairs.length === 1) {
    return {
      videoFile: pairs[0].videoFile,
      transcriptFile: pairs[0].transcriptFile,
      message: "已按同名规则找到 1 个视频和 1 个逐字稿",
    };
  }

  return {
    message:
      "飞书文件夹中检测到多组视频或逐字稿，请只保留一组，或将视频与逐字稿改成同名文件",
  };
}

function absoluteUrl(candidate: string, base: string): string {
  try {
    return new URL(candidate.replaceAll("\\/", "/"), base).toString();
  } catch {
    return "";
  }
}

interface TingwuSentence {
  bt?: number | string;
  et?: number | string;
  tc?: string;
}

interface TingwuParagraph {
  sc?: TingwuSentence[];
}

interface TingwuResult {
  pg?: TingwuParagraph[];
}

interface TingwuResponse {
  code?: string | number;
  message?: string;
  data?: {
    playVideoUrl?: string;
    playback?: string;
    result?: string;
  };
}

interface TingwuAsset {
  videoUrl: string;
  paragraphs: Array<{ startMs: number; endMs: number; text: string }>;
}

function getTingwuTransId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)tingwu\.(?:aliyun\.com|cn)$/i.test(parsed.hostname))
      return undefined;
    const match = parsed.pathname.match(/^\/doc\/transcripts\/([^/]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function parseTingwuParagraphs(rawResult: string): TingwuAsset["paragraphs"] {
  const result = JSON.parse(rawResult) as TingwuResult;
  const paragraphs: TingwuAsset["paragraphs"] = [];
  for (const paragraph of result.pg ?? []) {
    const sentences = (paragraph.sc ?? []).filter((item) =>
      String(item.tc ?? "").trim(),
    );
    for (const sentence of sentences) {
      const startMs = Number(sentence.bt);
      const endMs = Number(sentence.et);
      const text = String(sentence.tc ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (
        !text ||
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        endMs <= startMs
      )
        continue;
      paragraphs.push({ startMs, endMs, text });
    }
  }
  return paragraphs;
}

function formatSrtTime(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function paragraphsToSrt(paragraphs: TingwuAsset["paragraphs"]): string {
  return paragraphs
    .map((item, index) =>
      [
        String(index + 1),
        `${formatSrtTime(item.startMs)} --> ${formatSrtTime(item.endMs)}`,
        item.text,
        "",
      ].join("\n"),
    )
    .join("\n");
}

const DOWNLOAD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36";

function sourceReferer(url: string): string {
  const parsed = new URL(url);
  // Share text can end with `# 《标题》`. Fragments are not part of an HTTP
  // referer, and serializing the URL also encodes any Unicode query values.
  parsed.hash = "";
  return parsed.href;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
  cookie?: string,
  request: SourceFetch = (input, options) => fetch(input, options),
  onProgress?: (message: string) => void,
): Promise<TingwuResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(url, {
        ...init,
        headers: {
          "User-Agent": DOWNLOAD_USER_AGENT,
          "Accept-Encoding": "identity",
          ...(cookie ? { Cookie: cookie } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(45_000),
      });
      if (response.ok) {
        return await response.json() as TingwuResponse;
      }
      if (response.status < 500 && response.status !== 429 || attempt === attempts) {
        throw new Error(`听悟接口请求失败：HTTP ${response.status}`);
      }
      await response.body?.cancel();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (!(error instanceof SyntaxError) && !sourceNetworkError(error) && !/HTTP (?:429|5\d\d)/.test(String(error))) throw error;
    }
    if (attempt < attempts) {
      onProgress?.(`正在重新连接听悟 · ${attempt + 1}/${attempts}`);
      await wait(attempt * 2_000);
    }
  }
  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`听悟读取未完成，已尝试 ${attempts} 次。连接或返回数据中断：${reason}`);
}

function totalSizeFromHeaders(
  headers: http.IncomingHttpHeaders,
  existingBytes: number,
): number | undefined {
  const range = headers["content-range"]?.match(/\/(\d+)$/);
  if (range?.[1]) return Number(range[1]);
  const contentLength = Number(headers["content-length"]);
  return Number.isFinite(contentLength) && contentLength > 0
    ? existingBytes + contentLength
    : undefined;
}

async function downloadAttempt(
  url: string,
  partialPath: string,
  referer: string,
  existingBytes: number,
  attempt: number,
  onProgress?: ProgressListener,
  cookie?: string,
  signal?: AbortSignal,
  redirectsRemaining = 5,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("任务已停止"));
      return;
    }
    const parsed = new URL(url);
    const client = parsed.protocol === "http:" ? http : https;
    const headers: Record<string, string> = {
      Referer: referer,
      "User-Agent": DOWNLOAD_USER_AGENT,
      "Accept-Encoding": "identity",
      ...(cookie ? { Cookie: cookie } : {}),
    };
    if (existingBytes > 0) headers.Range = `bytes=${existingBytes}-`;

    const request = client.get(parsed, { family: 4, headers }, (response) => {
      const status = response.statusCode ?? 0;
      if (
        status >= 300 &&
        status < 400 &&
        response.headers.location &&
        redirectsRemaining > 0
      ) {
        response.resume();
        void downloadAttempt(
          new URL(response.headers.location, parsed).toString(),
          partialPath,
          referer,
          existingBytes,
          attempt,
          onProgress,
          cookie,
          signal,
          redirectsRemaining - 1,
        ).then(resolve, reject);
        return;
      }
      if (![200, 206].includes(status)) {
        response.resume();
        reject(new Error(`视频下载失败：HTTP ${status}`));
        return;
      }

      // If the server ignores Range, overwrite instead of appending duplicates.
      const shouldResume = existingBytes > 0 && status === 206;
      const startingBytes = shouldResume ? existingBytes : 0;
      const totalBytes = totalSizeFromHeaders(response.headers, startingBytes);
      const output = createWriteStream(partialPath, {
        flags: shouldResume ? "a" : "w",
      });
      let downloadedBytes = startingBytes;
      let intervalBytes = startingBytes;
      let intervalStartedAt = Date.now();
      let lastReportedAt = 0;

      response.on("data", (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastReportedAt < 2_000) return;
        const elapsedSeconds = Math.max(
          0.001,
          (now - intervalStartedAt) / 1_000,
        );
        onProgress?.({
          phase: "downloading",
          downloadedBytes,
          totalBytes,
          bytesPerSecond: (downloadedBytes - intervalBytes) / elapsedSeconds,
          attempt,
        });
        lastReportedAt = now;
        intervalBytes = downloadedBytes;
        intervalStartedAt = now;
      });

      void pipeline(response, output).then(() => {
        onProgress?.({
          phase: "downloading",
          downloadedBytes,
          totalBytes,
          attempt,
        });
        signal?.removeEventListener("abort", abortRequest);
        resolve();
      }, (error) => {
        signal?.removeEventListener("abort", abortRequest);
        reject(error);
      });
    });
    const abortRequest = () => {
      request.destroy(new Error("任务已停止"));
    };
    signal?.addEventListener("abort", abortRequest, { once: true });
    request.setTimeout(30_000, () => {
      request.destroy(new Error("视频服务器 30 秒未返回数据"));
    });
    request.once("error", (error) => {
      signal?.removeEventListener("abort", abortRequest);
      reject(error);
    });
  });
}

export async function downloadToFileResumable(
  url: string,
  destination: string,
  referer: string,
  onProgress?: ProgressListener,
  cookie?: string,
  signal?: AbortSignal,
): Promise<void> {
  const partialPath = `${destination}.download`;
  const requestReferer = sourceReferer(referer);
  if (
    await fs.stat(destination).then(
      () => true,
      () => false,
    )
  )
    return;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (signal?.aborted) throw new Error("任务已停止");
    const existingBytes = await fs.stat(partialPath).then(
      (stat) => stat.size,
      () => 0,
    );
    if (attempt > 1) {
      onProgress?.({
        phase: "retrying",
        downloadedBytes: existingBytes,
        attempt,
      });
      if (signal?.aborted) throw new Error("任务已停止");
      await wait(Math.min(2 ** (attempt - 1) * 1_000, 15_000));
    }
    try {
      await downloadAttempt(
        url,
        partialPath,
        requestReferer,
        existingBytes,
        attempt,
        onProgress,
        cookie,
        signal,
      );
      await fs.rename(partialPath, destination);
      return;
    } catch (error) {
      if (signal?.aborted) throw new Error("任务已停止");
      lastError = error;
    }
  }
  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`视频下载中断，已自动重试 5 次：${reason}`);
}

export class TingwuSourceAdapter implements SourceAdapter {
  private readonly cache = new Map<
    string,
    { expiresAt: number; asset: TingwuAsset }
  >();

  constructor(private readonly cookieProvider: CookieProvider = async () => undefined,
    private readonly request: SourceFetch = (input, options) => fetch(input, options)) {}

  canHandle(url: string): boolean {
    return Boolean(getTingwuTransId(url));
  }

  async readTranscript(url: string, onProgress?: (message: string) => void): Promise<TingwuAsset['paragraphs']> {
    return (await this.resolve(url, false, onProgress)).paragraphs;
  }

  private async resolve(url: string, requireVideo = true, onProgress?: (message: string) => void): Promise<TingwuAsset> {
    const transId = getTingwuTransId(url);
    if (!transId) throw new Error("不是有效的通义听悟逐字稿链接");
    const cached = this.cache.get(transId);
    if (cached && cached.expiresAt > Date.now() && (!requireVideo || cached.asset.videoUrl)) return cached.asset;

    const referer = sourceReferer(url);
    const parsed = new URL(referer);
    const cookie = await this.cookieProvider(referer);
    const payload = await fetchWithRetry(
      `${parsed.origin}/api/trans/getTransResult?c=web`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          Origin: parsed.origin,
          Referer: referer,
        },
        body: JSON.stringify({
          action: "getTransResult",
          version: "1.0",
          transId,
        }),
      },
      3,
      cookie,
      this.request,
      onProgress,
    );
    if (String(payload.code) !== "0" || !payload.data) {
      const reason = payload.message || String(payload.code || "未知错误");
      throw new Error(
        `听悟未授权读取这条记录（${reason}），请确认分享仍有效且允许查看`,
      );
    }
    const videoUrl =
      payload.data.playVideoUrl &&
      payload.data.playVideoUrl !== "null_video_url"
        ? payload.data.playVideoUrl
        : payload.data.playback;
    const paragraphs = payload.data.result
      ? parseTingwuParagraphs(payload.data.result)
      : [];
    if (requireVideo && !videoUrl) throw new Error("听悟记录中没有可下载的视频地址");
    if (!paragraphs.length)
      throw new Error("听悟记录中没有可用的带时间码逐字稿");
    const asset = { videoUrl: videoUrl ?? '', paragraphs };
    this.cache.set(transId, { expiresAt: Date.now() + 5 * 60_000, asset });
    return asset;
  }

  async inspect(url: string): Promise<SourceInspection> {
    try {
      const asset = await this.resolve(url);
      return {
        provider: "tingwu",
        supported: true,
        requiresFallback: false,
        videoUrl: asset.videoUrl,
        message: `已识别听悟视频和 ${asset.paragraphs.length} 段带时间码逐字稿，可直接导入`,
      };
    } catch (error) {
      return {
        provider: "tingwu",
        supported: true,
        requiresFallback: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async import(
    url: string,
    workDir: string,
    onProgress?: ProgressListener,
    signal?: AbortSignal,
  ): Promise<{ videoPath?: string; transcriptPath?: string }> {
    const referer = sourceReferer(url);
    const asset = await this.resolve(referer);
    await fs.mkdir(workDir, { recursive: true });
    const inputDir = path.join(workDir, "input");
    await fs.mkdir(inputDir, { recursive: true });
    const transcriptPath = path.join(inputDir, "transcript.srt");
    await fs.writeFile(
      transcriptPath,
      paragraphsToSrt(asset.paragraphs),
      "utf8",
    );
    const videoPath = path.join(inputDir, "source.mp4");
    await downloadToFileResumable(asset.videoUrl, videoPath, referer, onProgress, await this.cookieProvider(referer), signal);
    return { videoPath, transcriptPath };
  }
}

export class FeishuMinutesSourceAdapter implements SourceAdapter {
  constructor(private readonly minutes: FeishuMinutesSource) {}

  canHandle(url: string): boolean {
    return Boolean(feishuMinuteTokenFromUrl(url));
  }

  private minuteToken(url: string): string {
    const token = feishuMinuteTokenFromUrl(url);
    if (!token) throw new Error("不是有效的飞书妙记链接");
    return token;
  }

  async inspect(url: string): Promise<SourceInspection> {
    try {
      const info = await this.minutes.getMinutesInfo(this.minuteToken(url));
      const title = info.title ? `“${info.title}”` : "这条妙记";
      return {
        provider: "feishu",
        supported: true,
        requiresFallback: false,
        message: `已识别飞书妙记 ${title}，将自动读取视频和带时间码逐字稿`,
      };
    } catch (error) {
      return {
        provider: "feishu",
        supported: true,
        requiresFallback: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async import(
    url: string,
    workDir: string,
    onProgress?: ProgressListener,
    signal?: AbortSignal,
  ): Promise<{ videoPath?: string; transcriptPath?: string }> {
    void onProgress;
    const token = this.minuteToken(url);
    await fs.mkdir(workDir, { recursive: true });
    const inputDir = path.join(workDir, "input");
    await fs.mkdir(inputDir, { recursive: true });
    const videoPath = path.join(inputDir, "source.mp4");
    const transcriptPath = path.join(inputDir, "transcript.txt");

    await this.downloadAsset(
      videoPath,
      (destination) => signal
        ? this.minutes.downloadMinutesMedia(token, destination, signal)
        : this.minutes.downloadMinutesMedia(token, destination),
      "飞书妙记视频下载失败",
      signal,
    );
    await this.downloadAsset(
      transcriptPath,
      (destination) => signal
        ? this.minutes.downloadMinutesTranscript(token, destination, signal)
        : this.minutes.downloadMinutesTranscript(token, destination),
      "飞书妙记逐字稿下载失败",
      signal,
    );
    return { videoPath, transcriptPath };
  }

  private async downloadAsset(
    destination: string,
    action: (destination: string) => Promise<string>,
    label: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const partialPath = `${destination}.download`;
    await fs.rm(partialPath, { force: true });
    try {
      if (signal?.aborted) throw new Error("任务已停止");
      await action(partialPath);
      const stat = await fs.stat(partialPath);
      if (stat.size <= 0) throw new Error("下载文件为空");
      await fs.rm(destination, { force: true });
      await fs.rename(partialPath, destination);
    } catch (error) {
      await fs.rm(partialPath, { force: true });
      throw new Error(
        `${label}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export class FeishuMaterialSourceAdapter implements SourceAdapter {
  constructor(private readonly drive: FeishuMaterialDrive) {}

  canHandle(url: string): boolean {
    return Boolean(feishuFolderTokenFromUrl(url));
  }

  private async resolveSelection(url: string): Promise<{
    folderToken: string;
    videoFile: FeishuMaterialFile;
    transcriptFile: FeishuMaterialFile;
  }> {
    const folderToken = feishuFolderTokenFromUrl(url);
    if (!folderToken) throw new Error("不是有效的飞书云盘文件夹链接");
    const selection = chooseFeishuMaterialFiles(
      await this.drive.listFiles(folderToken),
    );
    if (!selection.videoFile || !selection.transcriptFile) {
      throw new Error(selection.message);
    }
    return {
      folderToken,
      videoFile: selection.videoFile,
      transcriptFile: selection.transcriptFile,
    };
  }

  async inspect(url: string): Promise<SourceInspection> {
    try {
      const selection = await this.resolveSelection(url);
      return {
        provider: "feishu",
        supported: true,
        requiresFallback: false,
        message: `已连接飞书云盘，识别到视频“${selection.videoFile.name}”和逐字稿“${selection.transcriptFile.name}”，可直接导入`,
      };
    } catch (error) {
      return {
        provider: "feishu",
        supported: true,
        requiresFallback: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async import(
    url: string,
    workDir: string,
    onProgress?: ProgressListener,
    signal?: AbortSignal,
  ): Promise<{ videoPath?: string; transcriptPath?: string }> {
    void onProgress;
    const selection = await this.resolveSelection(url);
    await fs.mkdir(workDir, { recursive: true });
    const inputDir = path.join(workDir, "input");
    await fs.mkdir(inputDir, { recursive: true });
    const videoExtension = materialExtension(selection.videoFile.name) || ".mp4";
    const transcriptExtension =
      materialExtension(selection.transcriptFile.name) || ".txt";
    const videoPath = path.join(inputDir, `source${videoExtension}`);
    const transcriptPath = path.join(inputDir, `transcript${transcriptExtension}`);

    await this.downloadMaterialFile(
      selection.videoFile,
      videoPath,
      "飞书视频下载失败",
      signal,
    );
    await this.downloadMaterialFile(
      selection.transcriptFile,
      transcriptPath,
      "飞书逐字稿下载失败",
      signal,
    );
    return { videoPath, transcriptPath };
  }

  private async downloadMaterialFile(
    file: FeishuMaterialFile,
    destination: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const partialPath = `${destination}.download`;
    await fs.rm(partialPath, { force: true });
    try {
      if (signal?.aborted) throw new Error("任务已停止");
      await (signal
        ? this.drive.downloadFile(file.token, partialPath, signal)
        : this.drive.downloadFile(file.token, partialPath));
      const stat = await fs.stat(partialPath);
      if (stat.size <= 0) throw new Error("下载文件为空");
      await fs.rm(destination, { force: true });
      await fs.rename(partialPath, destination);
    } catch (error) {
      await fs.rm(partialPath, { force: true });
      throw new Error(
        `${label}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export class ExperimentalShareLinkAdapter implements SourceAdapter {
  constructor(private readonly cookieProvider: CookieProvider = async () => undefined) {}
  canHandle(url: string): boolean {
    try {
      return providerFromUrl(url) !== "unknown";
    } catch {
      return false;
    }
  }

  async inspect(url: string): Promise<SourceInspection> {
    const provider = providerFromUrl(url);
    if (provider === "unknown") {
      return {
        provider,
        supported: false,
        requiresFallback: true,
        message: "暂不识别该分享平台，请补传视频和逐字稿",
      };
    }
    try {
      const cookie = await this.cookieProvider(url);
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          "User-Agent": DOWNLOAD_USER_AGENT,
        },
      });
      const html = await response.text();
      const videoMatch = html.match(
        /(?:property=["']og:video(?::url)?["'][^>]*content=["']([^"']+)|(?:https?:)?\\?\/\\?\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)/i,
      );
      const transcriptMatch = html.match(
        /(?:transcriptUrl|subtitleUrl|download_url)["'\s:=]+["']([^"']+\.(?:srt|vtt|txt|json)(?:\?[^"']*)?)/i,
      );
      const videoUrl = videoMatch?.[1] ?? videoMatch?.[0];
      return {
        provider,
        supported: true,
        requiresFallback: !videoUrl,
        videoUrl: videoUrl ? absoluteUrl(videoUrl, url) : undefined,
        transcriptUrl: transcriptMatch?.[1]
          ? absoluteUrl(transcriptMatch[1], url)
          : undefined,
        message: videoUrl
          ? "已发现可下载媒体，将尝试自动导入"
          : "页面可访问，但未发现直接媒体地址，请补传文件",
      };
    } catch (error) {
      return {
        provider,
        supported: true,
        requiresFallback: true,
        message: `链接检查失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async import(
    url: string,
    workDir: string,
    onProgress?: ProgressListener,
    signal?: AbortSignal,
  ): Promise<{ videoPath?: string; transcriptPath?: string }> {
    const inspection = await this.inspect(url);
    if (!inspection.videoUrl) return {};
    await fs.mkdir(workDir, { recursive: true });
    const inputDir = path.join(workDir, "input");
    await fs.mkdir(inputDir, { recursive: true });
    const videoPath = path.join(inputDir, "source.mp4");
    await downloadToFileResumable(
      inspection.videoUrl,
      videoPath,
      url,
      onProgress,
      await this.cookieProvider(url),
      signal,
    );
    let transcriptPath: string | undefined;
    if (inspection.transcriptUrl) {
      const cookie = await this.cookieProvider(url);
      const transcriptResponse = await fetch(inspection.transcriptUrl, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
        headers: cookie ? { Cookie: cookie } : undefined,
      });
      if (transcriptResponse.ok) {
        const extension =
          path.extname(new URL(inspection.transcriptUrl).pathname) || ".txt";
        transcriptPath = path.join(inputDir, `transcript${extension}`);
        await fs.writeFile(
          transcriptPath,
          Buffer.from(await transcriptResponse.arrayBuffer()),
        );
      }
    }
    return { videoPath, transcriptPath };
  }
}

export class SourceAdapterRegistry {
  private readonly adapters: SourceAdapter[];

  constructor(
    private readonly cookieProvider: CookieProvider = async () => undefined,
    feishuDrive?: FeishuMaterialDrive,
    feishuMinutes?: FeishuMinutesSource,
    request: SourceFetch = (input, options) => fetch(input, options),
  ) {
    this.adapters = [
      ...(feishuMinutes ? [new FeishuMinutesSourceAdapter(feishuMinutes)] : []),
      ...(feishuDrive ? [new FeishuMaterialSourceAdapter(feishuDrive)] : []),
      new TingwuSourceAdapter(cookieProvider, request),
      new ExperimentalShareLinkAdapter(cookieProvider),
    ];
  }

  async inspect(url: string): Promise<SourceInspection> {
    const adapter = this.adapters.find((item) => item.canHandle(url));
    return adapter
      ? adapter.inspect(url)
      : {
          provider: "unknown",
          supported: false,
          requiresFallback: true,
          message: "未知链接来源，请补传视频和逐字稿",
        };
  }

  async import(
    url: string,
    workDir: string,
    onProgress?: ProgressListener,
    signal?: AbortSignal,
  ): Promise<{ videoPath?: string; transcriptPath?: string }> {
    const adapter = this.adapters.find((item) => item.canHandle(url));
    return adapter ? adapter.import(url, workDir, onProgress, signal) : {};
  }
}
