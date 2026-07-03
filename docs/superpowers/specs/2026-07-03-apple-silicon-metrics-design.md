# apple-silicon-metrics — Apple Silicon Monitor — Design

**Date:** 2026-07-03
**Status:** Approved for implementation
**Package name:** `apple-silicon-metrics` (npm), Rust crate `apple-silicon-metrics`

## Summary

`apple-silicon-metrics` is a native-backed Node/TypeScript package that exposes Apple Silicon
hardware metrics (CPU/GPU power, usage, frequency, temperature, RAM/swap, ANE
power, SoC info) without `sudo`, by wrapping the Rust [`macmon`](https://crates.io/crates/macmon)
crate through [`napi-rs`](https://napi.rs) v3.

Target platform: **macOS Apple Silicon (`darwin-arm64`) only.** Every other
platform is treated as explicitly unsupported with a typed error — never a
silent failure or a fake reading.

## Key facts established from `macmon` 0.7.0 source

These constrain the design and were verified by reading the crate source:

- Public API is only: `Sampler::new()`, `Sampler::get_metrics(duration_ms: u32)`,
  `Sampler::get_soc_info() -> &SocInfo`. **There is no `get_metrics_now`** (it
  existed in the original spec notes but not in 0.7.0).
- `get_metrics(duration)` blocks for ~`duration` ms: internally it takes 4
  smoothed sub-samples of `duration/4` each via `IOReport::get_samples`.
- `IOReport` keeps `self.prev` across calls, so each `get_metrics` call
  self-establishes its baseline+delta. **No separate "prime" step is required
  for correctness** — priming only warms the chain for tighter short samples.
- The `Sampler` owns raw CoreFoundation pointers (IOReport / SMC / IOHID). It is
  **not `Send` and not `Sync`.** It must be pinned to a single OS thread.
- Unavailable sensors surface as `0.0` (e.g. temperature averages), which we
  normalize to `null` at the TypeScript layer.

## Architecture

Three layers, each independently testable:

```
┌─────────────────────────────────────────────────────────┐
│ ts/index.ts  — public API (ESM + CJS + .d.ts via tsdown) │
│   isSupported() · sampleOnce() · createSampler()         │
│   AppleSiliconMetricsError + typed codes · unit normalization + null   │
└───────────────▲─────────────────────────────────────────┘
                │ imports generated binding (external)
┌───────────────┴─────────────────────────────────────────┐
│ src/lib.rs — napi-rs bindings                            │
│   isSupportedNative() · class NativeSampler              │
│   async sample(durationMs) → NativeMetrics (AsyncTask)   │
│   socInfo() · close()                                    │
└───────────────▲─────────────────────────────────────────┘
                │ mpsc command / response channels
┌───────────────┴─────────────────────────────────────────┐
│ src/worker.rs — dedicated OS thread owning macmon::Sampler│
│   (Sampler never crosses threads → no Send needed)       │
└──────────────────────────────────────────────────────────┘
```

### Threading model (the crux)

Because `macmon::Sampler` is not `Send`, `NativeSampler::new()` spawns one
dedicated OS thread that constructs and forever owns the `macmon::Sampler`. The
JS side communicates over a `std::sync::mpsc` command channel:

- `Cmd::Sample { duration_ms, resp }` — worker calls `get_metrics`, sends the
  DTO back over a per-request response channel.
- `Cmd::Close` — worker breaks its loop and drops the sampler.

Each JS `sample()` call returns a napi `AsyncTask`. `AsyncTask::compute()` runs
on libuv's threadpool: it enqueues a `Cmd::Sample` and blocks on the response
receiver, so **Node's main event loop is never blocked** while macmon sleeps for
the sample interval. The command channel serializes concurrent samples.

`NativeSampler::new()` blocks briefly on an init handshake so a failed
`macmon::Sampler::new()` throws synchronously (mapped to `SAMPLER_INIT_FAILED`).
`SocInfo` is snapshotted into a plain `Send` struct at init and cached, so
`socInfo()` is a cheap synchronous getter.

### DTO mapping (`src/dto.rs`)

`#[napi(object)]` structs carry flat, camelCase, `f64`-typed fields (u64 byte
counts are cast to `f64` — max realistic RAM ~192 GB ≪ 2^53, so no precision
loss and no awkward BigInt). Raw macmon field names are **not** exposed; we map
to stable names. The TS layer reshapes flat → nested `Metrics` and applies
nullability.

| macmon | native DTO | TS `Metrics` field | null rule |
|---|---|---|---|
| `cpu_usage_pct` | `cpuUsageRatio` | `cpu.usageRatio` | — |
| — | — | `cpu.activeRatio` | always `null` (not distinguished by macmon) |
| `cpu_power` | `cpuPower` | `cpu.powerWatts` | — |
| `temp.cpu_temp_avg` | `cpuTemp` | `cpu.tempCelsius` | `≤ 0 → null` |
| `gpu_usage.1` | `gpuUsageRatio` | `gpu.usageRatio` | — |
| `gpu_usage.0` | `gpuFreqMhz` | `gpu.frequencyMhz` | `≤ 0 → null` |
| `gpu_power` | `gpuPower` | `gpu.powerWatts` | — |
| `temp.gpu_temp_avg` | `gpuTemp` | `gpu.tempCelsius` | `≤ 0 → null` |
| `memory.*` | `ramTotal`… | `memory.*Bytes` | — |
| `ram_power` | `ramPower` | `memory.ramPowerWatts` | `≤ 0 → null` |
| `ane_power` | `anePower` | `ane.powerWatts` | `≤ 0 → null` |
| `SocInfo.*` | `NativeSocInfo` | `soc.*` | — |

Fans: macmon 0.7.0 exposes no fan RPM API, so `fans` is omitted from output for
now (the field stays optional in the type for forward compatibility).

## Public TypeScript API

```ts
isSupported(): boolean               // sync platform+arch+load check
sampleOnce(opts?: { intervalMs?: number }): Promise<Metrics>
createSampler(opts?: { intervalMs?: number }): Sampler

interface Sampler {
  prime(): Promise<void>             // warm the IOReport baseline (optional)
  sampleNow(): Promise<Metrics>      // sample using the configured interval
  sample(opts?: { intervalMs?: number }): Promise<Metrics>
  close(): void
  readonly soc: SocInfo
}
```

- Default `intervalMs` = **1000**. `sampleNow()` uses the configured default.
- `sampleNow()` auto-primes (macmon self-baselines), so it always resolves to
  valid `Metrics`; `prime()` is offered for callers who want an explicit warm-up.
- Ratios `0..1`, temps °C, power W, freq MHz, memory bytes, `timestamp` ISO-8601.

### Typed errors

`class AppleSiliconMetricsError extends Error { code: AppleSiliconMetricsErrorCode }` where `AppleSiliconMetricsErrorCode`
is a string-literal union: `UNSUPPORTED_PLATFORM` | `UNSUPPORTED_ARCH` |
`SAMPLER_INIT_FAILED` | `SENSOR_UNAVAILABLE` | `SAMPLER_CLOSED`. Platform/arch
checks run in JS **before** loading the native addon, so unsupported hosts get a
clean typed error instead of a raw "module not found".

## Packaging & publishing

- Single package, `"os": ["darwin"]`, `"cpu": ["arm64"]`.
- `napi-rs` builds `apple-silicon-metrics.darwin-arm64.node` + generates a CJS binding loader.
- `tsdown` builds the wrapper to dual **ESM (`index.js`) + CJS (`index.cjs`) +
  `index.d.ts`**, with the native binding marked external.
- `exports` map wires `types` / `import` / `require`. Supports TS consumers
  (full `.d.ts`), modern Node ESM, and CJS.
- `pnpm` (latest) for package management; strict TypeScript (`strict` +
  `noUncheckedIndexedAccess` etc.).

## Testing

- **Rust unit tests** (`cargo test`): DTO conversion + null-normalization logic
  on synthetic `macmon::Metrics` values (no hardware needed).
- **TS unit tests** (vitest): mock the native binding, assert flat→nested
  mapping, null rules, error codes, platform gating.
- **Integration test** (vitest, gated to `darwin-arm64`): `isSupported()` true,
  sampler initializes, `ramTotalBytes > 0`, temps positive-or-null, CPU/GPU
  ratios within `0..1`. No high-load / exact-value assertions.

## CI

GitHub Actions on `macos-14` (arm64): set up pnpm + Rust, `cargo test`,
`napi build`, `pnpm build`, `pnpm test` (unit + integration).

## Out of scope for 0.1.x

Fan RPM, multi-platform binaries, Intel/Linux/Windows support, streaming
subscription API. The `fans` type field is reserved but unpopulated.
