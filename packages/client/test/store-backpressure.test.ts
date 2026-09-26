/**
 * The live frame queue is BOUNDED, and the bound is LOSSLESS BY REPAIR.
 *
 * Two halves. Ephemeral and heartbeat frames are evicted under pressure and
 * every eviction is reported (`onQueueOverflow`) — losing one is already a
 * tolerated condition, since a reconnect replays enduring frames only and the
 * following `StepDone` snaps the live segment wholesale. Durable frames —
 * `enduring`, and `error`, which may BE an unparseable enduring frame — are
 * never evicted: the queue discards its buffer unapplied and the binding
 * repairs from its last committed journal sequence.
 *
 * U2.2 inverted the second half. It used to drop the oldest enduring frame and
 * report it, which is silent durable loss with a receipt attached: nothing
 * re-delivers the frame and the reconnect cursor advances past it as soon as a
 * later frame is applied, so the transcript had a hole AND a persisted cursor
 * asserting the hole was covered.
 *
 * `join.ts`'s internal `AsyncQueue.push()` never blocks and had no drop policy,
 * so the buffer grew for exactly as long as the network outran `fold` — on a
 * busy main thread, until the tab died.
 *
 * ## Why the bound is inside `join` and not a wrapper around `liveSource`
 *
 * The obvious shape is a `boundedLiveSource(inner, max, onOverflow)` the store
 * wraps its source in. It CANNOT work, and this was measured rather than
 * argued: `pumpLiveConnection` is a trivial relay that awaits the source and
 * immediately pushes into the queue, so it is never the slow stage. A wrapper
 * upstream of it is asked for exactly one frame at a time and its own buffer
 * never exceeds one frame — it reports zero overflows while `join`'s queue,
 * downstream of it, grows without limit. The backlog forms where the slow stage
 * is, and the slow stage is `fold`, inside the generator body.
 *
 * The overflow case below is therefore driven by suspending the join generator
 * (the consumer) while its pump keeps relaying, which is exactly the real
 * shape of the problem and is fully deterministic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_QUEUED_FRAMES,
  joinSessionView,
  selectFrameToDrop,
  type JournalReader,
  type LiveFrameSource,
} from "../src/join.js";
import { SessionViewStore } from "../src/store.js";
import type { SseFrame } from "../src/sse.js";
import {
  controllableLive,
  emptyPage,
  enduringFrame,
  errorFrame,
  heartbeatFrame,
  manualScheduler,
  microtasks,
  pageOf,
  textFrame,
  tick,
} from "./store-fakes.js";
import { LOOP_A, LOOP_B, envelope } from "./helpers.js";

const enduring = (seq: number): SseFrame => enduringFrame(seq, envelope({ type: "TurnDone", loopId: LOOP_A }));

describe("selectFrameToDrop", () => {
  it("drops a heartbeat before anything else — it carries no content at all", () => {
    const frames = [enduring(1), textFrame("a", LOOP_A), heartbeatFrame(), errorFrame("x")];
    expect(selectFrameToDrop(frames as never)).toBe(2);
  });

  it("drops the OLDEST ephemeral frame once no heartbeat remains", () => {
    const frames = [enduring(1), textFrame("a", LOOP_A), textFrame("b", LOOP_A), errorFrame("x")];
    expect(selectFrameToDrop(frames as never)).toBe(1);
  });

  it("never drops an enduring frame while any ephemeral frame remains", () => {
    const frames = [textFrame("a", LOOP_A), enduring(1), enduring(2)];
    expect(selectFrameToDrop(frames as never)).toBe(0);
  });

  it("names NO victim rather than the oldest enduring frame once nothing cheaper remains", () => {
    // The inversion. Before U2.2 this returned 1 -- the oldest enduring frame,
    // dropped and never re-delivered, with the reconnect cursor free to walk
    // past it. -1 is "nothing here may be dropped", which is what makes the
    // queue repair instead.
    const frames = [errorFrame("x"), enduring(1), enduring(2)];
    expect(selectFrameToDrop(frames as never)).toBe(-1);
  });

  it("names NO victim in a buffer of error frames either", () => {
    // An error frame is a frame that failed to parse. It MAY have been an
    // enduring event, and nothing can tell after the fact, so it is outside the
    // eviction domain for the same reason: dropping it loses durable content
    // silently. Before U2.2 this returned 0.
    const frames = [errorFrame("x"), errorFrame("y")];
    expect(selectFrameToDrop(frames as never)).toBe(-1);
  });

  it("returns index 0 for a single droppable frame and -1 for a single durable one", () => {
    for (const frame of [heartbeatFrame(), textFrame("a", LOOP_A)]) {
      expect(selectFrameToDrop([frame] as never)).toBe(0);
    }
    for (const frame of [enduring(1), errorFrame("x")]) {
      expect(selectFrameToDrop([frame] as never)).toBe(-1);
    }
  });

  it("defaults the bound to roughly eight seconds of a fast token stream", () => {
    expect(DEFAULT_MAX_QUEUED_FRAMES).toBe(512);
  });
});

/**
 * Parks the join generator at a `yield` with its pump still running, which is
 * the exact state in which the queue backs up. Returns the parked generator and
 * the live handle so the caller can keep pushing into a consumer that is not
 * reading.
 */
