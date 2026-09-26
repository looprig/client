/**
 * Coalescing state makes a dropped intermediate impossible — PROVIDED the last
 * value is always committed. Without that, the final frame of a session (the
 * last `TurnDone`, the last gate resolution) sits in a scheduled callback that
 * never runs, because the store just tore itself down.
 *
 * So `finalize()` runs on stream end, on error and on `stop()`, and a restart
 * republishes the reset view rather than leaving the previous cycle's snapshot
 * visible.
 *
 * The other half is latency: a LIVE enduring frame flushes on a microtask
 * instead of waiting for a frame. Every gate transition is one, and a gate the
 * user has to answer must not sit behind a 16 ms (or, on a hidden tab, 33 ms)
 * scheduler hop. Ephemeral deltas and the cold history replay stay coalesced —
 * the replay is thousands of events and is exactly what coalescing is for.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionViewStore } from "../src/store.js";
import type { LiveFrameSource } from "../src/join.js";
import type { SseFrame } from "../src/sse.js";
import {
  controllableLive,
  emptyPage,
  enduringFrame,
  manualScheduler,
  pageOf,
  textFrame,
  tick,
} from "./store-fakes.js";
import { LOOP_A, envelope } from "./helpers.js";

const GATE_A = "9e2f0000-0000-4000-8000-00000000000a";
const TOOL_EXEC_1 = "99999999-9999-4999-8999-999999999999";

function gateOpened(gateId: string): SseFrame {
  return enduringFrame(
    0,
    envelope({
      type: "GateOpened",
      loopId: LOOP_A,
      payload: {
        gate: {
          id: gateId,
          kind: "harness.permission",
          resolver: "loop",
          blocks: "tool_call",
          effect: "resume",
          criticality: "critical",
          subject: { tool_execution_id: TOOL_EXEC_1, tool_use_id: "toolu_1" },
          prompt: {
            title: "Allow Write?",
            body: "write /tmp/x",
            controls: [{ action: "Approve", label: "Approve" }],
          },
          response_policy: { timeout: 60000000000, on_timeout: "respond" },
          restorable: true,
        },
      },
    }),
  );
}

/** A live source that yields `frames`, then rejects — the network-failure shape. */
function liveThatFails(frames: readonly SseFrame[], error: Error): LiveFrameSource {
  return () => ({
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async (): Promise<IteratorResult<SseFrame>> => {
          if (index < frames.length) return { value: frames[index++] as SseFrame, done: false };
          throw error;
        },
      };
    },
  });
}

function makeStore(join?: { autoReconnect?: boolean }) {
  const scheduler = manualScheduler();
  const live = controllableLive();
  const store = new SessionViewStore({
    journal: { readHistory: async () => emptyPage },
    sessionId: "s1",
    liveSource: live.source,
    scheduler,
    join: { autoReconnect: false, ...join },
  });
  return { scheduler, live, store };
}

describe("SessionViewStore: flush", () => {
  it("publishes the final state when the stream ENDS, with no frame flushed", async () => {
    const { live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    live.push(textFrame("last words", LOOP_A));
    await tick();
    live.close();
    await tick();
    await tick();

    // No scheduler.flush() anywhere above.
    expect(notified).toHaveBeenCalledTimes(1);
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "last words" });
    expect(store.isActive()).toBe(false);
  });

  it("publishes the final state when the join ERRORS", async () => {
    const scheduler = manualScheduler();
    const store = new SessionViewStore({
      journal: { readHistory: async () => emptyPage },
      sessionId: "s1",
      liveSource: liveThatFails([textFrame("before the failure", LOOP_A)], new Error("network gone")),
      scheduler,
      join: { autoReconnect: false },
    });
    const onError = vi.fn();
    store.subscribeErrors(onError);
    store.start();
    for (let i = 0; i < 5; i++) await tick();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "network gone" }));
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "before the failure" });
    expect(store.isActive()).toBe(false);
  });

  it("publishes the final state on stop(), with no frame flushed", async () => {
    const { live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    live.push(textFrame("mid-stream", LOOP_A));
    await tick();
    store.stop();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "mid-stream" });
  });

  it("cancels the pending frame on stop(), so nothing publishes afterwards", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    store.stop();
    expect(notified).toHaveBeenCalledTimes(1);
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("does not notify on a stop() with nothing pending", async () => {
    const { store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    store.stop();
    expect(notified).not.toHaveBeenCalled();
  });

  it("a restart after stop() starts from a fresh view", async () => {
    const { scheduler, live, store } = makeStore();
    store.start();
    await tick();
    live.push(textFrame("first run", LOOP_A));
    await tick();
    store.stop();
    expect(store.snapshot().view.rows).toHaveLength(1);

    store.start();
    // The reset must be PUBLISHED, not just staged: snapshot() is what a
    // useSyncExternalStore consumer renders, and leaving the previous cycle's
    // rows visible until the new join happens to produce its own first update
    // is a stale transcript for an unbounded amount of time.
    expect(store.snapshot().view.rows).toStrictEqual([]);
    await tick();
    scheduler.flush();
    expect(store.snapshot().view.rows).toStrictEqual([]);
    store.stop();
  });

  it("notifies on the restart reset, so a subscriber sees the cleared view", async () => {
    const { live, store } = makeStore();
    store.start();
    await tick();
    live.push(textFrame("first run", LOOP_A));
    await tick();
    store.stop();
    const afterStop = store.snapshot();

    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(store.snapshot()).not.toBe(afterStop);
    expect(store.snapshot().version).toBe(afterStop.version + 1);
    store.stop();
  });
});

describe("SessionViewStore: latency-critical flush", () => {
  it("flushes a live ENDURING frame on a microtask, never waiting for a frame", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    live.push(gateOpened(GATE_A));
    await tick();

    // No scheduler.flush(): a gate the user has to answer must not sit behind
    // a scheduler hop.
    expect(notified).toHaveBeenCalledTimes(1);
    expect(store.snapshot().view.gates.has(GATE_A)).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);
    store.stop();
  });

  it("carries any coalesced ephemeral work out with the urgent flush", async () => {
    const { live, store } = makeStore();
    store.start();
    await tick();
    live.push(textFrame("streamed", LOOP_A));
    await tick();
    live.push(gateOpened(GATE_A));
    await tick();
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "streamed" });
    expect(store.snapshot().view.gates.has(GATE_A)).toBe(true);
    store.stop();
  });

  it("does NOT flush per ephemeral frame", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    for (const text of ["a", "b", "c"]) {
      live.push(textFrame(text, LOOP_A));
      await tick();
    }
    expect(notified).not.toHaveBeenCalled();
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("does NOT flush per cold-history event — the replay stays coalesced", async () => {
    const events = Array.from({ length: 50 }, (_, i) => ({
      journal_seq: i,
      event: envelope({ type: "TurnDone", loopId: LOOP_A }),
    }));
    const scheduler = manualScheduler();
    const live = controllableLive();
    const store = new SessionViewStore({
      journal: { readHistory: async () => pageOf(events) },
      sessionId: "s1",
      liveSource: live.source,
      scheduler,
      join: { autoReconnect: false },
    });
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    // Fifty enduring events, ONE pending frame — the cold replay is exactly
    // the path coalescing exists for.
    expect(notified).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);
    store.stop();
  });
});
