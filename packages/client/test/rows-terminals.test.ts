/** Durable turn terminals preserve committed rows and project interruptions and failures. */
import { describe, expect, it } from "vitest";
import { emptySessionView } from "../src/fold.js";
import type { EventEnvelope } from "../src/types.js";
import { LOOP_A, LOOP_B, TURN_1, aiMessageWire, envelope, history, resetSeq, textBlockWire } from "./helpers.js";
import { run } from "./run.js";

/** `event.TurnDone{Header: …, TurnIndex: 2}` — no message, no usage. */
const TURN_DONE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":2,"type":"TurnDone","v":1}';

function wireEnvelope(json: string): EventEnvelope {
  return JSON.parse(json) as EventEnvelope;
}


/** `event.TurnInterrupted{Header: …, TurnIndex: 5}`. */
const TURN_INTERRUPTED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":5,"type":"TurnInterrupted","v":1}';

describe("rows: TurnInterrupted projects a durable tombstone", () => {

  it("commits a tombstone even with nothing in flight", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(wireEnvelope(TURN_INTERRUPTED_WIRE), 12),
    ]);
    expect(view.rows).toMatchObject([{ kind: "tombstone", journalSeq: 12, loopId: LOOP_A, turnId: TURN_1, live: false }]);
  });
});

/**
 * The five real `TurnFailed` shapes. Every one carries an `err` object: the
 * struct field is tagged `json:"-"`, but `marshalTurnFailed` marshals
 * `turnFailedWire`, which PROJECTS `Err` through `projectError` onto a
 * `restoredErrorWire{Kind,Message}` whose two keys carry no `omitempty` — and
 * `projectError(nil)` returns `{Kind: "unknown", Message: ""}` rather than nil,
 * so the pointer's own `omitempty` never fires either. "TurnFailed carries no
 * failure detail on the wire" is therefore false, and a failed turn that shows
 * no reason is a bug in this layer, not a limit of the protocol.
 */
const TURN_FAILED_UNKNOWN_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","err":{"kind":"unknown","message":"provider exploded: upstream 500"},"event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":2,"type":"TurnFailed","v":1}';

const TURN_FAILED_EMPTY_RESPONSE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","err":{"kind":"empty_response","message":"the model returned no content"},"event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":3,"type":"TurnFailed","v":1}';

const TURN_FAILED_TOOL_LIMIT_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","err":{"kind":"tool_limit","message":"tool limit reached: 12/12 iterations, 40/60 calls"},"event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":6,"type":"TurnFailed","v":1}';

/** `&event.RestoredError{Kind: "turn_panic", Message: ""}` — a classified failure with no text. */
const TURN_FAILED_KIND_ONLY_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","err":{"kind":"turn_panic","message":""},"event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":7,"type":"TurnFailed","v":1}';

/** `event.TurnFailed{…}` with a NIL Err — still an `err` object, kind "unknown". */
const TURN_FAILED_NIL_ERR_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","err":{"kind":"unknown","message":""},"event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":8,"type":"TurnFailed","v":1}';

describe("rows: TurnFailed projects a durable error notice", () => {

  it("renders the failure reason the wire actually carries", () => {
    // "TurnFailed.Err is json:\"-\", so no cause text reaches the wire" is a
    // FALSE reading of the struct: marshalTurnFailed projects it. A failed turn
    // rendering no reason at all is the bug this case exists to prevent.
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_FAILED_UNKNOWN_WIRE))]);
    expect(view.rows[0]).toMatchObject({
      kind: "notice",
      level: "error",
      text: "the turn failed: provider exploded: upstream 500",
    });
  });

  it("names the CLASSIFIED kind alongside its message", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_FAILED_EMPTY_RESPONSE_WIRE))]);
    expect(view.rows[0]).toMatchObject({
      text: "the turn failed (empty_response): the model returned no content",
    });
  });

  it("names the kind for tool_limit too, whose message carries the counters", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_FAILED_TOOL_LIMIT_WIRE))]);
    expect(view.rows[0]).toMatchObject({
      text: "the turn failed (tool_limit): tool limit reached: 12/12 iterations, 40/60 calls",
    });
  });

  it("falls back to the kind alone when the message is empty", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_FAILED_KIND_ONLY_WIRE))]);
    expect(view.rows[0]).toMatchObject({ text: "the turn failed (turn_panic)" });
  });

  it('suppresses the "unknown" kind, which is the ABSENCE of a classification', () => {
    // ErrKind's catch-all. Printing "(unknown)" would present the lack of a
    // classification as one, and it adds nothing beside the message.
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_FAILED_NIL_ERR_WIRE))]);
    expect(view.rows[0]).toMatchObject({ kind: "notice", level: "error", text: "the turn failed" });
  });

  it("still commits a notice for an envelope carrying no err at all", () => {
    // NOT REAL WIRE — every marshalled TurnFailed has an `err` object. Kept so
    // a corrupted or truncated record degrades to a bare failure notice rather
    // than rendering "undefined" or dropping the failure entirely.
    resetSeq();
    const view = run(emptySessionView(), [
      history(envelope({ type: "TurnFailed", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ kind: "notice", level: "error", text: "the turn failed" });
  });
});

it("preserves committed rows through TurnDone without adding a second assistant row", () => {
  const before = run(emptySessionView(), [history(envelope({ type: "StepDone", loopId: LOOP_A,
    payload: { messages: [aiMessageWire([textBlockWire("finished")])] },
  }))]);
  const row = before.rows[0];
  const after = run(before, [history(wireEnvelope(TURN_DONE_WIRE), 14)]);
  expect(after.rows).toHaveLength(1);
  expect(after.rows[0]).toBe(row);
});

it.each([
  ["TurnInterrupted", TURN_INTERRUPTED_WIRE, "tombstone"],
  ["TurnFailed", TURN_FAILED_UNKNOWN_WIRE, "notice"],
])("%s preserves prior durable rows and appends its terminal marker after them", (_type, wire, kind) => {
  const before = run(emptySessionView(), [
    history(envelope({ type: "StepDone", loopId: LOOP_A, payload: { messages: [aiMessageWire([textBlockWire("partial work")])] } }), 10),
    history(envelope({ type: "StepDone", loopId: LOOP_B, payload: { messages: [aiMessageWire([textBlockWire("child work")])] } }), 11),
  ]);
  const retained = before.rows.slice();
  const after = run(before, [history(wireEnvelope(wire), 12)]);
  expect(after.rows.map((row) => row.kind)).toEqual(["assistant", "assistant", kind]);
  expect(after.rows[0]).toBe(retained[0]);
  expect(after.rows[1]).toBe(retained[1]);
  expect(after.rows[2]).toMatchObject({ loopId: LOOP_A, journalSeq: 12 });
});
