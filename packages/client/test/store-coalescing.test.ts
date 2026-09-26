/**
 * One notify per frame, publishing the CURRENT snapshot.
 *
 * React 18+ already batches store notifications; the ~50-100 renders/sec figure
 * design §3c quotes comes from `joinSessionView` being an async generator whose
 * every `await` resumes in its own microtask, with React's flush running
 * between iterations. So coalescing must collapse many folds into one notify
 * per frame — and because it coalesces STATE rather than a queue, no
 * intermediate value can be lost: the frame publishes whatever the view is at
 * the moment it fires, not the oldest thing that was waiting. That last clause
 * is pinned by test/store.test.ts's "pumps the join CONTINUOUSLY, even while no
 * frame has fired", which folds three chunks before a single flush and asserts
 * the published row carries all three.
 */
import { describe, expect, it, vi } from "vitest";
import { SessionViewStore } from "../src/store.js";
import { selectFrameToDrop } from "../src/join.js";
import { ephemeralDropKey, isDroppableFrame } from "../src/enduring.js";
import {
  controllableLive,
  emptyPage,
  enduringFrame,
  errorFrame,
  heartbeatFrame,
  manualScheduler,
  textFrame,
  tick,
} from "./store-fakes.js";
import { LOOP_A, LOOP_B, envelope } from "./helpers.js";

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

describe("SessionViewStore: rAF coalescing", () => {
  it("collapses many folds into ONE notify per frame", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();

    for (const chunk of ["a", "b", "c", "d", "e"]) {
      live.push(textFrame(chunk, LOOP_A));
      await tick();
    }
    expect(notified).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("bumps the version exactly once per notify", async () => {
    const { scheduler, live, store } = makeStore();
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    live.push(textFrame("b", LOOP_A));
    await tick();
    scheduler.flush();
    expect(store.snapshot().version).toBe(1);
    live.push(textFrame("c", LOOP_A));
    await tick();
    scheduler.flush();
    expect(store.snapshot().version).toBe(2);
    store.stop();
  });

  // A second scheduler.flush() cannot exercise the dirty guard: flushing
  // DRAINS the manual scheduler's queue, so the store has nothing scheduled
  // and commit() is never reached at all. The real second-commit path is
  // finalize(), which stop() and end-of-stream both take unconditionally.
  it("does not notify on a commit with nothing pending", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);

    store.stop();
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous snapshot object identity across a no-op commit", async () => {
    const { scheduler, live, store } = makeStore();
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.flush();
    const first = store.snapshot();
    expect(first.version).toBe(1);

    store.stop();
    expect(store.snapshot()).toBe(first);
    expect(store.snapshot().version).toBe(1);
  });

  it("schedules a NEW frame for work that arrives after the last one fired", async () => {
    const { scheduler, live, store } = makeStore();
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(1);

    // The frame handle must have been cleared when it fired, or publish()
    // would believe a frame is still pending and never ask for another.
    live.push(textFrame("b", LOOP_A));
    await tick();
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.flush();
    expect(notified).toHaveBeenCalledTimes(2);
    expect(store.snapshot().view.rows.at(-1)).toMatchObject({ text: "ab" });
    store.stop();
  });

  it("notifies every subscriber on the one frame", async () => {
    const { scheduler, live, store } = makeStore();
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);
    store.start();
    await tick();
    live.push(textFrame("a", LOOP_A));
    await tick();
    scheduler.flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    store.stop();
  });
});

/**
 * Ephemeral coalescing, and the boundary it cannot cross.
 *
 * ## What the eviction domain is, and what "cannot" means here
 *
 * `selectFrameToDrop`'s parameter type is `readonly DroppableFrame[]`, which is
 * `Extract<SseFrame, { type: "heartbeat" } | { type: "ephemeral" }>` — an
 * `EnduringSseFrame` is not assignable to it, so no TypeScript call site can
 * pass one. That is checked by `npm run typecheck`, which compiles `test/` as
 * well as `src/` (tsconfig.typecheck.json), so the `@ts-expect-error` below
 * fails the build the day the parameter widens.
 *
 * TypeScript types are erased, so that argument covers TypeScript call sites
 * and nothing else. Two runtime properties carry the rest, and both are
 * asserted below rather than argued: the policy returns -1 ("no victim") rather
 * than an index when handed a buffer with nothing droppable in it, and the
 * queue's own eviction step re-checks `isDroppableFrame` on the item it is
 * about to splice and repairs instead of dropping if it is not.
 *
 * What this does NOT establish: anything about loss inside `fold`, anything
 * about a consumer that builds its own queue, and any claim that an enduring
 * frame is never lost — the whole point of U2.2 is that it CAN be refused, and
 * that refusing it is reported as `repair_required` instead of being applied.
 */
