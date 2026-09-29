# Changelog

## 0.3.0

- `@looprig/client` exports `contractInfo`, the provenance of its vendored
  Core contract.
- `@looprig/react` fixes `browseEarlier`: its first page now requests
  `from_seq=0`. Factory reads a journal request that names no position as the
  tail, so the walk previously re-read the newest page, reported `complete`,
  and never showed earlier history. A cursor restart also resumes from 0.
- `@looprig/react` pages earlier history BACKWARD. Each `browseEarlier()` call
  reads windows of at most `tailLimit` records backward from the oldest loaded
  record until one holds a public event (or sequence 1 is reached) and
  prepends what it found; repeated calls accumulate until sequence 1, when
  `earlierState` is `"complete"`. A call stopped by its page bound keeps the
  floor it reached, so the next call continues from there.
  Factory has no backward page, so a window is read with bounded forward
  `from_seq` reads (several if Factory clamps `limit`, each required to advance
  `covered_through`, at most `maxTailPages` reads under one 1 MiB byte
  budget per action) and is shown whole or not at all. Records already loaded are
  de-duplicated, and live records arriving meanwhile are kept. This replaces
  the 0.2.0 walk forward from the journal start, which kept only one
  replaceable page and followed opaque cursors; no cursor is sent now.
- Live tool steps. `@looprig/client` adds `decodeFactoryLiveToolStep`, which
  decodes harness's public `ToolCallStarted`/`ToolCallCompleted` bodies
  (carried in an ordinary `EphemeralPublication`) into a `FactoryLiveToolStep`
  keyed by `toolExecutionId`. Harness v0.42.0 adds the `tool_use_id` join key
  (both) and `tool_name`/`elapsed_ms` (Completed); older bodies decode with
  those empty or absent. The summary is capped at 4 KiB, the result preview at
  16 KiB; any other body, including `TokenDelta`, returns null. An absent
  `is_error` means success; an explicit `null` or non-boolean is refused.
  `liveToolRows` maps steps to live `ToolRow`s (`live: true`, no journal
  sequence, status `running`/`ok`/`error`).
- **`FactoryLivePreview` is now a union** that adds `{ kind: "tool", loopId,
  turnId, row }`; the text/reasoning shape is `FactoryLiveTextPreview`. An
  exhaustive `switch (preview.kind)` must add a `"tool"` arm.
  `placeLivePreviews` takes an optional sixth `liveToolSteps` argument and places
  tool previews after reasoning and text within a turn; `livePreviewKey` for a
  tool preview is `tool:<toolExecutionId>`. It is overloaded: the 0.2.0
  five-argument call still returns only `FactoryLiveTextPreview`s (so
  `unplaced.map((p) => p.text)` keeps compiling), and only the six-argument
  call returns the widened union. The result type is exported as
  `PlacedLivePreviews<P>`.
- `@looprig/react` exposes a **required** `liveToolSteps` array on
  `UseFactorySessionViewResult` (consumers constructing the type add
  `liveToolSteps: []`). A Completed whose Started was lost creates the step; a
  committed `StepDone` removes the steps whose `toolUseId` it commits, then
  those in its own loop, turn and step, in the same snapshot as the folded
  row, so a call never renders twice. Turn terminals remove the turn's steps,
  and a late step for an ended turn or a stopped session is ignored.
  Reset, repair, reconnect, stop, identity change and access revocation clear
  every step. At most 64 steps are kept, evicting the oldest completed, then
  the oldest running. Steps share the text frame batching and never change
  journal coverage. 0.2.0 clients ignore these frames.
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
