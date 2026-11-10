import type { SupportedUpdatePlatform, UpdateManifest } from "./update";

export interface ReleaseArtifact {
  fileName: string;
  version: string;
  platform: SupportedUpdatePlatform;
  architecture: "x64" | "arm64" | "ia32" | "universal";
  extension: "exe" | "dmg" | "zip";
}

export interface UpdatePublishPlan {
  version: string;
  artifacts: ReleaseArtifact[];
  manifest: UpdateManifest;
  warnings: string[];
}

const WINDOWS_ARTIFACT = /^live-clip-workbench-(\d+\.\d+\.\d+)-win-(x64|arm64|ia32)\.exe$/i;
const MAC_ARTIFACT = /^live-clip-workbench-(\d+\.\d+\.\d+)-mac-(universal|x64|arm64)\.(dmg|zip)$/i;

export function compareUpdateVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part) || 0);
  const b = right.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) - (b[index] ?? 0);
    }
  }
  return 0;
}

export function parseReleaseArtifact(fileName: string): ReleaseArtifact | undefined {
  const windows = fileName.match(WINDOWS_ARTIFACT);
  if (windows) {
    return {
      fileName,
      version: windows[1],
      platform: "win32",
      architecture: windows[2].toLowerCase() as ReleaseArtifact["architecture"],
      extension: "exe",
    };
  }
  const mac = fileName.match(MAC_ARTIFACT);
  if (mac) {
    return {
      fileName,
      version: mac[1],
      platform: "darwin",
      architecture: mac[2].toLowerCase() as ReleaseArtifact["architecture"],
      extension: mac[3].toLowerCase() as ReleaseArtifact["extension"],
    };
  }
  return undefined;
}

function architectureRank(artifact: ReleaseArtifact): number {
  if (artifact.platform === "win32") {
    return artifact.architecture === "x64" ? 0 : artifact.architecture === "arm64" ? 1 : 2;
  }
  if (artifact.architecture === "universal") return artifact.extension === "dmg" ? 0 : 1;
  if (artifact.extension === "dmg") return artifact.architecture === "x64" ? 2 : 3;
  return artifact.architecture === "x64" ? 4 : 5;
}

export function selectReleaseArtifacts(fileNames: string[]): UpdatePublishPlan {
  const candidates = fileNames
    .map(parseReleaseArtifact)
    .filter((item): item is ReleaseArtifact => Boolean(item));
  if (!candidates.length) {
    throw new Error("发布目录中没有找到工作台安装包（需要 live-clip-workbench-版本号-win-x64.exe 或 mac-universal.dmg）");
  }
  const versions = [...new Set(candidates.map((item) => item.version))];
  const version = versions.sort((left, right) => compareUpdateVersions(right, left))[0];
  const sameVersion = candidates.filter((item) => item.version === version);
  const selected: ReleaseArtifact[] = [];
  const windows = sameVersion
    .filter((item) => item.platform === "win32")
    .sort((left, right) => architectureRank(left) - architectureRank(right));
  const mac = sameVersion
    .filter((item) => item.platform === "darwin")
    .sort((left, right) => architectureRank(left) - architectureRank(right));
  if (windows[0]) selected.push(windows[0]);
  if (mac[0]) selected.push(mac[0]);

  const warnings: string[] = [];
  if (!windows[0]) warnings.push("没有找到 Windows 安装包；Windows 同事暂时不会收到这个版本");
  if (!mac[0]) warnings.push("没有找到 macOS 安装包；Mac 同事暂时不会收到这个版本");
  if (versions.some((item) => item !== version)) {
    warnings.push("发布目录中还有旧版本安装包，已自动忽略，只发布版本 " + version);
  }

  return {
    version,
    artifacts: selected,
    manifest: buildUpdateManifest(version, "", selected),
    warnings,
  };
}

export function buildUpdateManifest(
  version: string,
  notes: string,
  artifacts: ReleaseArtifact[],
): UpdateManifest {
  const windows = artifacts.find((item) => item.platform === "win32");
  const mac = artifacts.find((item) => item.platform === "darwin");
  const darwin = mac
    ? mac.architecture === "universal"
      ? { universal: mac.fileName }
      : mac.architecture === "arm64"
        ? { arm64: mac.fileName }
        : { x64: mac.fileName }
    : undefined;
  return {
    version,
    notes: notes.trim() || "工作台版本更新",
    platforms: {
      ...(windows ? { win32: windows.fileName } : {}),
      ...(darwin ? { darwin } : {}),
    },
  };
}
