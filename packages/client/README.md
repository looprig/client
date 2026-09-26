# @looprig/client

Framework-neutral browser client for Looprig Factory REST, ClientLink, commands,
Core v0.12.0 wire validation, live text and reasoning decoders, and durable
session projections. Includes content, row, gate and tool decoders,
pending-input persistence, auth refresh and link recovery controllers.
Apache-2.0.

```ts
import { createFactoryClient } from "@looprig/client";
const client = createFactoryClient({ baseUrl: "https://factory.example" });
```

Use the package root; no deep imports are supported. React adapters are available
in `@looprig/react`. This v0.2.0 surface has no Harness serve transport,
SSE parser, legacy constructor or serve wire DTOs.

In v0.2.0, `decodeFactoryLiveDelta` returns a `kind` of `text` or `reasoning`
for correlated `TokenDelta` chunks. `decodeFactoryLiveText` retains its
text-only result. An unclassifiable non-object chunk counts as text, matching
0.1.0. In `useFactorySessionView`, each preview kind has its own 64 KiB byte
budget and 16-key cap.

A preview's identity is (`kind`, `loopId`, `turnId`); use `livePreviewKey` to
derive it. `placeLivePreviews` positions both kinds after the last visible row
for their loop and turn, or at the visible tail. Unplaced turns keep first-seen
order, with reasoning before text within each turn.
