import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { safeStorage, shell } from "electron";
import type {
  FeishuConnectionInfo,
  FeishuFolderSetupResult,
} from "../shared/types";
import { SettingsService } from "./settings";
import type { SourceFetch } from "./source-http";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
const OAUTH_REDIRECT_URI = "http://127.0.0.1:37137/feishu/oauth/callback";
const OAUTH_SCOPES = [
  "offline_access",
  "drive:drive",
  "minutes:minutes.basic:read",
  "minutes:minutes.media:export",
  "minutes:minutes.transcript:export",
];
const DOCX_SCOPES = ["docx:document:create", "docx:document:write_only", "docx:document:readonly", "wiki:wiki:readonly"];
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const MULTIPART_THRESHOLD = 20 * 1024 * 1024;
const DEFAULT_BLOCK_SIZE = 4 * 1024 * 1024;
const FEISHU_EXPIRED_ACCESS_TOKEN_CODE = 99991677;

function openOAuthUrl(url: string): void {
  if (process.platform === "win32") {
    const chromeCandidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    const chromePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
    if (chromePath) {
      execFile(chromePath, [url], (error) => {
        if (error) void shell.openExternal(url);
      });
      return;
    }
  }
  void shell.openExternal(url);
}

export interface FeishuDriveFile {
  name: string;
  token: string;
  type?: string;
  url?: string;
  modifiedTime?: string;
  createdTime?: string;
}

export type FeishuTextStyle = { bold?: boolean; underline?: boolean; background_color?: number; link?: { url: string } };
type FeishuTextElement = { text_run: { content: string; text_element_style?: FeishuTextStyle } };
export type FeishuTextBlock = { block_type: 2; text: { elements: FeishuTextElement[] } } |
  { block_type: 3; heading1: { elements: FeishuTextElement[] } } |
  { block_type: 4; heading2: { elements: FeishuTextElement[] } };
export type FeishuDocumentBlock = FeishuTextBlock & { block_id: string };

export function isFeishuDocUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(?:^|\.)(?:feishu\.cn|larkoffice\.com)$/i.test(url.hostname) &&
      /^\/(?:docx|wiki)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  } catch { return false; }
}

interface FeishuAuthRecord {
  appId: string;
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
}

interface FeishuApiEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

interface FeishuFileListData {
  files?: Array<{
    name?: string;
    token?: string;
    type?: string;
    url?: string;
    modified_time?: string;
    created_time?: string;
  }>;
  has_more?: boolean;
  next_page_token?: string;
}

interface FeishuUploadPrepareData {
  upload_id: string;
  block_size: number;
  block_num: number;
}

interface FeishuUploadResult {
  file_token?: string;
}

interface FeishuFolderMeta {
  name?: string;
  token?: string;
}

export interface FeishuMinutesInfo {
  token: string;
  title?: string;
  duration?: string;
  url?: string;
}

interface FeishuMinutesDetailData {
  minute?: {
    token?: string;
    title?: string;
    duration?: string;
    url?: string;
  };
}

interface FeishuMinutesMediaData {
  download_url?: string;
}

interface FeishuOAuthResponse {
  code: number;
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

function encodeSecret(value: string): Buffer {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value)
    : Buffer.from(value, "utf8");
}

function decodeSecret(value: Buffer): string {
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(value)
      : value.toString("utf8");
  } catch {
    return value.toString("utf8");
  }
}

function apiError(code: number, message: string): Error {
  return new Error(`飞书接口错误（${code}）：${message}`);
}

const FEISHU_MINUTES_PERMISSION_HINT =
  "飞书妙记下载权限未开通：请在飞书开放平台给自建应用开启“妙记媒体导出”" +
  "（minutes:minutes.media:export）和“妙记逐字稿导出”（minutes:minutes.transcript:export），" +
  "发布/审批后在工作台断开并重新连接飞书；不要再请求旧权限 minutes:minute:download";

function explainMinutesPermissionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("2091005")) {
    return new Error("飞书已连接，但当前授权账号不能导出这条妙记的逐字稿（2091005）。请让妙记所有者将该账号加入协作者并允许导出，或改用能导出它的账号连接。权限调整后可直接重试。");
  }
  if (
    message.includes("99991679") ||
    message.includes("minutes:minute:download") ||
    message.includes("minutes:minutes.media:export") ||
    message.includes("minutes:minutes.transcript:export")
  ) {
    return new Error(FEISHU_MINUTES_PERMISSION_HINT);
  }
  return error instanceof Error ? error : new Error(message);
}

function safeInstallerName(value: string): string {
  const name = path.basename(value.trim());
  if (!name || name !== value.trim() || !/\.(?:exe|dmg|zip)$/i.test(name)) {
    throw new Error("飞书更新文件名无效");
  }
  return name;
}

export function extractFeishuFolderToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const urlMatch = trimmed.match(/(?:drive\/folder|folder)\/([A-Za-z0-9_-]+)/i);
  if (urlMatch?.[1]) return urlMatch[1];
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  throw new Error("飞书文件夹 token 或链接格式不正确");
}

export class FeishuDriveService {
  private readonly authPath: string;
  private accessTokenRefresh?: Promise<string>;

  constructor(
    private readonly settings: SettingsService,
    userDataPath: string,
    private readonly sourceRequest: SourceFetch = (input, options) => fetch(input, options),
  ) {
    this.authPath = path.join(userDataPath, "feishu-auth.bin");
  }

  private loadAuth(): FeishuAuthRecord | undefined {
    if (!fs.existsSync(this.authPath)) return undefined;
    try {
      return JSON.parse(decodeSecret(fs.readFileSync(this.authPath))) as FeishuAuthRecord;
    } catch {
      return undefined;
    }
  }

  private saveAuth(record: FeishuAuthRecord): void {
    fs.writeFileSync(this.authPath, encodeSecret(JSON.stringify(record)), {
      mode: 0o600,
    });
  }

  private clearAuth(): void {
    if (fs.existsSync(this.authPath)) fs.unlinkSync(this.authPath);
  }

  async getStatus(): Promise<FeishuConnectionInfo> {
    const appIdConfigured = Boolean(this.settings.get().feishuAppId.trim());
    const updateFolderConfigured = Boolean(
      this.settings.get().feishuUpdateFolderToken.trim(),
    );
    const auth = this.loadAuth();
    const sameApp = Boolean(
      auth && auth.appId === this.settings.get().feishuAppId.trim(),
    );
    const connected = Boolean(
      sameApp && auth && (auth.accessToken || auth.refreshToken),
    );
    return {
      connected,
      appIdConfigured,
      updateFolderConfigured,
      message: !appIdConfigured
        ? "请先填写飞书自建应用 App ID"
        : !this.settings.getFeishuAppSecret()
          ? "请先填写飞书自建应用 App Secret"
            : !connected
              ? "尚未连接飞书，请点击连接并授权"
            : !updateFolderConfigured
              ? "已连接飞书；可以读取素材文件夹，若要自动更新还需配置更新文件夹"
              : "飞书更新源已连接",
    };
  }

