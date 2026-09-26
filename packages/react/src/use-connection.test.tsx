import { FoldError, SessionViewStore } from "@looprig/client";
import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { ControlledLiveSource, badTokenDelta, toolCallStarted } from "./testing/live.js";
import { useConnection, useSessionViewErrors } from "./use-connection.js";

function makeStore(options: { autoReconnect?: boolean } = {}): {
  transport: FakeTransport;
  live: ControlledLiveSource;
  store: SessionViewStore;
} {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const store = new SessionViewStore({
    journal: transport,
    sessionId: SID,
    liveSource: live.source,
    join: { autoReconnect: options.autoReconnect ?? false },
  });
  return { transport, live, store };
}

test("reports idle before the join starts, and live once it has", async () => {
  const { store } = makeStore();
  const { result } = await renderHook(() => useConnection(store));

  expect(result.current).toStrictEqual({
    state: "idle",
    connected: false,
    failure: null,
    lastWarning: null,
    warningCount: 0,
  });

  store.start();

  await expect.poll(() => result.current.state).toBe("live");
  expect(result.current.connected).toBe(true);
  store.stop();
});

test("a live stream that ends on its own reports closed, not failed", async () => {
  const { live, store } = makeStore();
  const { result } = await renderHook(() => useConnection(store));
  store.start();
  await expect.poll(() => result.current.state).toBe("live");

  live.end();

  // The transition with NO other signal: no error, and no notify either,
  // because nothing was dirty. A renderer with only the notify channel reads
  // "live" here forever.
  await expect.poll(() => result.current.state).toBe("closed");
  expect(result.current.connected).toBe(false);
  expect(result.current.failure).toBeNull();
});

test("stopping the store reports closed", async () => {
  const { store } = makeStore();
  const { result } = await renderHook(() => useConnection(store));
  store.start();
  await expect.poll(() => result.current.state).toBe("live");

  store.stop();

  await expect.poll(() => result.current.state).toBe("closed");
  expect(result.current.failure).toBeNull();
});

test("a terminal join failure reports failed and carries the error", async () => {
  const { transport, store } = makeStore();
  transport.fail("readHistory", new Error("journal unavailable"));
  const { result } = await renderHook(() => useConnection(store));

  store.start();

  await expect.poll(() => result.current.state).toBe("failed");
  expect(result.current.connected).toBe(false);
  expect(result.current.failure?.message).toBe("journal unavailable");
  // A terminal failure is not a warning: the distinction is the whole point.
  expect(result.current.warningCount).toBe(0);
});

test("a fold error is a WARNING: the join keeps going and stays connected", async () => {
  const { live, store } = makeStore();
  const { result } = await renderHook(() => useConnection(store));
  store.start();
  await expect.poll(() => result.current.state).toBe("live");

  live.emit(badTokenDelta());

  // fold.ts's contract is that the loop keeps going past one bad input, so a
  // renderer must not tear the transcript down for one.
  await expect.poll(() => result.current.warningCount).toBe(1);
  expect(result.current.lastWarning).toBeInstanceOf(FoldError);
  expect(result.current.state).toBe("live");
  expect(result.current.failure).toBeNull();

  // And the join really did keep going.
  live.emit(toolCallStarted("t1", "Read"));
  await expect.poll(() => store.snapshot().view.rows).toHaveLength(1);
  store.stop();
});

test("every warning is counted, never coalesced away", async () => {
  const { live, store } = makeStore();
  const { result } = await renderHook(() => useConnection(store));
  store.start();
  await expect.poll(() => result.current.state).toBe("live");

  live.emit(badTokenDelta());
  live.emit(badTokenDelta());
  live.emit(badTokenDelta());

  // Two errors inside one frame collapse to one on any coalesced channel, and
  // an error followed by a success vanishes entirely. This counts all three.
  await expect.poll(() => result.current.warningCount).toBe(3);
  store.stop();
});

test("useSessionViewErrors delivers every error in order and stops on unmount", async () => {
  const { live, store } = makeStore();
  const seen: string[] = [];
  const { unmount } = await renderHook(() =>
    useSessionViewErrors(store, (error) => {
      seen.push(error.name);
    }),
  );
  store.start();
  await expect.poll(() => store.isActive()).toBe(true);

  live.emit(badTokenDelta());
  live.emit(badTokenDelta());
  await expect.poll(() => seen).toStrictEqual(["FoldError", "FoldError"]);

  await unmount();
  live.emit(badTokenDelta());
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(seen).toStrictEqual(["FoldError", "FoldError"]);
  store.stop();
});

test("useSessionViewErrors does not resubscribe for a fresh listener arrow", async () => {
  const { live, store } = makeStore();
  const seen: string[] = [];
  let subscriptions = 0;
  const original = store.subscribeErrors.bind(store);
  store.subscribeErrors = (listener): (() => void) => {
    subscriptions += 1;
    return original(listener);
  };
  // Every real call site passes an inline arrow, so a hook that depended on the
  // listener's identity would tear down and reopen on every single render — and
  // an error delivered in that window would be lost.
  const { rerender } = await renderHook(() =>
    useSessionViewErrors(store, (error) => {
      seen.push(error.name);
    }),
  );
  store.start();
  await expect.poll(() => store.isActive()).toBe(true);

  await rerender();
  await rerender();
  live.emit(badTokenDelta());

  await expect.poll(() => seen).toStrictEqual(["FoldError"]);
  expect(subscriptions).toBe(1);
  store.stop();
});

test("a fold error in the same turn as a teardown is still a warning, not the failure", async () => {
  const { live, store } = makeStore();
  const { result } = await renderHook(() => useConnection(store));
  store.start();
  await expect.poll(() => result.current.state).toBe("live");
  // A handler that tears the session down the moment anything goes wrong, so
  // the stop() lands in the SAME synchronous turn as the error. Subscribed
  // after the connection store, so it runs after it.
  const off = store.subscribeErrors(() => {
    store.stop();
  });

  live.emit(badTokenDelta());

  // Without the FoldError fast path this reports "failed" with a FoldError as
  // the cause: the candidate is still pending when the liveness transition
  // arrives, so the classifier promotes it. fold.ts's contract says a
  // FoldError NEVER ends the join, so it can never be the failure that did.
  await expect.poll(() => result.current.state).toBe("closed");
  expect(result.current.failure).toBeNull();
  expect(result.current.warningCount).toBe(1);
  off();
});
