import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
  shell: { openExternal: vi.fn() },
}));

import { FeishuDriveService } from "../src/main/feishu-drive";
import type { SettingsService } from "../src/main/settings";
import { buildTextDocumentBlocks, LegacyTextFeishuExporter as TextFeishuExporter } from "../src/main/text-feishu-export";
import type { TextClip, TextJob } from "../src/shared/text-selection";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("FeishuDriveService access token refresh", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refreshes and retries once when Feishu rejects a locally valid token", async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-drive-test-"));
    temporaryDirectories.push(userDataPath);
    fs.writeFileSync(
      path.join(userDataPath, "feishu-auth.bin"),
      JSON.stringify({
        appId: "test-app",
        accessToken: "expired-access-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "valid-refresh-token",
      }),
    );

    const settings = {
      get: () => ({
        feishuAppId: "test-app",
        feishuUpdateFolderToken: "folder-token",
      }),
      getFeishuAppSecret: () => "test-secret",
    } as unknown as SettingsService;
    const authorizations: Array<string | null> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/authen/v2/oauth/token")) {
        return jsonResponse({
          code: 0,
          access_token: "new-access-token",
          expires_in: 7200,
          refresh_token: "rotated-refresh-token",
        });
      }
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      if (authorizations.length === 1) {
        return jsonResponse({
          code: 99991677,
          msg: "Authentication token expired. Please request a new one.",
        });
      }
      return jsonResponse({ code: 0, data: { files: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new FeishuDriveService(settings, userDataPath);
    await expect(service.listFiles("folder-token")).resolves.toEqual([]);
    expect(authorizations).toEqual([
      "Bearer expired-access-token",
      "Bearer new-access-token",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const savedAuth = JSON.parse(
      fs.readFileSync(path.join(userDataPath, "feishu-auth.bin"), "utf8"),
    ) as { accessToken: string; refreshToken: string };
    expect(savedAuth).toMatchObject({
      accessToken: "new-access-token",
      refreshToken: "rotated-refresh-token",
    });
  });

  it("keeps the saved authorization when the token refresh service is temporarily unavailable", async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-refresh-test-"));
    temporaryDirectories.push(userDataPath);
    const authPath = path.join(userDataPath, "feishu-auth.bin");
    const original = JSON.stringify({ appId: "test-app", accessToken: "old", expiresAt: 0, refreshToken: "refresh" });
    fs.writeFileSync(authPath, original);
    const settings = { get: () => ({ feishuAppId: "test-app" }), getFeishuAppSecret: () => "secret" } as unknown as SettingsService;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 503 }, 503)));
    await expect(new FeishuDriveService(settings, userDataPath).listFiles("folder"))
      .rejects.toThrow("连接凭据已保留");
    expect(fs.readFileSync(authPath, "utf8")).toBe(original);
  });

  it("writes native Feishu blocks and resumes the same document and batch after an interrupted write", async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-text-test-"));
    temporaryDirectories.push(userDataPath);
    fs.writeFileSync(path.join(userDataPath, "feishu-auth.bin"), JSON.stringify({
      appId: "test-app", accessToken: "valid-token", expiresAt: Date.now() + 3600000,
    }));
    const settings = { get: () => ({ feishuAppId: "test-app" }), getFeishuAppSecret: () => "test-secret" } as unknown as SettingsService;
    const calls: { url: string; body: any }[] = [];
    let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: input, body });
      if (input.endsWith("/docx/v1/documents")) return jsonResponse({ code: 0, data: { document: { document_id: "docA" } } });
      if (input.includes("/blocks/docA/children?")) {
        if (++writes === 1) throw new Error("测试中断");
        return jsonResponse({ code: 0, data: {} });
      }
      if (input.endsWith("/metas/batch_query")) return jsonResponse({ code: 0, data: { metas: [{ url: "https://example.feishu.cn/docx/docA" }] } });
      throw new Error(`意外的请求 ${input}`);
    }));
    const originalUrl = "https://tingwu.aliyun.com/doc/transcripts/test?sl=1&key=a%2Bb#原链接";
    const job: TextJob = { id: "job", url: "https://tingwu.aliyun.com/doc/transcripts/test?sl=1&key=a%2Bb", originalUrl,
      name: "10月14号示例讲师丁直播回放链接", status: "ready", message: "", createdAt: "", clips: [] };
    const clip: TextClip = {
      id: "clip", title: "标注稿", name: "选题", topicValue: "", completeness: "", titles: ["标注稿"], hooks: [], notes: [],
      hook: { id: "1", ranges: [[0, 3]] }, repeatHook: true,
      body: [{ id: "1", ranges: [[0, 3]] }, { id: "3", ranges: [[0, 3]] }, { id: "2", ranges: [[0, 3]] }],
      units: ["先提问", "后解释对吧", "给结论"].map((text, i) => ({ id: String(i + 1), startMs: i * 1000, endMs: (i + 1) * 1000, text })),
    };
    const store = new Map<string, unknown>();
    const exporter = new TextFeishuExporter({
      getSetting: <T>(key: string, fallback: T) => (structuredClone(store.get(key)) as T | undefined) ?? fallback,
      setSetting: (key, value) => { store.set(key, structuredClone(value)); },
    }, new FeishuDriveService(settings, userDataPath));
    await expect(exporter.export(job, clip, "folderA", " ")).rejects.toThrow("老师姓名");
    await expect(exporter.export(job, clip, "https://example.feishu.cn/drive/folder/folderA", "示例讲师丙")).rejects.toThrow("文档已创建");
    const result = await exporter.export(job, clip, "folderA", "示例讲师丙");
    await expect(exporter.export(job, clip, "folderA", "示例讲师丙")).resolves.toEqual(result);
    expect(result.url).toBe("https://example.feishu.cn/docx/docA");
    expect(calls).toHaveLength(4);
    expect(calls[0].body).toEqual({ title: "示例讲师丙｜标注稿", folder_token: "folderA" });
    expect(calls[1].body.children[0].text.elements[0].text_run.content).toBe("直播老师：示例讲师丙");
    for (const [index, text] of [[1, job.name], [2, originalUrl]] as const) {
      const run = calls[1].body.children[index].text.elements[1].text_run;
      expect(run.content).toBe(text);
      expect(decodeURIComponent(run.text_element_style.link.url)).toBe(originalUrl);
    }
    expect(calls[1]).toEqual(calls[2]);
    const paragraphs = buildTextDocumentBlocks(job, clip).flatMap(block => block.block_type === 2 ? [block.text.elements] : []);
    expect(paragraphs).toContainEqual([
      { text_run: { content: "后解释", text_element_style: { background_color: 3, underline: true } } },
      { text_run: { content: "对吧" } },
    ]);
    expect(paragraphs).toContainEqual([{ text_run: { content: "先提问", text_element_style: { background_color: 4, underline: true } } }]);
    expect(paragraphs).toContainEqual([{ text_run: { content: "给结论", text_element_style: { background_color: 6 } } }]);
    expect(paragraphs.some(elements => elements[0].text_run.text_element_style?.background_color === 3 &&
      elements[0].text_run.text_element_style?.underline === undefined)).toBe(true);
    const delivery = { clipId: clip.id, teacher: "示例讲师丙", title: clip.title, documentId: result.documentId, exportedAt: "" };
    await exporter.sync(job, clip, delivery);
    expect(calls).toHaveLength(4);
    const revised = { ...clip, title: "新标题" };
    await exporter.sync(job, revised, delivery);
    await exporter.sync(job, revised, delivery);
    expect(calls).toHaveLength(5);
    expect(calls[4].url).toContain("/blocks/docA/children?");
    expect(calls[4].body.index).toBe(0);
    expect(calls[4].body.children[1].heading2.elements[0].text_run.content).toBe("新标题");
  });
});
