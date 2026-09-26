/** Durable command outcomes drive Factory/Oxy pending-controller reconciliation. */
import { describe, expect, it } from "vitest";
import { emptySessionView } from "../src/fold.js";
import { LOOP_A, LOOP_B, envelope, history, textBlockWire, userMessageWire } from "./helpers.js";
import { run } from "./run.js";

describe("durable command outcomes", () => {
  it.each([
    ["TurnStarted", "started"], ["TurnFoldedInto", "started"],
    ["TurnRejected", "rejected"], ["InputCancelled", "cancelled"],
  ])("records %s by its causal command identity", (type, outcome) => {
    const before = emptySessionView();
    const view = run(before, [history(envelope({ type, loopId: LOOP_A, cause: { command_id: "cmd-1" }, payload: { reason: 1 } }))]);
    expect([...view.commandOutcomes]).toEqual([["cmd-1", outcome]]);
    expect(before.commandOutcomes.size).toBe(0);
    expect(view.commandOutcomes).not.toBe(before.commandOutcomes);
  });
  it.each(["TurnStarted", "TurnFoldedInto"])("acknowledges %s even when hand-back commits no user row", (type) => {
    const view = run(emptySessionView(), [history(envelope({ type, loopId: LOOP_A, cause: { command_id: "cmd-1", loop_id: LOOP_B }, payload: { message: userMessageWire([textBlockWire("hand-back")]) } }))]);
    expect(view.commandOutcomes.get("cmd-1")).toBe("started");
    expect(view.rows).toEqual([]);
  });
  it("does not invent an outcome for an event with no command identity", () => {
    const view = run(emptySessionView(), [history(envelope({ type: "TurnStarted", loopId: LOOP_A }))]);
    expect(view.commandOutcomes.size).toBe(0);
  });
  it("retains unrelated command outcomes", () => {
    const view = run(emptySessionView(), [
      history(envelope({ type: "TurnStarted", cause: { command_id: "one" } })),
      history(envelope({ type: "InputCancelled", cause: { command_id: "two" } })),
    ]);
    expect([...view.commandOutcomes]).toEqual([["one", "started"], ["two", "cancelled"]]);
  });
  it("renders rejection as a notice and cancellation without a row", () => {
    const rejected = run(emptySessionView(), [history(envelope({ type: "TurnRejected", cause: { command_id: "one" }, payload: { reason: 1 } }))]);
    expect(rejected.rows).toMatchObject([{ kind: "notice", level: "error", text: "input rejected: the loop's queue is full" }]);
    const cancelled = run(emptySessionView(), [history(envelope({ type: "InputCancelled", cause: { command_id: "two" } }))]);
    expect(cancelled.rows).toEqual([]);
  });
});
