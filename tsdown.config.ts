import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["ts/index.ts"],
  format: ["esm", "cjs"],
  // Emit .d.ts (ESM) and .d.cts (CJS) so both `import` and `require` type-resolve.
  dts: true,
  outDir: "dist",
  target: "es2022",
  platform: "node",
  clean: true,
  // The generated N-API binding is loaded at runtime via `createRequire`, so it
  // is never statically analyzed or bundled.
});