async function parkedJoin(options: Record<string, unknown>, journal?: JournalReader) {
  const live = controllableLive();
  const generator = joinSessionView(
    journal ?? { readHistory: async () => emptyPage },
    "s1",
    live.source,
    { autoReconnect: false, ...options } as never,
  );
  const first = generator.next();
  await tick();
  live.push(textFrame("prime", LOOP_A));
  await first;
  // The generator is now suspended at its yield; its pump keeps relaying.
  return { generator, live };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("joinSessionView: bounded live queue", () => {
  it("drops frames and reports a cumulative, ascending total once over the bound", async () => {
    const onQueueOverflow = vi.fn();
    const { generator, live } = await parkedJoin({ maxQueuedFrames: 4, onQueueOverflow });
    for (let i = 0; i < 20; i++) live.push(textFrame(String(i), LOOP_A));
    await tick();

    const totals = onQueueOverflow.mock.calls.map((call) => call[0] as number);
    expect(totals).toStrictEqual([...totals].sort((a, b) => a - b));
    expect(totals.at(-1)).toBe(16);
    await generator.return();
  });

  it("does not report anything while the backlog stays under the bound", async () => {
    const onQueueOverflow = vi.fn();
    const { generator, live } = await parkedJoin({ maxQueuedFrames: 8, onQueueOverflow });
    for (let i = 0; i < 8; i++) live.push(textFrame(String(i), LOOP_A));
    await tick();
    expect(onQueueOverflow).not.toHaveBeenCalled();
    await generator.return();
  });

  it("keeps the enduring frames and drops the ephemeral ones around them", async () => {
    const onQueueOverflow = vi.fn();
    const { generator, live } = await parkedJoin({ maxQueuedFrames: 3, onQueueOverflow });
    live.push(enduring(10));
    for (let i = 0; i < 10; i++) live.push(textFrame(String(i), LOOP_A));
    live.push(enduring(11));
    await tick();
    expect(onQueueOverflow).toHaveBeenCalled();

    // Resume the consumer and collect what actually survived the backlog.
    const seen: SseFrame[] = [];
    for (let i = 0; i < 3; i++) {
      const next = await generator.next();
      if (next.done === true) break;
      if (next.value.input.segment === "live") seen.push(next.value.input.frame);
    }
    const enduringSeqs = seen
      .filter((frame): frame is Extract<SseFrame, { type: "enduring" }> => frame.type === "enduring")
      .map((frame) => frame.journalSeq);
    expect(enduringSeqs).toStrictEqual([10, 11]);
    await generator.return();
  });

  it("repairs instead of dropping an enduring frame the buffer cannot make room for", async () => {
    // THE INVERSION, at the level that matters. Three enduring frames into a
    // two-frame buffer used to evict the oldest and report a drop; the durable
    // event was gone and the reconnect cursor was free to walk past it.
    const onQueueOverflow = vi.fn();
    const states: string[] = [];
    const { generator, live } = await parkedJoin({
      maxQueuedFrames: 2,
      onQueueOverflow,
      onBindingState: (state: string) => states.push(state),
    });
    live.push(enduring(10));
    live.push(enduring(11));
    live.push(enduring(12));
    await tick();

    expect(states).toStrictEqual(["repair_required"]);
    // Nothing was DROPPED: a drop report would be the store telling a consumer
    // "this many frames are gone", which is exactly the claim U2.2 removes.
    expect(onQueueOverflow).not.toHaveBeenCalled();
    await generator.return();
  });

  it("does not repair while an ephemeral frame is still available to evict", async () => {
    const onQueueOverflow = vi.fn();
    const states: string[] = [];
    const { generator, live } = await parkedJoin({
      maxQueuedFrames: 2,
      onQueueOverflow,
      onBindingState: (state: string) => states.push(state),
    });
    live.push(enduring(10));
    live.push(enduring(11));
    live.push(textFrame("a", LOOP_A));
    await tick();
    expect(states).toStrictEqual([]);
    expect(onQueueOverflow).toHaveBeenCalledWith(1);
    await generator.return();
  });

  it("re-reads the overflowed sequences from the LAST COMMITTED cursor, never past them", async () => {
    // Lossless-by-repair, end to end: the frames the queue refused to drop come
    // back through the cold journal, from the cursor the join had actually
    // committed -- not from the sequence of the frame it was holding.
    const requested: number[] = [];
    let call = 0;
    const journal: JournalReader = {
      readHistory: async (_sid, options) => {
        requested.push(options?.fromJournalSeq ?? 0);
        call += 1;
        if (call === 1) return pageOf([]);
        return pageOf([
          envelope({ type: "TurnDone", loopId: LOOP_A }),
          envelope({ type: "TurnDone", loopId: LOOP_A }),
          envelope({ type: "TurnDone", loopId: LOOP_A }),
        ]);
      },
    };
    const states: string[] = [];
    const { generator, live } = await parkedJoin(
      {
        maxQueuedFrames: 2,
        autoReconnect: true,
        reconnectDelayMs: 0,
        onBindingState: (state: string) => states.push(state),
      },
      journal,
    );
    live.push(enduring(0));
    live.push(enduring(1));
    live.push(enduring(2));
    await tick();
    expect(states).toStrictEqual(["repair_required"]);

    // Resume the consumer. The refused buffer must have CLOSED the queue: a
    // queue that merely stopped accepting would leave the join parked at
    // `queue.next()` forever, so this first read is raced against a real timer
    // rather than awaited, and a stall is an assertion failure, not a hang.
    const seen: unknown[] = [];
    const first = await Promise.race([
      generator.next().then((next) => {
        if (next.done !== true) seen.push(next.value.input);
        return next.done === true ? "ended" : "event";
      }),
      new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 200)),
    ]);
    expect(first).toBe("event");
    for (let i = 0; i < 2; i++) {
      const next = await generator.next();
      if (next.done === true) break;
      seen.push(next.value.input);
    }
    expect(requested).toStrictEqual([0, 0]);
    expect(seen).toHaveLength(3);
    expect(states).toStrictEqual(["repair_required", "live"]);
    await generator.return();
  });

  it("announces repair_required ONCE across two overflows with no repair in between", async () => {
    // The second overflow is a real, reachable state, not a hypothetical: the
    // reconnect builds the replacement queue at the TOP of the connection loop,
    // BEFORE that connection's cold read, so a binding can refuse a second
    // backlog while it is still waiting to be repaired. `onBindingState` is a
    // public join option, so a direct consumer — not only the store, which
    // dedupes transitions itself — would see the repeat.
    const controller = new AbortController();
    let releaseSecondRead = (): void => {};
    let hold = true;
    let call = 0;
    const journal: JournalReader = {
      readHistory: async () => {
        call += 1;
        if (call === 1 || !hold) return emptyPage;
        // Held open: this parks the join AFTER the reconnect has built the
        // replacement queue and BEFORE the cold read can clear the pending
        // repair, which is the only window in which a second refusal can
        // happen without an intervening recovery.
        return new Promise((resolve) => {
          releaseSecondRead = () => resolve(emptyPage);
        });
      },
    };
    const states: string[] = [];
    const { generator, live } = await parkedJoin(
      {
        maxQueuedFrames: 2,
        autoReconnect: true,
        reconnectDelayMs: 0,
        signal: controller.signal,
        onBindingState: (state: string) => states.push(state),
      },
      journal,
    );
    for (const seq of [10, 11, 12]) live.push(enduring(seq));
    await tick();
    expect(states).toStrictEqual(["repair_required"]);

    // Let the join reconnect. It parks on the second cold read, with a fresh
    // queue and a live connection this test can still push into.
    void generator.next();
    await tick();
    await tick();
    expect(call).toBe(2);
    for (const seq of [13, 14, 15]) live.push(enduring(seq));
    await tick();

    expect(states).toStrictEqual(["repair_required"]);

    // Tear down through the SIGNAL, not `.return()`: a `.return()` queues
    // behind the `.next()` still in flight above, which is parked on a cold
    // read this test is deliberately holding open.
    hold = false;
    controller.abort();
    releaseSecondRead();
    live.close();
    await tick();
    void generator.return();
  });

  it("does not clear repair_required from a cold read that started BEFORE the refusal", async () => {
    // The read already in flight when the buffer was refused began before it
    // and cannot have repaired anything, so it must not announce `live`.
    // Measured before the epoch stamp: this sequence produced
    // ["repair_required", "live"] off that same page with coldReads === 1.
    let releaseFirstRead = (): void => {};
    let coldReads = 0;
    const journal: JournalReader = {
      readHistory: async () => {
        coldReads += 1;
        if (coldReads > 1) return emptyPage;
        return new Promise((resolve) => {
          releaseFirstRead = () => resolve(emptyPage);
        });
      },
    };
    const states: string[] = [];
    const live = controllableLive();
    const generator = joinSessionView(journal, "s1", live.source, {
      autoReconnect: false,
      maxQueuedFrames: 2,
      onBindingState: (state: string) => states.push(state),
    } as never);
    const first = generator.next();
    await tick();
    // The cold read is HELD. Flood the live buffer underneath it.
    for (const seq of [10, 11, 12]) live.push(enduring(seq));
    await tick();
    expect(states).toStrictEqual(["repair_required"]);

    releaseFirstRead();
    await expect(first).rejects.toThrow(/cannot be dropped/);
    expect(coldReads).toBe(1);
    // The held read returned, and it must NOT have cleared the refusal.
    expect(states).toStrictEqual(["repair_required"]);
    await generator.return();
  });

  it("closes the queue WITH the overflow error, so the consumer's next read rejects", async () => {
    // Closing without the error is silently different: the follow loop would
    // read `{done: true}`, which looks like a clean end of connection, and the
    // error-triggered reconnect delay would not apply.
    const states: string[] = [];
    const { generator, live } = await parkedJoin({
      maxQueuedFrames: 2,
      onBindingState: (state: string) => states.push(state),
    });
    for (const seq of [10, 11, 12]) live.push(enduring(seq));
    await tick();
    await expect(generator.next()).rejects.toMatchObject({
      name: "LiveQueueOverflowError",
      buffered: 3,
    });
    await generator.return();
  });

  it("rejects a bound that is not a positive safe integer", async () => {
    // `NaN` is the dangerous one: `items.length > NaN` is always false, so the
    // queue would never overflow and would grow without limit — the leak the
    // bound exists to prevent, reached by a typo.
    for (const bound of [0, -5, 1.5, Number.NaN]) {
      const generator = joinSessionView(
        { readHistory: async () => emptyPage },
        "s1",
        controllableLive().source,
        { autoReconnect: false, maxQueuedFrames: bound } as never,
      );
      // Raced against a timer rather than awaited: an UNVALIDATED `NaN` bound
      // parks the join forever instead of rejecting, and a hang is not an
      // assertion. This turns it into one.
      const outcome = await Promise.race([
        generator.next().then(
          () => "resolved",
          (error: Error) => error.message,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 100)),
      ]);
      expect(outcome, `bound ${String(bound)}`).toMatch(
        /maxQueuedFrames must be a positive safe integer/,
      );
      void generator.return();
    }
  });

  it("waits on a REAL timer before a repair reconnect, even at zero delay", async () => {
    // Every other await in the repair loop settles as a MICROTASK when the
    // failure is immediate, so a zero-delay repair drains the microtask queue
    // forever: a `setTimeout`-driven abort never runs, and the livelock becomes
    // a hang cancellation cannot break. Measured at `reconnectDelayMs: 0`
    // before this: a 4 GB heap exhausted in 65 s with the test's own timeout
    // never firing. `joinFactorySessionView` documents the same hazard.
    //
    // Asserted as "a timer was REGISTERED" rather than by observing the
    // starvation, because observing it is precisely a hang.
    vi.useFakeTimers();
    const live = controllableLive();
    let coldReads = 0;
    const generator = joinSessionView(
      {
        readHistory: async () => {
          coldReads += 1;
          return emptyPage;
        },
      },
      "s1",
      live.source,
      { autoReconnect: true, reconnectDelayMs: 0, maxQueuedFrames: 2 } as never,
    );
    // Park the generator at a yield first, so the flood BUFFERS instead of
    // being handed straight to a waiting consumer (which never overflows).
    const first = generator.next();
    await microtasks();
    live.push(textFrame("prime", LOOP_A));
    await first;
    for (const seq of [10, 11, 12]) live.push(enduring(seq));
    await microtasks();
    expect(coldReads).toBe(1);
    // Resume: the refused queue rejects and the join reconnects.
    void generator.next();
    await microtasks();

    // Exactly one timer, and it is THE reconnect: a bare `> 0` would be
    // satisfied by any future fixture that happens to call `setTimeout`.
    expect(vi.getTimerCount()).toBe(1);
    // Dependence, not just registration. The reconnect's cold read must not
    // have happened yet — microtasks alone cannot release it — and must happen
    // once the timer is allowed to run.
    expect(coldReads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await microtasks();
    expect(coldReads).toBe(2);
    void generator.return();
  });

  it("waits the FULL reconnect delay before the first repair, not zero", async () => {
    // The floor. An earlier version returned 0 for the first refusal after a
    // recovery, reasoning that a fresh refusal deserves an immediate retry —
    // but a refusal is a client-side backlog, so the condition that caused it
    // is still true at the moment of the retry. Combined with a streak counter
    // that never advanced, that made `reconnectDelayMs` dead code on this path.
    vi.useFakeTimers();
    const live = controllableLive();
    let coldReads = 0;
    const generator = joinSessionView(
      {
        readHistory: async () => {
          coldReads += 1;
          return emptyPage;
        },
      },
      "s1",
      live.source,
      { autoReconnect: true, reconnectDelayMs: 250, maxQueuedFrames: 2 } as never,
    );
    const first = generator.next();
    await microtasks();
    live.push(textFrame("prime", LOOP_A));
    await first;
    for (const seq of [10, 11, 12]) live.push(enduring(seq));
    await microtasks();
    void generator.next();
    await microtasks();

    expect(coldReads).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    await microtasks();
    // One millisecond short of the delay: the reconnect must not have happened.
    expect(coldReads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await microtasks();
    expect(coldReads).toBe(2);
    void generator.return();
  });

  it("ignores a refusal from a SUPERSEDED connection whose stream kept flowing", async () => {
    // The mirror of the epoch gate. That one stops a stale cold READ clearing a
    // current refusal; this stops a stale REFUSAL moving current state.
    //
    // `onIrreducible` closes over shared join state — `repairPending`,
    // `repairEpoch`, `refusalsWithoutRecovery` — while the flags the recovery
    // reset consults are per-connection, so an increment from an abandoned
    // connection is never forgiven by the connection that caused it. The
    // abandoned stream is not hypothetical: this module's own teardown is
    // best-effort by design (see the `finally` block), a `.return()` queues
    // behind an in-flight read, and a source that does not wire its own
    // cancellation is a stream nobody has closed — modelled here by omitting
    // `return()` entirely.
    //
    // Without the guard the binding is STRANDED: a healthy live connection
    // never re-reads the journal, so nothing ever announces `live` again and
    // the consumer is told a repair is under way that nobody is attempting.
    const connections: Array<{ push: (frame: SseFrame) => void }> = [];
    const source: LiveFrameSource = () => {
      const buffered: SseFrame[] = [];
      let waiter: ((result: IteratorResult<SseFrame>) => void) | undefined;
      connections.push({
        push: (frame) => {
          if (waiter !== undefined) {
            waiter({ value: frame, done: false });
            waiter = undefined;
          } else buffered.push(frame);
        },
      });
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<SseFrame>>((resolve) => {
              const item = buffered.shift();
              if (item !== undefined) resolve({ value: item, done: false });
              else waiter = resolve;
            }),
          // No `return()`: a source that does not honour cancellation.
        }),
      };
    };

    let coldReads = 0;
    const journal: JournalReader = {
      readHistory: async () => {
        coldReads += 1;
        if (coldReads === 1) throw new Error("journal blipped");
        return emptyPage;
      },
    };
    const states: string[] = [];
    const onQueueOverflow = vi.fn();
    const controller = new AbortController();
    const generator = joinSessionView(journal, "s1", source, {
      autoReconnect: true,
      reconnectDelayMs: 0,
      maxQueuedFrames: 2,
      signal: controller.signal,
      onQueueOverflow,
      onBindingState: (state: string) => states.push(state),
    } as never);
    const pending = generator.next();
    for (let i = 0; i < 6; i++) await tick();

    // Connection 1 died on its cold read; connection 2 is healthy and following.
    expect(connections.length).toBe(2);
    expect(coldReads).toBe(2);
    expect(states).toStrictEqual([]);

    // The sibling callback in that closure first, because it needs the
    // abandoned queue still OPEN: an abandoned queue is discarded wholesale, so
    // an eviction from it is not a live frame this binding lost. (Ordering
    // matters — the enduring flood below CLOSES that queue, after which pushes
    // are ignored and this assertion would pass vacuously.)
    for (let i = 0; i < 8; i++) connections[0]?.push(textFrame(String(i), LOOP_A));
    for (let i = 0; i < 2; i++) await tick();
    expect(onQueueOverflow).not.toHaveBeenCalled();

    // Now flood the ABANDONED connection with undroppable frames, repeatedly,
    // with nobody draining it.
    for (let round = 0; round < 3; round++) {
      for (const seq of [10, 11, 12]) connections[0]?.push(enduring(seq));
      for (let i = 0; i < 2; i++) await tick();
    }

    // The current connection is healthy, so its binding state must not move...
    expect(states).toStrictEqual([]);
    // ...and the binding must still be DELIVERING through it, not merely
    // un-announced: repeated stale refusals must not walk a healthy binding
    // toward `maxRepairAttempts` and a throw either.
    connections[1]?.push(textFrame("still delivering", LOOP_A));
    const next = await pending;
    expect(next.done).toBe(false);
    expect(next.done === true ? undefined : next.value.input).toMatchObject({ segment: "live" });
    expect(states).toStrictEqual([]);
    controller.abort();
    void generator.return();
  });

  it("never drops a frame handed straight to a waiting consumer", async () => {
    const onQueueOverflow = vi.fn();
    const live = controllableLive();
    const generator = joinSessionView({ readHistory: async () => emptyPage }, "s1", live.source, {
      autoReconnect: false,
      maxQueuedFrames: 1,
      onQueueOverflow,
    });
    const seen: string[] = [];
    for (const text of ["a", "b", "c", "d"]) {
      const next = generator.next();
      await tick();
      live.push(textFrame(text, LOOP_A));
      const result = await next;
      if (result.done !== true && result.value.input.segment === "live") seen.push(text);
    }
    expect(seen).toStrictEqual(["a", "b", "c", "d"]);
    expect(onQueueOverflow).not.toHaveBeenCalled();
    await generator.return();
  });
});

