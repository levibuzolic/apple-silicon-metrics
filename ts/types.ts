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
  /** Reserved: macmon does not distinguish an active-vs-usage ratio. Always `null`. */
  activeRatio: number | null;
  powerWatts: number | null;
  tempCelsius: number | null;
}

export interface GpuMetrics {
  usageRatio: number | null;
  /** Reserved: macmon does not distinguish an active-vs-usage ratio. Always `null`. */
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
}

export interface AneMetrics {
  powerWatts: number | null;
}

export interface FanMetrics {
  name: string;
  rpm: number;
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
  /** Reserved for a future release; macmon 0.7.0 exposes no fan RPM data. */
  fans?: FanMetrics[];
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
