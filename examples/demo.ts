/**
 * Live demo: prints a formatted metrics snapshot for the current machine.
 *
 *   pnpm demo            # one snapshot
 *   pnpm demo --watch    # refresh every second until Ctrl-C
 *
 * Run directly with modern Node (type-stripping); imports `apple-silicon-metrics` by name via
 * package self-reference, so it exercises the real published entry points.
 */
import { createSampler, isSupported, type Metrics } from "apple-silicon-metrics";

function ratio(value: number | null): string {
  return value === null ? "  —  " : `${(value * 100).toFixed(1).padStart(4)}%`;
}

function num(value: number | null, unit: string, digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits)}${unit}`;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function render(m: Metrics): string {
  const soc = m.soc;
  const lines = [
    soc
      ? `${soc.chipName}  ·  ${soc.macModel}  ·  ${soc.memoryGb} GB  ·  ${soc.gpuCores} GPU cores  ·  ${soc.ecpuCores}E+${soc.pcpuCores}P`
      : "(SoC info unavailable)",
    `  CPU   usage ${ratio(m.cpu.usageRatio)}   power ${num(m.cpu.powerWatts, " W")}   temp ${num(m.cpu.tempCelsius, "°C")}`,
    `  GPU   usage ${ratio(m.gpu.usageRatio)}   power ${num(m.gpu.powerWatts, " W")}   temp ${num(m.gpu.tempCelsius, "°C")}   freq ${num(m.gpu.frequencyMhz, " MHz", 0)}`,
    `  RAM   ${gib(m.memory.ramUsedBytes)} / ${gib(m.memory.ramTotalBytes)}   swap ${gib(m.memory.swapUsedBytes)} / ${gib(m.memory.swapTotalBytes)}   power ${num(m.memory.ramPowerWatts ?? null, " W")}`,
    `  ANE   power ${num(m.ane?.powerWatts ?? null, " W")}`,
    `  ${m.timestamp}`,
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!isSupported()) {
    console.error(
      `apple-silicon-metrics requires macOS on Apple Silicon (this is ${process.platform}/${process.arch}).`,
    );
    process.exitCode = 1;
    return;
  }

  const watch = process.argv.includes("--watch");
  const sampler = createSampler({ intervalMs: 1000 });
  const stop = (): void => {
    sampler.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);

  try {
    await sampler.prime();
    do {
      const metrics = await sampler.sampleNow();
      if (watch) process.stdout.write("[2J[H"); // clear screen
      console.log(render(metrics));
    } while (watch);
  } finally {
    sampler.close();
  }
}

void main();