describe("ephemeral coalescing by declared key", () => {
  const tokenA = textFrame("a", LOOP_A);
  const toolB = {
    type: "ephemeral",
    data: { kind: "tool_call_started", delta: {}, header: { session_id: "s", loop_id: LOOP_B } },
  } as never;

  it("keys a frame by its DECLARED kind and producing loop, not by its payload", () => {
    expect(ephemeralDropKey(textFrame("a", LOOP_A) as never)).toBe(ephemeralDropKey(textFrame("bbb", LOOP_A) as never));
    expect(ephemeralDropKey(textFrame("a", LOOP_A) as never)).not.toBe(ephemeralDropKey(textFrame("a", LOOP_B) as never));
    expect(ephemeralDropKey(textFrame("a", LOOP_A) as never)).not.toBe(ephemeralDropKey(toolB));
    expect(ephemeralDropKey(heartbeatFrame() as never)).toBe("heartbeat");
  });

  it("evicts from the NOISIEST key, leaving a quiet peer stream intact", () => {
    const frames = [toolB, tokenA, textFrame("b", LOOP_A), textFrame("c", LOOP_A)];
    // Three token_deltas on loop A, one tool_call_started on loop B. The victim
    // is the oldest of the busy key, never the lone frame of the quiet one.
    expect(selectFrameToDrop(frames as never)).toBe(1);
  });

  it("breaks a tie between equally noisy keys toward the OLDEST frame", () => {
    // Two keys, one frame each. Nothing is noisier than anything else, so the
    // choice must be the oldest buffered frame — and it must be a choice, not
    // whichever key the map happened to yield last.
    expect(selectFrameToDrop([tokenA, toolB] as never)).toBe(0);
    expect(selectFrameToDrop([toolB, tokenA] as never)).toBe(0);
  });

  it("keys on the full producing coordinates, not the loop alone", () => {
    // `header` carries turn and step as well. Two token_deltas from different
    // STEPS of one loop are different streams, and thinning one must not be
    // charged to the other.
    const step = (stepId: string) =>
      ({
        type: "ephemeral",
        data: {
          kind: "token_delta",
          delta: { chunk_type: "text", text: "x" },
          header: { session_id: "s", loop_id: LOOP_A, turn_id: "t-1", step_id: stepId },
        },
      }) as never;
    expect(ephemeralDropKey(step("s-1"))).not.toBe(ephemeralDropKey(step("s-2")));
    const turn = (turnId: string) =>
      ({
        type: "ephemeral",
        data: {
          kind: "token_delta",
          delta: { chunk_type: "text", text: "x" },
          header: { session_id: "s", loop_id: LOOP_A, turn_id: turnId, step_id: "s-1" },
        },
      }) as never;
    expect(ephemeralDropKey(turn("t-1"))).not.toBe(ephemeralDropKey(turn("t-2")));
    // ...and the noisiest-key pick follows the full key: two frames of one step
    // outweigh one frame of another, so the lone frame survives.
    expect(selectFrameToDrop([step("s-2"), step("s-1"), step("s-1")] as never)).toBe(1);
  });

  it("classifies exactly heartbeat and ephemeral frames as droppable", () => {
    expect(isDroppableFrame(heartbeatFrame())).toBe(true);
    expect(isDroppableFrame(textFrame("a", LOOP_A))).toBe(true);
    expect(isDroppableFrame(enduringFrame(1, envelope({ type: "TurnDone", loopId: LOOP_A })))).toBe(false);
    expect(isDroppableFrame(errorFrame("x"))).toBe(false);
  });

  it("cannot be handed an enduring frame, and names no victim if erasure hands it one anyway", () => {
    const enduring = enduringFrame(1, envelope({ type: "TurnDone", loopId: LOOP_A }));
    // @ts-expect-error an EnduringSseFrame is not a DroppableFrame. If this
    // line ever compiles, `npm run typecheck` fails on the unused suppression.
    const chosen: number = selectFrameToDrop([enduring]);
    expect(chosen).toBe(-1);
  });
});
