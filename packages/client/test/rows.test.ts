/**
 * The transcript row projection: the row shape, the ordinal, and §3b's first
 * commit rule.
 *
 * `SessionView.content` and `SessionView.toolCalls` are separate append-only
 * buckets with NO shared ordering key, so "text -> tool call -> text within a
 * turn" cannot be reconstructed from them: the interleaving is lost the moment
 * two updates land in different arrays. `rows` is ONE append-only array with a
 * monotonic ordinal, folded from the same inputs, so cross-bucket arrival
 * order survives.
 *
 * ## Provenance of the wire strings below
 *
 * `contract/fixtures/` carries exactly two enduring envelopes, a TurnDone and a
 * StepDone, so TurnStarted and TurnFoldedInto have NO vendored fixture at all.
 * Every `*_WIRE` constant here is therefore the VERBATIM stdout of
 * `event.MarshalEvent` in `github.com/looprig/harness@v0.30.0` — this module's
 * pin, and the version `contract/VERSION` records — driven by a throwaway main
 * that constructed real `event.TurnStarted` / `event.TurnFoldedInto` values
 * against `core@v0.6.0` / `inference@v0.12.0` (the versions the pin's module
 * graph resolves; a bare `go mod tidy` picks v0.6.1/v0.12.1, which is NOT the
 * pinned wire). They are parsed with JSON.parse, so these tests consume bytes
 * rather than JS object literals encoding this author's beliefs about the wire.
 *
 * ## Both spellings of a zero cause loop id are real
 *
 * `identity.Cause` tags every id `omitzero` and `event.Header` tags the whole
 * `Cause` `omitzero`, so PRODUCTION omits a zero id and omits `cause` entirely
 * when nothing in it is set (TURN_STARTED_ZERO_CAUSE_WIRE below is exactly
 * that, straight from the marshaller). The vendored fixtures spell the zero
 * OUT anyway, because harness's `pkg/serve/fixtures_test.go` normalises its
 * golden bodies with `uuidRE.ReplaceAll(b, []byte(zeroUUID))` — a REPLACEMENT,
 * so the key survives with an all-zeros value.
 * TURN_STARTED_HANDBACK_NORMALIZED_WIRE is a real hand-back event put through
 * that exact normaliser, and it is the form a gate written as
 * `cause?.loop_id === undefined` mis-classifies: it would commit no user row
 * for an event whose cause loop id reads as zero.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView, fold } from "../src/fold.js";
import type { EventEnvelope } from "../src/types.js";
import { LOOP_A, envelope, history, liveEnduring, loopStarted, resetSeq, textBlockWire, userMessageWire } from "./helpers.js";
import { run } from "./run.js";

const LOOP_ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TURN_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** A genuine user submit: Cause carries the submit CommandID and no loop id. */
const TURN_STARTED_USER_WIRE =
  '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"hello","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":3,"type":"TurnStarted","v":1}';

/** A zero Cause entirely — production's ordinary "no cause" spelling: no `cause` key. */
const TURN_STARTED_ZERO_CAUSE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"bare","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":8,"type":"TurnStarted","v":1}';

/** A real hand-back run through harness's fixture normaliser: `cause.loop_id` spelled all-zeros. */
const TURN_STARTED_HANDBACK_NORMALIZED_WIRE =
  '{"cause":{"loop_id":"00000000-0000-0000-0000-000000000000","command_id":"00000000-0000-0000-0000-000000000000"},"created_at":"2026-08-27T10:00:00Z","event_id":"00000000-0000-0000-0000-000000000000","loop_id":"00000000-0000-0000-0000-000000000000","message":{"role":"user","blocks":[{"Text":"normalized","type":"text"}]},"session_id":"00000000-0000-0000-0000-000000000000","turn_id":"00000000-0000-0000-0000-000000000000","turn_index":4,"type":"TurnStarted","v":1}';

/** A real TurnStarted whose `*content.UserMessage` was nil: no `message` key at all. */
const TURN_STARTED_NO_MESSAGE_WIRE =
  '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":7,"type":"TurnStarted","v":1}';

