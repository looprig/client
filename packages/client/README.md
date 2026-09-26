# @looprig/client

Framework-neutral browser client for Looprig Factory REST, ClientLink, commands,
Core v0.12.0 wire validation, live text and durable session projections. Includes
content, row, gate and tool decoders, pending-input persistence, auth refresh and
link recovery controllers. Apache-2.0.

```ts
import { createFactoryClient } from "@looprig/client";
const client = createFactoryClient({ baseUrl: "https://factory.example" });
```

Use the package root; no deep imports are supported. React adapters are available
in `@looprig/react`. This fresh v0.1.0 surface has no Harness serve transport,
SSE parser, legacy constructor or serve wire DTOs.
