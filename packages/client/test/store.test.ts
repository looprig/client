/**
 * `SessionViewStore`'s lifecycle: the continuous pump, the version-stamped
 * snapshot, and the teardown carried from client/sdk/svelte's
 * `LiveSessionViewStore`.
 *
 * The three teardown properties are the hard-won ones and each has its own case
 * here: `stop()` cancels the LIVE iterator directly (a `.return()` on the join
 * generator queues behind its parked `.next()` and never lands), it aborts the
 * store's own `AbortController` synchronously (or `autoReconnect` reopens the
 * moment the cascade completes), and a generation counter stops a superseded
 * pump from clobbering a newer `start()`.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionViewStore } from "../src/store.js";
import { controllableLive, emptyPage, manualScheduler, pageOf, textFrame, tick } from "./store-fakes.js";
import { LOOP_A, envelope } from "./helpers.js";

describe("SessionViewStore", () => {
  it("exposes a version-stamped snapshot whose reference changes only at notify", async () => {
    const scheduler = manualScheduler();
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: {
        readHistory: async () =>
          pageOf([{ journal_seq: 0, event: envelope({ type: "TurnDone", loopId: LOOP_A }) }]),
      },
      sessionId: "s1",
      liveSource: live.source,
      scheduler,
    });
    const first = store.snapshot();
    expect(first.version).toBe(0);

    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();

    // The pump has run; nothing is published until the frame fires.
    expect(store.snapshot()).toBe(first);
    expect(notified).not.toHaveBeenCalled();

    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);
    const second = store.snapshot();
    expect(second).not.toBe(first);
    expect(second.version).toBe(1);
    // Two reads with no intervening notify return the SAME object. React's
    // useSyncExternalStore throws "The result of getSnapshot should be cached
    // to avoid an infinite loop" the instant this stops holding.
    expect(store.snapshot()).toBe(second);
    expect(store.snapshot()).toBe(second);
    store.stop();
  });

  it("pumps the join CONTINUOUSLY, even while no frame has fired", async () => {
    const scheduler = manualScheduler();
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: live.source,
      scheduler,
    });
    store.start();
    await tick();
    for (const text of ["a", "b", "c"]) {
      live.push(textFrame(text, LOOP_A));
      await tick();
    }
    // No flush until now — but every frame was FOLDED as it arrived, not
    // queued behind a throttle. fold() runs inside joinSessionView's generator
    // body, so throttling the pump rather than the notify freezes it entirely.
    scheduler.flush();
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "abc" });
    store.stop();
  });

  it("stop() cancels the live iterator directly and opens no reconnect", async () => {
    const scheduler = manualScheduler();
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: live.source,
      scheduler,
      join: { autoReconnect: true, reconnectDelayMs: 0 },
    });
    store.start();
    await tick();
    expect(live.opens()).toBe(1);

    // The connection is parked in next() with nothing in flight — the exact
    // state in which a .return() on the JOIN generator never lands.
    store.stop();
    await tick();
    await tick();

    expect(live.returns()).toBeGreaterThan(0);
    expect(live.opens()).toBe(1);
    expect(store.isActive()).toBe(false);
  });

  it("discards a superseded pump: an old loop cannot clobber a newer start()", async () => {
    const scheduler = manualScheduler();
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: live.source,
      scheduler,
    });
    store.start();
    await tick();
    live.push(textFrame("stale", LOOP_A));
    store.stop();
    store.start();
    await tick();
    scheduler.flush();
    expect(store.snapshot().view.rows).toStrictEqual([]);
    store.stop();
  });

  it("start() is idempotent while already active", async () => {
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: live.source,
      scheduler: manualScheduler(),
    });
    store.start();
    store.start();
    await tick();
    expect(live.opens()).toBe(1);
    store.stop();
  });

  it("threads its abort signal into every readHistory call", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: {
        readHistory: async (_sessionId, options) => {
          seen.push(options?.signal);
          return emptyPage;
        },
      },
      sessionId: "s1",
      liveSource: live.source,
      scheduler: manualScheduler(),
    });
    store.start();
    await tick();
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    store.stop();
    expect(seen[0]?.aborted).toBe(true);
  });

  it("unsubscribing a listener stops delivery to it alone", async () => {
    const scheduler = manualScheduler();
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: live.source,
      scheduler,
    });
    const kept = vi.fn();
    const dropped = vi.fn();
    store.subscribe(kept);
    const off = store.subscribe(dropped);
    off();
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.flush();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
    store.stop();
  });

  it("stop() is safe when never started", () => {
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: controllableLive().source,
      scheduler: manualScheduler(),
    });
    expect(() => {
      store.stop();
    }).not.toThrow();
    expect(store.isActive()).toBe(false);
    expect(store.snapshot().version).toBe(0);
  });
});
