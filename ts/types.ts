/**
 * Public, unit-normalized types for `apple-silicon-metrics`.
 *
 * Units: ratios `0..1`, temperatures °C, power W, frequency MHz, memory bytes,
 * `timestamp` as an ISO-8601 string. A `null` value means the metric exists in
 * principle but the sensor was unavailable on this machine/OS.
 */

/** Static system-on-chip information, read once when a sampler initializes. */
export interface SocInfo {
  chipName: string;
  macModel: string;
  memoryGb: number;
  gpuCores: number;
  ecpuCores: number;
  pcpuCores: number;
}

export interface CpuMetrics {
  /** Combined E+P core utilization, weighted by core count. `0..1`. */
  usageRatio: number | null;
  /** Active residency ratio (not frequency-scaled), 0..1. */
  activeRatio: number | null;
  powerWatts: number | null;
  tempCelsius: number | null;
}

export interface GpuMetrics {
  usageRatio: number | null;
  /** Active residency ratio (not frequency-scaled), 0..1. */
  activeRatio: number | null;
  frequencyMhz: number | null;
  powerWatts: number | null;
  tempCelsius: number | null;
}

export interface MemoryMetrics {
  ramTotalBytes: number;
  ramUsedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  ramPowerWatts?: number | null;
  /** DRAM bandwidth in GB/s over the sample window; null when unavailable on this SoC. */
  readBandwidthGbps?: number | null;
  /** DRAM bandwidth in GB/s over the sample window; null when unavailable on this SoC. */
  writeBandwidthGbps?: number | null;
}

export interface AneMetrics {
  powerWatts: number | null;
}

/**
 * Coarse OS-level thermal-*pressure* signal, read from
 * `NSProcessInfo.thermalState`. This is the system-wide throttling hint macOS
 * exposes to apps — *not* an IOReport hardware temperature/counter. It only ever
 * takes four discrete levels.
 */
export interface ThermalMetrics {
  /** Raw level: 0 nominal, 1 fair, 2 serious, 3 critical. */
  level: number;
  /** Human-readable name for {@link ThermalMetrics.level}. */
  state: "nominal" | "fair" | "serious" | "critical";
  /** `true` when the OS has begun throttling to shed heat (level `>= 1`). */
  throttling: boolean;
}

export interface FanMetrics {
  /** Stable fan identifier derived from SMC fan order, e.g. `"fan0"`. */
  name: string;
  /** Current fan speed in revolutions per minute. */
  rpm: number;
  /** Maximum fan speed in RPM, or `null` when SMC does not report one. */
  maxRpm?: number | null;
}

/** A single point-in-time sample of Apple Silicon hardware metrics. */
export interface Metrics {
  timestamp: string;
  soc?: SocInfo;
  cpu: CpuMetrics;
  gpu: GpuMetrics;
  memory: MemoryMetrics;
  ane?: AneMetrics;
  /** Per-fan speeds. Empty on fanless Macs (e.g. MacBook Air). */
  fans?: FanMetrics[];
  /** Coarse OS thermal-pressure / throttling state. */
  thermal?: ThermalMetrics;
}

export interface SampleOptions {
  /** Sample window in milliseconds. Longer windows smooth delta-based metrics. */
  intervalMs?: number;
}

export interface SamplerOptions {
  /** Default sample window used by {@link Sampler.sampleNow}. Defaults to 1000. */
  intervalMs?: number;
}

/** A long-lived, stateful sampler. Prefer this over {@link sampleOnce} for repeated reads. */
export interface Sampler {
  /** Static SoC info for the host, captured at initialization. */
  readonly soc: SocInfo;
  /** Warm the IOReport baseline so the next sample uses a fresh delta window. */
  prime(): Promise<void>;
  /** Sample using the sampler's configured default interval. */
  sampleNow(): Promise<Metrics>;
  /** Sample with an explicit interval, overriding the configured default. */
  sample(options?: SampleOptions): Promise<Metrics>;
  /** Release the underlying worker thread. Idempotent; further sampling throws. */
  close(): void;
}
