# Known Core/TypeScript drift

The WUI v0.5.0 TypeScript mirror retains its earlier, bounded drift from Core. `packages/client/test/known-drift.json` records the exact existing failing files and, except for three timing-sensitive HTTP test files, failing test names. `packages/client/scripts/known-drift-gate.mjs` runs the full suite and rejects new failures, removed tests, or a stale allowance. This copy preserves the original allowance; test file inventory changes for ported Oxy cases do not permit new failures.
