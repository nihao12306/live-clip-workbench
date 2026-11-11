import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { UpdateInfo } from "../shared/types";
import { compareVersions, updatePlatformLabel, type SupportedUpdatePlatform } from "../shared/update";

const repository = "nihao12306/live-clip-workbench";
const latestReleaseUrl = `https://api.github.com/repos/${repository}/releases/latest`;

interface ReleaseAsset {
  id?: number;
  name?: string;
  state?: string;
  size?: number;
  digest?: string;
  browser_download_url?: string;
}

interface Release {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
  assets?: ReleaseAsset[];
}

export interface GithubUpdate {
  info: UpdateInfo;
  download?: { url: string; name: string; size: number; sha256: string };
}

export async function downloadGithubUpdate(
  download: NonNullable<GithubUpdate["download"]>,
  updatesDirectory: string,
  request: (url: string, init: RequestInit) => Promise<Response>,
): Promise<string> {
  const { url, name, size, sha256 } = download;
  await fs.mkdir(updatesDirectory, { recursive: true });
  const directory = await fs.mkdtemp(path.join(updatesDirectory, "github-"));
  const installerPath = path.join(directory, name);
  try {
    const response = await request(url, {
      credentials: "omit",
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok || !response.body) throw new Error(`下载 GitHub 安装包失败（HTTP ${response.status}）`);
    const hash = createHash("sha256");
    let received = 0;
    const verifySize = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > size) return done(new Error("GitHub 安装包大小超出预期"));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      verifySize,
      createWriteStream(installerPath, { flags: "wx" }),
    );
    if (received !== size || hash.digest("hex") !== sha256) {
      throw new Error("GitHub 安装包校验失败，请重新下载");
    }
    return installerPath;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function checkGithubUpdate(
  currentVersion: string,
  platform: SupportedUpdatePlatform,
  architecture: string,
  request: (url: string, init: RequestInit) => Promise<Response>,
): Promise<GithubUpdate> {
  const info: UpdateInfo = { currentVersion, platform, source: "github", available: false, message: "" };
  try {
    const response = await request(latestReleaseUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "live-clip-workbench" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) {
      return { info: { ...info, message: "GitHub 暂无正式发布版本" } };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const release: Release = await response.json();
    const tag = release.tag_name;
    if (release.draft !== false || release.prerelease !== false || !tag || !/^v?\d+\.\d+\.\d+$/.test(tag)) {
      throw new Error("正式版本信息无效");
    }
    const version = tag.replace(/^v/, "");
    if (compareVersions(version, currentVersion) <= 0) {
      return { info: { ...info, message: `当前 ${updatePlatformLabel(platform)} 版本已是最新版本（${currentVersion}）` } };
    }

    const platformName = platform === "darwin" ? "mac" : "win";
    const extension = platform === "darwin" ? "dmg" : "exe";
    const name = `live-clip-workbench-${version}-${platformName}-${architecture}.${extension}`;
    const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    const supportedArch = architecture === "x64" || architecture === "arm64";
    const asset = supportedArch && release.assets?.find((candidate) => candidate?.name === name);
    const sha256 = asset && typeof asset.digest === "string"
      ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1]?.toLowerCase()
      : undefined;
    if (!asset || !sha256 || asset.state !== "uploaded" || asset.browser_download_url !== url ||
      typeof asset.id !== "number" || !Number.isSafeInteger(asset.id) || asset.id <= 0 ||
      typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      return { info: { ...info, message: `GitHub 版本 ${version} 暂无适用于当前系统和架构的可验证安装包` } };
    }
    return {
      info: {
        ...info,
        available: true,
        version,
        githubAssetId: asset.id,
        notes: typeof release.body === "string" ? release.body.trim().slice(0, 600) : undefined,
        message: `GitHub 上有新版本 ${version}`,
      },
      download: { url, name, size: asset.size, sha256 },
    };
  } catch (error) {
    return {
      info: {
        ...info,
        message: `检查 GitHub 更新失败：${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}
