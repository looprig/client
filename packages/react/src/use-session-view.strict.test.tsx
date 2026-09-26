/**
 * React 19's StrictMode mounts effects, unmounts them, and mounts them again in
 * development, and it double-invokes render-phase functions including a
 * `useMemo` factory. `app/` runs under StrictMode, so a store that cannot be
 * restarted after `stop()` — or one built by a factory with side effects, whose
 * discarded copy leaks a connection — breaks in dev and works in prod, which is
 * the worst possible failure shape.
 *
 * These use `renderHookStrict` rather than `renderHook(hook, { wrapper })`.
 * See `testing/strict.tsx`: a `wrapper` puts StrictMode one level BELOW the
 * root, which double-RENDERS but does not remount. Measured against the plan's
 * form, a non-restartable store passes all four of these — the very defect this
 * file's own preamble says to expect a failure from.
 */
import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { ControlledLiveSource, toolCallStarted } from "./testing/live.js";
import { renderHookStrict } from "./testing/strict.js";
import { useSessionView } from "./use-session-view.js";

test("leaves exactly one live connection open under a StrictMode double-mount", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();

  const { result } = await renderHookStrict(() => useSessionView(transport, SID, live.source));

  await expect.poll(() => live.isOpen).toBe(true);
  // start -> stop -> start leaves opens minus closes at exactly one. Asserting
  // the DIFFERENCE rather than openCount === 2 keeps the test honest if the
  // store ever learns to no-op a restart.
  expect(live.openCount - live.closedCount).toBe(1);

  // And the surviving connection is the one actually wired to the view.
  live.emit(toolCallStarted("t1", "Read"));
  await expect.poll(() => result.current.view.rows.length).toBe(1);
  expect(result.current.store.isActive()).toBe(true);
});

test("unmounting closes every connection the StrictMode mount opened", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();

  const { unmount } = await renderHookStrict(() => useSessionView(transport, SID, live.source));
  await expect.poll(() => live.isOpen).toBe(true);

  await unmount();
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Every open accounted for, not just a net of one. StrictMode invokes the
  // useMemo factory twice and throws one store away, so a factory that STARTED
  // what it built would leave a connection behind that no effect cleanup holds
  // a reference to — invisible to a `openCount - closedCount` check, because
  // the orphan's own open is what makes the arithmetic work out.
  expect(live.openCount).toBe(live.closedCount);
  expect(live.isOpen).toBe(false);
});

test("a real unmount and remount restarts cleanly, leaving no orphan connection", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();

  const first = await renderHook(() => useSessionView(transport, SID, live.source));
  await expect.poll(() => live.isOpen).toBe(true);
  await first.unmount();
  await expect.poll(() => live.isOpen).toBe(false);

  const second = await renderHook(() => useSessionView(transport, SID, live.source));
  await expect.poll(() => live.isOpen).toBe(true);
  live.emit(toolCallStarted("t2", "Bash"));

  await expect.poll(() => second.result.current.view.rows.length).toBe(1);
  expect(live.openCount - live.closedCount).toBe(1);
});

test("a restarted store publishes the new cycle's view, not the previous one's rows", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();

  const { result } = await renderHookStrict(() => useSessionView(transport, SID, live.source));
  await expect.poll(() => live.isOpen).toBe(true);
  live.emit(toolCallStarted("t1", "Read"));
  await expect.poll(() => result.current.view.rows.length).toBe(1);

  // The rows came from the SECOND start, after the StrictMode stop reset the
  // accumulated view — a store that kept folding into the first cycle's view
  // would show this row twice once the first connection's frames replayed.
  expect(result.current.view.rows.filter((row) => row.kind === "tool")).toHaveLength(1);
});
