# Source provenance

- WUI release `v0.5.0`, commit `8529a960f2c72b6ba1812d84b02c5f9b00cf05b9`: Factory and shared presentation code from `packages/protocol/` → `packages/client/`; Factory React adapters from `packages/react/` → `packages/react/`; complete Core mirror from `contract/` → `contract/`. Root workspace metadata and the Core contract recipe were adapted from the same tag.
- Oxy `main`, commit `5550af368a9c9f3fb891259b35f987aeaddb75af`: reusable portions of `web/src/agents/pending-store.ts`, `factory-view.ts`, `factory.ts` and tests → the browser packages. Storage namespace, authentication, fetch and ID generation are injectable.

The initial WUI copy was subsequently narrowed for the fresh v0.1.0 release.
`legacy-contract/`, serve/v1 schemas, validators and DTOs, Host/Serve transports,
SSE, the legacy client constructor, transport-only folds/stores/React hooks and
the known-drift gate were removed. Core v0.12.0 schemas and fixtures are unchanged.
`EventEnvelope` and `StatusEvent` remain shared presentation types for decoding
the opaque enduring bodies in Factory journal pages/publications; they are not
serve DTOs. Durable transcript folding, Factory live text and Oxy controllers remain.

## Consumer audit and Carbon migration

Oxy main at v0.16.0 uses Factory APIs and shared durable projections, with no
serve transport or hook imports. Its existing package imports will migrate from
`@looprig/protocol` to `@looprig/client` in its consumer phase.

WUI v0.5.0's router mounts Factory routes, but its app source still includes old
serve routes. Carbon's copy must remove `SessionDetailRoute` from
`session-detail-route.tsx`, `SessionsPage` from `sessions-page.tsx`,
`session-detail-page.tsx`, the old new-session button, session reachability and
legacy transcript/store test support, together with their exclusive tests.
Keep `FactorySessionDetailRoute`, `FactorySessionsPage`, Factory gate-board and
tool-capture components. Shared catalogue helpers (`session-row`,
`filter-sessions`, `sessions-state`) must replace serve `SessionSummary` annotations
with `RecentSessionPage["sessions"][number]`. These consumer changes belong to
Carbon's phase; no sibling repository was modified here.
