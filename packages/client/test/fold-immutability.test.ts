/** Durable row objects and maps remain safe to retain while outer arrays append. */
import { describe, expect, it } from "vitest";
import { emptySessionView, fold, type FoldInput } from "../src/fold.js";
import { LOOP_A, LOOP_B, aiMessageWire, envelope, history, textBlockWire, userMessageWire } from "./helpers.js";
import { run } from "./run.js";

function inputs(): FoldInput[] {
  return [
    history(envelope({ type: "TurnStarted", loopId: LOOP_A, cause: { command_id: "c1" }, payload: { message: userMessageWire([textBlockWire("hello")]) } })),
    history(envelope({ type: "StepDone", loopId: LOOP_B, payload: { messages: [aiMessageWire([textBlockWire("reply")])] } })),
    history(envelope({ type: "GateOpened", loopId: LOOP_A, payload: { gate: { id: "g2", kind: "harness.permission" } } })),
    history(envelope({ type: "GateResolved", loopId: LOOP_A, payload: { gate_id: "g1" } })),
    history(envelope({ type: "LoopStarted", loopId: LOOP_A })),
    history(envelope({ type: "TurnRejected", loopId: LOOP_A, cause: { command_id: "c2" }, payload: { reason: 1 } })),
    history(envelope({ type: "InputCancelled", loopId: LOOP_A, cause: { command_id: "c3" } })),
    history(envelope({ type: "TurnInterrupted", loopId: LOOP_A })),
    history(envelope({ type: "TurnFailed", loopId: LOOP_A, payload: { err: { kind: "tool_limit", message: "too many" } } })),
    history(envelope({ type: "TurnDone", loopId: LOOP_A })),
  ];
}
function seededView() {
  return run(emptySessionView(), [
    history(envelope({ type: "TurnStarted", loopId: LOOP_A, cause: { command_id: "seed" }, payload: { message: userMessageWire([textBlockWire("seed")]) } })),
    history(envelope({ type: "GateOpened", loopId: LOOP_A, payload: { gate: { id: "g1", kind: "harness.permission" } } })),
  ]);
}
describe("durable fold immutability", () => {
  it("preserves existing row objects and status markers across every durable input", () => {
    for (const input of inputs()) {
      const view = seededView();
      const rows = structuredClone(view.rows);
      const markers = structuredClone(view.statusEvents);
      view.rows.forEach(Object.freeze);
      const result = fold(view, input);
      expect(result.ok).toBe(true);
      expect(view.rows.slice(0, rows.length)).toEqual(rows);
      expect(view.statusEvents.slice(0, markers.length)).toEqual(markers);
    }
  });
  it("does not mutate prior maps or counters", () => {
    for (const input of inputs()) {
      const view = seededView();
      const before = structuredClone({ gates: view.gates, loops: view.loops, commandOutcomes: view.commandOutcomes, nextOrdinal: view.nextOrdinal });
      fold(view, input);
      expect({ gates: view.gates, loops: view.loops, commandOutcomes: view.commandOutcomes, nextOrdinal: view.nextOrdinal }).toEqual(before);
    }
  });
  it("returns a new view and copies each map that changes", () => {
    for (const input of inputs()) {
      const view = seededView();
      const result = fold(view, input);
      if (!result.ok) throw result.error;
      expect(result.view).not.toBe(view);
      for (const key of ["gates", "loops", "commandOutcomes"] as const) {
        if (result.view[key].size !== view[key].size) expect(result.view[key]).not.toBe(view[key]);
      }
    }
  });
  it("preserves identity for an absent event body", () => {
    const view = seededView();
    expect(fold(view, { segment: "history", event: { journal_seq: 99 } })).toEqual({ ok: true, view });
    const result = fold(view, { segment: "history", event: { journal_seq: 99 } });
    if (!result.ok) throw result.error;
    expect(result.view).toBe(view);
  });
});
