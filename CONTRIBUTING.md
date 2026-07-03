# Contributing

## Building from source

Requires Rust (stable) and pnpm.

```sh
pnpm install
pnpm run build        # build:native (napi) + build:ts (tsdown)
pnpm run test:rust    # Rust DTO tests
pnpm test             # JS unit + hardware integration tests
pnpm demo             # print a live metrics snapshot (add --watch to refresh)
```

## Releasing

See [RELEASING.md](./RELEASING.md).
