#!/usr/bin/env node
/**
 * Minimal CLI: print a formatted metrics snapshot for the current machine.
 *
 *   apple-silicon-metrics                 one snapshot
 *   apple-silicon-metrics --watch         refresh every second until Ctrl-C
 *   apple-silicon-metrics --interval 500  set the sample window (ms)
 *   apple-silicon-metrics --json          machine-readable output (NDJSON in --watch)
 */
import { createRequire } from "node:module";

import {
  createSampler,
  isAppleSiliconMetricsError,
  isSupported,
  type Metrics,
} from "./index.js";

const require = createRequire(import.meta.url);

function version(): string {
  try {
    return (require("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

const HELP = `apple-silicon-metrics — sudo-less Apple Silicon hardware metrics

Usage:
  apple-silicon-metrics [options]

Options:
  -w, --watch            Refresh continuously until interrupted (Ctrl-C)
  -i, --interval <ms>    Sample window in milliseconds (default: 1000)
  -j, --json             Output JSON (newline-delimited when watching)
  -h, --help             Show this help
  -v, --version          Show the version
`;

interface Options {
  watch: boolean;
  json: boolean;
  intervalMs: number;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { watch: false, json: false, intervalMs: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-w":
      case "--watch":
        opts.watch = true;
        break;
      case "-j":
      case "--json":
        opts.json = true;
        break;
      case "-i":
      case "--interval": {
        const raw = argv[++i];
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`--interval expects a positive number, got "${raw ?? ""}"`);
        }
        opts.intervalMs = Math.floor(value);
        break;
      }
      default:
        throw new Error(`unknown option "${arg ?? ""}" (try --help)`);
    }
  }
  return opts;
}

function ratio(value: number | null): string {
  return value === null ? "  —  " : `${(value * 100).toFixed(1).padStart(4)}%`;
}

function num(value: number | null, unit: string, digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits)}${unit}`;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function fans(list: Metrics["fans"]): string {
  if (!list || list.length === 0) return "—";
  return list
    .map((f) => (f.maxRpm != null ? `${f.name} ${f.rpm}/${f.maxRpm} rpm` : `${f.name} ${f.rpm} rpm`))
    .join("   ");
}

function render(m: Metrics): string {
  const soc = m.soc;
  return [
    soc
      ? `${soc.chipName}  ·  ${soc.macModel}  ·  ${soc.memoryGb} GB  ·  ${soc.gpuCores} GPU cores  ·  ${soc.ecpuCores}E+${soc.pcpuCores}P`
      : "(SoC info unavailable)",
    `  CPU   usage ${ratio(m.cpu.usageRatio)}   power ${num(m.cpu.powerWatts, " W")}   temp ${num(m.cpu.tempCelsius, "°C")}`,
    `  GPU   usage ${ratio(m.gpu.usageRatio)}   power ${num(m.gpu.powerWatts, " W")}   temp ${num(m.gpu.tempCelsius, "°C")}   freq ${num(m.gpu.frequencyMhz, " MHz", 0)}`,
    `  RAM   ${gib(m.memory.ramUsedBytes)} / ${gib(m.memory.ramTotalBytes)}   swap ${gib(m.memory.swapUsedBytes)} / ${gib(m.memory.swapTotalBytes)}   power ${num(m.memory.ramPowerWatts ?? null, " W")}`,
    `  ANE   power ${num(m.ane?.powerWatts ?? null, " W")}`,
    `  FAN   ${fans(m.fans)}`,
    `  ${m.timestamp}`,
  ].join("\n");
}

function print(m: Metrics, opts: Options): void {
  if (opts.json) {
    console.log(JSON.stringify(m, null, opts.watch ? 0 : 2));
  } else {
    if (opts.watch) process.stdout.write("\x1b[2J\x1b[H"); // clear screen
    console.log(render(m));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(version());
    return;
  }

  const opts = parseArgs(argv);

  if (!isSupported()) {
    console.error(
      `apple-silicon-metrics requires macOS on Apple Silicon (this is ${process.platform}/${process.arch}).`,
    );
    process.exitCode = 1;
    return;
  }

  const sampler = createSampler({ intervalMs: opts.intervalMs });
  process.on("SIGINT", () => {
    sampler.close();
    process.exit(0);
  });

  try {
    await sampler.prime();
    do {
      print(await sampler.sampleNow(), opts);
    } while (opts.watch);
  } finally {
    sampler.close();
  }
}

main().catch((error: unknown) => {
  const message = isAppleSiliconMetricsError(error)
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
