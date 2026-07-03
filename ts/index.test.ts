import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  NativeBinding,
  NativeMetrics,
  NativeSamplerHandle,
  NativeSocInfo,
} from "./binding.js";

vi.mock("./binding.js", () => ({ loadNative: vi.fn() }));

import { loadNative } from "./binding.js";
import {
  AsmonError,
  createSampler,
  isAsmonError,
  isSupported,
  sampleOnce,
  toMetrics,
} from "./index.js";

const mockedLoad = vi.mocked(loadNative);

const SOC: NativeSocInfo = {
  chipName: "Apple M4 Pro",
  macModel: "Mac16,8",
  memoryGb: 48,
  gpuCores: 20,
  ecpuCores: 4,
  pcpuCores: 10,
};

function nativeMetrics(overrides: Partial<NativeMetrics> = {}): NativeMetrics {
  return {
    cpuUsageRatio: 0.25,
    cpuPowerWatts: 3,
    cpuTempCelsius: 55,
    gpuUsageRatio: 0.4,
    gpuFreqMhz: 1200,
    gpuPowerWatts: 5,
    gpuTempCelsius: 0,
    ramTotalBytes: 51_539_607_552,
    ramUsedBytes: 20_000_000_000,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    ramPowerWatts: 0,
    anePowerWatts: 0,
    ...overrides,
  };
}

interface FakeControls {
  sample?: NativeSamplerHandle["sample"];
  construct?: () => void;
}

function fakeBinding(controls: FakeControls = {}): {
  binding: NativeBinding;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const sample = controls.sample ?? vi.fn(async () => nativeMetrics());

  class FakeSampler implements NativeSamplerHandle {
    constructor() {
      controls.construct?.();
    }
    socInfo(): NativeSocInfo {
      return SOC;
    }
    sample(durationMs: number): Promise<NativeMetrics> {
      return sample(durationMs);
    }
    close(): void {
      close();
    }
  }

  return {
    close,
    binding: { isSupportedNative: () => true, Sampler: FakeSampler },
  };
}

function withHostOverride(
  platform: NodeJS.Platform,
  arch: string,
  fn: () => void,
): void {
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const origArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", origPlatform);
    Object.defineProperty(process, "arch", origArch);
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("toMetrics", () => {
  it("reshapes flat native data into the nested public shape", () => {
    const m = toMetrics(nativeMetrics(), {
      chipName: SOC.chipName,
      macModel: SOC.macModel,
      memoryGb: SOC.memoryGb,
      gpuCores: SOC.gpuCores,
      ecpuCores: SOC.ecpuCores,
      pcpuCores: SOC.pcpuCores,
    });

    expect(m.cpu.usageRatio).toBe(0.25);
    expect(m.cpu.powerWatts).toBe(3);
    expect(m.cpu.tempCelsius).toBe(55);
    expect(m.gpu.frequencyMhz).toBe(1200);
    expect(m.memory.ramTotalBytes).toBe(51_539_607_552);
    expect(m.soc?.chipName).toBe("Apple M4 Pro");
    expect(typeof m.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(m.timestamp))).toBe(false);
  });

  it("normalizes unavailable sensors (<= 0) to null", () => {
    const m = toMetrics(
      nativeMetrics({ gpuTempCelsius: 0, gpuFreqMhz: 0, anePowerWatts: 0, ramPowerWatts: 0 }),
      {
        chipName: "x",
        macModel: "y",
        memoryGb: 8,
        gpuCores: 8,
        ecpuCores: 4,
        pcpuCores: 4,
      },
    );

    expect(m.gpu.tempCelsius).toBeNull();
    expect(m.gpu.frequencyMhz).toBeNull();
    expect(m.ane?.powerWatts).toBeNull();
    expect(m.memory.ramPowerWatts).toBeNull();
  });

  it("marks activeRatio as null (not distinguished by macmon)", () => {
    const m = toMetrics(nativeMetrics(), SOC);
    expect(m.cpu.activeRatio).toBeNull();
    expect(m.gpu.activeRatio).toBeNull();
  });
});

