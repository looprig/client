import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @looprig/client's package.json points `main` at ./dist, mirroring
      // client/sdk/core. Aliasing straight to its source removes the
      // build-then-test ordering between the two workspace packages, so
      // `vitest run` here never fails on a stale or missing protocol build —
      // and packages/client/dist is gitignored, so a fresh checkout has none.
      // Delete this if Phase 3 points its own `main` at ./src/index.ts.
      "@looprig/client": fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // Same guard client/ uses: a test that asserts nothing is a test that
    // passes for the wrong reason.
    expect: { requireAssertions: true },
    setupFiles: ["./src/vitest-setup.ts"],
    // One project, all tests in the browser. The pure store tests would run
    // fine in node, but a second project buys speed at the cost of every
    // future contributor having to decide which project a new file belongs in.
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium", headless: true }],
    },
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
