# asmon

**A**pple **S**ilicon **Mon**itor — sudo-less Apple Silicon hardware metrics for
Node.js & TypeScript. Native N-API bindings around the Rust
[`macmon`](https://crates.io/crates/macmon) crate: GPU utilization / frequency /
power, CPU usage / power, RAM & swap, CPU/GPU temperature, and ANE power — no
`sudo`, no spawning subprocesses.

> **Platform:** macOS on Apple Silicon (`darwin-arm64`) only. Every other
> platform throws a typed error rather than returning fake data.

## Install

```sh
pnpm add asmon
# or: npm i asmon / yarn add asmon
```

The package ships a prebuilt `darwin-arm64` binary and is marked
`"os": ["darwin"], "cpu": ["arm64"]`, so it will refuse to install on
unsupported hosts.

## Usage

Works from TypeScript, ESM JavaScript, and CommonJS JavaScript out of the box.

```ts
import { createSampler, sampleOnce, isSupported } from "asmon";

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
const { sampleOnce } = require("asmon");
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
  "cpu": { "usageRatio": 0.24, "activeRatio": null, "powerWatts": 3.16, "tempCelsius": 61.3 },
  "gpu": { "usageRatio": 1, "activeRatio": null, "frequencyMhz": 1578, "powerWatts": 34.49, "tempCelsius": 87.1 },
  "memory": { "ramTotalBytes": 51539607552, "ramUsedBytes": 41494380544, "swapTotalBytes": 10737418240, "swapUsedBytes": 9884270592, "ramPowerWatts": 2.66 },
  "ane": { "powerWatts": null }
}
```

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

### Errors — `AsmonError`

All expected failures throw an `AsmonError` with a stable `.code`:

| code | when |
| --- | --- |
| `UNSUPPORTED_PLATFORM` | not running on macOS |
| `UNSUPPORTED_ARCH` | not running on Apple Silicon (arm64) |
| `SAMPLER_INIT_FAILED` | sensor initialization failed |
| `SENSOR_UNAVAILABLE` | a sample read failed |
| `SAMPLER_CLOSED` | used after `close()` |

```ts
import { isAsmonError } from "asmon";
try {
  await sampleOnce();
} catch (err) {
  if (isAsmonError(err) && err.code === "SAMPLER_INIT_FAILED") { /* ... */ }
}
```

## How it works

`macmon`'s metrics come from private macOS APIs (IOReport, AppleSMC, IOHID) and
are **delta-based**, so a long-lived sampler is more accurate than repeated
one-shots. Because `macmon::Sampler` owns raw CoreFoundation pointers and is not
thread-safe, `asmon` pins it to a single dedicated OS thread and drives it over
channels. Each `sample()` runs the blocking read on libuv's threadpool, so
Node's event loop is never blocked while the sample window elapses.

## Building from source

Requires Rust (stable) and pnpm.

```sh
pnpm install
pnpm run build        # build:native (napi) + build:ts (tsdown)
pnpm run test:rust    # Rust DTO tests
pnpm test             # JS unit + hardware integration tests
pnpm demo             # print a live metrics snapshot (add --watch to refresh)
```

## Publishing

Releases use the most hardened npm setup available, layering four independent
controls:

1. **Trusted publishing (OIDC)** — CI authenticates to npm via GitHub's OIDC, so
   there is **no long-lived `NPM_TOKEN`** secret to leak.
2. **Provenance** — a signed SLSA build attestation links each tarball to the
   exact workflow run (requires a public repo).
3. **Staged publishing** — CI runs `npm stage publish`, which uploads the version
   to npm's staging queue. It is **not installable** until a maintainer approves
   it with 2FA (`npm stage approve <id>` or the npmjs.com UI).
4. **GitHub Environment gate** — the `Publish` environment can require a human
   reviewer before the publish job runs at all.

### One-time bootstrap (first version only)

Trusted publishing can't be configured until a package exists, and staged
publishing can't stage a brand-new package — so `0.1.0` is published manually:

```sh
npm login                     # with 2FA enabled
pnpm run build                # produce dist/ + native/*.node
npm publish                   # unscoped → public by default
```

Then, on npmjs.com → **asmon → Settings → Trusted Publisher**, add:

- Provider: **GitHub Actions**
- Organization/user: `levibuzolic`, Repository: `asmon`
- Workflow filename: `publish.yml`
- Environment: `Publish`
- Allowed action: **`npm stage publish`**

Finally, in GitHub → **Settings → Environments → `Publish`**, add yourself as a
**required reviewer** (optional but recommended).

### Steady-state releases (every version after)

1. Bump the version and push a tag.
2. Publish a **GitHub Release** — this triggers `.github/workflows/publish.yml`.
3. CI runs tests, then `npm stage publish --provenance` (no token, no 2FA).
4. Review and **approve** the staged version with 2FA to make it live.

Requirements (enforced by the workflow): npm ≥ 11.15.0, Node ≥ 22.14.0,
GitHub-hosted runners only.

## Limitations

- macOS Apple Silicon only; relies on private, undocumented macOS APIs that can
  change between OS releases.
- Fan RPM is not yet exposed (`macmon` 0.7.0 has no fan API); the `fans` field
  is reserved for a future release.
- `cpu.activeRatio` / `gpu.activeRatio` are always `null` — `macmon` does not
  distinguish an active-vs-usage ratio.

## License

MIT
