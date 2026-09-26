/** Durable replay appends outer rows and status-marker arrays in place for amortized constant time. */
import { describe, expect, it } from "vitest";
import { emptySessionView, fold, type FoldInput, type SessionView } from "../src/fold.js";
import { LOOP_A, aiMessageWire, envelope, history, resetSeq, textBlockWire } from "./helpers.js";
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
});

it("publishes a fresh view object after appending a durable row", () => {
  const before = emptySessionView();
  const after = foldOrThrow(before, stepDone("committed"));
  expect(after).not.toBe(before);
  expect(before.nextOrdinal).toBe(0);
  expect(after.nextOrdinal).toBe(1);
});
