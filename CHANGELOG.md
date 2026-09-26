# Changelog

## 0.2.0

- `@looprig/client` decodes correlated text and reasoning `TokenDelta` previews
  with `decodeFactoryLiveDelta`. The existing `decodeFactoryLiveText` result
  remains text-only. `placeLivePreviews` places both kinds with their visible
  loop and turn rows for consumers such as Oxy.
- `@looprig/react` exposes a **required** `liveReasoning` array on
  `UseFactorySessionViewResult`. Consumers that construct this type must add
  `liveReasoning: []` when empty. Host reasoning publication is optional; older
  Hosts leave the array empty.
- Reasoning uses the existing subscription and frame batching. Text and
  reasoning share the 64 KiB byte budget and 16-entry limit. Invalid
  correlated chunks suppress only their own kind and key until `StepDone`.
  Both previews clear on completion, reset, repair, stop, identity change,
  and access revocation; neither changes durable journal coverage.
- Both packages are versioned 0.2.0; `@looprig/react` depends on exactly
  `@looprig/client` 0.2.0.

## 0.1.0

- Initial Factory-native `@looprig/client` and `@looprig/react` packages.