function wireEnvelope(json: string): EventEnvelope {
  return JSON.parse(json) as EventEnvelope;
}

/** Reads a wire key WITHOUT collapsing an absent one to "" — the distinction this file turns on. */
function wireCauseLoopId(json: string): string | undefined {
  const raw = JSON.parse(json) as { cause?: { loop_id?: unknown } };
  const value = raw.cause?.loop_id;
  return typeof value === "string" ? value : undefined;
}

describe("rows: the shape and the ordinal", () => {
  it("commits one fully-specified user row from a REAL TurnStarted whose cause loop id is zero", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_ALPHA),
      history(wireEnvelope(TURN_STARTED_USER_WIRE), 7),
    ]);
    // toStrictEqual, not toMatchObject: every projected field is pinned here,
    // and an extra field nobody meant to add fails rather than passing quietly.
    expect(view.rows).toStrictEqual([
      {
        kind: "user",
        ordinal: 0,
        loopId: LOOP_ALPHA,
        turnId: TURN_1,
        journalSeq: 7,
        live: false,
        orphanedLoop: false,
        blocks: [{ type: "text", text: "hello" }],
      },
    ]);
    expect(view.nextOrdinal).toBe(1);
  });

  it("still appends the generic StatusEventMarker alongside the row", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_USER_WIRE), 7)]);
    expect(view.statusEvents).toHaveLength(1);
    expect(view.statusEvents[0]?.type).toBe("TurnStarted");
  });

  it("commits a user row when production OMITS the cause entirely", () => {
    // Read the property out of the bytes rather than asserting it as a belief.
    expect(wireCauseLoopId(TURN_STARTED_ZERO_CAUSE_WIRE)).toBeUndefined();
    expect(Object.hasOwn(JSON.parse(TURN_STARTED_ZERO_CAUSE_WIRE) as object, "cause")).toBe(false);

    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_ZERO_CAUSE_WIRE), 2)]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.kind).toBe("user");
  });

  it("commits a user row when the cause loop id is SPELLED OUT as all-zeros, the form every fixture carries", () => {
    // The bytes really do carry the key with a zero value: this is the case a
    // gate written as `cause?.loop_id === undefined` gets wrong.
    expect(wireCauseLoopId(TURN_STARTED_HANDBACK_NORMALIZED_WIRE)).toBe(ZERO_UUID);

    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_HANDBACK_NORMALIZED_WIRE), 5)]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toStrictEqual({
      kind: "user",
      ordinal: 0,
      loopId: ZERO_UUID,
      turnId: ZERO_UUID,
      journalSeq: 5,
      live: false,
      orphanedLoop: false,
      blocks: [{ type: "text", text: "normalized" }],
    });
  });

  it("commits NO row for a REAL TurnStarted that carries no message", () => {
    expect(Object.hasOwn(JSON.parse(TURN_STARTED_NO_MESSAGE_WIRE) as object, "message")).toBe(false);

    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_NO_MESSAGE_WIRE), 1)]);
    expect(view.rows).toStrictEqual([]);
    expect(view.nextOrdinal).toBe(0);
  });

  it("takes journalSeq from the COMMITTING event, cold or live, and folds both segments to the same row", () => {
    resetSeq();
    const cold = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_USER_WIRE), 11)]);
    resetSeq();
    const live = run(emptySessionView(), [liveEnduring(wireEnvelope(TURN_STARTED_USER_WIRE), 11)]);
    expect(cold.rows).toStrictEqual(live.rows);
    expect(cold.rows[0]?.journalSeq).toBe(11);
  });

  it("assigns strictly increasing ordinals, and never reuses one", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(envelope({ type: "TurnStarted", loopId: LOOP_A, payload: { message: userMessageWire([textBlockWire("one")]) } })),
      // A TurnStarted with no message commits nothing and must not burn an ordinal.
      history(envelope({ type: "TurnStarted", loopId: LOOP_A })),
      history(envelope({ type: "TurnStarted", loopId: LOOP_A, payload: { message: userMessageWire([textBlockWire("two")]) } })),
      history(envelope({ type: "TurnStarted", loopId: LOOP_A, payload: { message: userMessageWire([textBlockWire("three")]) } })),
    ]);
    const ordinals = view.rows.map((r) => r.ordinal);
    expect(ordinals).toStrictEqual([0, 1, 2]);
    for (let i = 1; i < ordinals.length; i++) {
      expect(ordinals[i]!, "ordinals must strictly increase").toBeGreaterThan(ordinals[i - 1]!);
    }
    expect(new Set(ordinals).size, "an ordinal was reused").toBe(ordinals.length);
    expect(view.nextOrdinal, "nextOrdinal must sit past every allocated ordinal").toBe(3);
  });

  it("carries the decoded blocks through verbatim, including a block kind it does not understand", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(
        envelope({
          type: "TurnStarted",
          loopId: LOOP_A,
          payload: {
            message: userMessageWire([textBlockWire("look"), { type: "image", Source: "x" }]),
          },
        }),
      ),
    ]);
    expect(view.rows[0]).toMatchObject({
      blocks: [
        { type: "text", text: "look" },
        { type: "other", wireType: "image", raw: { type: "image", Source: "x" } },
      ],
    });
  });
});

