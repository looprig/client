# @looprig/react

React 19 hooks and stores for the Factory-native `@looprig/client`. Apache-2.0.

Use `FactoryIdentityProvider` and `FactoryLinkProvider` for application identity
and realtime connection ownership. `useFactorySessionList` and
`useFactorySessionView` provide durable reads, journal recovery, live text, and
live reasoning. `UseFactorySessionViewResult.liveReasoning` is required in
v0.2.0; consumers constructing this result type must supply an empty array
when no preview exists. Host reasoning publication itself is optional.
Text and reasoning each have their own 64 KiB byte budget and 16-key cap.
`browseEarlier()` pages earlier history backward on demand: each call reads
the window of at most `tailLimit` records before the oldest loaded one (bounded
forward `from_seq` reads; no Factory change needed) and prepends it, until
`earlierState` is `"complete"` at sequence 1. `earlierFrom` reports the lowest
contiguously loaded sequence.
`useFactoryComposer`, `useFactoryGate`, and `useFactoryInterrupt` retain command
identity across retries and remounts.

Oxy adapters (`usePendingInput`, `useFoldedEvents`, `useGateBoard`, and
`useLinkRecovery`) and framework-neutral `useStore`/`useStoreSelector` bindings
are included. There is no Harness `serve` transport, SSE session hook, or legacy
constructor surface in v0.2.0.
