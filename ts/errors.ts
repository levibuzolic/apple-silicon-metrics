/** Stable, machine-checkable error codes surfaced by `apple-silicon-metrics`. */
export type AppleSiliconMetricsErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "UNSUPPORTED_ARCH"
  | "SAMPLER_INIT_FAILED"
  | "SENSOR_UNAVAILABLE"
  | "SAMPLER_CLOSED";

/**
 * Error thrown by `apple-silicon-metrics` for all expected failure modes. Inspect
 * {@link AppleSiliconMetricsError.code} rather than matching on the message.
 */
export class AppleSiliconMetricsError extends Error {
  readonly code: AppleSiliconMetricsErrorCode;

  constructor(code: AppleSiliconMetricsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppleSiliconMetricsError";
    this.code = code;
    // Preserve prototype chain when compiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Narrowing helper for consumers who prefer a guard over `instanceof`. */
export function isAppleSiliconMetricsError(value: unknown): value is AppleSiliconMetricsError {
  return value instanceof AppleSiliconMetricsError;
}
