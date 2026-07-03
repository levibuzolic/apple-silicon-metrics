/**
 * Measures how a pull request changes the published npm package size, split into
 * the compiled native binary (Rust `.node`) and the JavaScript output.
 *
 * Pure functions ({@link summarize}, {@link formatBytes}, {@link renderComment})
 * are unit-tested. When run directly as a script it reads two
 * `npm pack --dry-run --json` outputs (base, head) and prints a Markdown comment:
 *
 *     node ts/pkg-size.ts base.json head.json > comment.md
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One entry from `npm pack --dry-run --json`. */
interface NpmPackEntry {
  /** Packed (gzipped) tarball size in bytes. */
  size: number;
  /** Sum of unpacked file sizes in bytes. */
  unpackedSize: number;
  files: Array<{ path: string; size: number }>;
}

/** Per-component byte sizes for one build of the package. */
export interface Summary {
  /** Unpacked size of the native `.node` binary. */
  native: number;
  /** Unpacked size of everything that isn't the native binary. */
  js: number;
  /** Packed (gzipped) tarball size — what users download. */
  tarballGzip: number;
}

const MARKER = "<!-- pkg-size-report -->";

function isNativeBinary(path: string): boolean {
  return path.endsWith(".node");
}

/**
 * Reduce parsed `npm pack --dry-run --json` output to per-component byte totals.
 * A missing report (null / empty array) is treated as all zeros so a failed or
 * absent baseline still produces a comment.
 */
export function summarize(report: unknown): Summary {
  const entry = Array.isArray(report)
    ? (report[0] as NpmPackEntry | undefined)
    : undefined;
  if (!entry) {
    return { native: 0, js: 0, tarballGzip: 0 };
  }

  let native = 0;
  let js = 0;
  for (const file of entry.files) {
    if (isNativeBinary(file.path)) {
      native += file.size;
    } else {
      js += file.size;
    }
  }

  return { native, js, tarballGzip: entry.size };
}

/** Human-readable byte size using binary units (0 B, 512 B, 1.0 KB, 1.20 MB). */
export function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs < 1024) {
    return `${bytes} B`;
  }
  if (abs < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Signed byte delta with an arrow, e.g. "+18.0 KB (+1.5%) ▲". */
function formatDelta(base: number, head: number): string {
  const delta = head - base;
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "▬";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const magnitude = formatBytes(Math.abs(delta));

  let percent: string;
  if (base === 0) {
    percent = head === 0 ? "0%" : "new";
  } else {
    const pct = (delta / base) * 100;
    const pctSign = pct > 0 ? "+" : pct < 0 ? "−" : "";
    percent = `${pctSign}${Math.abs(pct).toFixed(1)}%`;
  }

  return `${sign}${magnitude} (${percent}) ${arrow}`;
}

function row(label: string, base: number, head: number, bold = false): string {
  const cells = [
    label,
    formatBytes(base),
    formatBytes(head),
    formatDelta(base, head),
  ];
  return `| ${(bold ? cells.map((c) => `**${c}**`) : cells).join(" | ")} |`;
}

/** Render the sticky PR comment comparing a base build to the head build. */
export function renderComment(base: Summary, head: Summary): string {
  return [
    MARKER,
    "## 📦 Package size change",
    "",
    "| Component | Base | This PR | Δ |",
    "|---|---|---|---|",
    row("Native binary", base.native, head.native),
    row("JavaScript", base.js, head.js),
    row("Tarball (gzip)", base.tarballGzip, head.tarballGzip, true),
    "",
    "<sub>Compared against the base branch. JavaScript and Native are unpacked" +
      " on-disk sizes (JS = everything that isn't the `.node` binary); Tarball is" +
      " the gzipped download.</sub>",
    "",
  ].join("\n");
}

function readReport(path: string | undefined): unknown {
  if (!path) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A missing or unreadable base report is expected (e.g. base build failed
    // or a brand-new package) — fall back to an empty baseline.
    return null;
  }
}

function main(argv: string[]): void {
  const [basePath, headPath] = argv;
  const base = summarize(readReport(basePath));
  const head = summarize(readReport(headPath));
  process.stdout.write(renderComment(base, head));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
