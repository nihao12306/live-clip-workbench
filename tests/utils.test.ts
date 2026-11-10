import { describe, expect, it } from "vitest";
import { toFileUrl } from "../src/shared/utils";

describe("local media URLs", () => {
  it("keeps the legacy URL when no preview revision is supplied", () => {
    expect(toFileUrl("D:\\工作目录\\preview file.mp4")).toBe(
      "local-media://D/%E5%B7%A5%E4%BD%9C%E7%9B%AE%E5%BD%95/preview%20file.mp4",
    );
  });

  it("adds an encoded revision so a replaced preview is fetched again", () => {
    expect(
      toFileUrl(
        "D:\\工作目录\\preview file.mp4",
        "2026-08-26T01:46:06.258Z",
      ),
    ).toBe(
      "local-media://D/%E5%B7%A5%E4%BD%9C%E7%9B%AE%E5%BD%95/preview%20file.mp4" +
      "?v=2026-08-26T01%3A46%3A06.258Z",
    );
  });
});
