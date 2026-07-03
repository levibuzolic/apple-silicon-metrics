# apple-silicon-metrics

Sudo-less Apple Silicon hardware metrics for Node.js & TypeScript. Native N-API
bindings around the Rust [`macmon`](https://crates.io/crates/macmon) crate: GPU
utilization / frequency / power, CPU usage & active residency / power, RAM &
swap, CPU/GPU temperature, fan RPM, ANE power, and OS thermal-pressure state —
no `sudo`, no spawning subprocesses.

> **Platform:** macOS on Apple Silicon (`darwin-arm64`) only. Every other
> platform throws a typed error rather than returning fake data.

## Install

```sh
pnpm add apple-silicon-metrics
# or: npm i apple-silicon-metrics / yarn add apple-silicon-metrics
```

The package ships a prebuilt `darwin-arm64` binary and is marked
`"os": ["darwin"], "cpu": ["arm64"]`, so it will refuse to install on
unsupported hosts.

## Usage

Works from TypeScript, ESM JavaScript, and CommonJS JavaScript out of the box.

```ts
import { createSampler, sampleOnce, isSupported } from "apple-silicon-metrics";

if (!isSupported()) throw new Error("Requires macOS on Apple Silicon");

// One-shot: samples over a 1s window, then tears down.
const snapshot = await sampleOnce({ intervalMs: 1000 });
console.log(snapshot.cpu.powerWatts, snapshot.gpu.usageRatio);

// Stateful: prefer this for repeated reads (delta metrics stay accurate).
const sampler = createSampler({ intervalMs: 1000 });
await sampler.prime();            // optional: warm the IOReport baseline
const metrics = await sampler.sampleNow();
console.log(metrics);
sampler.close();                 // release the worker thread when done
```

CommonJS:

```js
const { sampleOnce } = require("apple-silicon-metrics");
sampleOnce({ intervalMs: 500 }).then(console.log);
```

### Example output

```jsonc
{
  "timestamp": "2026-07-03T02:21:39.409Z",
  "soc": {
    "chipName": "Apple M4 Pro",
    "macModel": "Mac16,8",
    "memoryGb": 48,
    "gpuCores": 20,
    "ecpuCores": 4,
    "pcpuCores": 10
  },
  "cpu": { "usageRatio": 0.24, "activeRatio": 0.18, "powerWatts": 3.16, "tempCelsius": 61.3 },
  "gpu": { "usageRatio": 1, "activeRatio": 0.97, "frequencyMhz": 1578, "powerWatts": 34.49, "tempCelsius": 87.1 },
  "memory": { "ramTotalBytes": 51539607552, "ramUsedBytes": 41494380544, "swapTotalBytes": 10737418240, "swapUsedBytes": 9884270592, "ramPowerWatts": 2.66 },
  "ane": { "powerWatts": null },
  "fans": [{ "name": "fan0", "rpm": 1980, "maxRpm": 7826 }, { "name": "fan1", "rpm": 2010, "maxRpm": 7826 }],
  "thermal": { "level": 0, "state": "nominal", "throttling": false }
}
```

## CLI

The package ships a small `apple-silicon-metrics` binary:

```sh
npx apple-silicon-metrics              # one formatted snapshot
npx apple-silicon-metrics --watch      # refresh every second until Ctrl-C
npx apple-silicon-metrics -i 500       # set the sample window (ms)
npx apple-silicon-metrics --json       # machine-readable (NDJSON when watching)
```

```
Apple M4 Pro  ·  Mac16,8  ·  48 GB  ·  20 GPU cores  ·  4E+10P
  CPU   usage 16.7%   active 12.4%   power 1.9 W   temp 58.5°C
  GPU   usage 12.4%   active  9.1%   power 0.7 W   temp 41.5°C   freq 398 MHz
  RAM   17.5 GiB / 48.0 GiB   swap 2.6 GiB / 4.0 GiB   power 0.9 W
  ANE   power —
  FAN   fan0 1980/7826 rpm   fan1 2010/7826 rpm
  THRM  nominal
  2026-07-03T05:37:34.386Z
```

Flags: `-w/--watch`, `-i/--interval <ms>`, `-j/--json`, `-h/--help`, `-v/--version`.

## API

### `isSupported(): boolean`

Synchronous check for macOS on Apple Silicon. Never loads the native addon.

### `sampleOnce(options?): Promise<Metrics>`

Create a sampler, take one sample over `options.intervalMs` (default `1000`),
then close it.

### `createSampler(options?): Sampler`

Create a long-lived sampler backed by a dedicated worker thread.

- `sampler.soc` — static `SocInfo`, captured at init.
- `sampler.prime()` — take a short throwaway sample to warm the delta baseline.
- `sampler.sampleNow()` — sample using the configured default interval.
- `sampler.sample({ intervalMs })` — sample with an explicit interval.
- `sampler.close()` — release the worker thread (idempotent).

### Units

Ratios `0..1` · temperatures °C · power W · frequency MHz · memory bytes ·
`timestamp` ISO-8601. A `null` value means the metric exists but its sensor was
unavailable on this machine/OS.

`usageRatio` is frequency-scaled effective usage; `activeRatio` is raw active
residency (not frequency-scaled). `thermal` is the coarse OS-level
thermal-*pressure* signal from `NSProcessInfo.thermalState` (`level` 0–3,
`throttling` = `level >= 1`) — a system throttling hint, not a hardware sensor.

### Errors — `AppleSiliconMetricsError`

All expected failures throw an `AppleSiliconMetricsError` with a stable `.code`:

| code | when |
| --- | --- |
| `UNSUPPORTED_PLATFORM` | not running on macOS |
| `UNSUPPORTED_ARCH` | not running on Apple Silicon (arm64) |
| `SAMPLER_INIT_FAILED` | sensor initialization failed |
| `SENSOR_UNAVAILABLE` | a sample read failed |
| `SAMPLER_CLOSED` | used after `close()` |

```ts
import { isAppleSiliconMetricsError } from "apple-silicon-metrics";
try {
  await sampleOnce();
} catch (err) {
  if (isAppleSiliconMetricsError(err) && err.code === "SAMPLER_INIT_FAILED") { /* ... */ }
}
```

## How it works

`macmon`'s metrics come from private macOS APIs (IOReport, AppleSMC, IOHID) and
are **delta-based**, so a long-lived sampler is more accurate than repeated
one-shots. Because `macmon::Sampler` owns raw CoreFoundation pointers and is not
thread-safe, `apple-silicon-metrics` pins it to a single dedicated OS thread and
drives it over channels. Each `sample()` runs the blocking read on libuv's
threadpool, so Node's event loop is never blocked while the sample window elapses.

## Contributing

Building from source and running the tests is documented in
[CONTRIBUTING.md](./CONTRIBUTING.md); the release process lives in
[RELEASING.md](./RELEASING.md).

## Limitations

- macOS Apple Silicon only; relies on private, undocumented macOS APIs that can
  change between OS releases.
- Fanless Macs (e.g. MacBook Air) report an empty `fans` array.

## License

MIT
