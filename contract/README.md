# contract

This directory is a vendored, version-pinned copy of harness's `pkg/serve` wire
contract: the hand-authored JSON Schema documents (`schema/`) and golden fixtures
(`fixtures/`) that describe the `serve` HTTP/SSE protocol. `VERSION` records the
harness version (currently `v0.25.0`, see `HARNESS_VERSION` in the `Makefile`) it
was copied from.

Vendoring these bytes verbatim, rather than depending on harness's testdata at
runtime, means both repos parse the exact same schema and fixtures — a wire change
in harness has to be deliberately re-vendored here, rather than silently drifting
out from under this client.

## Refreshing

```sh
make contract
```

This copies `pkg/serve/testdata/schema/*.json` and `pkg/serve/testdata/fixtures/*`
from whichever harness module `go.mod` currently resolves to (via `go list -m`),
overwriting `schema/`, `fixtures/`, and `VERSION` in place.

## Drift guard

`contract_test.go` asserts every file under `schema/` and `fixtures/` is byte-identical
to the corresponding file in the *pinned* harness module (resolved fresh via `go list -m`,
not cached). If harness's wire contract changes and this directory isn't re-vendored with
`make contract`, the test fails with a diff pointing at the affected file — turning a
would-be silent protocol mismatch at runtime into a reviewable fixture diff at test time.
