/** Presenter context is recorded around, not inside, the user's own blocks. */
import { beforeEach, describe, expect, it } from "vitest";
import { emptySessionView, fold, type FoldInput, type SessionView } from "../src/fold.js";
import type { TranscriptRow, UserRow } from "../src/rows.js";
import { LOOP_A, TURN_1, envelope, history, loopStarted, resetSeq, textBlockWire, userMessageWire } from "./helpers.js";

const alex = { tenant: "acme", subject: "user_alex", kind: "actor" as const };

function foldAll(inputs: FoldInput[]): SessionView {
  let view = emptySessionView();
  for (const input of inputs) {
    const result = fold(view, input);
    if (!result.ok) throw new Error(`fold failed: ${result.error.reason}: ${result.error.message}`);
    view = result.view;
  }
  return view;
}

function turnStarted(blocks: string[], input?: Record<string, unknown>): FoldInput {
  return history(envelope({
    type: "TurnStarted", loopId: LOOP_A, turnId: TURN_1,
    payload: { message: userMessageWire(blocks.map(textBlockWire)), ...(input === undefined ? {} : { input }) },
  }));
}

function userRows(view: SessionView): UserRow[] {
  return view.rows.filter((row: TranscriptRow): row is UserRow => row.kind === "user");
}

describe("user rows: presenter frame and principal", () => {
  beforeEach(() => resetSeq());

  it("keeps the exact pre-feature user row shape", () => {
    const [row] = userRows(foldAll([loopStarted(LOOP_A), turnStarted(["hello"])]));
    expect(Object.keys(row!).sort()).toEqual(["blocks", "journalSeq", "kind", "live", "loopId", "ordinal", "orphanedLoop", "turnId"]);
    expect(row!.blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("splits prefix and suffix while retaining the user's own blocks exactly", () => {
    const [row] = userRows(foldAll([
      loopStarted(LOOP_A),
      turnStarted(["[from: Alex]", "add milk", "and eggs", "[end]"], { principal: alex, prefix: 1, suffix: 1 }),
    ]));
    expect(row!.blocks).toEqual([{ type: "text", text: "add milk" }, { type: "text", text: "and eggs" }]);
    expect(row!.frame).toEqual({ prefix: [{ type: "text", text: "[from: Alex]" }], suffix: [{ type: "text", text: "[end]" }] });
    expect(row!.principal).toEqual(alex);
  });

  it("carries a principal without inventing a frame when no presenter ran", () => {
    const [row] = userRows(foldAll([loopStarted(LOOP_A), turnStarted(["hi"], { principal: alex })]));
    expect(row!.blocks).toEqual([{ type: "text", text: "hi" }]);
    expect(row).not.toHaveProperty("frame");
    expect(row!.principal).toEqual(alex);
  });

  it("never hides blocks when corrupted frame counts do not fit", () => {
    const [row] = userRows(foldAll([loopStarted(LOOP_A), turnStarted(["a", "b"], { prefix: 2, suffix: 1 })]));
    expect(row!.blocks).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
    expect(row).not.toHaveProperty("frame");
  });

  it("applies the same frame split to TurnFoldedInto", () => {
    const view = foldAll([
      loopStarted(LOOP_A),
      history(envelope({ type: "TurnFoldedInto", loopId: LOOP_A, turnId: TURN_1,
        payload: { message: userMessageWire([textBlockWire("ctx"), textBlockWire("more")]), input: { principal: alex, prefix: 1 } },
      })),
    ]);
    expect(userRows(view)[0]!.frame).toEqual({ prefix: [{ type: "text", text: "ctx" }], suffix: [] });
  });

  it("names the interrupting principal only when stamped", () => {
    const view = foldAll([
      loopStarted(LOOP_A),
      turnStarted(["go"]),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1, payload: { principal: alex } })),
      turnStarted(["again"]),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    const tombstones = view.rows.filter((row) => row.kind === "tombstone");
    expect(tombstones[0]).toMatchObject({ principal: alex });
    expect(tombstones[1]).not.toHaveProperty("principal");
  });

  it("records a stamped gate answer as a neutral notice", () => {
    const view = foldAll([
      loopStarted(LOOP_A),
      history(envelope({ type: "GateResolved", loopId: LOOP_A, payload: { gate_id: "g1", action: "approve_once", principal: alex } })),
      history(envelope({ type: "GateResolved", loopId: LOOP_A, payload: { gate_id: "g2", action: "deny" } })),
    ]);
    const notices = view.rows.filter((row) => row.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: "info", text: "gate approve_once by user_alex", principal: alex });
  });
});
