# Looprig browser clients

This repository publishes two Apache-2.0 browser libraries:

- `@looprig/client`: framework-neutral Factory REST, ClientLink, wire and session helpers.
- `@looprig/react`: React 19 hooks and stores built on `@looprig/client`.

Both packages are versioned together. Build and verify from the workspace root with `npm ci`, `npm run build`, `npm run typecheck`, `npm test --workspaces`, and `npm run contract:check`. The Core wire fixtures are pinned in `contract/` for a test-only drift check. See `docs/provenance.md` for source revisions and `docs/known-drift.md` for the existing TypeScript contract allowance.
