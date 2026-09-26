/**
 * The append-only arrays must cost O(1) amortized per event, not O(M).
 *
 * A cold journal replay folds EVERY enduring event before first paint, and
 * `[...view.statusEvents, marker]` ran on every one of them — O(M²) on exactly
 * the "open a session that already ran" path this design exists to serve. The
 * per-token `[...view.content, entry]` and the per-row `[...view.rows, row]`
 * are the same shape one level down.
 *
 * Design §3c blesses the fix: "The outer array may be appended in place." This
 * file asserts it STRUCTURALLY — the array object is reused across appends —
 * rather than by wall-clock, which would be flaky in CI and would not say which
 * array regressed.
 *
 * What in-place appending does NOT buy, and what test/fold-immutability.test.ts
 * and test/rows.test.ts still pin: row OBJECTS stay copy-on-write, the Maps stay
 * copy-on-write, and a FAILED fold appends nothing.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView, fold, type FoldInput, type SessionView } from "../src/fold.js";
import {
  LOOP_A,
  aiMessageWire,
  envelope,
  history,
  liveEphemeral,
  resetSeq,
  textBlockWire,
  textDelta,
} from "./helpers.js";
import { run } from "./run.js";

function stepDone(text: string, seq?: number): FoldInput {
  return history(
    envelope({
      type: "StepDone",
      loopId: LOOP_A,
      payload: { messages: [aiMessageWire([textBlockWire(text)])] },
    }),
    seq,
  );
}

function foldOrThrow(view: SessionView, input: FoldInput): SessionView {
  const result = fold(view, input);
  if (!result.ok) throw result.error;
  return result.view;
}

describe("fold: the append-only arrays are appended in place", () => {
  it("reuses the rows array across appends instead of copying it", () => {
    resetSeq();
    const first = foldOrThrow(emptySessionView(), stepDone("a"));
    const second = foldOrThrow(first, stepDone("b"));
    expect(second.rows, "appendRow copied the outer array").toBe(first.rows);
    expect(second.rows).toHaveLength(2);
  });

  it("reuses the statusEvents array across a whole cold replay", () => {
    resetSeq();
    const view = run(
      emptySessionView(),
      Array.from({ length: 500 }, (_, i) =>
        history(envelope({ type: "ContextMeasured", loopId: LOOP_A }), i),
      ),
    );
    expect(view.statusEvents).toHaveLength(500);
    const next = foldOrThrow(view, history(envelope({ type: "ContextMeasured", loopId: LOOP_A })));
    expect(next.statusEvents, "the marker append copied the outer array").toBe(view.statusEvents);
    expect(next.statusEvents).toHaveLength(501);
  });

  it("reuses the content array across token deltas", () => {
    resetSeq();
    const first = foldOrThrow(emptySessionView(), textDelta("a", LOOP_A));
    const second = foldOrThrow(first, textDelta("b", LOOP_A));
    expect(second.content, "the token_delta case copied the outer array").toBe(first.content);
    expect(second.content).toHaveLength(2);
  });

  it("reuses the toolCalls, queuedInputs and compactions arrays across appends", () => {
    resetSeq();
    const first = run(emptySessionView(), [
      liveEphemeral("tool_call_started", { tool_execution_id: "te-1", tool_name: "Read" }, LOOP_A),
      liveEphemeral("input_queued", undefined, LOOP_A),
      liveEphemeral(
        "compaction_started",
        { attempt_id: "a1", reason: 1, basis: { revision: 1, through_event_id: "e1" } },
        LOOP_A,
      ),
    ]);
    const second = run(first, [
      liveEphemeral("tool_call_started", { tool_execution_id: "te-2", tool_name: "Bash" }, LOOP_A),
      liveEphemeral("input_queued", undefined, LOOP_A),
      liveEphemeral(
        "compaction_started",
        { attempt_id: "a2", reason: 1, basis: { revision: 2, through_event_id: "e2" } },
        LOOP_A,
      ),
    ]);
    expect(second.toolCalls).toBe(first.toolCalls);
    expect(second.queuedInputs).toBe(first.queuedInputs);
    expect(second.compactions).toBe(first.compactions);
    expect([second.toolCalls.length, second.queuedInputs.length, second.compactions.length]).toStrictEqual([2, 2, 2]);
  });

  it("still publishes a NEW view object per accepted event, so a snapshot reference changes", () => {
    resetSeq();
    const before = emptySessionView();
    const after = foldOrThrow(before, textDelta("x", LOOP_A));
    expect(after, "a store's snapshot() would never change identity").not.toBe(before);
    expect(before.nextOrdinal, "the ordinal counter must still be per-view").toBe(0);
    expect(after.nextOrdinal).toBe(1);
  });
});
