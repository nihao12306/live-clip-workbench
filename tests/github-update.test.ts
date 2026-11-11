import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkGithubUpdate, downloadGithubUpdate } from "../src/main/github-update";

const release = {
  tag_name: "v0.1.74",
  draft: false,
  prerelease: false,
  body: "新增 GitHub 更新提醒",
  assets: ["mac-arm64.dmg", "mac-x64.dmg", "win-x64.exe"].map((suffix, index) => {
    const name = `live-clip-workbench-0.1.74-${suffix}`;
    return {
      id: index + 1,
      name,
      size: 1234,
      state: "uploaded",
      digest: `sha256:${"a".repeat(64)}`,
      browser_download_url: `https://github.com/nihao12306/live-clip-workbench/releases/download/v0.1.74/${name}`,
    };
  }),
};

describe("GitHub release updates", () => {
  it.each([
    ["darwin", "arm64", 1],
    ["darwin", "x64", 2],
    ["win32", "x64", 3],
  ] as const)("selects the installer for %s %s", async (platform, architecture, id) => {
    const request = vi.fn(async () => Response.json(release));
    const result = await checkGithubUpdate("0.1.73", platform, architecture, request);
    expect(result.info).toMatchObject({ available: true, source: "github", githubAssetId: id, version: "0.1.74" });
    expect(result.download).toMatchObject({ name: release.assets[id - 1].name, sha256: "a".repeat(64) });
    expect(request).toHaveBeenCalledWith(
      "https://api.github.com/repos/nihao12306/live-clip-workbench/releases/latest",
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it.each(["0.1.74", "0.1.100"])("does not offer an equal or older version to %s", async (currentVersion) => {
    expect((await checkGithubUpdate(currentVersion, "darwin", "arm64", async () => Response.json(release))).info.available).toBe(false);
  });

  it("does not substitute an Intel installer for Apple Silicon", async () => {
    const result = await checkGithubUpdate("0.1.73", "darwin", "arm64", async () =>
      Response.json({ ...release, assets: [release.assets[1]] }));
    expect(result.download).toBeUndefined();
    expect(result.info.available).toBe(false);
  });

  it.each([{ digest: null }, { browser_download_url: "https://example.com/update.dmg" }])(
    "does not offer an unverified asset",
    async (patch) => {
      const result = await checkGithubUpdate("0.1.73", "darwin", "arm64", async () =>
        Response.json({ ...release, assets: [{ ...release.assets[0], ...patch }] }));
      expect(result.download).toBeUndefined();
      expect(result.info.available).toBe(false);
    },
  );

  it("reports that no release exists when GitHub returns 404", async () => {
    const result = await checkGithubUpdate("0.1.73", "darwin", "arm64", async () => new Response(null, { status: 404 }));
    expect(result.info).toMatchObject({ available: false, message: "GitHub 暂无正式发布版本" });
  });
});

describe("GitHub installer download", () => {
  let directory: string;
  const contents = "trial installer";
  const download = {
    name: release.assets[0].name,
    url: release.assets[0].browser_download_url,
    size: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };

  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "github-update-test-")); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it("returns a verified installer at a path with its original filename", async () => {
    const file = await downloadGithubUpdate(download, directory, async () => new Response(contents));
    expect(path.basename(file)).toBe(download.name);
    expect(await fs.readFile(file, "utf8")).toBe(contents);
  });

  it.each(["wrong installer", "too short", "trial installer with extra bytes"])(
    "removes a partial or invalid download",
    async (body) => {
      await expect(downloadGithubUpdate(download, directory, async () => new Response(body))).rejects.toThrow();
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );
});