/** A source that yields an already-resolved burst, then stays closed. */
function burst(frames: readonly SseFrame[]): LiveFrameSource {
  return () => ({
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () =>
          index < frames.length
            ? { value: frames[index++] as SseFrame, done: false as const }
            : { value: undefined as never, done: true as const },
      };
    },
  });
}

describe("SessionViewStore: overflow reporting", () => {
  it("surfaces overflow on the error channel rather than growing without limit", async () => {
    const frames = Array.from({ length: 400 }, (_, i) => textFrame(String(i), LOOP_A));
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: burst(frames),
      scheduler: manualScheduler(),
      maxQueuedFrames: 2,
      join: { autoReconnect: false },
    });
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    for (let i = 0; i < 10; i++) await tick();

    const overflows = onError.mock.calls
      .map(([error]) => (error as Error).message)
      .filter((message) => /overflow/i.test(message));
    expect(overflows.length).toBeGreaterThan(0);
    // Reported on a DOUBLING schedule, so a 400-frame gap costs a handful of
    // notifications rather than hundreds on an already-overloaded main thread.
    expect(overflows.length).toBeLessThan(16);
    store.stop();
  });

  it("re-arms the overflow report across a restart", async () => {
    const frames = Array.from({ length: 100 }, (_, i) => textFrame(String(i), LOOP_A));
    const make = (): SessionViewStore =>
      new SessionViewStore({
        journal: { readHistory: async () => emptyPage },
        sessionId: "s1",
        liveSource: burst(frames),
        scheduler: manualScheduler(),
        maxQueuedFrames: 2,
        join: { autoReconnect: false },
      });
    const store = make();
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    for (let i = 0; i < 10; i++) await tick();
    const firstRun = onError.mock.calls.length;
    expect(firstRun).toBeGreaterThan(0);

    store.stop();
    onError.mockClear();
    store.start();
    for (let i = 0; i < 10; i++) await tick();
    expect(onError.mock.calls.length).toBeGreaterThan(0);
    store.stop();
  });

  it("reports nothing when the stream stays under the bound", async () => {
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: live.source,
      scheduler: manualScheduler(),
      maxQueuedFrames: 8,
    });
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    await tick();
    for (const text of ["a", "b", "c"]) {
      live.push(textFrame(text, LOOP_A));
      await tick();
    }
    expect(onError).not.toHaveBeenCalled();
    store.stop();
  });
});

