/**
 * The turn TERMINALS' row behaviour (design §3b rule 2): "every turn terminal
 * first commits any non-empty live segment, then resets it".
 *
 * ## Why a terminal has to commit anything at all
 *
 * A step that decoded nothing usable emits NO `StepDone` at all — that is not a
 * convention but an enforced property of harness's durable write boundary:
 * `MarshalEvent` REFUSES a `StepDone` whose `Messages` is empty
 * ("event: invalid StepDone: Messages is invalid"), which
 * test/enduring.test.ts pins against harness v0.30.0. `StepDone` is the only
 * other place a live segment is ever snapped, so on an abnormal terminal the
 * in-flight segment was never snapped and, if the terminal does not commit it,
 * the partial work SILENTLY VANISHES. `TurnDone` does the same defensively —
 * tui's `ApplyEvent` doc calls it exactly that ("it only flushes any leftover
 * provisional live (defensive) and resets").
 *
 * ## Provenance of the wire strings
 *
 * Every `*_WIRE` constant here is the VERBATIM stdout of `event.MarshalEvent`
 * in `github.com/looprig/harness@v0.30.0` (this module's pin, forcing
 * `core@v0.6.0` / `inference@v0.12.0`), driven by a throwaway main package that
 * constructed the real event values. They are parsed with `JSON.parse` so these
 * tests consume bytes, not JS object literals. The builder-made envelopes
 * elsewhere in the file exist to vary `loop_id` / `journal_seq` / interleaving,
 * which the fixed wire strings cannot.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView, fold, type SessionView } from "../src/fold.js";
import type { EventEnvelope } from "../src/types.js";
import {
  LOOP_A,
  LOOP_B,
  TURN_1,
  aiMessageWire,
  envelope,
  history,
  liveEnduring,
  liveEphemeral,
  loopStarted,
  resetSeq,
  textBlockWire,
  textDelta,
  thinkingDelta,
} from "./helpers.js";
import { run } from "./run.js";

/** `event.TurnDone{Header: …, TurnIndex: 2}` — no message, no usage. */
const TURN_DONE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":2,"type":"TurnDone","v":1}';

function wireEnvelope(json: string): EventEnvelope {
  return JSON.parse(json) as EventEnvelope;
}

/** A live tool card, started and left RUNNING. */
function toolStarted(toolExecutionId: string, toolName: string, loopId: string) {
  return liveEphemeral(
    "tool_call_started",
    { tool_execution_id: toolExecutionId, tool_name: toolName },
    loopId,
    TURN_1,
  );
}

