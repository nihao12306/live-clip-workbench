import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseFeishuMaterialFiles,
  downloadToFileResumable,
  FeishuMinutesSourceAdapter,
  FeishuMaterialSourceAdapter,
  TingwuSourceAdapter,
} from "../src/main/source-adapters";

const tempDirs: string[] = [];

describe("resumable source downloads", () => {
  it("resumes after the media connection is interrupted", async () => {
    const payload = Buffer.alloc(128 * 1024, 7);
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests += 1;
      const start = Number(
        request.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0,
      );
      if (requests === 1) {
        response.writeHead(200, {
          "Content-Length": payload.length,
          "Content-Type": "video/mp4",
        });
        response.write(payload.subarray(0, 32 * 1024));
        response.socket?.destroy();
        return;
      }
      response.writeHead(start > 0 ? 206 : 200, {
        "Content-Length": payload.length - start,
        "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
        "Content-Type": "video/mp4",
      });
      response.end(payload.subarray(start));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing test port");
    }
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "tingwu-download-"),
    );
    tempDirs.push(directory);
    const destination = path.join(directory, "source.mp4");

    try {
      await downloadToFileResumable(
        `http://127.0.0.1:${address.port}/source.mp4`,
        destination,
        "https://tingwu.aliyun.com/",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requests).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(destination)).toEqual(payload);
  });
});

