import { describe, expect, it } from "vitest";
import {
  buildUpdateManifest,
  parseReleaseArtifact,
  selectReleaseArtifacts,
} from "../src/shared/update-publish";

describe("update publish assistant", () => {
  it("recognizes supported Windows and Mac installers", () => {
    expect(parseReleaseArtifact("live-clip-workbench-0.1.37-win-x64.exe")).toMatchObject({
      version: "0.1.37",
      platform: "win32",
      architecture: "x64",
    });
    expect(parseReleaseArtifact("live-clip-workbench-0.1.37-mac-universal.dmg")).toMatchObject({
      version: "0.1.37",
      platform: "darwin",
      architecture: "universal",
      extension: "dmg",
    });
    expect(parseReleaseArtifact("live-clip-workbench-0.1.37-win-x64.exe.blockmap")).toBeUndefined();
  });

  it("chooses the newest version and ignores old release artifacts", () => {
    const plan = selectReleaseArtifacts([
      "live-clip-workbench-0.1.36-win-x64.exe",
      "live-clip-workbench-0.1.37-win-x64.exe",
      "live-clip-workbench-0.1.37-mac-universal.dmg",
      "live-clip-workbench-0.1.37-mac-universal.zip",
    ]);
    expect(plan.version).toBe("0.1.37");
    expect(plan.artifacts.map((item) => item.fileName)).toEqual([
      "live-clip-workbench-0.1.37-win-x64.exe",
      "live-clip-workbench-0.1.37-mac-universal.dmg",
    ]);
    expect(plan.warnings).toContain("发布目录中还有旧版本安装包，已自动忽略，只发布版本 0.1.37");
  });

  it("builds a platform-aware manifest from the selected packages", () => {
    const plan = selectReleaseArtifacts([
      "live-clip-workbench-0.1.37-win-x64.exe",
      "live-clip-workbench-0.1.37-mac-universal.dmg",
    ]);
    expect(buildUpdateManifest(plan.version, "新增一键发布", plan.artifacts)).toEqual({
      version: "0.1.37",
      notes: "新增一键发布",
      platforms: {
        win32: "live-clip-workbench-0.1.37-win-x64.exe",
        darwin: { universal: "live-clip-workbench-0.1.37-mac-universal.dmg" },
      },
    });
  });

  it("keeps an Apple Silicon release under the arm64 key", () => {
    expect(buildUpdateManifest("0.1.42", "修复 macOS 窗口拖动", [
      {
        fileName: "live-clip-workbench-0.1.42-mac-arm64.dmg",
        version: "0.1.42",
        platform: "darwin",
        architecture: "arm64",
        extension: "dmg",
      },
    ])).toEqual({
      version: "0.1.42",
      notes: "修复 macOS 窗口拖动",
      platforms: {
        darwin: { arm64: "live-clip-workbench-0.1.42-mac-arm64.dmg" },
      },
    });
  });
});