describe("rows: TurnDone commits any dangling live segment", () => {
  it("commits the dangling prose in full, stamped with the terminal's journalSeq", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      thinkingDelta("weighing it up", LOOP_A, TURN_1),
      textDelta("streamed but never StepDone'd", LOOP_A, TURN_1),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 5),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "assistant",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: 5,
        live: false,
        orphanedLoop: false,
        thinking: "weighing it up",
        text: "streamed but never StepDone'd",
        refusal: "",
        // A terminal COMMITS the live row in place, so it keeps the live
        // path's false: the terminal carries no blocks to learn otherwise from.
        redactedThinking: false,
      },
    ]);
  });

  it("commits it off real TurnDone wire too, not just a builder envelope", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("half an answer", LOOP_A, TURN_1),
      history(wireEnvelope(TURN_DONE_WIRE), 11),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      kind: "assistant",
      live: false,
      journalSeq: 11,
      text: "half an answer",
    });
  });

  it("commits it from a LIVE enduring frame, carrying that frame's journalSeq", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("live-path prose", LOOP_A, TURN_1),
      liveEnduring(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 21),
    ]);
    expect(view.rows[0]).toMatchObject({ live: false, journalSeq: 21, text: "live-path prose" });
  });

  it("commits nothing extra on the normal path — StepDone already snapped", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("provisional", LOOP_A, TURN_1),
      history(
        envelope({
          type: "StepDone",
          loopId: LOOP_A,
          turnId: TURN_1,
          payload: { messages: [aiMessageWire([textBlockWire("answer")])] },
        }),
      ),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["assistant"]);
    expect(view.rows[0]).toMatchObject({ text: "answer", live: false });
  });

  it("resets the segment, so the NEXT turn's deltas open a fresh row", () => {
    resetSeq();
    let view = run(emptySessionView(), [
      textDelta("turn one", LOOP_A, TURN_1),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    view = run(view, [textDelta("turn two", LOOP_A, TURN_1)]);
    expect(view.rows.map((r) => (r.kind === "assistant" ? r.text : ""))).toStrictEqual([
      "turn one",
      "turn two",
    ]);
  });

  it("resolves a still-RUNNING live tool card as ok — the step finalized", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      toolStarted("te-1", "Read", LOOP_A),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 7),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "tool",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: 7,
        live: false,
        orphanedLoop: false,
        toolUseId: "",
        toolExecutionId: "te-1",
        toolName: "Read",
        summary: "",
        status: "ok",
        result: "",
        spawnedLoopId: "",
      },
    ]);
  });

  it("does NOT overwrite an already-resolved card's status", () => {
    // The card completed with is_error, so it is NOT running: the terminal's
    // resolution applies to running cards only. Blanket-assigning the
    // terminal's status would rewrite a real failure as a success.
    resetSeq();
    const view = run(emptySessionView(), [
      toolStarted("te-1", "Bash", LOOP_A),
      liveEphemeral(
        "tool_call_completed",
        { tool_execution_id: "te-1", is_error: true, result_preview: "exit 1" },
        LOOP_A,
        TURN_1,
      ),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows[0]).toMatchObject({ status: "error", result: "exit 1", live: false });
  });

  it("commits every live row of the loop, keeping their relative order", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("before the call", LOOP_A, TURN_1),
      toolStarted("te-1", "Read", LOOP_A),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 9),
    ]);
    expect(view.rows.map((r) => [r.kind, r.ordinal, r.live, r.journalSeq])).toStrictEqual([
      ["assistant", 0, false, 9],
      ["tool", 1, false, 9],
    ]);
  });

  it("only touches the terminating loop", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("child", LOOP_B, TURN_1),
      toolStarted("te-b", "Grep", LOOP_B),
      textDelta("parent", LOOP_A, TURN_1),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    const other = view.rows.filter((r) => r.loopId === LOOP_B);
    expect(other).toHaveLength(2);
    expect(other.map((r) => [r.live, r.journalSeq])).toStrictEqual([
      [true, undefined],
      [true, undefined],
    ]);
    expect(other[1]).toMatchObject({ kind: "tool", status: "running" });
  });

  it("DROPS an empty live prose row rather than committing a blank assistant turn", () => {
    // A zero-length chunk still opens a segment (applyLiveChunk appends on the
    // first chunk it sees, whatever its length). Committing it would put an
    // empty assistant bubble in the transcript for every such turn.
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("", LOOP_A, TURN_1),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows).toStrictEqual([]);
  });

  it("commits a refusal-only segment, which is never empty", () => {
    // Guards the empty-prose drop against over-reaching: `refusal` is the third
    // field, and a drop testing only thinking/text would silently discard a
    // declined turn.
    resetSeq();
    let view = emptySessionView();
    const opened = fold(view, textDelta("", LOOP_A, TURN_1));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    view = withRefusal(opened.view, "I can't help with that");
    view = run(view, [history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 4)]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ kind: "assistant", refusal: "I can't help with that", live: false, journalSeq: 4 });
  });

  it("REPLACES the committed row object rather than writing through it", () => {
    // Object.freeze in the test, never in production: a write-through then
    // throws, which is the only guard that catches a VALUE-PRESERVING in-place
    // write. Phase 4's per-row Object.is selectors depend on the replacement.
    resetSeq();
    const first = run(emptySessionView(), [textDelta("prose", LOOP_A, TURN_1)]);
    const before = first.rows[0];
    first.rows.forEach((row) => Object.freeze(row));
    const after = run(first, [
      history(envelope({ type: "TurnDone", loopId: LOOP_A, turnId: TURN_1 }), 3),
    ]);
    expect(after.rows[0]).not.toBe(before);
    expect(before).toMatchObject({ live: true, journalSeq: undefined });
    expect(after.rows[0]).toMatchObject({ live: false, journalSeq: 3 });
  });
});

/**
 * Sets a refusal on the loop's live assistant row. No ephemeral frame carries a
 * refusal — `content.RefusalBlock` only ever arrives in a finalized message —
 * so a live refusal cannot be produced by folding wire, and this test-only
 * surgery is how the field's participation in the empty-prose check is
 * exercised at all. It rebuilds the row rather than mutating it.
 */
function withRefusal(view: SessionView, refusal: string): SessionView {
  const rows = view.rows.map((row) =>
    row.live && row.kind === "assistant" ? { ...row, refusal } : row,
  );
  return { ...view, rows };
}

/** `event.TurnInterrupted{Header: …, TurnIndex: 5}`. */
const TURN_INTERRUPTED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":5,"type":"TurnInterrupted","v":1}';

