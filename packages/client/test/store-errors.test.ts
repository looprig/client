/**
 * Fold errors are EVENTS, not state.
 *
 * Coalescing state would hide them exactly as batching inside `join` would: two
 * errors inside one frame collapse to a single observable value, and an error
 * immediately followed by a success vanishes entirely, because the view
 * published at the end of the frame carries no trace of it. So they get their
 * own channel, deliberately NOT coalesced — delivered synchronously, in order,
 * at the moment they are folded.
 *
 * A `FoldError` is non-fatal (fold.ts's contract is that the loop keeps going
 * past one bad input) and the store stays active. A FATAL join failure arrives
 * on the SAME channel as a plain `Error` and IS followed by the store going
 * inactive; `isActive()` is how a consumer tells them apart.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionViewStore } from "../src/store.js";
import { FoldError } from "../src/fold.js";
import {
  badFrame,
  controllableLive,
  emptyPage,
  enduringFrame,
  manualScheduler,
  textFrame,
  tick,
} from "./store-fakes.js";
import { LOOP_A, envelope } from "./helpers.js";
import type { EventJournalPage } from "../src/types.js";

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

describe("SessionViewStore: fold errors", () => {
  it("delivers every fold error immediately, without waiting for a frame", async () => {
    const { live, store } = makeStore();
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    // No scheduler.flush(): errors are deliberately NOT coalesced.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(FoldError);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      name: "FoldError",
      reason: "unknown_chunk_type",
    });
    store.stop();
  });

  it("delivers EVERY error, never collapsing two in one frame into one", async () => {
    const { live, store } = makeStore();
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    expect(onError).toHaveBeenCalledTimes(2);
    store.stop();
  });

  it("does not lose an error that a success follows in the same frame", async () => {
    const { scheduler, live, store } = makeStore();
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    live.push(textFrame("recovered", LOOP_A));
    await tick();
    // One frame covers both. The view published at the end of it carries no
    // trace of the failure, which is exactly why this channel exists.
    scheduler.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "recovered" });
    store.stop();
  });

  it("a fold error does NOT stop the join", async () => {
    const { scheduler, live, store } = makeStore();
    store.subscribeErrors(() => {});
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    live.push(textFrame("still going", LOOP_A));
    await tick();
    scheduler.flush();
    expect(store.isActive()).toBe(true);
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "still going" });
    store.stop();
  });

  it("reports a FATAL join error on the same channel and goes inactive", async () => {
    const store = new SessionViewStore({
      journal: {
        readHistory: async () => {
          throw new Error("journal is down");
        },
      },
      sessionId: "s1",
      liveSource: controllableLive().source,
      scheduler: manualScheduler(),
      join: { autoReconnect: false },
    });
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    await tick();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "journal is down" }));
    expect(onError.mock.calls[0]?.[0]).not.toBeInstanceOf(FoldError);
    expect(store.isActive()).toBe(false);
  });

  it("does not throw when nobody is listening", async () => {
    const { live, store } = makeStore();
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    expect(store.isActive()).toBe(true);
    store.stop();
  });

  it("unsubscribing stops delivery", async () => {
    const { live, store } = makeStore();
    const onError = vi.fn();
    const off = store.subscribeErrors(onError);
    store.start();
    await tick();
    off();
    live.push(badFrame(LOOP_A));
    await tick();
    expect(onError).not.toHaveBeenCalled();
    store.stop();
  });

  it("does not report an error from a SUPERSEDED pump", async () => {
    const { live, store } = makeStore();
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    live.push(badFrame(LOOP_A));
    store.stop();
    store.start();
    await tick();
    expect(onError).not.toHaveBeenCalled();
    store.stop();
  });

  it("still publishes the view a failed fold left untouched", async () => {
    const { scheduler, live, store } = makeStore();
    store.subscribeErrors(() => {});
    store.start();
    await tick();
    live.push(textFrame("kept", LOOP_A));
    await tick();
    live.push(badFrame(LOOP_A));
    await tick();
    scheduler.flush();
    // join yields the PREVIOUS view on a failed fold, and a failed fold appends
    // nothing — so the last good state survives the error untouched.
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "kept" });
    store.stop();
  });
});

/**
 * The binding state is a THIRD channel, next to the view and the errors.
 *
 * `repair_required` is neither a fold error (it is not about one bad input, and
 * the join keeps running) nor view state (a view carries no trace of a frame
 * that was never applied). It is a property of the binding, so it gets its own
 * transitions-only channel — and, like `subscribeErrors`, it is not coalesced.
 */
