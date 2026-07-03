/** Stable, machine-checkable error codes surfaced by `asmon`. */
export type AsmonErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "UNSUPPORTED_ARCH"
  | "SAMPLER_INIT_FAILED"
  | "SENSOR_UNAVAILABLE"
  | "SAMPLER_CLOSED";

/**
 * Error thrown by `asmon` for all expected failure modes. Inspect
 * {@link AsmonError.code} rather than matching on the message.
 */
export class AsmonError extends Error {
  readonly code: AsmonErrorCode;

  constructor(code: AsmonErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AsmonError";
    this.code = code;
    // Preserve prototype chain when compiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Narrowing helper for consumers who prefer a guard over `instanceof`. */
export function isAsmonError(value: unknown): value is AsmonError {
  return value instanceof AsmonError;
}
