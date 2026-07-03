import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["ts/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },
});
