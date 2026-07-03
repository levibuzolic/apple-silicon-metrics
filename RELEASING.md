# Releasing

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

## One-time bootstrap (first version only)

Trusted publishing can't be configured until a package exists, and staged
publishing can't stage a brand-new package — so `0.1.0` is published manually:

```sh
npm login                     # with 2FA enabled
pnpm run build                # produce dist/ + native/*.node
npm publish                   # unscoped → public by default
```

Then, on npmjs.com → **apple-silicon-metrics → Settings → Trusted Publisher**, add:

- Provider: **GitHub Actions**
- Organization/user: `levibuzolic`, Repository: `apple-silicon-metrics`
- Workflow filename: `publish.yml`
- Environment: `Publish`
- Allowed action: **`npm stage publish`**

Finally, in GitHub → **Settings → Environments → `Publish`**, add yourself as a
**required reviewer** (optional but recommended).

## Steady-state releases (every version after)

1. Bump the version and push a tag.
2. Publish a **GitHub Release** — this triggers `.github/workflows/publish.yml`.
3. CI runs tests, then `npm stage publish --provenance` (no token, no 2FA).
4. Review and **approve** the staged version with 2FA to make it live.

Requirements (enforced by the workflow): npm ≥ 11.15.0, Node ≥ 22.14.0,
GitHub-hosted runners only.

## Dependency caveat: git-pinned `macmon`

`Cargo.toml` pins `macmon` to a specific git rev rather than a crates.io
release, because fan-RPM support (`Metrics.fans`) has not shipped in a published
version yet (0.7.0 is the latest on crates.io). The prebuilt `darwin-arm64`
binary bundled in each npm release is therefore compiled against that pinned
rev. When `macmon` publishes a release that includes fans, switch the dependency
back to a version requirement and drop the pin.
