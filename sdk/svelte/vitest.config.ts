import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ["test/**/*.test.ts"],
  },
  // The `svelte()` plugin above is the load-bearing piece: it compiles
  // `.svelte.ts` files (via svelte/compiler's module-only `compileModule`)
  // so `$state`/`$derived` become real reactive bindings against
  // `svelte/internal/client` instead of plain (undefined) function calls —
  // verified empirically by temporarily deleting the plugin from this
  // config and re-running test/rune-smoke.test.ts, which then failed with
  // `ReferenceError: $state is not defined`.
  //
  // `resolve.conditions: ["browser"]` is kept defensively per Svelte's own
  // testing guidance (svelte's package.json exports a "browser" condition,
  // real DOM-effect-backed src/index-client.js, distinct from the
  // "default"/server condition's inert SSR stub, src/index-server.js) for
  // whenever store/component code imports something from the top-level
  // "svelte" package itself (`tick`, `onMount`, `onDestroy`, ...) — but note
  // it was NOT load-bearing for the plain-$state-in-a-class smoke test
  // above: compileModule's output imports svelte/internal/client directly,
  // bypassing the top-level package's browser/default condition entirely.
  // No DOM environment (jsdom/happy-dom) is configured: nothing here mounts
  // a `.svelte` component or touches `document`/`window`, so Vitest's
  // default Node test environment is enough — pulling in a DOM package
  // neither package.json needs would be unapproved scope this task doesn't
  // require.
  resolve: {
    conditions: ["browser"],
  },
});