  async connect(includeDocumentPermissions = false): Promise<FeishuConnectionInfo> {
    const appId = this.settings.get().feishuAppId.trim();
    const appSecret = this.settings.getFeishuAppSecret().trim();
    if (!appId) throw new Error("请先填写飞书自建应用 App ID，并保存设置");
    if (!appSecret) throw new Error("请先填写飞书自建应用 App Secret，并保存设置");

    const state = crypto.randomBytes(24).toString("base64url");
    const codeVerifier = crypto.randomBytes(48).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const authorizeUrl = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    authorizeUrl.searchParams.set("client_id", appId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
    authorizeUrl.searchParams.set("scope", (includeDocumentPermissions ? [...OAUTH_SCOPES, ...DOCX_SCOPES] : OAUTH_SCOPES).join(" "));
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const code = await this.waitForAuthorizationCode(authorizeUrl.toString(), state);
    const response = await this.sourceRequest(`${FEISHU_API_BASE}/authen/v2/oauth/token`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: appId,
        client_secret: appSecret,
        code,
        redirect_uri: OAUTH_REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    });
    const payload = (await response.json()) as FeishuOAuthResponse;
    if (!response.ok || payload.code !== 0 || !payload.access_token) {
      throw apiError(
        payload.code || response.status,
        payload.error_description || payload.error || "授权换取访问令牌失败",
      );
    }
    this.saveAuth({
      appId,
      accessToken: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 7200) * 1000,
      refreshToken: payload.refresh_token,
      refreshTokenExpiresAt: payload.refresh_token_expires_in
        ? Date.now() + payload.refresh_token_expires_in * 1000
        : undefined,
    });
    return this.getStatus();
  }

  async disconnect(): Promise<FeishuConnectionInfo> {
    this.clearAuth();
    return this.getStatus();
  }

  async testFolder(folderValue?: string): Promise<FeishuFolderSetupResult> {
    const configured = folderValue?.trim() || this.settings.get().feishuUpdateFolderToken;
    const folderToken = extractFeishuFolderToken(configured);
    if (!folderToken) {
      throw new Error("请填写飞书更新文件夹的链接或 token");
    }
    const meta = await this.requestJson<FeishuFolderMeta>(
      `/drive/explorer/v2/folder/${encodeURIComponent(folderToken)}/meta`,
    );
    if (meta.name && meta.name !== "直播切片工作台更新") {
      throw new Error(`选中的飞书文件夹名称是“${meta.name}”，请使用名称为“直播切片工作台更新”的文件夹`);
    }
    const files = await this.listFiles(folderToken);
    return {
      folderToken,
      folderName: meta.name || "直播切片工作台更新",
      folderUrl: `https://feishu.cn/drive/folder/${folderToken}`,
    };
  }

  async listFiles(folderToken: string): Promise<FeishuDriveFile[]> {
    const files: FeishuDriveFile[] = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ page_size: "200", direction: "ASC" });
      if (folderToken) query.set("folder_token", folderToken);
      if (pageToken) query.set("page_token", pageToken);
      const data = await this.requestJson<FeishuFileListData>(
        `/drive/v1/files?${query.toString()}`,
      );
      for (const file of data.files ?? []) {
        if (!file.name || !file.token) continue;
        files.push({
          name: file.name,
          token: file.token,
          type: file.type,
          url: file.url,
          modifiedTime: file.modified_time,
          createdTime: file.created_time,
        });
      }
      pageToken = data.has_more ? data.next_page_token ?? "" : "";
    } while (pageToken);
    return files;
  }

  async createTextDocument(title: string, folderToken: string): Promise<string> {
    const data = await this.requestJson<{ document?: { document_id?: string } }>("/docx/v1/documents", {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ title, ...(folderToken ? { folder_token: folderToken } : {}) }),
    });
    const id = data.document?.document_id;
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("飞书创建文档后未返回有效编号");
    return id;
  }

  async resolveTextDocument(value: string): Promise<{ documentId: string; url: string }> {
    if (!isFeishuDocUrl(value)) throw new Error("请填写飞书新版文档或知识库文档链接");
    const url = new URL(value);
    const [, type, token] = url.pathname.split("/");
    if (type === "docx") return { documentId: token, url: value };
    const data = await this.requestJson<{ node?: { obj_type?: string; obj_token?: string } }>(
      `/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(30000) },
    );
    if (data.node?.obj_type !== "docx" || !data.node.obj_token) {
      throw new Error("这条知识库链接指向的不是新版飞书文档，请选择可编辑的文字文档");
    }
    return { documentId: data.node.obj_token, url: value };
  }

  async textDocumentChildren(documentId: string): Promise<FeishuDocumentBlock[]> {
    const id = encodeURIComponent(documentId);
    const blocks: FeishuDocumentBlock[] = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ page_size: "500", document_revision_id: "-1" });
      if (pageToken) query.set("page_token", pageToken);
      const data = await this.requestJson<{ items?: FeishuDocumentBlock[]; has_more?: boolean; page_token?: string }>(
        `/docx/v1/documents/${id}/blocks/${id}/children?${query}`,
        { signal: AbortSignal.timeout(30000) },
      );
      blocks.push(...(data.items ?? []));
      if (data.has_more && (!data.page_token || data.page_token === pageToken)) throw new Error("飞书文档分页未完成，请重试");
      pageToken = data.has_more ? data.page_token! : "";
    } while (pageToken);
    return blocks;
  }

  async insertTextDocumentBlocks(documentId: string, children: FeishuTextBlock[], clientToken: string, index: number): Promise<string[]> {
    const id = encodeURIComponent(documentId);
    const query = new URLSearchParams({ document_revision_id: "-1", client_token: clientToken });
    const data = await this.requestJson<{ children?: Array<{ block_id: string }> }>(
      `/docx/v1/documents/${id}/blocks/${id}/children?${query}`,
      { method: "POST", signal: AbortSignal.timeout(30000), body: JSON.stringify({ index, children }) },
    );
    if (data.children?.length !== children.length) throw new Error("飞书未返回完整写入记录，请保持稿件不变再次导出");
    return data.children.map(block => block.block_id);
  }

  async updateTextDocumentBlocks(documentId: string, blocks: Array<{ id: string; block: FeishuTextBlock }>): Promise<void> {
    const requests = blocks.map(({ id, block }) => ({
      block_id: id, update_text_elements: { elements: block.block_type === 2 ? block.text.elements
        : block.block_type === 3 ? block.heading1.elements : block.heading2.elements },
    }));
    await this.requestJson(`/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/batch_update?document_revision_id=-1`, {
      method: "PATCH", signal: AbortSignal.timeout(30000), body: JSON.stringify({ requests }),
    });
  }

  async appendTextDocumentBlocks(documentId: string, children: FeishuTextBlock[], clientToken: string, index = -1): Promise<void> {
    const id = encodeURIComponent(documentId);
    const query = new URLSearchParams({ document_revision_id: "-1", client_token: clientToken });
    await this.requestJson(`/docx/v1/documents/${id}/blocks/${id}/children?${query}`, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ index, children }),
    });
  }

  async textDocumentUrl(documentId: string): Promise<string | undefined> {
    const data = await this.requestJson<{ metas?: { url?: string }[] }>("/drive/v1/metas/batch_query", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ request_docs: [{ doc_token: documentId, doc_type: "docx" }], with_url: true }),
    });
    const url = data.metas?.[0]?.url;
    return url && isFeishuDocUrl(url) ? url : undefined;
  }

  async getMinutesInfo(minuteToken: string): Promise<FeishuMinutesInfo> {
    let data: FeishuMinutesDetailData;
    try {
      data = await this.requestJson<FeishuMinutesDetailData>(
        `/minutes/v1/minutes/${encodeURIComponent(minuteToken)}`,
      );
    } catch (error) {
      throw explainMinutesPermissionError(error);
    }
    const minute = data.minute;
    if (!minute?.token) throw new Error("飞书妙记没有返回有效的妙记信息");
    return {
      token: minute.token,
      title: minute.title,
      duration: minute.duration,
      url: minute.url,
    };
  }

  async downloadMinutesMedia(
    minuteToken: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let data: FeishuMinutesMediaData;
    try {
      data = await this.requestJson<FeishuMinutesMediaData>(
        `/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/media`,
        signal ? { signal } : undefined,
      );
    } catch (error) {
      throw explainMinutesPermissionError(error);
    }
    if (!data.download_url) {
      throw new Error("飞书妙记没有返回可下载的视频地址，请确认当前账号有下载权限");
    }
    return this.downloadExternalFile(data.download_url, destination, signal);
  }

  async downloadMinutesTranscript(
    minuteToken: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const text = await this.readMinutesTranscript(minuteToken, "txt", signal);
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    await fsPromises.writeFile(destination, text, "utf8");
    return destination;
  }

  async readMinutesTranscript(minuteToken: string, format: "txt" | "srt", signal?: AbortSignal): Promise<string> {
    const query = new URLSearchParams({
      need_speaker: format === "txt" ? "true" : "false",
      need_timestamp: "true",
      file_format: format,
    });
    const response = await this.fetchWithAccessToken(
      `${FEISHU_API_BASE}/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/transcript?${query.toString()}`,
      { signal },
      this.sourceRequest,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw explainMinutesPermissionError(
        new Error(
          `飞书妙记逐字稿下载失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
        ),
      );
    }
    const raw = await response.text();
    const text = this.extractTranscriptText(raw);
    if (!text.trim()) throw new Error("飞书妙记没有返回可用的逐字稿");
    return text;
  }

  async readTextFile(fileToken: string): Promise<string> {
    const response = await this.downloadResponse(fileToken);
    return response.text();
  }

  async downloadFile(fileToken: string, destination: string, signal?: AbortSignal): Promise<string> {
    const response = await this.downloadResponse(fileToken, signal);
    if (!response.body) throw new Error("飞书更新文件没有返回内容");
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    const stream = fs.createWriteStream(destination);
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<any>),
      stream,
      ...(signal ? [{ signal }] : []),
    );
    return destination;
  }

  private async downloadExternalFile(
    url: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // The Minutes API returns a short-lived signed download URL. Do not send
    // the OAuth token to the CDN that serves the media.
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`飞书妙记视频下载失败（HTTP ${response.status}）`);
    }
    if (!response.body) throw new Error("飞书妙记视频没有返回内容");
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    const stream = fs.createWriteStream(destination);
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<any>),
      stream,
      ...(signal ? [{ signal }] : []),
    );
    return destination;
  }

  private extractTranscriptText(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return raw;
    try {
      const payload = JSON.parse(trimmed) as {
        data?: { text?: string; content?: string; transcript?: string } | string;
        text?: string;
        content?: string;
      };
      if (typeof payload.data === "string") return payload.data;
      return (
        payload.data?.text ||
        payload.data?.content ||
        payload.data?.transcript ||
        payload.text ||
        payload.content ||
        ""
      );
    } catch {
      return raw;
    }
  }

  async uploadFile(
    filePath: string,
    folderToken: string,
    remoteFileName = path.basename(filePath),
  ): Promise<string> {
    const fileName = remoteFileName;
    const stat = await fsPromises.stat(filePath);
    if (stat.size <= MULTIPART_THRESHOLD) {
      const form = new FormData();
      form.append("file_name", fileName);
      form.append("parent_type", "explorer");
      form.append("parent_node", folderToken);
      form.append("size", String(stat.size));
      form.append("file", new Blob([await fsPromises.readFile(filePath)]), fileName);
      const data = await this.requestJson<FeishuUploadResult>(
        "/drive/v1/files/upload_all",
        { method: "POST", body: form },
      );
      if (!data.file_token) throw new Error(`飞书上传失败：${fileName} 未返回文件 token`);
      return data.file_token;
    }

    const prepare = await this.requestJson<FeishuUploadPrepareData>(
      "/drive/v1/files/upload_prepare",
      {
        method: "POST",
        body: JSON.stringify({
          file_name: fileName,
          parent_type: "explorer",
          parent_node: folderToken,
          size: stat.size,
        }),
      },
    );
    const blockSize = prepare.block_size || DEFAULT_BLOCK_SIZE;
    const file = await fsPromises.open(filePath, "r");
    try {
      for (let sequence = 0; sequence < prepare.block_num; sequence += 1) {
        const size = Math.min(blockSize, stat.size - sequence * blockSize);
        const buffer = Buffer.alloc(size);
        const result = await file.read(buffer, 0, size, sequence * blockSize);
        if (result.bytesRead !== size) {
          throw new Error(`读取安装包分片失败：${fileName}（第 ${sequence + 1} 片）`);
        }
        const form = new FormData();
        form.append("upload_id", prepare.upload_id);
        form.append("seq", String(sequence));
        form.append("size", String(size));
        form.append("file", new Blob([buffer]), fileName);
        await this.requestJson<unknown>(
          "/drive/v1/files/upload_part",
          { method: "POST", body: form },
        );
      }
    } finally {
      await file.close();
    }
    const completed = await this.requestJson<FeishuUploadResult>(
      "/drive/v1/files/upload_finish",
      {
        method: "POST",
        body: JSON.stringify({
          upload_id: prepare.upload_id,
          block_num: prepare.block_num,
        }),
      },
    );
    if (!completed.file_token) {
      throw new Error(`飞书上传失败：${fileName} 完成接口未返回文件 token`);
    }
    return completed.file_token;
  }

  async deleteFile(fileToken: string): Promise<void> {
    await this.requestJson<unknown>(`/drive/v1/files/${encodeURIComponent(fileToken)}`, {
      method: "DELETE",
    });
  }

  private async downloadResponse(fileToken: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetchWithAccessToken(
      `${FEISHU_API_BASE}/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
      { signal },
    );
    if (!response.ok) {
      throw new Error(`飞书下载失败（HTTP ${response.status}）`);
    }
    return response;
  }

  private async requestJson<T>(
    endpoint: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && typeof init.body === "string") {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    const response = await this.fetchWithAccessToken(`${FEISHU_API_BASE}${endpoint}`, {
      ...init,
      headers,
    }, !init.method || init.method === "GET" ? this.sourceRequest : undefined);
    const payload = (await response.json()) as FeishuApiEnvelope<T>;
    if (!response.ok || payload.code !== 0) {
      throw apiError(
        payload.code || response.status,
        payload.msg || `HTTP ${response.status}`,
      );
    }
    return (payload.data ?? {}) as T;
  }

  private async fetchWithAccessToken(
    url: string,
    init: RequestInit = {},
    request: SourceFetch = (input, options) => fetch(input, options),
  ): Promise<Response> {
    let token = await this.ensureAccessToken();
    const send = (accessToken: string) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${accessToken}`);
      return request(url, { ...init, headers });
    };

    let response = await send(token);
    if (await this.isExpiredAccessTokenResponse(response)) {
      token = await this.ensureAccessToken(true, token);
      response = await send(token);
    }
    return response;
  }

  private async isExpiredAccessTokenResponse(response: Response): Promise<boolean> {
    if (response.status === 401) return true;
    if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
      return false;
    }
    try {
      const payload = (await response.clone().json()) as { code?: number };
      return payload.code === FEISHU_EXPIRED_ACCESS_TOKEN_CODE;
    } catch {
      return false;
    }
  }

  private async ensureAccessToken(
    forceRefresh = false,
    rejectedAccessToken?: string,
  ): Promise<string> {
    const appId = this.settings.get().feishuAppId.trim();
    const appSecret = this.settings.getFeishuAppSecret().trim();
    const auth = this.loadAuth();
    if (!appId || !appSecret || !auth || auth.appId !== appId) {
      throw new Error("尚未连接飞书，请先在本地设置中连接并授权");
    }
    const tokenIsLocallyValid = Boolean(
      auth.accessToken && auth.expiresAt > Date.now() + 60_000,
    );
    if (!forceRefresh && tokenIsLocallyValid) {
      return auth.accessToken;
    }
    // Another request may already have replaced the token rejected by the
    // server. Reuse that new token instead of rotating the refresh token twice.
    if (
      forceRefresh &&
      rejectedAccessToken &&
      auth.accessToken !== rejectedAccessToken &&
      tokenIsLocallyValid
    ) {
      return auth.accessToken;
    }
    if (!auth.refreshToken) {
      throw new Error("飞书授权已过期，请重新连接飞书");
    }
    if (this.accessTokenRefresh) return this.accessTokenRefresh;

    this.accessTokenRefresh = (async () => {
      const response = await this.sourceRequest(`${FEISHU_API_BASE}/authen/v2/oauth/token`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: appId,
          client_secret: appSecret,
          refresh_token: auth.refreshToken,
        }),
      });
      const payload = (await response.json()) as FeishuOAuthResponse;
      if (!response.ok || payload.code !== 0 || !payload.access_token) {
        if (response.status === 429 || response.status >= 500) {
          throw new Error("飞书授权服务暂时不可用，连接凭据已保留，请稍后重试");
        }
        throw apiError(
          payload.code || response.status,
          payload.error_description || payload.error || "飞书授权已失效，请重新连接",
        );
      }
      this.saveAuth({
        appId,
        accessToken: payload.access_token,
        expiresAt: Date.now() + (payload.expires_in ?? 7200) * 1000,
        // Feishu may rotate the refresh token; if a response omits it, keep the
        // still-valid previous token so a transient response cannot break auto-refresh.
        refreshToken: payload.refresh_token || auth.refreshToken,
        refreshTokenExpiresAt: payload.refresh_token_expires_in
          ? Date.now() + payload.refresh_token_expires_in * 1000
          : auth.refreshTokenExpiresAt,
      });
      return payload.access_token;
    })().finally(() => {
      this.accessTokenRefresh = undefined;
    });
    return this.accessTokenRefresh;
  }

  private async waitForAuthorizationCode(
    authorizeUrl: string,
    expectedState: string,
  ): Promise<string> {
    let server: http.Server | undefined;
    let timer: NodeJS.Timeout | undefined;
    const codePromise = new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, code?: string) => {
        if (timer) clearTimeout(timer);
        server?.close();
        if (error) reject(error);
        else if (code) resolve(code);
        else reject(new Error("飞书授权没有返回授权码"));
      };
      server = http.createServer((request, response) => {
        const requestUrl = new URL(
          request.url ?? "/",
          OAUTH_REDIRECT_URI,
        );
        if (requestUrl.pathname !== "/feishu/oauth/callback") {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        const state = requestUrl.searchParams.get("state");
        const error = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code");
        const validCallback = !error && state === expectedState && Boolean(code);
        response.writeHead(validCallback ? 200 : 400, {
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end(
          validCallback
            ? "<h2>已收到飞书授权回调</h2><p>请返回工作台，等它显示已连接后再继续。</p>"
            : "<h2>飞书授权未完成</h2><p>可以关闭此页面，回到工作台查看原因或重试。</p>",
        );
        if (state !== expectedState) {
          finish(new Error("飞书授权状态校验失败，请重新连接"));
          return;
        }
        if (error) {
          finish(new Error("飞书授权被取消"));
          return;
        }
        if (!code) {
          finish(new Error("飞书授权没有返回授权码"));
          return;
        }
        finish(undefined, code);
      });
      server.once("error", () => {
        finish(new Error("无法启动本地授权回调端口 37137，请关闭占用该端口的程序后重试"));
      });
      server.listen(37137, "127.0.0.1", () => {
        openOAuthUrl(authorizeUrl);
      });
      timer = setTimeout(() => {
        finish(new Error("飞书授权等待超时，请重新点击连接"));
      }, OAUTH_TIMEOUT_MS);
    });
    return codePromise;
  }
}

export { OAUTH_REDIRECT_URI, OAUTH_SCOPES };
