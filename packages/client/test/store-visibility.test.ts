/**
 * The hidden-tab hang, and the visibility handoff that closes it.
 *
 * This is not a slowdown, it is a freeze. Every browser throttles a hidden
 * tab's `requestAnimationFrame` to a standstill, and a callback scheduled just
 * BEFORE the tab hides never fires at all and never falls through to anything
 * else. A store that only ever used rAF would therefore stop publishing the
 * instant the user switched tabs and would not resume until they came back —
 * freezing the transcript AND any open permission gate, indefinitely.
 *
 * Two separate guarantees, tested separately:
 *
 *  1. `browserFrameScheduler` picks a ~33 ms timer over rAF while
 *     `document.hidden`. Tested with stubbed globals and fake timers, including
 *     one case that drives a whole store through a rAF stub which NEVER invokes
 *     its callback — the faithful model of a hidden tab — and proves the store
 *     still publishes.
 *  2. `SessionViewStore` cancels its pending handle on `visibilitychange` and
 *     re-schedules on whichever timer the NEW state selects. Switching
 *     schedulers without cancelling is not enough: the dead handle would still
 *     be the store's `frame`, so `publish()` would believe a frame is already
 *     scheduled and never ask for another.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionViewStore, browserFrameScheduler } from "../src/store.js";
import {
  controllableLive,
  emptyPage,
  manualScheduler,
  microtasks,
  textFrame,
  tick,
} from "./store-fakes.js";
import { LOOP_A } from "./helpers.js";

function makeStore() {
  const scheduler = manualScheduler();
  const live = controllableLive();
  const store = new SessionViewStore({
    journal: { readHistory: async () => emptyPage },
    sessionId: "s1",
    liveSource: live.source,
    scheduler,
  });
  return { scheduler, live, store };
}

/** A hidden document whose listeners are inert: the store registers, nothing fires. */
function stubDocument(hidden: boolean): { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> } {
  const doc = { hidden, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("document", doc);
  return doc;
}

describe("SessionViewStore: hidden tab", () => {
  it("cancels the pending frame and re-schedules when the tab hides", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    expect(scheduler.pendingCount()).toBe(1);

    // The frame scheduled on the line above would never fire once hidden.
    scheduler.setHidden(true);
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "a" });
    store.stop();
  });

  it("re-schedules again when the tab becomes visible", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    scheduler.setHidden(true);
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.setHidden(false);
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("leaves exactly one live handle after a visibility change", async () => {
    const { scheduler, live, store } = makeStore();
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.setHidden(true);
    // The dead handle must be cancelled, not merely abandoned, or a later
    // stop() would cancel the WRONG handle and leave a callback live.
    expect(scheduler.pendingCount()).toBe(1);
    store.stop();
  });

  it("does not schedule anything on a visibility change with nothing pending", async () => {
    const { scheduler, store } = makeStore();
    store.start();
    await tick();
    scheduler.setHidden(true);
    expect(scheduler.pendingCount()).toBe(0);
    store.stop();
  });

  it("unsubscribes from visibilitychange on stop()", async () => {
    const { scheduler, store } = makeStore();
    store.start();
    await tick();
    expect(scheduler.visibilityListenerCount()).toBe(1);
    store.stop();
    expect(scheduler.visibilityListenerCount()).toBe(0);
  });

  it("unsubscribes from visibilitychange when the stream ends on its own", async () => {
    const scheduler = manualScheduler();
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: live.source,
      scheduler,
      join: { autoReconnect: false },
    });
    store.start();
    await tick();
    expect(scheduler.visibilityListenerCount()).toBe(1);
    live.close();
    await tick();
    await tick();
    expect(store.isActive()).toBe(false);
    expect(scheduler.visibilityListenerCount()).toBe(0);
  });

  it("registers a fresh listener on a restart without leaking the old one", async () => {
    const { scheduler, store } = makeStore();
    store.start();
    await tick();
    store.stop();
    store.start();
    await tick();
    expect(scheduler.visibilityListenerCount()).toBe(1);
    store.stop();
    expect(scheduler.visibilityListenerCount()).toBe(0);
  });

  it("keeps publishing while the tab is hidden, where rAF never fires at all", async () => {
    vi.useFakeTimers();
    stubDocument(true);
    // The faithful model of a hidden tab: a handle is minted and the callback
    // is NEVER invoked. If the scheduler reaches for rAF here, the store hangs.
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const live = controllableLive();
      const store = new SessionViewStore({
        journal: { readHistory: async () => emptyPage },
        sessionId: "s1",
        liveSource: live.source,
        scheduler: browserFrameScheduler(),
      });
      const notified = vi.fn();
      store.subscribe(notified);
      store.start();
      await microtasks();
      live.push(textFrame("a", LOOP_A));
      await microtasks();

      expect(raf).not.toHaveBeenCalled();
      expect(notified).not.toHaveBeenCalled();
      vi.advanceTimersByTime(32);
      expect(notified).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(notified).toHaveBeenCalledTimes(1);
      expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "a" });
      store.stop();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("browserFrameScheduler", () => {
  it("uses a ~33 ms timer instead of rAF while the document is hidden", () => {
    vi.useFakeTimers();
    stubDocument(true);
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    try {
      const scheduler = browserFrameScheduler();
      expect(scheduler.isHidden()).toBe(true);
      const callback = vi.fn();
      scheduler.schedule(callback);
      expect(raf).not.toHaveBeenCalled();
      vi.advanceTimersByTime(32);
      expect(callback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("uses rAF while the document is visible", () => {
    stubDocument(false);
    const raf = vi.fn(() => 7);
    vi.stubGlobal("requestAnimationFrame", raf);
    try {
      const callback = (): void => {};
      expect(browserFrameScheduler().schedule(callback)).toBe(7);
      expect(raf).toHaveBeenCalledWith(callback);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-reads document.hidden per call, so one scheduler spans a visibility change", () => {
    vi.useFakeTimers();
    const doc = { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
    try {
      const scheduler = browserFrameScheduler();
      expect(scheduler.isHidden()).toBe(false);
      doc.hidden = true;
      expect(scheduler.isHidden()).toBe(true);
      const callback = vi.fn();
      scheduler.schedule(callback);
      vi.advanceTimersByTime(33);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("cancels through BOTH cancellers, because the handle spaces are independent", () => {
    stubDocument(false);
    const caf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 3));
    vi.stubGlobal("cancelAnimationFrame", caf);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      browserFrameScheduler().cancel(3);
      expect(caf).toHaveBeenCalledWith(3);
      expect(clear).toHaveBeenCalledWith(3);
    } finally {
      clear.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("actually cancels a hidden-tab timer handle", () => {
    vi.useFakeTimers();
    stubDocument(true);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const scheduler = browserFrameScheduler();
      const callback = vi.fn();
      scheduler.cancel(scheduler.schedule(callback));
      vi.advanceTimersByTime(100);
      expect(callback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("registers and unregisters a visibilitychange listener", () => {
    const doc = stubDocument(false);
    try {
      const off = browserFrameScheduler().onVisibilityChange(() => {});
      expect(doc.addEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
      const handler = doc.addEventListener.mock.calls[0]?.[1] as unknown;
      off();
      expect(doc.removeEventListener).toHaveBeenCalledWith("visibilitychange", handler);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("degrades to a timer with no DOM at all (Node, SSR)", () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    try {
      const scheduler = browserFrameScheduler();
      expect(scheduler.isHidden()).toBe(false);
      expect(scheduler.onVisibilityChange(() => {})).toBeTypeOf("function");
      const callback = vi.fn();
      scheduler.schedule(callback);
      vi.advanceTimersByTime(50);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
