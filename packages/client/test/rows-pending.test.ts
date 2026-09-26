/**
 * The optimistic pending row and its resolution (design §3b).
 *
 * ## Why the pending row cannot come from the fold
 *
 * `input_queued` is an EPHEMERAL frame carrying no `delta` and therefore no
 * text — it announces that *something* was queued, not what. The submitted text
 * exists only in the composer that sent it, so the pending row enters the view
 * through an explicit `addPendingRow` call rather than through a fold input.
 * That makes it PER-TAB by construction: a second tab, or the TUI, sees nothing
 * for this submit until `TurnStarted`.
 *
 * ## Why `commandOutcomes` exists
 *
 * A consumer cannot observe pending-row resolution by scanning `rows`:
 * `TurnRejected` commits a NOTICE row, not a user row, and `InputCancelled`
 * commits nothing at all, so the command id would have to be duplicated onto
 * three row kinds to be findable. `commandOutcomes` is the one place a caller
 * asks "what became of the command I submitted", keyed by `Header.Cause
 * .CommandID` — the same key `addPendingRow` files the row under.
 *
 * ## Provenance of the wire strings
 *
 * Verbatim stdout of `event.MarshalEvent` in
 * `github.com/looprig/harness@v0.30.0` (forcing `core@v0.6.0` /
 * `inference@v0.12.0`), driven by a throwaway main package that constructed the
 * real event values. Note what the marshaller REFUSES: a `TurnRejected`
 * carrying a non-zero `TurnID` fails with
 * "event: invalid TurnRejected: TurnID must be zero", so no real rejection
 * envelope has a `turn_id` and the notice's `turnId` is always "".
 */
import { describe, expect, it } from "vitest";
import { addPendingRow, emptySessionView, type SessionView } from "../src/fold.js";
import type { EventEnvelope } from "../src/types.js";
import { LOOP_A, TURN_1, envelope, history, loopStarted, resetSeq, textBlockWire, textDelta, userMessageWire } from "./helpers.js";
import { run } from "./run.js";

const CMD_1 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CMD_2 = "dddddddd-1111-4111-8111-111111111111";

function wireEnvelope(json: string): EventEnvelope {
  return JSON.parse(json) as EventEnvelope;
}

/** `event.TurnStarted{Header: {Cause: {CommandID: CMD_1}}, TurnIndex: 1, Message: "hello"}`. */
const TURN_STARTED_WIRE =
  '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"hello","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":1,"type":"TurnStarted","v":1}';

/** The four RejectReason values. Every one is marshalled with a ZERO TurnID. */
const TURN_REJECTED_WIRE: ReadonlyArray<{ reason: number; text: string; json: string }> = [
  {
    reason: 0,
    text: "input rejected: an unspecified reason",
    json: '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","type":"TurnRejected","v":1}',
  },
  {
    reason: 1,
    text: "input rejected: the loop's queue is full",
    json: '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":1,"session_id":"11111111-1111-4111-8111-111111111111","type":"TurnRejected","v":1}',
  },
  {
    reason: 2,
    text: "input rejected: the loop is shutting down",
    json: '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":2,"session_id":"11111111-1111-4111-8111-111111111111","type":"TurnRejected","v":1}',
  },
  {
    reason: 3,
    text: "input rejected: a transient internal failure",
    json: '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":3,"session_id":"11111111-1111-4111-8111-111111111111","type":"TurnRejected","v":1}',
  },
];

/** `event.InputCancelled{…, Reason: CancelClientRetracted}` — reason 0, dropped by omitzero. */
const INPUT_CANCELLED_WIRE =
  '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":4,"type":"InputCancelled","v":1}';

function pendingView(commandId = CMD_1, text = "hello"): SessionView {
  resetSeq();
  return addPendingRow(emptySessionView(), commandId, [{ type: "text", text }]);
}

