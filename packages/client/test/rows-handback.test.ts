/**
 * §3b rule 2, the negative half: "a non-zero cause loop id is a subagent
 * hand-back and commits no row; without this the UI renders a phantom user
 * message on every hand-back."
 *
 * `handlers_events.go` subscribes `LoopScope{All: true}`, so a parent loop sees
 * every child's frames; a hand-back arrives as a turn opener on the PARENT loop
 * whose `Cause.LoopID` is the CHILD's loop id. It carries a real UserMessage —
 * the subagent's answer, folded back in as the parent's next input — so the
 * only thing separating it from genuine human input is that cause id.
 *
 * The wire strings are the verbatim stdout of `event.MarshalEvent` in
 * `github.com/looprig/harness@v0.30.0` against `core@v0.6.0`, driven by a
 * throwaway main that built real `event.TurnStarted` values (the same producer
 * rows.test.ts's constants came from; see its header for why hand-authoring
 * them would prove nothing).
 *
 * Every case here asserts that the event was SEEN and deliberately not
 * committed — `statusEvents` grows and `nextOrdinal` does not — rather than
 * just that `rows` is empty. `rows` is empty in a fold that ignored the event
 * entirely, so the bare assertion would pass against a decoder that never
 * reached the gate at all.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView } from "../src/fold.js";
import type { EventEnvelope } from "../src/types.js";
import { LOOP_A, envelope, history, loopStarted, resetSeq, textBlockWire, userMessageWire } from "./helpers.js";
import { run } from "./run.js";

const LOOP_ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOOP_BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A real hand-back: Cause.LoopID is the CHILD loop, and a real user message rides along. */
const TURN_STARTED_HANDBACK_WIRE =
  '{"cause":{"loop_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"subagent said: done","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":4,"type":"TurnStarted","v":1}';

/** A genuine user submit on the same loop: Cause carries only the submit CommandID. */
const TURN_STARTED_USER_WIRE =
  '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"hello","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":3,"type":"TurnStarted","v":1}';

/** A genuine folded tool-continuation input: queued text folded into a mandatory continuation. */
const TURN_FOLDED_INTO_USER_WIRE =
  '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"also do this","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":5,"type":"TurnFoldedInto","v":1}';

/** The same fold, but a hand-back: Cause.LoopID is the child loop. */
const TURN_FOLDED_INTO_HANDBACK_WIRE =
  '{"cause":{"loop_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"result","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":6,"type":"TurnFoldedInto","v":1}';

function wireEnvelope(json: string): EventEnvelope {
  return JSON.parse(json) as EventEnvelope;
}

describe("rows: subagent hand-back gating", () => {
  it("commits NO user row for a REAL TurnStarted whose cause loop id is a child loop", () => {
    // The bytes carry a real message, so "no row" is a decision about the gate,
    // not a consequence of there being nothing to commit.
    const message = (JSON.parse(TURN_STARTED_HANDBACK_WIRE) as { message?: unknown }).message;
    expect(message).toBeDefined();

    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_HANDBACK_WIRE), 3)]);

    expect(view.rows).toStrictEqual([]);
    // Seen, not skipped: the generic marker landed and the ordinal was not burned.
    expect(view.statusEvents).toHaveLength(1);
    expect(view.statusEvents[0]?.type).toBe("TurnStarted");
    expect(view.nextOrdinal).toBe(0);
  });

  it("still commits the genuine user row that follows on the same loop, at ordinal 0", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_ALPHA),
      history(wireEnvelope(TURN_STARTED_HANDBACK_WIRE), 3),
      history(wireEnvelope(TURN_STARTED_USER_WIRE), 4),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "user",
        ordinal: 0,
        loopId: LOOP_ALPHA,
        turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        journalSeq: 4,
        live: false,
        orphanedLoop: false,
        blocks: [{ type: "text", text: "hello" }],
      },
    ]);
    expect(
      view.statusEvents.map((m) => m.type),
      "both turn events must still reach the generic marker, alongside the LoopStarted prelude",
    ).toStrictEqual(["LoopStarted", "TurnStarted", "TurnStarted"]);
  });

  it("does not let a hand-back between two genuine inputs burn an ordinal", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(wireEnvelope(TURN_STARTED_USER_WIRE), 1),
      history(wireEnvelope(TURN_STARTED_HANDBACK_WIRE), 2),
      history(wireEnvelope(TURN_STARTED_USER_WIRE), 3),
    ]);
    expect(view.rows.map((r) => r.ordinal)).toStrictEqual([0, 1]);
    expect(view.rows.map((r) => r.journalSeq)).toStrictEqual([1, 3]);
  });

  it("treats a cause carrying ONLY a command id as genuine input, not a hand-back", () => {
    // The distinction is Cause.LoopID alone. Cause.CommandID is set on BOTH —
    // gating on "a cause is present" would suppress every real user row.
    const cause = (JSON.parse(TURN_STARTED_USER_WIRE) as { cause?: Record<string, unknown> }).cause;
    expect(cause).toBeDefined();
    expect(Object.hasOwn(cause ?? {}, "command_id")).toBe(true);
    expect(Object.hasOwn(cause ?? {}, "loop_id")).toBe(false);

    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_USER_WIRE), 1)]);
    expect(view.rows).toHaveLength(1);
  });

  it("commits a row for a cause loop id that is not a string at all — the decoder's uniform malformed-reads-as-zero rule", () => {
    // NOT REAL WIRE: uuid.UUID always marshals to a string. A corrupted record
    // could carry this, and decodeEnduring projects any non-string id onto ""
    // exactly as it projects a non-numeric turn_index onto 0, so the gate sees
    // a zero cause and commits. Pinned because it is a REAL consequence of the
    // projection, and enduring.ts's comment used to claim the opposite.
    resetSeq();
    const view = run(emptySessionView(), [
      history(
        envelope({
          type: "TurnStarted",
          loopId: LOOP_A,
          cause: { loop_id: 42 },
          payload: { message: userMessageWire([textBlockWire("corrupt")]) },
        }),
      ),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.loopId).toBe(LOOP_A);
  });

  it("gates on the CAUSE loop id, never on the producing loop id", () => {
    // Same producing loop, two different cause loop ids. If the gate read
    // decoded.loopId (or compared the two) instead of decoded.causeLoopId, both
    // of these would land the same way.
    resetSeq();
    const suppressed = run(emptySessionView(), [
      history(
        envelope({
          type: "TurnStarted",
          loopId: LOOP_ALPHA,
          cause: { loop_id: LOOP_BETA },
          payload: { message: userMessageWire([textBlockWire("handback")]) },
        }),
      ),
    ]);
    const committed = run(emptySessionView(), [
      history(
        envelope({
          type: "TurnStarted",
          loopId: LOOP_ALPHA,
          cause: { command_id: "cmd-1" },
          payload: { message: userMessageWire([textBlockWire("genuine")]) },
        }),
      ),
    ]);
    expect(suppressed.rows).toHaveLength(0);
    expect(committed.rows).toHaveLength(1);
  });

  it("suppresses a hand-back whose cause loop id equals the PRODUCING loop id", () => {
    // A self-referential cause is still non-zero, so the rule is "zero or not",
    // never "different from the producing loop".
    resetSeq();
    const view = run(emptySessionView(), [
      history(
        envelope({
          type: "TurnStarted",
          loopId: LOOP_ALPHA,
          cause: { loop_id: LOOP_ALPHA },
          payload: { message: userMessageWire([textBlockWire("self")]) },
        }),
      ),
    ]);
    expect(view.rows).toStrictEqual([]);
  });
});