describe("rows: copy-on-write", () => {
  it("APPENDS INTO the input view's rows array, and advances no counter on it", () => {
    // AMENDED by the O(M^2) fix. This case pinned the opposite — "never appends
    // into the input view's rows array" — and design §3c deliberately reversed
    // it: "The outer array may be appended in place." Copying it per event made
    // a cold journal replay quadratic before first paint.
    //
    // The consequence is written down rather than hidden. A caller that retains
    // an older view reads the NEWER rows through it while that object's
    // `nextOrdinal` stays put, so retaining a view is unsupported. Retaining a
    // ROW is supported, and the two cases below are what make it so.
    resetSeq();
    const before = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_USER_WIRE), 1)]);
    const beforeRows = before.rows;
    const after = run(before, [history(wireEnvelope(TURN_STARTED_USER_WIRE), 2)]);

    expect(after.rows, "the append copied the array instead of pushing into it").toBe(beforeRows);
    expect(after.rows).toHaveLength(2);
    expect(before.nextOrdinal, "the ordinal counter must stay per-view, not shared").toBe(1);
    expect(after.nextOrdinal).toBe(2);
  });

  it("keeps an already-committed row's object identity across later folds, which per-row Object.is selectors depend on", () => {
    resetSeq();
    const first = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_USER_WIRE), 1)]);
    const committed = first.rows[0];
    const second = run(first, [history(wireEnvelope(TURN_STARTED_USER_WIRE), 2)]);
    expect(second.rows[0], "an untouched row was re-created, so every card would re-render").toBe(committed);
  });

  it("never writes THROUGH a row already committed in the input view", () => {
    // Object.freeze here, in the test, never in production: a write through a
    // frozen object throws in module (strict) code, so this catches an in-place
    // row update even when it writes a value EQUAL to the one already there —
    // which a deep-compare snapshot cannot. Every later task that "updates" a
    // row (completing a tool card, extending the live segment) must replace the
    // object; this is the assertion that stops it writing through instead.
    resetSeq();
    const first = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_USER_WIRE), 1)]);
    first.rows.forEach((row) => Object.freeze(row));
    const second = run(first, [history(wireEnvelope(TURN_STARTED_USER_WIRE), 2)]);
    expect(second.rows).toHaveLength(2);
    expect(second.rows[0]).toBe(first.rows[0]);
  });

  it("leaves rows untouched on a failed fold", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(TURN_STARTED_USER_WIRE), 1)]);
    const rows = view.rows;
    const result = fold(view, { segment: "live", frame: { type: "ephemeral", data: { kind: "token_delta" } } as never });
    expect(result.ok).toBe(false);
    expect(view.rows).toBe(rows);
    expect(view.rows).toHaveLength(1);
  });
});