describe("rows: the optimistic pending row", () => {
  it("adds a live user row keyed by the submit command id", () => {
    const view = pendingView();
    expect(view.rows).toStrictEqual([
      {
        kind: "user",
        ordinal: 0,
        loopId: "",
        turnId: "",
        journalSeq: undefined,
        live: true,
        orphanedLoop: false,
        blocks: [{ type: "text", text: "hello" }],
      },
    ]);
    expect(view.pending.get(CMD_1)).toBe(0);
    expect(view.commandOutcomes.size).toBe(0);
  });

  it("copies the pending map and the counter, and appends the row in place", () => {
    // AMENDED alongside fold's contract: `rows` is an append-only outer array
    // and §3c allows appending it in place, so the row DOES land in the input
    // view's array. Everything else addPendingRow touches is still
    // copy-on-write — the `pending` map above all, since a per-map selector
    // compares it by identity.
    const before = emptySessionView();
    const rows = before.rows;
    const after = addPendingRow(before, CMD_1, []);
    expect(after.rows, "the row append copied the array instead of pushing into it").toBe(rows);
    expect(after.rows).toHaveLength(1);
    expect(before.pending.size, "the input view's pending map was written through").toBe(0);
    expect(before.nextOrdinal, "the input view's ordinal counter advanced in place").toBe(0);
    expect(after.pending).not.toBe(before.pending);
    expect(after.nextOrdinal).toBe(1);
  });

  it("keys each submit separately, allocating a fresh ordinal per row", () => {
    let view = pendingView(CMD_1, "first");
    view = addPendingRow(view, CMD_2, [{ type: "text", text: "second" }]);
    expect(view.rows.map((r) => r.ordinal)).toStrictEqual([0, 1]);
    expect([...view.pending]).toStrictEqual([
      [CMD_1, 0],
      [CMD_2, 1],
    ]);
  });
});

describe("rows: TurnStarted / TurnFoldedInto resolve the pending row", () => {
  it("replaces the pending row with the authoritative row, off real wire", () => {
    const view = run(pendingView(), [history(wireEnvelope(TURN_STARTED_WIRE), 3)]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      kind: "user",
      live: false,
      journalSeq: 3,
      loopId: LOOP_A,
      turnId: TURN_1,
      blocks: [{ type: "text", text: "hello" }],
    });
    expect(view.pending.size).toBe(0);
    expect(view.commandOutcomes.get(CMD_1)).toBe("started");
  });

  it("leaves a pending row keyed by a DIFFERENT command id alone", () => {
    // The pairing key is the whole mechanism: resolving on arrival rather than
    // on the id would retire the wrong tab's row on any concurrent submit.
    const view = run(pendingView(CMD_2, "mine"), [history(wireEnvelope(TURN_STARTED_WIRE))]);
    expect(view.rows.filter((r) => r.live)).toHaveLength(1);
    expect(view.rows.find((r) => r.live)).toMatchObject({ blocks: [{ type: "text", text: "mine" }] });
    expect(view.pending.get(CMD_2)).toBe(0);
    expect(view.commandOutcomes.get(CMD_1)).toBe("started");
    expect(view.commandOutcomes.has(CMD_2)).toBe(false);
  });

  it("resolves on TurnFoldedInto too — still the user's input, still acknowledged", () => {
    const view = run(pendingView(), [
      history(
        envelope({
          type: "TurnFoldedInto",
          loopId: LOOP_A,
          turnId: TURN_1,
          cause: { command_id: CMD_1 },
          payload: { message: userMessageWire([textBlockWire("folded")]) },
        }),
      ),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["user"]);
    expect(view.pending.size).toBe(0);
    expect(view.commandOutcomes.get(CMD_1)).toBe("started");
  });

  it("acknowledges a turn opener that commits NO user row", () => {
    // A subagent hand-back carries a non-zero Cause.LoopID and commits no user
    // row. The acknowledgement is independent of that gate: if it were not, a
    // pending row could dangle live forever behind a turn that really started.
    const view = run(pendingView(), [
      history(
        envelope({
          type: "TurnStarted",
          loopId: LOOP_A,
          turnId: TURN_1,
          cause: { command_id: CMD_1 },
        }),
      ),
    ]);
    expect(view.rows).toStrictEqual([]);
    expect(view.pending.size).toBe(0);
    expect(view.commandOutcomes.get(CMD_1)).toBe("started");
  });

  it("records no outcome for an opener carrying no command id", () => {
    const view = run(emptySessionView(), [
      history(
        envelope({
          type: "TurnStarted",
          loopId: LOOP_A,
          turnId: TURN_1,
          payload: { message: userMessageWire([textBlockWire("no cause")]) },
        }),
      ),
    ]);
    expect([...view.commandOutcomes]).toStrictEqual([]);
  });
});

