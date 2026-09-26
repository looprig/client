# Looprig browser clients

Two Apache-2.0 libraries, versioned together:

- `@looprig/client`: framework-neutral Factory REST, ClientLink, commands, Core wire validation, live text and reasoning decoders, and session controllers.
- `@looprig/react`: React 19 Factory hooks and adapters over the client.

The v0.2.0 API is Factory-native. It includes shared enduring-event, content,
row, gate and tool decoders plus Oxy's pending-input, auth, recovery and view
controllers. Harness `serve` transports, SSE, legacy constructors and their React
hooks are not part of these packages.

From the workspace root:

```sh
npm ci
npm run build
npm run typecheck
npm test --workspaces
npm run contract:check
npm run test:package
```

Every test must pass; there is no failure allowance. `contract/` mirrors published
Core v0.12.0 artifacts, with a byte-for-byte Go guard and TypeScript Factory schema
and fixture checks. Package checks install packed artifacts into clean vanilla
and React consumers. Builds clean `dist/` so removed APIs cannot linger in tarballs.
See [source provenance](docs/provenance.md) for origins and migration notes.

## Live previews

`useFactorySessionView` exposes required `liveText` and `liveReasoning` arrays.
Each preview has `loopId`, `turnId`, and uncommitted `text`. Older Hosts and
Hosts without reasoning publication enabled leave `liveReasoning` empty. A
consumer constructing `UseFactorySessionViewResult` must supply
`liveReasoning: []` when it has no preview.

`decodeFactoryLiveDelta` distinguishes text and reasoning (`kind: "text"` or
`"reasoning"`); `decodeFactoryLiveText` keeps its text-only result. Both preview
kinds share a 64 KiB byte budget and 16-entry limit. Invalid correlated chunks
freeze only their own kind and key until `StepDone`; durable completion replaces
the preview. Previews clear on terminal events, reset, repair, stop, identity
change, and access revocation. `placeLivePreviews` positions both kinds after
their last visible row for the same loop and turn, or at the visible tail.
