/**
 * Hardware integration test. Exercises the real native binding and only runs on
 * Apple Silicon; it is skipped elsewhere. Assertions stay loose on purpose — no
 * dependence on load level or exact utilization values.
 *
 * Requires `pnpm run build:native` to have produced `native/index.cjs`.
 */
import { describe, expect, it } from "vitest";

import { createSampler, isSupported, sampleOnce } from "./index.js";

const onHardware = isSupported() ? describe : describe.skip;

onHardware("integration (darwin-arm64)", () => {
  it("reports isSupported() === true", () => {
    expect(isSupported()).toBe(true);
  });

  it("initializes a sampler with sane static SoC info", () => {
    const sampler = createSampler({ intervalMs: 200 });
    try {
      expect(sampler.soc.chipName.length).toBeGreaterThan(0);
      expect(sampler.soc.memoryGb).toBeGreaterThan(0);
      expect(sampler.soc.gpuCores).toBeGreaterThan(0);
      expect(sampler.soc.ecpuCores + sampler.soc.pcpuCores).toBeGreaterThan(0);
    } finally {
      sampler.close();
    }
  });

  it("produces a well-formed sample", async () => {
    const sampler = createSampler({ intervalMs: 200 });
    try {
      await sampler.prime();
      const m = await sampler.sampleNow();

      // Memory totals are always present and positive.
      expect(m.memory.ramTotalBytes).toBeGreaterThan(0);
      expect(m.memory.ramUsedBytes).toBeGreaterThan(0);
      expect(m.memory.ramUsedBytes).toBeLessThanOrEqual(m.memory.ramTotalBytes);

      // Temperatures are positive when present, otherwise null.
      for (const temp of [m.cpu.tempCelsius, m.gpu.tempCelsius]) {
        if (temp !== null) expect(temp).toBeGreaterThan(0);
      }

      // Usage ratios, when present, are within 0..1.
      for (const ratio of [m.cpu.usageRatio, m.gpu.usageRatio]) {
        if (ratio !== null) {
          expect(ratio).toBeGreaterThanOrEqual(0);
          expect(ratio).toBeLessThanOrEqual(1);
        }
      }

      expect(Number.isNaN(Date.parse(m.timestamp))).toBe(false);
    } finally {
      sampler.close();
    }
  });

  it("sampleOnce resolves to a single sample", async () => {
    const m = await sampleOnce({ intervalMs: 200 });
    expect(m.memory.ramTotalBytes).toBeGreaterThan(0);
  });
});
