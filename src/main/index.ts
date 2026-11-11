import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  net,
  protocol,
  shell,
  session,
} from "electron";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { parse } from "csv-parse/sync";
import type {
  AccountProfile,
  AppSettings,
  BatchTaskRow,
  Candidate,
  ClipTask,
  CreateTaskInput,
  FeedbackRecord,
  ModelConnectionInput,
  PerformanceRecord,
  RejectionReason,
  FeishuFolderSetupResult,
  UpdateInfo,
  UpdateInstallRequest,
  UpdateFileChunk,
  UpdatePublishResult,
} from "../shared/types";
import { DatabaseService } from "./database";
import {
  candidatePolicyTexts,
  findPolicyMatches,
  policyMatchMessage,
} from "./content-policy";
import { ExportService } from "./exporter";
import { MediaService, resolveBundledFfmpeg } from "./media";
import { DeepSeekModelAdapter } from "./model-adapter";
import { SettingsService } from "./settings";
import { SourceAdapterRegistry, TingwuSourceAdapter, providerFromUrl } from "./source-adapters";
import { TextWorkbench } from "./text-workbench";
import { TextSources } from "./text-sources";
import { createSourceFetch } from "./source-http";
import { originalTextSource } from "../shared/text-selection";
import type { TextJobInput } from "../shared/text-selection";
import { TextFeishuExporter } from "./text-feishu-export";
import { repairCandidateOpening, TaskProcessor } from "./task-processor";
import { buildTopicContext } from "./topic-context";
import { parseTranscriptFile } from "./transcript";
import { SampleLearningService } from "./sample-learning";
import { ensureCandidateWordTimings } from "./word-alignment";
import { prepareCandidateSubtitleSync } from "../shared/subtitle-sync";
import { assessSelectionPrinciples, assertSelectionPrinciples } from "./selection-principles";
import { assessContentDensity, assertContentDensity } from "./content-density";
import {
  compareVersions,
  selectUpdateInstaller,
  selectUpdateRelease,
  type UpdateChunk,
  updatePlatformLabel,
  type UpdateRelease,
  type UpdateManifest,
} from "../shared/update";
import { checkGithubUpdate, downloadGithubUpdate } from "./github-update";
import {
  buildUpdateManifest,
  selectReleaseArtifacts,
} from "../shared/update-publish";
import {
  FeishuDriveService,
  extractFeishuFolderToken,
  isFeishuDocUrl,
  type FeishuDriveFile,
} from "./feishu-drive";

const sourceLoginPartition = "persist:live-clip-source-login";
const publicDataPath = path.join(app.getPath("appData"), "live-clip-workbench-community");
fsSync.mkdirSync(publicDataPath, { recursive: true });
app.setPath("userData", publicDataPath);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "local-media",
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | undefined;
let database: DatabaseService;
let settings: SettingsService;
let sources: SourceAdapterRegistry;
let processor: TaskProcessor;
let exporter: ExportService;
let model: DeepSeekModelAdapter;
let sampleLearning: SampleLearningService;
let feishu: FeishuDriveService;
let textWorkbench: TextWorkbench;
let textFeishuExporter: TextFeishuExporter;

function mediaUrlToPath(url: string): string {
  // The renderer adds a revision query to force Chromium to request a newly
  // rendered preview even though previews intentionally reuse the same path.
  // Windows file names cannot contain '?' or '#', so remove URL metadata
  // before resolving the local path.
  const resourceUrl = url.replace(/[?#].*$/u, "");
  let raw = decodeURI(resourceUrl.replace(/^local-media:\/\//, ""));
  raw = raw.replace(/^([A-Za-z])\//, "$1:/");
  return raw;
}

function mediaContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".mp4": "video/mp4",
      ".m4v": "video/mp4",
      ".mov": "video/quicktime",
      ".mkv": "video/x-matroska",
      ".webm": "video/webm",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".m4a": "audio/mp4",
    }[extension] ?? "application/octet-stream"
  );
}

function localMediaResponse(request: Request): Response {
  try {
    const requestedPath = mediaUrlToPath(request.url);
    const candidateId = path.basename(requestedPath, ".mp4");
    const candidate = database.getCandidate(candidateId);
    if (!candidate?.previewPath || path.resolve(requestedPath) !== path.resolve(candidate.previewPath)) {
      return new Response(null, { status: 404 });
    }
    const filePath = fsSync.realpathSync(candidate.previewPath);
    const task = database.getTask(candidate.taskId);
    if (!task || !isPathInside(fsSync.realpathSync(path.join(task.workDir, "previews")), filePath)) {
      return new Response(null, { status: 404 });
    }
    const stat = fsSync.statSync(filePath);
    if (!stat.isFile()) return new Response(null, { status: 404 });
    const totalSize = stat.size;
    const baseHeaders = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": mediaContentType(filePath),
      "Last-Modified": stat.mtime.toUTCString(),
    };
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { ...baseHeaders, "Content-Length": String(totalSize) },
      });
    }

    const rangeHeader = request.headers.get("range");
    let start = 0;
    let end = Math.max(0, totalSize - 1);
    let status = 200;
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (match) {
        if (match[1]) start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
        if (!match[1] && match[2]) {
          const suffixLength = Number(match[2]);
          start = Math.max(0, totalSize - suffixLength);
        }
        end = Math.min(end, totalSize - 1);
        if (start >= totalSize || start > end) {
          return new Response(null, {
            status: 416,
            headers: {
              ...baseHeaders,
              "Content-Range": `bytes */${totalSize}`,
            },
          });
        }
        status = 206;
      }
    }
    const contentLength = end - start + 1;
    const stream = Readable.toWeb(
      fsSync.createReadStream(filePath, { start, end }),
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status,
      headers: {
        ...baseHeaders,
        "Content-Length": String(contentLength),
        ...(status === 206
          ? { "Content-Range": `bytes ${start}-${end}/${totalSize}` }
          : {}),
      },
    });
  } catch {
    return new Response("媒体文件不存在", { status: 404 });
  }
}

function createWindow(): void {
  const smokeTest = process.argv.includes("--smoke-test");
  if (process.platform === "win32") {
    Menu.setApplicationMenu(null);
  }
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#eef2f6",
    show: !smokeTest,
    // Keep the native title bar on macOS so the window remains draggable.
    // A hidden title bar would require an explicit app-region drag area in the renderer.
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
  if (smokeTest) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const screenshotArg = process.argv.find((value) =>
          value.startsWith("--screenshot="),
        );
        if (screenshotArg && mainWindow) {
          const image = await mainWindow.webContents.capturePage();
          fsSync.writeFileSync(
            screenshotArg.slice("--screenshot=".length),
            image.toPNG(),
          );
        }
        console.log("SMOKE_TEST_READY");
        app.quit();
      }, 650);
    });
  }
}

function ensureWindowsDesktopShortcut(): void {
  if (!app.isPackaged || process.platform !== "win32") return;
  try {
    const shortcutPath = path.join(
      app.getPath("desktop"),
      "直播切片工作台社区版.lnk",
    );
    shell.writeShortcutLink(shortcutPath, "replace", {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: "直播回放智能切片工作台",
      icon: process.execPath,
      iconIndex: 0,
      appUserModelId: "cn.liveclip.workbench.community",
    });
  } catch (error) {
    // A locked-down desktop or a missing desktop folder must not prevent the
    // workbench from starting. The installer still recreates the shortcut.
    console.warn("更新桌面快捷方式失败", error);
  }
}

