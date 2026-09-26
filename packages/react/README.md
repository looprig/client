# @looprig/react

React 19 hooks and stores for the Factory-native `@looprig/client`. Apache-2.0.

Use `FactoryIdentityProvider` and `FactoryLinkProvider` for application identity
and realtime connection ownership. `useFactorySessionList` and
`useFactorySessionView` provide durable reads, journal recovery, live text, and
live reasoning. `UseFactorySessionViewResult.liveReasoning` is required in
v0.2.0; consumers constructing this result type must supply an empty array
when no preview exists. Host reasoning publication itself is optional.
Text and reasoning each have their own 64 KiB byte budget and 16-key cap.
`useFactoryComposer`, `useFactoryGate`, and `useFactoryInterrupt` retain command
identity across retries and remounts.

Oxy adapters (`usePendingInput`, `useFoldedEvents`, `useGateBoard`, and
`useLinkRecovery`) and framework-neutral `useStore`/`useStoreSelector` bindings
are included. There is no Harness `serve` transport, SSE session hook, or legacy
constructor surface in v0.2.0.