describe("isSupported", () => {
  it("is true on darwin/arm64", () => {
    withHostOverride("darwin", "arm64", () => {
      expect(isSupported()).toBe(true);
    });
  });

  it("is false off darwin or off arm64", () => {
    withHostOverride("linux", "x64", () => expect(isSupported()).toBe(false));
    withHostOverride("darwin", "x64", () => expect(isSupported()).toBe(false));
  });
});

describe("createSampler platform gating", () => {
  it("throws UNSUPPORTED_PLATFORM off macOS", () => {
    withHostOverride("linux", "arm64", () => {
      expect(() => createSampler()).toThrowError(
        expect.objectContaining({ code: "UNSUPPORTED_PLATFORM" }),
      );
    });
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("throws UNSUPPORTED_ARCH on Intel macOS", () => {
    withHostOverride("darwin", "x64", () => {
      try {
        createSampler();
        expect.unreachable();
      } catch (error) {
        expect(isAsmonError(error)).toBe(true);
        expect((error as AsmonError).code).toBe("UNSUPPORTED_ARCH");
      }
    });
  });
});

describe("createSampler / sampler lifecycle", () => {
  it("exposes soc and samples using the configured interval", async () => {
    const sampleFn = vi.fn(async () => nativeMetrics());
    const { binding } = fakeBinding({ sample: sampleFn });
    mockedLoad.mockReturnValue(binding);

    const sampler = createSampler({ intervalMs: 750 });
    expect(sampler.soc.chipName).toBe("Apple M4 Pro");

    const metrics = await sampler.sampleNow();
    expect(sampleFn).toHaveBeenCalledWith(750);
    expect(metrics.cpu.usageRatio).toBe(0.25);
    sampler.close();
  });

  it("prime uses a short window and sample() overrides the interval", async () => {
    const sampleFn = vi.fn(async () => nativeMetrics());
    const { binding } = fakeBinding({ sample: sampleFn });
    mockedLoad.mockReturnValue(binding);

    const sampler = createSampler({ intervalMs: 1000 });
    await sampler.prime();
    expect(sampleFn).toHaveBeenLastCalledWith(50);

    await sampler.sample({ intervalMs: 250 });
    expect(sampleFn).toHaveBeenLastCalledWith(250);
    sampler.close();
  });

  it("throws SAMPLER_CLOSED after close()", async () => {
    const { binding, close } = fakeBinding();
    mockedLoad.mockReturnValue(binding);

    const sampler = createSampler();
    sampler.close();
    sampler.close(); // idempotent
    expect(close).toHaveBeenCalledTimes(1);
    await expect(sampler.sampleNow()).rejects.toMatchObject({ code: "SAMPLER_CLOSED" });
  });

  it("wraps sensor-init failure as SAMPLER_INIT_FAILED", () => {
    const { binding } = fakeBinding({
      construct: () => {
        throw new Error("IOReport unavailable");
      },
    });
    mockedLoad.mockReturnValue(binding);

    expect(() => createSampler()).toThrowError(
      expect.objectContaining({ code: "SAMPLER_INIT_FAILED" }),
    );
  });

  it("wraps a sampling failure as SENSOR_UNAVAILABLE", async () => {
    const { binding } = fakeBinding({
      sample: vi.fn(async () => {
        throw new Error("SMC read failed");
      }),
    });
    mockedLoad.mockReturnValue(binding);

    const sampler = createSampler();
    await expect(sampler.sampleNow()).rejects.toMatchObject({
      code: "SENSOR_UNAVAILABLE",
    });
    sampler.close();
  });

  it("rejects a non-positive interval", async () => {
    const { binding } = fakeBinding();
    mockedLoad.mockReturnValue(binding);
    const sampler = createSampler();
    await expect(sampler.sample({ intervalMs: 0 })).rejects.toBeInstanceOf(RangeError);
    sampler.close();
  });
});

describe("sampleOnce", () => {
  it("samples once and closes the sampler", async () => {
    const { binding, close } = fakeBinding();
    mockedLoad.mockReturnValue(binding);

    const metrics = await sampleOnce({ intervalMs: 300 });
    expect(metrics.memory.ramTotalBytes).toBeGreaterThan(0);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
