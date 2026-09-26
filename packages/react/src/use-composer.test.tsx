import { SessionViewStore } from "@looprig/client";
import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { ControlledLiveSource } from "./testing/live.js";
import { useComposer } from "./use-composer.js";

const CMD = "aabbccdd-1122-4334-8556-778899aabbcc";

function setup(): { transport: FakeTransport; live: ControlledLiveSource; view: SessionViewStore } {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const view = new SessionViewStore({ journal: transport, sessionId: SID, liveSource: live.source });
  return { transport, live, view };
}

test("submitting exposes an optimistic pending row", async () => {
  const { transport, view } = setup();
  transport.inputResponse = { command_id: CMD };
  const { result } = await renderHook(() => useComposer(transport, SID, view));

  await result.current.submit("ship it");

  await expect.poll(() => result.current.pending.map((row) => row.text)).toStrictEqual(["ship it"]);
  expect(result.current.submitting).toBe(false);
  expect(result.current.error).toBeNull();
});

test("a second submit while one is in flight is refused", async () => {
  const { transport, view } = setup();
  const held = transport.defer<{ command_id: string }>("submit");
  const { result } = await renderHook(() => useComposer(transport, SID, view));

  const first = result.current.submit("one");
  await expect.poll(() => result.current.submitting).toBe(true);
  await expect(result.current.submit("two")).resolves.toBe(false);

  held.resolve({ command_id: CMD });
  await expect(first).resolves.toBe(true);
  expect(transport.countOf("submit")).toBe(1);
});

test("a failed submit surfaces the error and leaves no pending row", async () => {
  const { transport, view } = setup();
  transport.fail("submit", new Error("session not found"));
  const { result } = await renderHook(() => useComposer(transport, SID, view));

  await expect(result.current.submit("ship it")).resolves.toBe(false);

  await expect.poll(() => result.current.error?.message).toBe("session not found");
  expect(result.current.pending).toStrictEqual([]);
});

test("clearError clears it", async () => {
  const { transport, view } = setup();
  transport.fail("submit", new Error("boom"));
  const { result } = await renderHook(() => useComposer(transport, SID, view));
  await result.current.submit("ship it");
  await expect.poll(() => result.current.error?.message).toBe("boom");

  result.current.clearError();

  await expect.poll(() => result.current.error).toBeNull();
});

test("the returned callbacks are stable across re-renders", async () => {
  const { transport, view } = setup();
  const { result, rerender } = await renderHook(() => useComposer(transport, SID, view));
  const first = { submit: result.current.submit, clearError: result.current.clearError };

  await rerender();
  await rerender();

  // A send button that re-memoises on every keystroke defeats every memo below
  // it; both callbacks key only on the store, which keys on transport + sid.
  expect(result.current.submit).toBe(first.submit);
  expect(result.current.clearError).toBe(first.clearError);
});