async function copyIntoWorkDir(
  sourcePath: string | undefined,
  destinationDir: string,
  prefix: string,
): Promise<string | undefined> {
  if (!sourcePath) return undefined;
  await fs.mkdir(destinationDir, { recursive: true });
  const destination = path.join(
    destinationDir,
    `${prefix}${path.extname(sourcePath).toLowerCase()}`,
  );
  if (path.resolve(sourcePath) !== path.resolve(destination))
    await fs.copyFile(sourcePath, destination);
  return destination;
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeTaskWorkDir(task: ClipTask): Promise<void> {
  const workspaceRoot = settings.get().workspacePath;
  if (!isPathInside(workspaceRoot, task.workDir)) {
    throw new Error("任务目录不在工作台工作区内，为保护原始文件未执行删除");
  }
  await fs.rm(task.workDir, { recursive: true, force: true });
}

async function removeCandidatePreview(candidate: Candidate, task: ClipTask): Promise<void> {
  if (!candidate.previewPath || !isPathInside(task.workDir, candidate.previewPath)) return;
  await fs.rm(candidate.previewPath, { force: true });
}

function assertCandidatePolicy(candidate: Candidate, account: AccountProfile): void {
  const matches = findPolicyMatches(account, candidatePolicyTexts(candidate));
  if (matches.length) throw new Error(policyMatchMessage(matches));
}

function candidateHasManualEdits(candidate: Candidate): boolean {
  if ((candidate.editHistory?.length ?? 0) > 1) return true;
  return Boolean(
    candidate.originalRenderPlan
    && JSON.stringify(candidate.originalRenderPlan) !== JSON.stringify(candidate.renderPlan),
  );
}

function repairPersistedCandidateOpenings(): void {
  let repairedCount = 0;
  for (const task of database.listTasks()) {
    for (const candidate of database.listCandidates(task.id)) {
      const repaired = repairCandidateOpening(candidate);
      if (repaired === candidate) continue;
      database.saveCandidate(repaired);
      repairedCount += 1;
    }
  }
  if (repairedCount > 0) {
    console.info(`已修复 ${repairedCount} 条旧候选的真实开头音频顺序`);
  }
}

function assertCandidateSelection(
  candidate: Candidate,
  account: AccountProfile,
  allowManualEditOverride = false,
): void {
  // Automatic quality gates decide which candidates enter the review feed.
  // Once a reviewer deliberately edits a candidate, density/selection gates
  // must not prevent saving that human decision; policy and valid timecodes
  // remain hard safety checks below.
  if (allowManualEditOverride && candidateHasManualEdits(candidate)) return;
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
}

function feishuFileTimestamp(file: FeishuDriveFile): number {
  const raw = Number(file.modifiedTime ?? file.createdTime ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

function newestFeishuFile(files: FeishuDriveFile[], name: string): FeishuDriveFile | undefined {
  return files
    .filter((file) => file.name === name)
    .sort((left, right) => feishuFileTimestamp(right) - feishuFileTimestamp(left))[0];
}

async function readFeishuLatestManifest(folderToken: string): Promise<{
  file: FeishuDriveFile;
  manifest: UpdateManifest;
} | undefined> {
  const files = await feishu.listFiles(folderToken);
  const manifestFiles = files
    .filter((file) => file.name === "latest.json")
    .sort((left, right) => feishuFileTimestamp(right) - feishuFileTimestamp(left));
  for (const file of manifestFiles) {
    try {
      const manifest = JSON.parse(await feishu.readTextFile(file.token)) as UpdateManifest;
      if (manifest.version) return { file, manifest };
    } catch {
      // Ignore an incomplete or malformed older manifest and try the next one.
    }
  }
  return undefined;
}

async function readFeishuUpdateInfo(folderToken: string): Promise<UpdateInfo> {
  const currentVersion = app.getVersion();
  const platform = process.platform === "darwin" || process.platform === "win32"
    ? process.platform
    : undefined;
  if (!platform) {
    return {
      currentVersion,
      platform: "win32",
      source: "feishu",
      available: false,
      message: `当前平台（${process.platform}）暂不支持自动更新`,
    };
  }
  const platformLabel = updatePlatformLabel(platform);
  try {
    const latest = await readFeishuLatestManifest(folderToken);
    if (!latest) {
      return {
        currentVersion,
        platform,
        source: "feishu",
        available: false,
        message: "飞书更新文件夹中还没有有效的 latest.json",
      };
    }
    if (!latest.manifest.version || compareVersions(latest.manifest.version, currentVersion) <= 0) {
      return {
        currentVersion,
        platform,
        source: "feishu",
        available: false,
        message: `当前 ${platformLabel} 版本已是最新版本（${currentVersion}）`,
      };
    }
    const selectedInstaller = selectUpdateInstaller(
      latest.manifest,
      platform,
      process.arch,
    );
    const selectedRelease = selectUpdateRelease(latest.manifest, platform);
    const files = await feishu.listFiles(folderToken);
    const chunks = typeof selectedRelease === "object" ? selectedRelease.chunks : undefined;
    if (chunks?.length) {
      const chunkFiles: UpdateFileChunk[] = [];
      for (const chunk of chunks) {
        const file = newestFeishuFile(files, path.basename(chunk.fileName));
        if (!file) continue;
        chunkFiles.push({
          fileName: file.name,
          token: file.token,
          size: chunk.size,
          sha256: chunk.sha256,
        });
      }
      const installerFileName = selectedInstaller
        ? path.basename(selectedInstaller)
        : undefined;
      const complete = chunkFiles.length === chunks.length;
      return {
        currentVersion,
        platform,
        source: "feishu",
        available: true,
        version: latest.manifest.version,
        installerFileName,
        installerSize: typeof selectedRelease === "object" ? selectedRelease.size : undefined,
        installerSha256: typeof selectedRelease === "object" ? selectedRelease.sha256 : undefined,
        feishuFileChunks: complete ? chunkFiles : undefined,
        notes: latest.manifest.notes,
        message: complete
          ? `发现 ${platformLabel} 版本 ${latest.manifest.version}（${chunks.length} 个分片），可以下载并安装更新`
          : `发现版本 ${latest.manifest.version}，但飞书文件夹中缺少更新分片（${chunkFiles.length}/${chunks.length}）`,
      };
    }
    const installer = selectedInstaller
      ? newestFeishuFile(files, path.basename(selectedInstaller))
      : undefined;
    return {
      currentVersion,
      platform,
      source: "feishu",
      available: true,
      version: latest.manifest.version,
      feishuFileToken: installer?.token,
      installerFileName: installer?.name ?? (selectedInstaller ? path.basename(selectedInstaller) : undefined),
      notes: latest.manifest.notes,
      message: installer
        ? `发现 ${platformLabel} 版本 ${latest.manifest.version}，可以下载并安装更新`
        : `发现版本 ${latest.manifest.version}，但飞书文件夹中未找到适用于 ${platformLabel} 的安装包`,
    };
  } catch (error) {
    return {
      currentVersion,
      platform,
      source: "feishu",
      available: false,
      message: `读取飞书更新失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readUpdateInfo(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion();
  const platform = process.platform === "darwin" || process.platform === "win32"
    ? process.platform
    : undefined;
  if (!platform) {
    return {
      currentVersion,
      platform: "win32",
      available: false,
      message: `当前平台（${process.platform}）暂不支持自动更新`,
    };
  }
  const platformLabel = updatePlatformLabel(platform);
  const currentSettings = settings.get();
  if (currentSettings.feishuUpdateFolderToken.trim()) {
    const status = await feishu.getStatus();
    if (!status.connected) {
      return {
        currentVersion,
        platform,
        source: "feishu",
        available: false,
        message: status.message,
      };
    }
    return readFeishuUpdateInfo(currentSettings.feishuUpdateFolderToken.trim());
  }
  const configured = currentSettings.updateManifestPath;
  const manifestPath = configured || (currentSettings.feishuSyncPath
    ? path.join(currentSettings.feishuSyncPath, "直播切片工作台更新", "latest.json")
    : "");
  if (!manifestPath) {
    const update = await checkGithubUpdate(currentVersion, platform, process.arch, (url, init) => net.fetch(url, init));
    return update.info;
  }
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as UpdateManifest;
    if (!raw.version || compareVersions(raw.version, currentVersion) <= 0) {
      return {
        currentVersion,
        platform,
        source: "local",
        available: false,
        message: `当前 ${platformLabel} 版本已是最新版本（${currentVersion}）`,
      };
    }
    const selectedInstaller = selectUpdateInstaller(raw, platform, process.arch);
    const installerPath = selectedInstaller
      ? path.isAbsolute(selectedInstaller)
        ? selectedInstaller
        : path.resolve(path.dirname(manifestPath), selectedInstaller)
      : undefined;
    const exists = installerPath
      ? await fs.stat(installerPath).then(() => true, () => false)
      : false;
    return {
      currentVersion,
      platform,
      source: "local",
      available: true,
      version: raw.version,
      installerPath: exists ? installerPath : undefined,
      notes: raw.notes,
      message: exists
        ? `发现 ${platformLabel} 版本 ${raw.version}，可以安装更新`
        : `发现版本 ${raw.version}，但未找到适用于 ${platformLabel} 的安装包`,
    };
  } catch (error) {
    return {
      currentVersion,
      platform,
      source: "local",
      available: false,
      message: `读取更新清单失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function findDefaultReleaseDirectory(): Promise<string | undefined> {
  const candidates = [
    path.resolve(process.cwd(), "release"),
    path.resolve(__dirname, "../../release"),
    path.resolve(process.resourcesPath, "../.."),
  ];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate;
    } catch {
      // The release folder is optional on a user's installed copy.
    }
  }
  return undefined;
}

async function chooseReleasePlan(): Promise<{
  releaseDirectory: string;
  plan: ReturnType<typeof selectReleaseArtifacts>;
}> {
  const defaultPath = await findDefaultReleaseDirectory();
  const chooserOptions = {
    title: "选择本次新版所在的 release 文件夹",
    properties: ["openDirectory"] as Array<"openDirectory">,
    ...(defaultPath ? { defaultPath } : {}),
  };
  const chosen = mainWindow
    ? await dialog.showOpenDialog(mainWindow, chooserOptions)
    : await dialog.showOpenDialog(chooserOptions);
  if (chosen.canceled || !chosen.filePaths[0]) throw new Error("已取消发布");
  const releaseDirectory = chosen.filePaths[0];
  const entries = await fs.readdir(releaseDirectory, { withFileTypes: true });
  const plan = selectReleaseArtifacts(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  return { releaseDirectory, plan };
}

const FEISHU_UPDATE_CHUNK_SIZE = 15 * 1024 * 1024;

function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function uploadFeishuReleaseArtifact(
  sourcePath: string,
  fileName: string,
  folderToken: string,
): Promise<{
  release: UpdateRelease;
  files: string[];
  tokens: string[];
}> {
  const stat = await fs.stat(sourcePath);
  if (stat.size <= FEISHU_UPDATE_CHUNK_SIZE) {
    const token = await feishu.uploadFile(sourcePath, folderToken);
    return { release: fileName, files: [fileName], tokens: [token] };
  }

  const chunkCount = Math.ceil(stat.size / FEISHU_UPDATE_CHUNK_SIZE);
  const tempDirectory = path.join(
    app.getPath("temp"),
    `live-clip-workbench-publish-${process.pid}-${Date.now()}`,
  );
  await fs.mkdir(tempDirectory, { recursive: true });
  const uploadedTokens: string[] = [];
  const chunks: UpdateChunk[] = [];
  const files: string[] = [];
  const source = await fs.open(sourcePath, "r");
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const size = Math.min(
        FEISHU_UPDATE_CHUNK_SIZE,
        stat.size - index * FEISHU_UPDATE_CHUNK_SIZE,
      );
      const buffer = Buffer.alloc(size);
      const result = await source.read(buffer, 0, size, index * FEISHU_UPDATE_CHUNK_SIZE);
      if (result.bytesRead !== size) {
        throw new Error(`读取安装包分片失败：${fileName}（第 ${index + 1} 片）`);
      }
      const chunkFileName = `${fileName}.part-${String(index + 1).padStart(3, "0")}-of-${String(chunkCount).padStart(3, "0")}`;
      const chunkPath = path.join(tempDirectory, chunkFileName);
      await fs.writeFile(chunkPath, buffer);
      const chunk: UpdateChunk = {
        fileName: chunkFileName,
        size,
        sha256: sha256Buffer(buffer),
      };
      const token = await feishu.uploadFile(chunkPath, folderToken);
      uploadedTokens.push(token);
      chunks.push(chunk);
      files.push(chunkFileName);
    }
  } catch (error) {
    await Promise.allSettled(uploadedTokens.map((token) => feishu.deleteFile(token)));
    throw error;
  } finally {
    await source.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }

  return {
    release: {
      installerPath: fileName,
      size: stat.size,
      sha256: await sha256File(sourcePath),
      chunks,
    },
    files,
    tokens: uploadedTokens,
  };
}

async function downloadGithubInstaller(assetId: number): Promise<string> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "win32") throw new Error("当前系统不支持安装更新");

  const update = await checkGithubUpdate(app.getVersion(), platform, process.arch, (url, init) => net.fetch(url, init));
  if (!update.download || update.info.githubAssetId !== assetId) {
    throw new Error(update.download ? "GitHub 版本已变化，请重新检查更新" : update.info.message);
  }
  return downloadGithubUpdate(
    update.download,
    path.join(app.getPath("userData"), "updates"),
    (url, init) => net.fetch(url, init),
  );
}

async function downloadAndAssembleFeishuUpdate(
  chunks: UpdateFileChunk[],
  installerFileName: string,
  expectedSize?: number,
  expectedSha256?: string,
): Promise<string> {
  const safeName = path.basename(installerFileName);
  if (!safeName || safeName !== installerFileName) {
    throw new Error("飞书更新文件名无效");
  }
  const updatesDirectory = path.join(app.getPath("userData"), "updates");
  const temporaryDirectory = path.join(
    app.getPath("temp"),
    `live-clip-workbench-update-${process.pid}-${Date.now()}`,
  );
  const installerPath = path.join(updatesDirectory, safeName);
  await fs.mkdir(updatesDirectory, { recursive: true });
  await fs.mkdir(temporaryDirectory, { recursive: true });
  try {
    const output = await fs.open(installerPath, "w");
    let totalSize = 0;
    try {
      for (const [index, chunk] of chunks.entries()) {
        const safeChunkName = path.basename(chunk.fileName);
        if (!safeChunkName || safeChunkName !== chunk.fileName || !chunk.token) {
          throw new Error("飞书更新分片信息无效");
        }
        const chunkPath = path.join(
          temporaryDirectory,
          `${String(index + 1).padStart(3, "0")}-${safeChunkName}`,
        );
        await feishu.downloadFile(chunk.token, chunkPath);
        const chunkStat = await fs.stat(chunkPath);
        if (chunkStat.size !== chunk.size) {
          throw new Error(`更新分片大小校验失败：${safeChunkName}`);
        }
        if (chunk.sha256 && (await sha256File(chunkPath)) !== chunk.sha256) {
          throw new Error(`更新分片完整性校验失败：${safeChunkName}`);
        }
        const buffer = await fs.readFile(chunkPath);
        await output.write(buffer);
        totalSize += buffer.length;
      }
    } finally {
      await output.close();
    }
    if (expectedSize !== undefined && totalSize !== expectedSize) {
      throw new Error(`更新安装包大小校验失败：期望 ${expectedSize}，实际 ${totalSize}`);
    }
    if (expectedSha256 && (await sha256File(installerPath)) !== expectedSha256) {
      throw new Error("更新安装包完整性校验失败");
    }
    return installerPath;
  } catch (error) {
    await fs.rm(installerPath, { force: true });
    throw error;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function publishUpdateToLocal(notes = ""): Promise<UpdatePublishResult> {
  const syncRoot = settings.get().feishuSyncPath.trim();
  if (!syncRoot) throw new Error("请先在设置中选择本地同步目录，或先连接飞书云端更新");
  if (!(await fs.stat(syncRoot).catch(() => undefined))?.isDirectory()) {
    throw new Error("本地同步目录不存在，请先在设置中重新选择目录");
  }

  const { releaseDirectory, plan } = await chooseReleasePlan();
  const manifest: UpdateManifest = {
    ...buildUpdateManifest(plan.version, notes, plan.artifacts),
    publishedAt: new Date().toISOString(),
  };
  const targetDirectory = path.join(syncRoot, "直播切片工作台更新");
  const manifestPath = path.join(targetDirectory, "latest.json");

  let existingVersion = "";
  try {
    const existing = JSON.parse(await fs.readFile(manifestPath, "utf8")) as UpdateManifest;
    existingVersion = existing.version ?? "";
  } catch {
    // A first publish, or an old/missing manifest, is allowed.
  }
  if (existingVersion && compareVersions(existingVersion, plan.version) >= 0) {
    throw new Error(
      `本地同步目录中已经是 ${existingVersion}，本次识别到 ${plan.version}；为避免误降级，已停止写入`,
    );
  }

  const warningText = plan.warnings.length
    ? `\n\n发布提醒：\n${plan.warnings.map((warning) => `· ${warning}`).join("\n")}`
    : "";
  const confirmation = mainWindow
    ? await dialog.showMessageBox(mainWindow, {
      type: plan.warnings.length ? "warning" : "question",
        title: "确认写入本地同步目录",
        message: `即将发布工作台 ${plan.version}`,
        detail: [
          `目标目录：${targetDirectory}`,
          `安装包：${plan.artifacts.map((artifact) => artifact.fileName).join("、")}`,
          `更新说明：${manifest.notes ?? "工作台版本更新"}${warningText}`,
        ].join("\n"),
        buttons: ["确认写入", "取消"],
        defaultId: 0,
        cancelId: 1,
      })
    : { response: 0 };
  if (confirmation.response !== 0) throw new Error("已取消发布");

  await fs.mkdir(targetDirectory, { recursive: true });
  const copiedFiles: string[] = [];
  for (const artifact of plan.artifacts) {
    const sourcePath = path.join(releaseDirectory, artifact.fileName);
    const targetPath = path.join(targetDirectory, artifact.fileName);
    await fs.copyFile(sourcePath, targetPath);
    const [sourceStat, targetStat] = await Promise.all([
      fs.stat(sourcePath),
      fs.stat(targetPath),
    ]);
    if (sourceStat.size !== targetStat.size) {
      throw new Error(`文件校验失败：${artifact.fileName} 未完整写入`);
    }
    copiedFiles.push(artifact.fileName);
  }

  const temporaryManifestPath = path.join(
    targetDirectory,
    `.latest-${process.pid}-${Date.now()}.json`,
  );
  try {
    await fs.writeFile(
      temporaryManifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    // Installers are copied and verified first; latest.json is written last so
    // another workstation never sees a new version before its package exists.
    await fs.copyFile(temporaryManifestPath, manifestPath);
  } finally {
    await fs.rm(temporaryManifestPath, { force: true });
  }
  return {
    version: plan.version,
    source: "local",
    manifestPath,
    targetDirectory,
    files: copiedFiles,
    warnings: plan.warnings,
  };
}

async function publishUpdateToFeishuCloud(notes = ""): Promise<UpdatePublishResult> {
  const folderToken = extractFeishuFolderToken(settings.get().feishuUpdateFolderToken);
  if (!folderToken) throw new Error("请先配置飞书更新文件夹");
  const status = await feishu.getStatus();
  if (!status.connected) throw new Error(status.message);

  const { releaseDirectory, plan } = await chooseReleasePlan();
  const manifest: UpdateManifest = {
    ...buildUpdateManifest(plan.version, notes, plan.artifacts),
    publishedAt: new Date().toISOString(),
  };
  const existing = await readFeishuLatestManifest(folderToken);
  const existingVersion = existing?.manifest.version ?? "";
  if (existingVersion && compareVersions(existingVersion, plan.version) >= 0) {
    throw new Error(
      `飞书云端已经是 ${existingVersion}，本次识别到 ${plan.version}；为避免误降级，已停止上传`,
    );
  }

  const warningText = plan.warnings.length
    ? `\n\n发布提醒：\n${plan.warnings.map((warning) => `· ${warning}`).join("\n")}`
    : "";
  const confirmation = mainWindow
    ? await dialog.showMessageBox(mainWindow, {
        type: plan.warnings.length ? "warning" : "question",
        title: "确认上传到飞书云盘",
        message: `即将发布工作台 ${plan.version}`,
        detail: [
          `目标文件夹：直播切片工作台更新（${folderToken}）`,
          `安装包：${plan.artifacts.map((artifact) => artifact.fileName).join("、")}`,
          `更新说明：${manifest.notes ?? "工作台版本更新"}${warningText}`,
        ].join("\n"),
        buttons: ["确认上传", "取消"],
        defaultId: 0,
        cancelId: 1,
      })
    : { response: 0 };
  if (confirmation.response !== 0) throw new Error("已取消发布");

  const uploadedFiles: string[] = [];
  const uploadedTokens: string[] = [];
  const temporaryManifestPath = path.join(
    app.getPath("temp"),
    `live-clip-workbench-latest-${process.pid}-${Date.now()}.json`,
  );
  let newManifestToken = "";
  try {
    for (const artifact of plan.artifacts) {
      const uploaded = await uploadFeishuReleaseArtifact(
        path.join(releaseDirectory, artifact.fileName),
        artifact.fileName,
        folderToken,
      );
      uploadedFiles.push(...uploaded.files);
      uploadedTokens.push(...uploaded.tokens);
      manifest.platforms = {
        ...manifest.platforms,
        ...(artifact.platform === "win32"
          ? { win32: uploaded.release }
          : { darwin: uploaded.release }),
      };
    }
    await fs.writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    newManifestToken = await feishu.uploadFile(temporaryManifestPath, folderToken, "latest.json");
    uploadedTokens.push(newManifestToken);
  } catch (error) {
    await Promise.allSettled(uploadedTokens.map((token) => feishu.deleteFile(token)));
    throw error;
  } finally {
    await fs.rm(temporaryManifestPath, { force: true });
  }

  const warnings = [...plan.warnings];
  if (existing?.file.token && existing.file.token !== newManifestToken) {
    try {
      await feishu.deleteFile(existing.file.token);
    } catch (error) {
      warnings.push(`旧 latest.json 清理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    version: plan.version,
    source: "feishu",
    targetDirectory: folderToken,
    manifestPath: newManifestToken,
    files: [...uploadedFiles, "latest.json"],
    warnings,
  };
}

async function publishUpdate(notes = ""): Promise<UpdatePublishResult> {
  if (settings.get().feishuUpdateFolderToken.trim()) {
    return publishUpdateToFeishuCloud(notes);
  }
  return publishUpdateToLocal(notes);
}

async function createTask(input: CreateTaskInput): Promise<ClipTask> {
  const account = database.getAccount(input.accountId);
  if (!account) throw new Error("请先选择有效账号");
  const id = crypto.randomUUID();
  const workDir = path.join(settings.get().workspacePath, "tasks", id);
  const inputDir = path.join(workDir, "input");
  const now = new Date().toISOString();
  const task: ClipTask = {
    id,
    accountId: account.id,
    name: input.name.trim() || `直播任务 ${now.slice(0, 10)}`,
    sourceType: input.sourceUrl ? "link" : "file",
    sourceUrl: input.sourceUrl?.trim() || undefined,
    sourceVideoPath: await copyIntoWorkDir(input.videoPath, inputDir, "source"),
    transcriptPath: await copyIntoWorkDir(
      input.transcriptPath,
      inputDir,
      "transcript",
    ),
    status: "imported",
    progress: 0,
    statusMessage: "等待开始处理",
    workDir,
    createdAt: now,
    updatedAt: now,
  };
  return database.saveTask(task);
}

function registerIpc(): void {
  ipcMain.handle("snapshot:get", () => database.snapshot());
  ipcMain.handle("text:list", () => textWorkbench.list());
  ipcMain.handle("text:learning-summary", () => textWorkbench.learningSummary());
  ipcMain.handle("text:export-destinations", () => textFeishuExporter.destinations());
  ipcMain.handle("text:start", (_event, inputs: TextJobInput[]) => textWorkbench.start(inputs));
  ipcMain.handle("text:retry", (_event, jobId: string) => textWorkbench.retry(jobId));
  ipcMain.handle("text:dismiss", (_event, jobId: string) => textWorkbench.dismiss(jobId));
  ipcMain.handle("text:transcript", (_event, jobId: string) => textWorkbench.transcript(jobId));
  ipcMain.handle("text:supplement", (_event, jobId: string, startMs: number, endMs: number) => textWorkbench.supplement(jobId, startMs, endMs));
  ipcMain.handle("text:subtitle", async (_event, jobId: string) => {
    const job = textWorkbench.list().find(item => item.id === jobId);
    if (!job || job.status === 'running') throw new Error('请先等待这场直播处理完成');
    const options: Electron.OpenDialogOptions = { title: '选择同一场直播的带时间码字幕', properties: ['openFile'], filters: [{ name: '字幕', extensions: ['srt', 'vtt'] }] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : textWorkbench.retry(jobId, result.filePaths[0]);
  });
  const syncTextDelivery = async (jobId: string, clipId: string) => {
    const { job, clip } = textWorkbench.get(jobId, clipId);
    const delivery = job.deliveries?.find(item => item.clipId === clipId);
    if (!delivery) return;
    try {
      const synced = structuredClone(clip);
      await textFeishuExporter.sync(job, synced, delivery);
      textWorkbench.recordSync(jobId, delivery.documentId, synced.title, undefined, synced);
    } catch (error) {
      textWorkbench.recordSync(jobId, delivery.documentId, clip.title, error instanceof Error ? error.message : String(error));
    }
  };
  ipcMain.handle("text:rename", (_event, jobId: string, name: string, teacher?: string) => {
    const job = textWorkbench.rename(jobId, name, teacher);
    for (const clipId of new Set(job.deliveries?.map(delivery => delivery.clipId))) {
      void syncTextDelivery(jobId, clipId);
    }
    return job;
  });
  ipcMain.handle('text:topic-feedback', (_event, jobId: string, clipId: string, verdict: import('../shared/text-selection').TextTopicVerdict, reason: string) =>
    textWorkbench.rateTopic(jobId, clipId, verdict, reason));
  ipcMain.handle('text:clear-topic-feedback', (_event, jobId: string, clipId: string) => textWorkbench.clearTopicFeedback(jobId, clipId));
  ipcMain.handle('text:confirm-final', (_event, jobId: string, clipId: string, note: string, expectedEdit: import('../shared/text-selection').TextEdit) => {
    if (!expectedEdit) throw new Error('请刷新后确认当前版本');
    return textWorkbench.confirmFinal(jobId, clipId, note, expectedEdit);
  });
  ipcMain.handle('text:withdraw-final', (_event, jobId: string, clipId: string) => textWorkbench.withdrawFinal(jobId, clipId));
  ipcMain.handle("text:save", (_event, jobId: string, clipId: string, edit: unknown) => {
    const clip = textWorkbench.save(jobId, clipId, edit);
    void syncTextDelivery(jobId, clipId);
    return clip;
  });
  ipcMain.handle("text:review", async (_event, jobId: string, clipId: string) => {
    const clip = await textWorkbench.review(jobId, clipId);
    void syncTextDelivery(jobId, clipId);
    return clip;
  });
  ipcMain.handle("text:sync", (_event, jobId: string, clipId: string) => syncTextDelivery(jobId, clipId));
  ipcMain.handle("text:open-source", (_event, jobId: string) => {
    const job = textWorkbench.list().find(item => item.id === jobId);
    if (!job) throw new Error('文字任务不存在');
    return shell.openExternal(originalTextSource(job));
  });
  ipcMain.handle("text:connect-feishu", () => feishu.connect(true));
  ipcMain.handle("text:open-feishu-document", (_event, url: string) => {
    if (!isFeishuDocUrl(url)) throw new Error('飞书文档链接无效');
    return shell.openExternal(url);
  });
  ipcMain.handle("text:export", async (_event, jobId: string, clipId: string, folder: string, teacher: string) => {
    const { job, clip } = textWorkbench.get(jobId, clipId);
    const exported = structuredClone(clip);
    const result = await textFeishuExporter.export(job, exported, folder, teacher);
    textWorkbench.recordDelivery(jobId, clipId, teacher.trim(), exported, result);
    return result;
  });
  ipcMain.handle("accounts:list", () => database.listAccounts());
  ipcMain.handle(
    "accounts:save",
    (_event, input: Partial<AccountProfile> & Pick<AccountProfile, "name">) =>
      database.saveAccount(input),
  );
  ipcMain.handle(
    "accounts:learn-samples",
    async (_event, input: { accountId: string; samplePaths?: string[] }) => {
      const account = database.getAccount(input.accountId);
      if (!account) throw new Error("老师账号不存在");
      const report = await sampleLearning.learn(account, input.samplePaths ?? account.samplePaths);
      database.saveSampleLearning(account.id, report.transcript, report.state);
      return report;
    },
  );
  ipcMain.handle("accounts:delete", (_event, id: string) =>
    database.deleteAccount(id),
  );
  ipcMain.handle(
    "files:select",
    async (
      _event,
      options: {
        type: "video" | "transcript" | "media" | "binary" | "csv" | "directory";
        multiple?: boolean;
      },
    ) => {
      if (!mainWindow) return [];
      if (options.type === "directory") {
        const result = await dialog.showOpenDialog(mainWindow, {
          properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? [] : result.filePaths;
      }
      const filters =
        options.type === "video"
          ? [{ name: "视频", extensions: ["mp4", "mov", "mkv", "webm", "m4v"] }]
          : options.type === "transcript"
            ? [{ name: "逐字稿", extensions: ["srt", "vtt", "txt", "docx"] }]
            : options.type === "csv"
              ? [{ name: "批量任务表", extensions: ["csv"] }]
              : options.type === "binary"
                ? undefined
                : [
                    {
                      name: "媒体与图片",
                      extensions: [
                        "mp4",
                        "mov",
                        "mkv",
                        "mp3",
                        "wav",
                        "m4a",
                        "png",
                        "jpg",
                        "jpeg",
                      ],
                    },
                  ];
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: options.multiple
          ? ["openFile", "multiSelections"]
          : ["openFile"],
        ...(filters ? { filters } : {}),
      });
      return result.canceled ? [] : result.filePaths;
    },
  );
  ipcMain.handle("tasks:create", (_event, input: CreateTaskInput) =>
    createTask(input),
  );
  ipcMain.handle(
    "tasks:attach-files",
    async (
      _event,
      input: { taskId: string; videoPath?: string; transcriptPath?: string },
    ) => {
      const task = database.getTask(input.taskId);
      if (!task) throw new Error("任务不存在");
      const inputDir = path.join(task.workDir, "input");
      task.sourceVideoPath =
        (await copyIntoWorkDir(input.videoPath, inputDir, "source")) ??
        task.sourceVideoPath;
      task.transcriptPath =
        (await copyIntoWorkDir(input.transcriptPath, inputDir, "transcript")) ??
        task.transcriptPath;
      task.status = "imported";
      task.statusMessage = "补充文件完成，可以重新处理";
      task.error = undefined;
      return database.saveTask(task);
    },
  );
  ipcMain.handle("tasks:import-batch", async (_event, csvPath: string) => {
    const content = await fs.readFile(csvPath, "utf8");
    const rows = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];
    const accounts = database.listAccounts();
    const created: ClipTask[] = [];
    for (const raw of rows) {
      const row: BatchTaskRow = {
        accountName: raw.accountName || raw["账号"] || raw["老师账号"],
        taskName: raw.taskName || raw["任务名称"] || raw["直播名称"],
        sourceUrl: raw.sourceUrl || raw["分享链接"],
        videoPath: raw.videoPath || raw["视频路径"],
        transcriptPath: raw.transcriptPath || raw["逐字稿路径"],
      };
      const account = accounts.find((item) => item.name === row.accountName);
      if (!account) continue;
      created.push(
        await createTask({
          accountId: account.id,
          name: row.taskName,
          sourceUrl: row.sourceUrl,
          videoPath: row.videoPath,
          transcriptPath: row.transcriptPath,
        }),
      );
    }
    return created;
  });
  ipcMain.handle("sources:inspect", async (_event, url: string) => {
    let provider: Parameters<DatabaseService["recordSourceStat"]>[0] = "unknown";
    try {
      provider = providerFromUrl(url);
      const result = await sources.inspect(url);
      database.recordSourceStat(
        provider,
        !result.requiresFallback,
        result.requiresFallback ? result.message : undefined,
      );
      return result;
    } catch (error) {
      database.recordSourceStat(
        provider,
        false,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  });
  ipcMain.handle("sources:login", async (_event, url: string) => {
    if (!mainWindow) return;
    const target = new URL(url);
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error("仅支持 HTTP 或 HTTPS 分享链接");
    }
    const loginWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      parent: mainWindow,
      title: "登录分享平台后关闭此窗口",
      webPreferences: { contextIsolation: true, sandbox: true, partition: sourceLoginPartition },
    });
    await loginWindow.loadURL(target.href);
  });
  ipcMain.handle("tasks:run", (_event, taskId: string) => {
    const task = database.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    // Queue work in the main process and return immediately so a long download
    // or DeepSeek request never blocks the creator modal or the dashboard.
    void processor
      .enqueue(taskId)
      .then(() => {
        const latest = database.getTask(taskId);
        if (latest?.status === "awaiting_review" && Notification.isSupported())
          new Notification({
            title: "直播切片工作台",
            body: "候选已生成，可以开始审核",
          }).show();
      })
      .catch((error) => {
        if (Notification.isSupported())
          new Notification({
            title: "直播切片处理失败",
            body: error instanceof Error ? error.message : String(error),
          }).show();
        console.error("后台任务失败", error);
      });
    task.status = "queued";
    task.statusMessage = "已进入本地处理队列";
      task.error = undefined;
    return database.saveTask(task);
  });
  ipcMain.handle("tasks:pause", (_event, taskId: string) =>
    processor.pauseTask(taskId),
  );
  ipcMain.handle("tasks:rebuild-candidates", (_event, taskId: string) =>
    processor.rebuildCandidates(taskId),
  );
  ipcMain.handle("tasks:delete", async (_event, taskId: string) => {
    const task = database.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    const processing = ["queued", "validating", "analyzing", "generating_candidates", "generating_previews"].includes(task.status);
    if (processing) await processor.cancelTask(taskId);
    const latest = database.getTask(taskId);
    if (!latest) return;
    const candidates = database.listCandidates(taskId);
    const deletable =
      processing ||
      latest.status === "paused" ||
      latest.status === "imported" ||
      latest.status === "failed" ||
      (latest.status === "awaiting_review" && candidates.length === 0) ||
      (candidates.length > 0 && candidates.every((candidate) => candidate.decision === "rejected"));
    if (!deletable) {
      throw new Error("只允许删除未开始、已暂停、失败或全部已驳回候选的任务");
    }
    await removeTaskWorkDir(latest);
    database.deleteTask(taskId);
  });
  ipcMain.handle("candidates:list", async (_event, taskId: string) => {
    const task = database.getTask(taskId);
    const account = task ? database.getAccount(task.accountId) : undefined;
    if (!task || !account) return [];
    // Do not show stale candidates generated before the account policy was
    // enforced. They remain in the database for auditability, but cannot be
    // reviewed, approved, or exported.
    const candidates = database
      .listCandidates(taskId)
      .filter(
        (candidate) =>
          findPolicyMatches(account, candidatePolicyTexts(candidate)).length ===
          0
          && (
            candidateHasManualEdits(candidate)
            || (
              assessSelectionPrinciples(
                account,
                candidate.title,
                candidate.hookText,
                candidate.transcriptText,
              ).accepted
              && assessContentDensity(
                candidate.title,
                candidate.hookText,
                candidate.transcriptText,
              ).accepted
            )
          ),
      );
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate) continue;
      const repaired = repairCandidateOpening(candidate);
      if (repaired !== candidate) candidates[index] = database.saveCandidate(repaired);
    }
    // Candidates generated before the context-review feature do not have the
    // surrounding transcript persisted. Hydrate that view lazily so old
    // tasks can still be audited without downloading or re-analyzing them.
    if (task.transcriptPath && candidates.some((candidate) => !candidate.contextSegments?.length)) {
      try {
        const transcript = await parseTranscriptFile(
          task.transcriptPath,
          task.duration ?? 0,
        );
        for (const candidate of candidates) {
          if (candidate.contextSegments?.length) continue;
          candidate.contextSegments = buildTopicContext(
            transcript,
            candidate.renderPlan.segments,
            account,
          );
        }
      } catch (error) {
        console.warn("加载候选话题前后文失败", error);
      }
    }
    return candidates;
  });
  ipcMain.handle("candidates:preview", (_event, candidateId: string) =>
    processor.generateCandidatePreview(candidateId),
  );
  ipcMain.handle("candidates:delete", async (_event, candidateId: string) => {
    const candidate = database.getCandidate(candidateId);
    if (!candidate) throw new Error("候选不存在");
    if (candidate.decision !== "rejected") {
      throw new Error("只有已经驳回的候选可以删除");
    }
    const task = database.getTask(candidate.taskId);
    if (!task) throw new Error("任务不存在");
    await removeCandidatePreview(candidate, task);
    database.deleteCandidate(candidateId);
  });
  const saveCandidateInput = (input: Candidate): Candidate => {
    const candidate = repairCandidateOpening(input);
    if (!candidate.renderPlan.segments.length)
      throw new Error("剪辑方案至少需要一个片段");
    const task = database.getTask(candidate.taskId);
    if (!task) throw new Error("任务不存在");
    const account = database.getAccount(task.accountId);
    if (!account) throw new Error("账号不存在");
    assertCandidatePolicy(candidate, account);
    assertCandidateSelection(candidate, account, true);
    candidate.renderPlan.platformSafeAreas ??= account.platformSafeAreas;
    for (const segment of candidate.renderPlan.segments) {
      if (
        !Number.isFinite(segment.sourceStart) ||
        !Number.isFinite(segment.sourceEnd) ||
        segment.sourceStart < 0 ||
        segment.sourceEnd <= segment.sourceStart
      ) {
        throw new Error("片段入点或出点无效，请确保出点晚于入点");
      }
    }
    candidate.renderPlan.segments.sort(
      (left, right) => left.order - right.order,
    );
    candidate.duration = candidate.renderPlan.segments.reduce(
      (sum, segment) => sum + segment.sourceEnd - segment.sourceStart,
      0,
    );
    candidate.transcriptText = candidate.renderPlan.segments
      .map((segment) => segment.text)
      .join(" ");
    return database.saveCandidate(candidate);
  };
  const prepareCandidateForSave = async (input: Candidate): Promise<Candidate> => {
    const aligned = await ensureCandidateWordTimings(input);
    const prepared = prepareCandidateSubtitleSync(aligned);
    if (prepared.result.unmatched.length) {
      throw new Error("字幕中仍有无法对应原始音频的文字，尚未保存");
    }
    if (prepared.result.needsWordAlignment || !prepared.canSave) {
      throw new Error("字幕切口尚未通过词级时间轴校验，尚未保存");
    }
    return prepared.nextCandidate;
  };
  ipcMain.handle("candidates:save", async (_event, input: Candidate) =>
    saveCandidateInput(await prepareCandidateForSave(input)),
  );
  ipcMain.handle("candidates:ensure-word-timings", async (_event, input: Candidate) => {
    const stored = database.getCandidate(input.id);
    if (!stored) throw new Error("候选不存在");
    const candidate: Candidate = {
      ...input,
      taskId: stored.taskId,
      contextSegments: input.contextSegments?.length
        ? input.contextSegments
        : stored.contextSegments,
      renderPlan: {
        ...input.renderPlan,
        sourceVideoPath: stored.renderPlan.sourceVideoPath,
      },
    };
    return ensureCandidateWordTimings(candidate);
  });
  ipcMain.handle("candidates:save-and-preview", async (_event, input: Candidate) => {
    const saved = saveCandidateInput(await prepareCandidateForSave(input));
    try {
      return await processor.generateCandidatePreview(saved.id);
    } catch {
      // The edit itself is already durable. Return the persisted candidate so
      // the review page can show the actual preview error and offer a retry.
      return database.getCandidate(saved.id) ?? saved;
    }
  });
  ipcMain.handle(
    "candidates:review",
    (
      _event,
      input: {
        candidateId: string;
        decision: "approved" | "rejected";
        reason?: RejectionReason;
        note?: string;
      },
    ) => {
      const candidate = database.getCandidate(input.candidateId);
      if (!candidate) throw new Error("候选不存在");
      const task = database.getTask(candidate.taskId);
      if (!task) throw new Error("任务不存在");
      const account = database.getAccount(task.accountId);
      if (!account) throw new Error("账号不存在");
      assertCandidatePolicy(candidate, account);
      assertCandidateSelection(candidate, account, true);
      candidate.decision = input.decision;
      candidate.rejectionReason = input.reason;
      candidate.rejectionNote = input.note;
      database.saveCandidate(candidate);
      const feedback: FeedbackRecord = {
        id: crypto.randomUUID(),
        accountId: task.accountId,
        taskId: task.id,
        candidateId: candidate.id,
        decision: input.decision,
        rejectionReason: input.reason,
        note: input.note,
        originalPlan:
          candidate.originalRenderPlan ?? candidate.renderPlan,
        finalPlan: candidate.renderPlan,
        createdAt: new Date().toISOString(),
      };
      database.saveFeedback(feedback);
      return candidate;
    },
  );
  ipcMain.handle(
    "candidates:ack-risk",
    (_event, input: { candidateId: string; index: number }) => {
      const candidate = database.getCandidate(input.candidateId);
      if (!candidate) throw new Error("候选不存在");
      if (!candidate.riskFlags[input.index]) throw new Error("风险项不存在");
      candidate.riskFlags[input.index].acknowledged = true;
      return database.saveCandidate(candidate);
    },
  );
  ipcMain.handle("export:candidate", (_event, candidateId: string) =>
    exporter.exportCandidate(candidateId),
  );
  ipcMain.handle("export:candidates", (_event, candidateIds: string[]) =>
    exporter.exportCandidates(candidateIds),
  );
  ipcMain.handle("settings:get", () => settings.get());
  ipcMain.handle(
    "settings:save",
    (_event, input: Partial<AppSettings> & { apiKey?: string; feishuAppSecret?: string }) =>
      settings.save(input),
  );
  ipcMain.handle("model:test-connection", async (_event, input?: ModelConnectionInput) => {
    if (!model) throw new Error("模型尚未初始化");
    return model.testConnection(input);
  });
  ipcMain.handle("updates:check", () => readUpdateInfo());
  ipcMain.handle("updates:publish", (_event, notes?: string) =>
    publishUpdate(notes),
  );
  ipcMain.handle("feishu:status", () => feishu.getStatus());
  ipcMain.handle("feishu:connect", () => feishu.connect());
  ipcMain.handle("feishu:disconnect", () => feishu.disconnect());
  ipcMain.handle("feishu:test-folder", async (): Promise<FeishuFolderSetupResult> =>
    feishu.testFolder(),
  );
  ipcMain.handle("updates:install", async (_event, request: UpdateInstallRequest) => {
    let installerPath = request?.installerPath?.trim() || "";
    if (request?.githubAssetId !== undefined) {
      installerPath = await downloadGithubInstaller(request.githubAssetId);
    } else if (!installerPath && request?.feishuFileChunks?.length) {
      const installerFileName = request.installerFileName?.trim() || "";
      installerPath = await downloadAndAssembleFeishuUpdate(
        request.feishuFileChunks,
        installerFileName,
        request.installerSize,
        request.installerSha256,
      );
    } else if (!installerPath && request?.feishuFileToken) {
      const installerFileName = request.installerFileName?.trim() || "";
      const safeName = path.basename(installerFileName);
      if (!safeName || safeName !== installerFileName) {
        throw new Error("飞书更新文件名无效");
      }
      installerPath = path.join(
        app.getPath("userData"),
        "updates",
        safeName,
      );
      await feishu.downloadFile(request.feishuFileToken, installerPath);
    }
    const allowed = process.platform === "win32"
      ? /\.exe$/i
      : process.platform === "darwin"
        ? /\.(?:dmg|zip)$/i
        : /\.(?:exe|dmg|zip)$/i;
    if (!installerPath || !allowed.test(installerPath))
      throw new Error(`当前平台不支持此更新安装包：${installerPath || "未提供路径"}`);
    await fs.access(installerPath);
    const openError = await shell.openPath(installerPath);
    if (openError) throw new Error(`打开更新安装包失败：${openError}`);
    if (process.platform === "win32") {
      // Let the installer replace the running executable and let its
      // runAfterFinish launch the newly installed version. The new process
      // will also refresh the desktop shortcut to its own executable path.
      setTimeout(() => app.quit(), 250);
    }
  });
  ipcMain.handle("shell:open-path", (_event, targetPath: string) =>
    shell.openPath(targetPath),
  );
  ipcMain.handle(
    "performance:save",
    (
      _event,
      input: Omit<PerformanceRecord, "id" | "createdAt" | "relativeScore">,
    ) =>
      database.savePerformance({
        ...input,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      }),
  );
  ipcMain.handle("performance:list", (_event, candidateId?: string) =>
    database.listPerformance(candidateId),
  );
  ipcMain.handle("blind-test:snapshot", () => database.blindTestSnapshot());
  ipcMain.handle("blind-test:save-session", (_event, input) =>
    database.saveBlindTestSession(input),
  );
  ipcMain.handle("backup:now", () => {
    const syncPath = settings.get().feishuSyncPath;
    if (!syncPath) throw new Error("请先在设置中选择飞书同步目录");
    const destination = path.join(
      syncPath,
      "直播切片工作台备份",
      `workbench-${new Date().toISOString().slice(0, 10)}.sqlite`,
    );
    return database.exportCopy(destination);
  });
}

async function cleanupExpiredWork(): Promise<void> {
  const current = settings.get();
  const taskRoot = path.join(current.workspacePath, "tasks");
  if (!fsSync.existsSync(taskRoot)) return;
  const threshold = Date.now() - current.retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of await fs.readdir(taskRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidateDir = path.join(taskRoot, entry.name);
    const stat = await fs.stat(candidateDir);
    if (stat.mtimeMs < threshold) {
      await fs.rm(path.join(candidateDir, "previews"), {
        recursive: true,
        force: true,
      });
      await fs.rm(path.join(candidateDir, "input"), {
        recursive: true,
        force: true,
      });
      // Older link-imported tasks stored these files beside the checkpoint;
      // remove them too so long recordings do not bypass retention cleanup.
      const legacyFiles = await fs.readdir(candidateDir);
      for (const fileName of legacyFiles) {
        if (
          /^(?:source\.(?:mp4|webm|mov|mkv)(?:\.download)?|transcript\.(?:srt|vtt|txt|docx|json))$/i.test(
            fileName,
          )
        ) {
          await fs.rm(path.join(candidateDir, fileName), { force: true });
        }
      }
    }
  }
}

function backupDatabaseIfConfigured(): void {
  const syncPath = settings.get().feishuSyncPath;
  if (!syncPath) return;
  const destination = path.join(
    syncPath,
    "直播切片工作台备份",
    `workbench-${new Date().toISOString().slice(0, 10)}.sqlite`,
  );
  try {
    database.exportCopy(destination);
  } catch (error) {
    console.error("自动备份失败", error);
  }
}

const notifiedReminderKeys = new Set<string>();
function notifyDueReminders(): void {
  if (!Notification.isSupported()) return;
  const allPerformance = database.listPerformance();
  for (const publication of database.dueReminders()) {
    const ageDays = (Date.now() - new Date(publication.publishedAt).getTime()) / 86_400_000;
    const matching = allPerformance.filter(
      (item) => item.candidateId === publication.candidateId && item.platform === publication.platform,
    );
    const windows = [
      ...(ageDays >= 3 && !matching.some((item) => item.window === "day3") ? ["day3"] : []),
      ...(ageDays >= 7 && !matching.some((item) => item.window === "day7") ? ["day7"] : []),
    ];
    for (const window of windows) {
      const key = `${publication.candidateId}:${publication.platform}:${window}`;
      if (notifiedReminderKeys.has(key)) continue;
      notifiedReminderKeys.add(key);
      new Notification({
        title: "发布数据待回填",
        body: `有一条内容已到 ${window === "day3" ? "T+3" : "T+7"} 数据窗口，请回填表现`,
      }).show();
    }
  }
}

app.whenReady().then(async () => {
  protocol.handle("local-media", (request) => localMediaResponse(request));
  const binaries = resolveBundledFfmpeg();
  database = new DatabaseService(
    path.join(app.getPath("userData"), "workbench.sqlite"),
  );
  await database.initialize();
  settings = new SettingsService(
    database,
    app.getPath("userData"),
    binaries.ffmpeg,
    binaries.ffprobe,
  );
  const sourceRequest = createSourceFetch(
    (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    (input, init) => fetch(input, init),
  );
  feishu = new FeishuDriveService(settings, app.getPath("userData"), sourceRequest);
  textFeishuExporter = new TextFeishuExporter(database, feishu);
  const sourceCookies = async (url: string) => {
    const cookies = await session.fromPartition(sourceLoginPartition).cookies.get({ url });
    const value = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    return value || undefined;
  };
  sources = new SourceAdapterRegistry(sourceCookies, feishu, feishu, sourceRequest);
  const media = new MediaService(
    () => settings.get().ffmpegPath,
    () => settings.get().ffprobePath,
  );
  sampleLearning = new SampleLearningService(
    () => settings.get().ffmpegPath,
    () => settings.get().ffprobePath,
  );
  const modelConfig = async () => ({
    apiKey: settings.getApiKey(),
    baseUrl: settings.get().deepseekBaseUrl,
    model: settings.get().deepseekModel,
  });
  model = new DeepSeekModelAdapter(modelConfig, { request: (input, init) => net.fetch(input instanceof URL ? input.href : input, init) });
  textWorkbench = new TextWorkbench(database,
    new TextSources(new TingwuSourceAdapter(sourceCookies, sourceRequest), feishu, sourceCookies, sourceRequest),
    new DeepSeekModelAdapter(modelConfig, { request: (input, init) => net.fetch(input instanceof URL ? input.href : input, init) }));
  processor = new TaskProcessor(database, media, model, sources);
  exporter = new ExportService(database, media, model, settings);
  repairPersistedCandidateOpenings();
  const interruptedTasks = database.recoverInterruptedTasks();
  // Resume processing tasks automatically. The persisted checkpoint means a
  // restart continues from the last successful stage instead of re-downloading
  // or creating duplicate candidates. Export jobs remain reviewable and can be
  // started again explicitly because their destination may have changed.
  for (const task of interruptedTasks.filter((item) => item.status === "imported")) {
    void processor.enqueue(task.id).catch((error) => {
      console.error("恢复任务失败", error);
    });
  }
  registerIpc();
  await cleanupExpiredWork();
  backupDatabaseIfConfigured();
  setInterval(backupDatabaseIfConfigured, 6 * 60 * 60 * 1000).unref();
  notifyDueReminders();
  setInterval(notifyDueReminders, 15 * 60 * 1000).unref();
  ensureWindowsDesktopShortcut();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  database?.close();
  if (process.platform !== "darwin") app.quit();
});
