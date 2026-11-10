import { describe, expect, it } from "vitest";
import { selectUpdateInstaller, selectUpdateRelease } from "../src/shared/update";

describe("cross-platform update manifest", () => {
  it("selects the Windows installer from a shared manifest", () => {
    expect(
      selectUpdateInstaller(
        {
          version: "0.1.36",
          platforms: {
            win32: { installerPath: "live-clip-workbench-0.1.36-win-x64.exe" },
            darwin: { universal: "live-clip-workbench-0.1.36-mac-universal.dmg" },
          },
        },
        "win32",
        "x64",
      ),
    ).toBe("live-clip-workbench-0.1.36-win-x64.exe");
  });

  it("selects the universal Mac package for both Mac architectures", () => {
    const manifest = {
      version: "0.1.36",
      platforms: {
        darwin: { universal: "live-clip-workbench-0.1.36-mac-universal.dmg" },
      },
    };
    expect(selectUpdateInstaller(manifest, "darwin", "x64")).toContain("universal");
    expect(selectUpdateInstaller(manifest, "darwin", "arm64")).toContain("universal");
  });

  it("keeps reading the original Windows-only manifest format", () => {
    expect(
      selectUpdateInstaller(
        { version: "0.1.36", installerPath: "legacy-update.exe" },
        "win32",
        "x64",
      ),
    ).toBe("legacy-update.exe");
  });

  it("selects a chunked Windows release and keeps its installer name", () => {
    const manifest = {
      version: "0.1.46",
      platforms: {
        win32: {
          installerPath: "live-clip-workbench-0.1.46-win-x64.exe",
          size: 123,
          sha256: "installer-hash",
          chunks: [
            { fileName: "installer.part-001-of-002", size: 100, sha256: "part-1" },
            { fileName: "installer.part-002-of-002", size: 23, sha256: "part-2" },
          ],
        },
      },
    };
    expect(selectUpdateInstaller(manifest, "win32", "x64")).toBe(
      "live-clip-workbench-0.1.46-win-x64.exe",
    );
    expect(selectUpdateRelease(manifest, "win32")).toMatchObject({
      installerPath: "live-clip-workbench-0.1.46-win-x64.exe",
      chunks: expect.any(Array),
    });
  });
});
