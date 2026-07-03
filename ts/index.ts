/**
 * `apple-silicon-metrics` — sudo-less Apple Silicon hardware metrics for Node & TypeScript.
 *
 * @example
 * ```ts
 * import { createSampler, isSupported } from "apple-silicon-metrics";
 *
 * if (isSupported()) {
 *   const sampler = createSampler({ intervalMs: 1000 });
 *   await sampler.prime();
 *   console.log(await sampler.sampleNow());
 *   sampler.close();
 * }
 * ```
 */
import {
  loadNative,
  type NativeBinding,
  type NativeMetrics,
  type NativeSamplerHandle,
  type NativeSocInfo,
} from "./binding.js";
import { AppleSiliconMetricsError } from "./errors.js";
import type {
  Metrics,
  SampleOptions,
  Sampler,
  SamplerOptions,
  SocInfo,
} from "./types.js";

export type {
  AneMetrics,
  CpuMetrics,
  FanMetrics,
  GpuMetrics,
  MemoryMetrics,
  Metrics,
  SampleOptions,
  Sampler,
  SamplerOptions,
  SocInfo,
} from "./types.js";
export { AppleSiliconMetricsError, isAppleSiliconMetricsError, type AppleSiliconMetricsErrorCode } from "./errors.js";

/** Default sample window (ms) used by {@link Sampler.sampleNow}. */
const DEFAULT_INTERVAL_MS = 1000;
/** Short window (ms) used by {@link Sampler.prime} to warm the delta baseline. */
const PRIME_INTERVAL_MS = 50;

/** Whether the current process can run `apple-silicon-metrics` (macOS on Apple Silicon). */
export function isSupported(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

function assertSupported(): void {
  if (process.platform !== "darwin") {
    throw new AppleSiliconMetricsError(
      "UNSUPPORTED_PLATFORM",
      `apple-silicon-metrics requires macOS; current platform is "${process.platform}".`,
    );
  }
  if (process.arch !== "arm64") {
    throw new AppleSiliconMetricsError(
      "UNSUPPORTED_ARCH",
      `apple-silicon-metrics requires Apple Silicon (arm64); current architecture is "${process.arch}".`,
    );
  }
}

function resolveInterval(intervalMs: number | undefined, fallback: number): number {
  if (intervalMs === undefined) return fallback;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(
      `intervalMs must be a positive, finite number; received ${String(intervalMs)}.`,
    );
  }
  return Math.floor(intervalMs);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Zero or negative sensor readings signal "unavailable" and become `null`. */
function positiveOrNull(value: number): number | null {
  return value > 0 ? value : null;
}

function mapSoc(native: NativeSocInfo): SocInfo {
  return {
    chipName: native.chipName,
    macModel: native.macModel,
    memoryGb: native.memoryGb,
    gpuCores: native.gpuCores,
    ecpuCores: native.ecpuCores,
    pcpuCores: native.pcpuCores,
  };
}

/** Reshape a flat native sample into the nested, null-normalized public shape. */
export function toMetrics(native: NativeMetrics, soc: SocInfo): Metrics {
  return {
    timestamp: new Date().toISOString(),
    soc,
    cpu: {
      usageRatio: native.cpuUsageRatio,
      activeRatio: null,
      powerWatts: native.cpuPowerWatts,
      tempCelsius: positiveOrNull(native.cpuTempCelsius),
    },
    gpu: {
      usageRatio: native.gpuUsageRatio,
      activeRatio: null,
      frequencyMhz: positiveOrNull(native.gpuFreqMhz),
      powerWatts: native.gpuPowerWatts,
      tempCelsius: positiveOrNull(native.gpuTempCelsius),
    },
    memory: {
      ramTotalBytes: native.ramTotalBytes,
      ramUsedBytes: native.ramUsedBytes,
      swapTotalBytes: native.swapTotalBytes,
      swapUsedBytes: native.swapUsedBytes,
      ramPowerWatts: positiveOrNull(native.ramPowerWatts),
    },
    ane: {
      powerWatts: positiveOrNull(native.anePowerWatts),
    },
  };
}

class SamplerImpl implements Sampler {
  readonly #soc: SocInfo;
  readonly #intervalMs: number;
  #handle: NativeSamplerHandle | null;

  constructor(handle: NativeSamplerHandle, soc: SocInfo, intervalMs: number) {
    this.#handle = handle;
    this.#soc = soc;
    this.#intervalMs = intervalMs;
  }

  get soc(): SocInfo {
    return this.#soc;
  }

  #open(): NativeSamplerHandle {
    if (this.#handle === null) {
      throw new AppleSiliconMetricsError("SAMPLER_CLOSED", "sampler has been closed.");
    }
    return this.#handle;
  }

  async #sampleFor(durationMs: number): Promise<Metrics> {
    const handle = this.#open();
    let native: NativeMetrics;
    try {
      native = await handle.sample(durationMs);
    } catch (error) {
      throw new AppleSiliconMetricsError(
        "SENSOR_UNAVAILABLE",
        `failed to read metrics: ${messageOf(error)}`,
        { cause: error },
      );
    }
    return toMetrics(native, this.#soc);
  }

  async prime(): Promise<void> {
    await this.#sampleFor(Math.min(this.#intervalMs, PRIME_INTERVAL_MS));
  }

  async sampleNow(): Promise<Metrics> {
    return this.#sampleFor(this.#intervalMs);
  }

  async sample(options?: SampleOptions): Promise<Metrics> {
    return this.#sampleFor(resolveInterval(options?.intervalMs, this.#intervalMs));
  }

  close(): void {
    if (this.#handle !== null) {
      this.#handle.close();
      this.#handle = null;
    }
  }
}

function initSampler(binding: NativeBinding): NativeSamplerHandle {
  try {
    return new binding.Sampler();
  } catch (error) {
    throw new AppleSiliconMetricsError(
      "SAMPLER_INIT_FAILED",
      `failed to initialize Apple Silicon sensors: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

/** Create a long-lived, stateful sampler. Prefer this for repeated reads. */
export function createSampler(options?: SamplerOptions): Sampler {
  assertSupported();
  const intervalMs = resolveInterval(options?.intervalMs, DEFAULT_INTERVAL_MS);
  const binding = loadNative();
  const handle = initSampler(binding);
  const soc = mapSoc(handle.socInfo());
  return new SamplerImpl(handle, soc, intervalMs);
}

/** Take a single sample, then tear the sampler down. */
export async function sampleOnce(options?: SampleOptions): Promise<Metrics> {
  const sampler = createSampler(
    options?.intervalMs === undefined ? undefined : { intervalMs: options.intervalMs },
  );
  try {
    return await sampler.sampleNow();
  } finally {
    sampler.close();
  }
}
