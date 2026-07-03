import { describe, expect, it } from "vitest";

import { formatBytes, renderComment, summarize } from "./pkg-size.js";

// A trimmed-down shape of `npm pack --dry-run --json` output: a single-element
// array describing the tarball, its packed size, and every included file.
function packReport(
  files: Array<{ path: string; size: number }>,
  packedSize: number,
) {
  const unpackedSize = files.reduce((sum, f) => sum + f.size, 0);
  return [{ size: packedSize, unpackedSize, files }];
}

const BASE = packReport(
  [
    { path: "native/apple-silicon-metrics.darwin-arm64.node", size: 1_200_000 },
    { path: "native/index.cjs", size: 500 },
    { path: "dist/index.mjs", size: 40_000 },
    { path: "README.md", size: 5_000 },
  ],
  512_000,
);

describe("summarize", () => {
  it("splits native (.node) from everything else and keeps the packed total", () => {
    expect(summarize(BASE)).toEqual({
      native: 1_200_000,
      js: 45_500,
      tarballGzip: 512_000,
    });
  });

  it("treats a missing report (null) as all zeros", () => {
    expect(summarize(null)).toEqual({ native: 0, js: 0, tarballGzip: 0 });
  });

  it("treats an empty array as all zeros", () => {
    expect(summarize([])).toEqual({ native: 0, js: 0, tarballGzip: 0 });
  });
});

describe("formatBytes", () => {
  it("formats bytes, KB and MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1_258_291)).toBe("1.20 MB");
  });
});

describe("renderComment", () => {
  it("includes the hidden marker so the comment can be updated in place", () => {
    const md = renderComment(summarize(BASE), summarize(BASE));
    expect(md).toContain("<!-- pkg-size-report -->");
  });

  it("shows an increase with a ▲ and a signed delta", () => {
    const head = packReport(
      [
        {
          path: "native/apple-silicon-metrics.darwin-arm64.node",
          size: 1_218_400,
        },
        { path: "native/index.cjs", size: 500 },
        { path: "dist/index.mjs", size: 40_000 },
        { path: "README.md", size: 5_000 },
      ],
      515_000,
    );
    const md = renderComment(summarize(BASE), summarize(head));
    expect(md).toContain("▲");
    expect(md).toContain("+18.0 KB");
    expect(md).toContain("Native binary");
  });

  it("shows a decrease with a ▼", () => {
    const head = packReport(
      [{ path: "dist/index.mjs", size: 10_000 }],
      400_000,
    );
    const md = renderComment(summarize(BASE), summarize(head));
    expect(md).toContain("▼");
  });

  it("marks a brand-new package (no baseline) rather than dividing by zero", () => {
    const md = renderComment(
      { native: 0, js: 0, tarballGzip: 0 },
      summarize(BASE),
    );
    expect(md).toContain("new");
    expect(md).not.toContain("Infinity");
    expect(md).not.toContain("NaN");
  });
});
