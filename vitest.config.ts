import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run each test file in its own Node process so PGlite WASM
    // doesn't conflict between suites (Vitest 4+ top-level option).
    pool: "forks",
    environment: "node",
  },
});