describe("SessionViewStore: binding state", () => {
  const enduring = (seq: number) =>
    enduringFrame(seq, envelope({ type: "TurnDone", loopId: LOOP_A }));

  function floodedStore(overrides: Record<string, unknown> = {}) {
    const scheduler = manualScheduler();
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: live.source,
      scheduler,
      maxQueuedFrames: 2,
      ...overrides,
    });
    return { scheduler, live, store };
  }

  it("starts live and stays live under an ephemeral flood", async () => {
    const { live, store } = floodedStore();
    const states: string[] = [];
    store.subscribeBindingState((state) => states.push(state));
    store.subscribeErrors(() => {});
    expect(store.bindingState()).toBe("live");
    store.start();
    await tick();
    for (let i = 0; i < 40; i++) live.push(textFrame(String(i), LOOP_A));
    await tick();
    expect(store.bindingState()).toBe("live");
    expect(states).toStrictEqual([]);
    store.stop();
  });

  it("transitions to repair_required when the enduring backlog cannot be evicted", async () => {
    const { store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
      join: { autoReconnect: false },
    });
    const states: string[] = [];
    store.subscribeBindingState((state) => states.push(state));
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    for (let i = 0; i < 6; i++) await tick();
    // With `autoReconnect` off the refusal is terminal, so the binding reports
    // the repair AND then that nothing is still attempting it.
    expect(states).toStrictEqual(["repair_required", "inactive"]);
    expect(store.bindingState()).toBe("inactive");
    expect(store.isActive()).toBe(false);
    // Surfaced on the error channel too — a repair the user cannot see is
    // indistinguishable from a session that quietly stopped catching up — and
    // exactly ONCE, not once as an echo and again as the fatal join failure.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: "LiveQueueOverflowError" }));
  });

  it("damps the error echo while the state channel keeps reporting every flap", async () => {
    // A backlog that repair cannot fix re-enters the episode once per
    // reconnect. The STATE must keep telling the truth about that; the error
    // channel must not turn it into a notification storm on an already
    // overloaded main thread.
    const { store } = floodedStore({
      liveSource: floodSource(),
      join: { autoReconnect: true, reconnectDelayMs: 0, maxRepairAttempts: 64 },
    });
    const states: string[] = [];
    store.subscribeBindingState((state) => states.push(state));
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    for (let i = 0; i < 40; i++) await tick();

    const episodes = states.filter((state) => state === "repair_required").length;
    const overflows = onError.mock.calls.filter(
      ([error]) => (error as Error).name === "LiveQueueOverflowError",
    ).length;
    expect(episodes).toBeGreaterThan(2);
    // Doubling schedule: the 1st, 2nd, 4th, 8th ... episode, so strictly fewer
    // reports than episodes the moment there are more than two.
    expect(overflows).toBeGreaterThan(0);
    expect(overflows).toBeLessThan(episodes);
    store.stop();
  });

  it("does not flap once per round trip while the journal is ADVANCING", async () => {
    // B3. The first throttle keyed on journal cursor progress, and a session
    // busy enough to overflow the live buffer is a session whose journal is
    // advancing — so every refusal scored as progress, the streak never got
    // past 1, the backoff stayed at its zero-th step and `reconnectDelayMs`
    // was dead code on this path. Measured then: 783 episodes and 783 cold
    // reads per SECOND, one full subscribe/REST cycle per round trip.
    //
    // Asserted on the ADVANCING journal specifically, because the stuck one
    // passed throughout and is what made the defect invisible.
    let coldReads = 0;
    let journalSeq = 0;
    const { store } = floodedStore({
      journal: {
        readHistory: async () => {
          coldReads += 1;
          journalSeq += 1;
          return { events: [], next_journal_seq: journalSeq, done: true } as unknown as EventJournalPage;
        },
      },
      liveSource: floodSource(),
      join: { autoReconnect: true, reconnectDelayMs: 250, maxRepairAttempts: 1_000 },
    });
    const states: string[] = [];
    store.subscribeBindingState((state) => states.push(state));
    store.subscribeErrors(() => {});
    store.start();
    const started = Date.now();
    while (Date.now() - started < 250) await tick();

    const episodes = states.filter((state) => state === "repair_required").length;
    expect(episodes).toBeGreaterThan(0);
    // Single digits over a quarter second. The unfixed build produced ~195
    // here, and one cold read per episode is a REST call per round trip.
    expect(episodes).toBeLessThan(10);
    expect(coldReads).toBeLessThan(10);
    store.stop();
  });

  it("spaces consecutive refusals out, instead of spending the cap in milliseconds", async () => {
    // The backoff SCHEDULE, pinned black-box. It is not merely how far apart
    // attempts sit: it is what buys a transient overload time to clear before
    // `maxRepairAttempts` fires. With the schedule, a binding is still alive
    // after 250 ms having used two attempts; with the backoff flattened to
    // zero it burns the whole cap in tens of milliseconds and is already dead.
    const { store } = floodedStore({
      liveSource: floodSource(),
      join: { autoReconnect: true, reconnectDelayMs: 250, maxRepairAttempts: 32 },
    });
    const states: string[] = [];
    store.subscribeBindingState((state) => states.push(state));
    store.subscribeErrors(() => {});
    store.start();
    const started = Date.now();
    while (Date.now() - started < 250) await tick();

    expect(store.isActive()).toBe(true);
    expect(store.bindingState()).not.toBe("inactive");
    expect(states.filter((state) => state === "repair_required").length).toBeLessThan(5);
    store.stop();
  });

  it("gives up instead of flapping forever when the backlog never clears", async () => {
    const { store } = floodedStore({
      liveSource: floodSource(),
      join: { autoReconnect: true, reconnectDelayMs: 0, maxRepairAttempts: 2 },
    });
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    for (let i = 0; i < 40; i++) await tick();
    expect(store.isActive()).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("without recovering") }),
    );
    expect(store.bindingState()).toBe("inactive");
  });

  it("a repair does NOT stop the join and does not fabricate view state", async () => {
    const { scheduler, store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
    });
    store.subscribeErrors(() => {});
    store.start();
    for (let i = 0; i < 6; i++) await tick();
    scheduler.flush();
    expect(store.isActive()).toBe(true);
    // The refused frames were never applied: nothing claims they were.
    expect(store.snapshot().view.rows).toStrictEqual([]);
    store.stop();
  });

  it("re-arms to live on a restart", async () => {
    const { store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
      join: { autoReconnect: false },
    });
    const states: string[] = [];
    store.subscribeBindingState((state) => states.push(state));
    store.subscribeErrors(() => {});
    store.start();
    for (let i = 0; i < 6; i++) await tick();
    expect(states).toStrictEqual(["repair_required", "inactive"]);
    store.start();
    expect(states).toStrictEqual(["repair_required", "inactive", "live"]);
    expect(store.bindingState()).toBe("live");
    store.stop();
  });

  it("a SUPERSEDED join cannot flip the binding state", async () => {
    const { store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
    });
    const states: string[] = [];
    store.subscribeErrors(() => {});
    store.start();
    store.subscribeBindingState((state) => states.push(state));
    store.stop();
    for (let i = 0; i < 6; i++) await tick();
    // `stop()` itself is a real transition and is announced. What must NOT
    // arrive is the refusal from the join the stop superseded.
    expect(states).toStrictEqual(["inactive"]);
    expect(states).not.toContain("repair_required");
    expect(store.bindingState()).toBe("inactive");
  });

  it("unsubscribing stops binding-state delivery", async () => {
    const { store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
    });
    const states: string[] = [];
    const off = store.subscribeBindingState((state) => states.push(state));
    store.subscribeErrors(() => {});
    off();
    store.start();
    for (let i = 0; i < 6; i++) await tick();
    expect(states).toStrictEqual([]);
    expect(store.bindingState()).toBe("repair_required");
    store.stop();
  });

  it("does not leave a stopped binding reporting a repair nothing is attempting", async () => {
    const { store } = floodedStore({
      liveSource: burstOf([enduring(1), enduring(2), enduring(3), enduring(4), enduring(5)]),
    });
    store.subscribeErrors(() => {});
    store.start();
    for (let i = 0; i < 6; i++) await tick();
    expect(store.bindingState()).toBe("repair_required");
    store.stop();
    // A badge wired to this channel ALONE must not read "repairing" forever on
    // a store that is not running.
    expect(store.bindingState()).toBe("inactive");
  });
});

/**
 * Five undroppable frames per connection, each above the last, and then the
 * connection STAYS OPEN.
 *
 * This is the shape of a producer the consumer cannot keep up with, and it is
 * the fixture the B3 regression needs: a source that ENDS lets a later
 * connection drain without refusing, which is a recovery and legitimately
 * resets the refusal streak. Sequence numbers keep climbing so the tip filter
 * never starts discarding the flood for free.
 */
function floodSource(): () => AsyncIterable<unknown> {
  let seq = 1_000_000;
  return () => ({
    [Symbol.asyncIterator]: () => {
      let emitted = 0;
      return {
        next: async () =>
          emitted++ < 5
            ? { value: enduringFrame(++seq, envelope({ type: "TurnDone", loopId: LOOP_A })), done: false as const }
            : new Promise<never>(() => {}),
      };
    },
  });
}

/** A source that yields an already-resolved burst, then stays closed. */
function burstOf(frames: readonly unknown[]) {
  return () => ({
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () =>
          index < frames.length
            ? { value: frames[index++], done: false as const }
            : { value: undefined, done: true as const },
      };
    },
  });
}