/**
 * TurnFoldedInto is queued input folded into a mandatory tool-continuation. §3b
 * treats it identically to TurnStarted — same payload shape from decodePayload,
 * same cause gate — so the two share one fold case. It gets its own suite
 * because the hand-back half of it is the case that would otherwise pass
 * vacuously: before the fold case existed, "commits no row" was true of a
 * TurnFoldedInto for the trivial reason that NOTHING was committed for one.
 */
describe("rows: TurnFoldedInto", () => {
  it("commits a full user row for a REAL genuine folded tool-continuation input", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_ALPHA),
      history(wireEnvelope(TURN_FOLDED_INTO_USER_WIRE), 4),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "user",
        ordinal: 0,
        loopId: LOOP_ALPHA,
        turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        journalSeq: 4,
        live: false,
        orphanedLoop: false,
        blocks: [{ type: "text", text: "also do this" }],
      },
    ]);
    expect(view.nextOrdinal).toBe(1);
  });

  it("commits NO user row for a REAL TurnFoldedInto hand-back", () => {
    // Non-vacuous now that the fold case exists: the sibling case above proves
    // a TurnFoldedInto CAN commit a row, so an empty rows array here is the
    // gate's decision rather than an unhandled event type.
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_FOLDED_INTO_HANDBACK_WIRE), 5)]);
    expect(view.rows).toStrictEqual([]);
    expect(view.statusEvents).toHaveLength(1);
    expect(view.statusEvents[0]?.type).toBe("TurnFoldedInto");
    expect(view.nextOrdinal).toBe(0);
  });

  it("projects the same row shape as TurnStarted, differing only in what the events differ in", () => {
    resetSeq();
    const started = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_USER_WIRE), 9)]);
    resetSeq();
    const folded = run(emptySessionView(), [history(wireEnvelope(TURN_FOLDED_INTO_USER_WIRE), 9)]);
    const startedRow = started.rows[0];
    const foldedRow = folded.rows[0];
    expect(startedRow).toBeDefined();
    expect(foldedRow).toBeDefined();
    expect(Object.keys(foldedRow ?? {}).sort()).toStrictEqual(Object.keys(startedRow ?? {}).sort());
    // Identical apart from the blocks the two events actually carry: no field
    // records which opener committed the row, because §3b draws no distinction.
    expect({ ...foldedRow, blocks: [] }).toStrictEqual({ ...startedRow, blocks: [] });
  });

  it("shares one ordinal sequence with TurnStarted, in arrival order", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(wireEnvelope(TURN_STARTED_USER_WIRE), 1),
      history(wireEnvelope(TURN_FOLDED_INTO_HANDBACK_WIRE), 2),
      history(wireEnvelope(TURN_FOLDED_INTO_USER_WIRE), 3),
      history(wireEnvelope(TURN_STARTED_HANDBACK_WIRE), 4),
      history(wireEnvelope(TURN_FOLDED_INTO_USER_WIRE), 5),
    ]);
    expect(view.rows.map((r) => r.ordinal)).toStrictEqual([0, 1, 2]);
    expect(view.rows.map((r) => r.journalSeq)).toStrictEqual([1, 3, 5]);
  });
});