describe("TingwuSourceAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tempDirs
      .splice(0)
      .forEach((directory) =>
        fs.rmSync(directory, { recursive: true, force: true }),
      );
  });

  it("recognizes a Tingwu transcript page and its dynamic API payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "0",
          data: {
            playVideoUrl: "https://media.example/source.mp4",
            result: JSON.stringify({
              pg: [
                {
                  sc: [
                    { bt: 1000, et: 2300, tc: "第一句。" },
                    { bt: 2300, et: 4200, tc: "第二句。" },
                  ],
                },
                { sc: [{ bt: 5000, et: 7300, tc: "下一段。" }] },
              ],
            }),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TingwuSourceAdapter();
    const result = await adapter.inspect(
      "https://tingwu.aliyun.com/doc/transcripts/abc123?sl=1#",
    );

    expect(result).toMatchObject({
      provider: "tingwu",
      supported: true,
      requiresFallback: false,
      videoUrl: "https://media.example/source.mp4",
    });
    expect(result.message).toContain("3 段带时间码逐字稿");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tingwu.aliyun.com/api/trans/getTransResult?c=web",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each(["# 《undefined》", "#%20%E3%80%8Aundefined%E3%80%8B"])(
    "imports shared links with the title fragment %s using valid HTTP headers",
    async (fragment) => {
      const payload = Buffer.from("test video bytes");
      const referer = "https://tingwu.aliyun.com/doc/transcripts/abc123?sl=1&label=%E7%9B%B4%E6%92%AD";
      const downloadReferers: Array<string | undefined> = [];
      const server = http.createServer((request, response) => {
        downloadReferers.push(request.headers.referer);
        response.writeHead(200, { "Content-Length": payload.length });
        response.end(payload);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test port");
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tingwu-shared-link-"));
      tempDirs.push(directory);
      const requests: Request[] = [];
      const fetchMock = vi.fn((input: string, init: RequestInit) => {
        requests.push(new Request(input, init));
        return Promise.resolve(new Response(JSON.stringify({
          code: "0",
          data: {
            playVideoUrl: `http://127.0.0.1:${address.port}/source.mp4`,
            result: JSON.stringify({ pg: [{ sc: [{ bt: 1000, et: 2300, tc: "测试字幕。" }] }] }),
          },
        }), { status: 200 }));
      });
      vi.stubGlobal("fetch", fetchMock);
      const cookieProvider = vi.fn(async () => "session=test-cookie");
      const adapter = new TingwuSourceAdapter(cookieProvider);
      const url = `https://tingwu.aliyun.com/doc/transcripts/abc123?sl=1&label=直播${fragment}`;

      try {
        const inspection = await adapter.inspect(url);
        expect(inspection.requiresFallback).toBe(false);
        const imported = await adapter.import(url, directory);
        expect(fs.readFileSync(imported.videoPath!)).toEqual(payload);
        expect(fs.readFileSync(imported.transcriptPath!, "utf8")).toContain("测试字幕。");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(requests[0].headers.get("referer")).toBe(referer);
        expect(requests[0].headers.get("cookie")).toBe("session=test-cookie");
        expect(await requests[0].json()).toMatchObject({ transId: "abc123" });
        expect(downloadReferers).toEqual([referer]);
        expect(cookieProvider.mock.calls).toEqual([[referer], [referer]]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    10_000,
  );

  it("reports a clear fallback when the share is not authorized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "TRS.NeedLogin",
            message: "need login",
            success: false,
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await new TingwuSourceAdapter().inspect(
      "https://tingwu.aliyun.com/doc/transcripts/private?sl=1",
    );
    expect(result.requiresFallback).toBe(true);
    expect(result.message).toContain("未授权");
  });
});

describe("FeishuMaterialSourceAdapter", () => {
  afterEach(() => {
    tempDirs
      .splice(0)
      .forEach((directory) =>
        fs.rmSync(directory, { recursive: true, force: true }),
      );
  });

  it("selects the only video and transcript in a Feishu folder", () => {
    const result = chooseFeishuMaterialFiles([
      { name: "直播回放.mp4", token: "video" },
      { name: "直播逐字稿.docx", token: "transcript" },
      { name: "封面.png", token: "cover" },
    ]);

    expect(result.videoFile?.token).toBe("video");
    expect(result.transcriptFile?.token).toBe("transcript");
  });

  it("uses a unique same-name pair when a folder contains multiple assets", () => {
    const result = chooseFeishuMaterialFiles([
      { name: "旧版.mp4", token: "old-video" },
      { name: "上次稿件.srt", token: "old-transcript" },
      { name: "本次回放.mp4", token: "new-video" },
      { name: "本次回放-逐字稿.srt", token: "new-transcript" },
    ]);

    expect(result.videoFile?.token).toBe("new-video");
    expect(result.transcriptFile?.token).toBe("new-transcript");
  });

  it("downloads both assets from a Feishu folder into the task input directory", async () => {
    const drive = {
      listFiles: vi.fn().mockResolvedValue([
        { name: "回放.mov", token: "video" },
        { name: "逐字稿.txt", token: "transcript" },
      ]),
      downloadFile: vi.fn(async (token: string, destination: string) => {
        fs.writeFileSync(destination, token === "video" ? "video" : "transcript");
        return destination;
      }),
    };
    const adapter = new FeishuMaterialSourceAdapter(drive);
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "feishu-material-source-"),
    );
    tempDirs.push(directory);

    const result = await adapter.inspect(
      "https://example.feishu.cn/drive/folder/folder-token",
    );
    expect(result).toMatchObject({
      provider: "feishu",
      supported: true,
      requiresFallback: false,
    });
    expect(result.message).toContain("回放.mov");
    expect(result.message).toContain("逐字稿.txt");

    const imported = await adapter.import(
      "https://example.feishu.cn/drive/folder/folder-token",
      directory,
    );
    expect(imported.videoPath).toMatch(/source\.mov$/);
    expect(imported.transcriptPath).toMatch(/transcript\.txt$/);
    expect(fs.readFileSync(imported.videoPath!, "utf8")).toBe("video");
    expect(fs.readFileSync(imported.transcriptPath!, "utf8")).toBe("transcript");
    expect(drive.listFiles).toHaveBeenCalledWith("folder-token");
    expect(drive.downloadFile).toHaveBeenCalledTimes(2);
  });

  it("reports missing materials instead of falling back to HTML scraping", async () => {
    const adapter = new FeishuMaterialSourceAdapter({
      listFiles: vi.fn().mockResolvedValue([
        { name: "回放.mp4", token: "video" },
      ]),
      downloadFile: vi.fn(),
    });

    const result = await adapter.inspect(
      "https://example.feishu.cn/drive/folder/folder-token",
    );
    expect(result.requiresFallback).toBe(true);
    expect(result.message).toContain("没有逐字稿");
  });
});

describe("FeishuMinutesSourceAdapter", () => {
  afterEach(() => {
    tempDirs
      .splice(0)
      .forEach((directory) =>
        fs.rmSync(directory, { recursive: true, force: true }),
      );
  });

  it("imports a Feishu Minutes link like a Tingwu link", async () => {
    const minutes = {
      getMinutesInfo: vi.fn().mockResolvedValue({
        token: "obc123",
        title: "示例账号丙（河北）",
      }),
      downloadMinutesMedia: vi.fn(async (_token: string, destination: string) => {
        fs.writeFileSync(destination, "video");
        return destination;
      }),
      downloadMinutesTranscript: vi.fn(async (_token: string, destination: string) => {
        fs.writeFileSync(destination, "[00:00:01] 第一段文字");
        return destination;
      }),
    };
    const adapter = new FeishuMinutesSourceAdapter(minutes);
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "feishu-minutes-source-"),
    );
    tempDirs.push(directory);
    const url = "https://example.feishu.cn/minutes/obc123";

    expect(adapter.canHandle(url)).toBe(true);
    const inspection = await adapter.inspect(url);
    expect(inspection).toMatchObject({
      provider: "feishu",
      supported: true,
      requiresFallback: false,
    });
    expect(inspection.message).toContain("示例账号丙");

    const imported = await adapter.import(url, directory);
    expect(imported.videoPath).toMatch(/source\.mp4$/);
    expect(imported.transcriptPath).toMatch(/transcript\.txt$/);
    expect(fs.readFileSync(imported.videoPath!, "utf8")).toBe("video");
    expect(fs.readFileSync(imported.transcriptPath!, "utf8")).toContain("第一段文字");
    expect(minutes.getMinutesInfo).toHaveBeenCalledWith("obc123");
    expect(minutes.downloadMinutesMedia).toHaveBeenCalledWith(
      "obc123",
      expect.stringMatching(/source\.mp4\.download$/),
    );
    expect(minutes.downloadMinutesTranscript).toHaveBeenCalledWith(
      "obc123",
      expect.stringMatching(/transcript\.txt\.download$/),
    );
  });
});