describe("rows: TurnRejected", () => {
  it("drops the pending row AND commits an error notice", () => {
    // A rejected submit must never silently vanish: the composer's optimistic
    // row disappears, so something has to say why.
    const view = run(pendingView(CMD_1, "too much"), [
      loopStarted(LOOP_A),
      history(wireEnvelope(TURN_REJECTED_WIRE[1]!.json), 4),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["notice"]);
    expect(view.rows[0]).toStrictEqual({
      kind: "notice",
      level: "error",
      text: "input rejected: the loop's queue is full",
      // Always "": MarshalEvent refuses a TurnRejected with a non-zero TurnID.
      turnId: "",
      ordinal: 1,
      loopId: LOOP_A,
      journalSeq: 4,
      live: false,
      orphanedLoop: false,
    });
    expect(view.pending.size).toBe(0);
    expect(view.commandOutcomes.get(CMD_1)).toBe("rejected");
  });

  it.each(TURN_REJECTED_WIRE)("renders RejectReason $reason off real wire", ({ text, json }) => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(json))]);
    expect(view.rows[0]).toMatchObject({ kind: "notice", level: "error", text });
  });

  it("commits the notice even with no pending row — a second tab, or the TUI", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_REJECTED_WIRE[2]!.json))]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["notice"]);
    expect(view.rows[0]).toMatchObject({ text: "input rejected: the loop is shutting down" });
    expect(view.commandOutcomes.get(CMD_1)).toBe("rejected");
  });

  it("leaves an unrelated pending row alone", () => {
    const view = run(pendingView(CMD_2, "mine"), [history(wireEnvelope(TURN_REJECTED_WIRE[1]!.json))]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["user", "notice"]);
    expect(view.pending.get(CMD_2)).toBe(0);
  });
});

describe("rows: InputCancelled", () => {
  it("drops the pending row, committing NO row", () => {
    // A retract, or a queued input returned after an abnormal terminal. The
    // input never entered history, so there is nothing to show — but the
    // affordance must still go, and the outcome must still be observable.
    const view = run(pendingView(CMD_1, "retracted"), [history(wireEnvelope(INPUT_CANCELLED_WIRE))]);
    expect(view.rows).toStrictEqual([]);
    expect(view.pending.size).toBe(0);
    expect(view.commandOutcomes.get(CMD_1)).toBe("cancelled");
  });

  it("records the outcome with no pending row of its own", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(INPUT_CANCELLED_WIRE))]);
    expect(view.rows).toStrictEqual([]);
    expect(view.commandOutcomes.get(CMD_1)).toBe("cancelled");
  });

  it("leaves an unrelated pending row alone", () => {
    const view = run(pendingView(CMD_2, "mine"), [history(wireEnvelope(INPUT_CANCELLED_WIRE))]);
    expect(view.rows).toHaveLength(1);
    expect(view.pending.get(CMD_2)).toBe(0);
  });
});

describe("rows: a pending row is resolved by command id and by nothing else", () => {
  it("survives a turn terminal, which never commits or discards it", () => {
    // A pending row is `live` and carries loopId "" — the same loopId a
    // session-scoped frame folds under. A terminal that committed every live
    // row without excluding user rows would stamp the composer's unsent text
    // into the transcript as though the server had accepted it.
    let view = pendingView(CMD_1, "not yet acknowledged");
    view = run(view, [
      textDelta("prose", "", TURN_1),
      history(envelope({ type: "TurnDone" })),
      history(envelope({ type: "TurnInterrupted" })),
    ]);
    const user = view.rows.find((r) => r.kind === "user");
    expect(user).toMatchObject({ live: true, journalSeq: undefined });
    expect(view.pending.get(CMD_1)).toBe(0);
  });

  it("survives a StepDone snap of the same (empty) loop id", () => {
    let view = pendingView(CMD_1, "still pending");
    view = run(view, [
      history(envelope({ type: "StepDone", payload: { messages: [] } })),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["user"]);
    expect(view.pending.get(CMD_1)).toBe(0);
  });
});

describe("rows: pending and commandOutcomes are copy-on-write", () => {
  it("rebuilds both maps rather than writing into the input's", () => {
    const before = pendingView();
    const after = run(before, [history(wireEnvelope(TURN_STARTED_WIRE))]);
    expect(after.pending).not.toBe(before.pending);
    expect(after.commandOutcomes).not.toBe(before.commandOutcomes);
    expect(before.pending.get(CMD_1)).toBe(0);
    expect(before.commandOutcomes.size).toBe(0);
  });

  it("reuses both maps when an event changes neither", () => {
    const before = pendingView();
    const after = run(before, [history(envelope({ type: "SessionIdle" }))]);
    expect(after.pending).toBe(before.pending);
    expect(after.commandOutcomes).toBe(before.commandOutcomes);
  });
});
