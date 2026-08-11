import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["session-client.test.ts"],
  },
});
