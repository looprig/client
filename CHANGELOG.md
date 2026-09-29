# Changelog

## 0.3.0

- `@looprig/client` exports `contractInfo`, the provenance of its vendored
  Core contract.
- `@looprig/react` fixes `browseEarlier`: its first page now requests
  `from_seq=0`. Factory reads a journal request that names no position as the
  tail, so the walk previously re-read the newest page, reported `complete`,
  and never showed earlier history. A cursor restart also resumes from 0.
- `@looprig/react` pages earlier history BACKWARD. Each `browseEarlier()` call
  reads the window of at most `tailLimit` records immediately before the
  oldest loaded record and prepends its public events; repeated calls
  accumulate windows until sequence 1, when `earlierState` is `"complete"`.
  Factory has no backward page, so a window is read with bounded forward
  `from_seq` reads (several if Factory clamps `limit`, each required to advance
  `covered_through`, at most `maxTailPages` per action under one 1 MiB byte
  budget) and is shown whole or not at all. Records already loaded are
  de-duplicated, and live records arriving meanwhile are kept. This replaces
  the 0.2.0 walk forward from the journal start, which kept only one
  replaceable page and followed opaque cursors; no cursor is sent now.
- `UseFactorySessionViewResult` gains the optional `earlierFrom` (the lowest
  contiguously loaded sequence, `null` before a window lands); the hook always
  sets it. `earlierState` still reports `"loading"` and `"complete"`
  (exhausted). `browseEarlier()` is a no-op before the first durable snapshot.

## 0.2.0

- `@looprig/client` decodes correlated text and reasoning `TokenDelta` previews
  with `decodeFactoryLiveDelta`. The existing `decodeFactoryLiveText` result
  remains text-only. `placeLivePreviews` places both kinds with their visible
  loop and turn rows for consumers such as Oxy. `livePreviewKey` identifies a
  preview by kind, loop and turn; unplaced turns remain grouped in first-seen
  order, with reasoning before text within each turn.
- `@looprig/react` exposes a **required** `liveReasoning` array on
  `UseFactorySessionViewResult`. Consumers that construct this type must add
  `liveReasoning: []` when empty. Host reasoning publication is optional; older
  Hosts leave the array empty.
- Reasoning uses the existing subscription and frame batching. Text and
  reasoning each have a 64 KiB byte budget and 16-entry limit. Invalid
  correlated chunks suppress only their own kind and key until `StepDone`.
  Both previews clear on completion, reset, repair, stop, identity change,
  and access revocation; neither changes durable journal coverage.
  Unclassifiable non-object chunks count as text, matching 0.1.0.
- Both packages are versioned 0.2.0; `@looprig/react` depends on exactly
  `@looprig/client` 0.2.0.

## 0.1.0

- Initial Factory-native `@looprig/client` and `@looprig/react` packages.
