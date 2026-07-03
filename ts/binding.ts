/**
 * Lazy, format-agnostic loader for the generated N-API binding.
 *
 * The native addon is required on first use (never at module-eval time) so that
 * platform/arch gating in `index.ts` can throw typed {@link AppleSiliconMetricsError}s instead
 * of a raw module-resolution failure. `createRequire` keeps this working from
 * both the ESM (`dist/index.mjs`) and CJS (`dist/index.cjs`) builds.
 */
import { createRequire } from "node:module";

import type {
  NativeMetrics,
  NativeSocInfo,
  Sampler as NativeSamplerClass,
} from "../native/index.cjs";

export type { NativeMetrics, NativeSocInfo };

/**
 * The subset of the generated native `Sampler` we consume, derived directly
 * from the generated declarations so a signature drift fails the build.
 */
export type NativeSamplerHandle = Pick<
  NativeSamplerClass,
  "socInfo" | "sample" | "close"
>;

/** Shape of the CommonJS module produced by `napi build`. */
export interface NativeBinding {
  isSupportedNative(): boolean;
  Sampler: new () => NativeSamplerHandle;
}

const require = createRequire(import.meta.url);
let cached: NativeBinding | undefined;

/** Load (and memoize) the native binding. Throws if the addon cannot be loaded. */
export function loadNative(): NativeBinding {
  if (cached === undefined) {
    cached = require("../native/index.cjs") as NativeBinding;
  }
  return cached;
}
