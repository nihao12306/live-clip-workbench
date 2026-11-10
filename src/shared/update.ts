export type SupportedUpdatePlatform = "win32" | "darwin";

export interface UpdateChunk {
  fileName: string;
  size: number;
  sha256: string;
}

export type UpdateRelease = string | {
  installerPath?: string;
  size?: number;
  sha256?: string;
  chunks?: UpdateChunk[];
  universal?: string | { installerPath?: string };
  x64?: string | { installerPath?: string };
  arm64?: string | { installerPath?: string };
};

export interface UpdateManifest {
  version?: string;
  notes?: string;
  publishedAt?: string;
  // Kept for backward compatibility with the original Windows-only manifest.
  installerPath?: string;
  platforms?: {
    win32?: UpdateRelease;
    windows?: UpdateRelease;
    darwin?: UpdateRelease;
    mac?: UpdateRelease;
  };
}

function releasePath(value: UpdateRelease | undefined, architecture: string): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value.installerPath) return value.installerPath;
  const preferred = architecture === "arm64" ? value.arm64 : value.x64;
  if (typeof preferred === "string") return preferred;
  if (preferred?.installerPath) return preferred.installerPath;
  if (value.universal) {
    return typeof value.universal === "string"
      ? value.universal
      : value.universal.installerPath;
  }
  return undefined;
}

export function selectUpdateInstaller(
  manifest: UpdateManifest,
  platform: SupportedUpdatePlatform,
  architecture: string,
): string | undefined {
  const release = selectUpdateRelease(manifest, platform);
  return releasePath(release, architecture) ?? manifest.installerPath;
}

export function selectUpdateRelease(
  manifest: UpdateManifest,
  platform: SupportedUpdatePlatform,
): UpdateRelease | undefined {
  const releases = manifest.platforms;
  return platform === "win32"
    ? releases?.win32 ?? releases?.windows
    : releases?.darwin ?? releases?.mac;
}

export function updatePlatformLabel(platform: SupportedUpdatePlatform): string {
  return platform === "win32" ? "Windows" : "macOS";
}