/**
 * Two bindings, one process, one shared scheduler and one shared journal
 * reader.
 *
 * "Only that binding" is only a claim worth testing where the two bindings
 * SHARE something: these two hold the same `FrameScheduler` instance (so a
 * repair that cancelled frames globally would strand the peer's publication)
 * and the same `JournalReader` (so a repair that reset a reader's state would
 * corrupt the peer's cold walk). The peer assertion is deliberately
 * DELIVERY, not absence of error: a binding that has stopped publishing but
 * has not errored looks identical to a healthy one on every other channel.
 */
describe("SessionViewStore: two simultaneous bindings", () => {
  function twoBindings() {
    const scheduler = manualScheduler();
    const journal: JournalReader = { readHistory: async () => emptyPage };
    const flood = Array.from({ length: 400 }, (_, i) => enduring(i + 1));
    const quiet = controllableLive();
    const overflowing = new SessionViewStore({
      journal,
      sessionId: "flooded",
      liveSource: burst(flood),
      scheduler,
      maxQueuedFrames: 2,
    });
    const peer = new SessionViewStore({
      journal,
      sessionId: "quiet",
      liveSource: quiet.source,
      scheduler,
      maxQueuedFrames: 2,
    });
    return { scheduler, quiet, overflowing, peer };
  }

  it.each([
    { name: "the flooded binding starts first", flip: false },
    { name: "the quiet binding starts first", flip: true },
  ])("repairs only the overflowing binding while its peer keeps delivering, when $name", async ({ flip }) => {
    const { scheduler, quiet, overflowing, peer } = twoBindings();
    const peerStates: string[] = [];
    peer.subscribeBindingState((state) => peerStates.push(state));
    const floodedStates: string[] = [];
    overflowing.subscribeBindingState((state) => floodedStates.push(state));
    peer.subscribeErrors(() => {});
    overflowing.subscribeErrors(() => {});

    for (const store of flip ? [peer, overflowing] : [overflowing, peer]) store.start();
    for (let i = 0; i < 10; i++) await tick();

    // Weakened from `toStrictEqual(["repair_required"])` because the binding
    // now FLAPS — it repairs, recovers, and refuses again at the reconnect
    // cadence — not because the outcome changed. The first transition is still
    // exactly the refusal. `.not.toBe("live")` is deliberately loose about
    // WHICH non-live state, since a long enough window also admits `inactive`
    // once `maxRepairAttempts` fires; that is a materially different outcome
    // and is asserted on its own in test/store-errors.test.ts's "gives up
    // instead of flapping forever when the backlog never clears".
    expect(floodedStates[0]).toBe("repair_required");
    expect(overflowing.bindingState()).not.toBe("live");

    // The peer is not merely un-errored: it is still DELIVERING.
    expect(peer.bindingState()).toBe("live");
    expect(peerStates).toStrictEqual([]);
    expect(peer.isActive()).toBe(true);
    const before = peer.snapshot();
    quiet.push(textFrame("after the peer repaired", LOOP_B));
    await tick();
    scheduler.flush();
    const after = peer.snapshot();
    expect(after.version).toBe(before.version + 1);
    expect(after.view.rows.at(-1)).toMatchObject({ text: "after the peer repaired" });

    overflowing.stop();
    peer.stop();
  });
});