describe("rows: TurnInterrupted commits the segment, then a tombstone", () => {
  it("commits the partial work FIRST, then the tombstone", () => {
    // Order is the whole point. A tombstone appended before the partial work
    // would read as work produced AFTER the interrupt landed.
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      textDelta("half an ans", LOOP_A, TURN_1),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 }), 8),
    ]);
    expect(view.rows.map((r) => [r.kind, r.ordinal])).toStrictEqual([
      ["assistant", 0],
      ["tombstone", 1],
    ]);
    expect(view.rows[0]).toMatchObject({ live: false, text: "half an ans", journalSeq: 8 });
    expect(view.rows[1]).toStrictEqual({
      kind: "tombstone",
      ordinal: 1,
      loopId: LOOP_A,
      turnId: TURN_1,
      journalSeq: 8,
      live: false,
      orphanedLoop: false,
    });
  });

  it("commits the tombstone off real TurnInterrupted wire", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("mid-thought", LOOP_A, TURN_1),
      history(wireEnvelope(TURN_INTERRUPTED_WIRE), 14),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["assistant", "tombstone"]);
    expect(view.rows[1]).toMatchObject({ loopId: LOOP_A, turnId: TURN_1, journalSeq: 14 });
  });

  it("marks a still-running tool card CANCELLED, not ok", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      toolStarted("te-1", "Bash", LOOP_A),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 }), 6),
    ]);
    expect(view.rows[0]).toMatchObject({ kind: "tool", status: "cancelled", live: false, journalSeq: 6 });
  });

  it("leaves an already-completed card alone — it finished before the interrupt", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      toolStarted("te-1", "Read", LOOP_A),
      liveEphemeral("tool_call_completed", { tool_execution_id: "te-1" }, LOOP_A, TURN_1),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows[0]).toMatchObject({ kind: "tool", status: "ok" });
  });

  it("commits a tombstone even with nothing in flight", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["tombstone"]);
  });

  it("drops an EMPTY live prose row, so the tombstone stands alone", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("", LOOP_A, TURN_1),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["tombstone"]);
  });

  it("leaves another loop's live segment running", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("child still going", LOOP_B, TURN_1),
      textDelta("parent", LOOP_A, TURN_1),
      history(envelope({ type: "TurnInterrupted", loopId: LOOP_A, turnId: TURN_1 })),
    ]);
    expect(view.rows.filter((r) => r.loopId === LOOP_B)).toHaveLength(1);
    expect(view.rows.find((r) => r.loopId === LOOP_B)).toMatchObject({ live: true });
    expect(view.rows.filter((r) => r.kind === "tombstone")).toHaveLength(1);
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

describe("rows: TurnFailed commits the segment, then an error notice", () => {
  it("commits the truncated prefix FIRST, then the notice", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      textDelta("the model got this far", LOOP_A, TURN_1),
      history(wireEnvelope(TURN_FAILED_UNKNOWN_WIRE), 12),
    ]);
    expect(view.rows.map((r) => [r.kind, r.ordinal])).toStrictEqual([
      ["assistant", 0],
      ["notice", 1],
    ]);
    expect(view.rows[0]).toMatchObject({ live: false, text: "the model got this far", journalSeq: 12 });
    expect(view.rows[1]).toStrictEqual({
      kind: "notice",
      level: "error",
      text: "the turn failed: provider exploded: upstream 500",
      ordinal: 1,
      loopId: LOOP_A,
      turnId: TURN_1,
      journalSeq: 12,
      live: false,
      orphanedLoop: false,
    });
  });

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

  it("marks a still-running tool card as errored", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      toolStarted("te-1", "Bash", LOOP_A),
      history(wireEnvelope(TURN_FAILED_UNKNOWN_WIRE), 15),
    ]);
    expect(view.rows[0]).toMatchObject({ kind: "tool", status: "error", live: false, journalSeq: 15 });
  });

  it("drops an EMPTY live prose row, so the notice stands alone", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("", LOOP_A, TURN_1),
      history(wireEnvelope(TURN_FAILED_UNKNOWN_WIRE)),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["notice"]);
  });

  it("leaves another loop's live segment running", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("child still going", LOOP_B, TURN_1),
      history(wireEnvelope(TURN_FAILED_UNKNOWN_WIRE)),
    ]);
    expect(view.rows.find((r) => r.loopId === LOOP_B)).toMatchObject({ live: true });
    expect(view.rows.filter((r) => r.kind === "notice")).toHaveLength(1);
  });
});
