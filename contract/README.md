# contract

This directory is a vendored, version-pinned copy of Core's `sessionwire/v1`
wire artifacts: the JSON Schema documents in `schema/` and golden fixtures in
`fixtures/`. `VERSION` records the Core version copied here; it matches
`CORE_VERSION` in the `Makefile` and the direct Core requirement in `go.mod`.
Core v0.12.0 supplies 43 schemas and 43 fixtures, including eight new
principal/metadata schema-and-fixture pairs; the 35 previous fixtures are
byte-identical to the prior release.

Core is the authority for this contract. The client keeps an exact local mirror so its
browser protocol can be reviewed and tested without resolving a sibling checkout.
The drift guard resolves the published version pinned by `go.mod` with
`GOWORK=off`, then compares both mirrored trees byte-for-byte in both directions.

Nothing here is non-test Go source. The direct Core requirement exists only for
this drift guard, so `go mod tidy` would remove it; use the documented `go get`
workflow when moving the pin.

The TypeScript package mirrors the Factory-facing schema subset and checks each
mirror and its corresponding fixtures. HostLink schemas remain in this complete
Core corpus for the byte-for-byte guard; they are not a browser transport API.

## Refreshing

```sh
make contract
```

This copies the complete `sessionwire/v1/schema/` and
`sessionwire/v1/testdata/fixtures/` trees from the pinned Core module, replacing
both local trees and updating `VERSION`. Move `CORE_VERSION` and the direct
`go.mod` requirement in the same commit.

## Drift guard

`contract_test.go` checks the pinned version and exact file bytes. A missing,
changed, or extra local artifact fails with the affected path, and the version
test catches a stale provenance record even when two releases contain identical
artifacts.
