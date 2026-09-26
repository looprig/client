/**
 * The loop tree, and §3b's orphaned-`LoopStarted` fallback:
 *
 *   "A child loop whose `LoopStarted` was never observed renders as a top-level
 *    block with an 'orphaned subagent' marker rather than being DROPPED."
 *
 * The orphan case is reachable, not defensive. `GET /journal` defaults to 100
 * events and caps at 1000, so a consumer that does not replay from
 * `from_journal_seq=0` starts after the `LoopStarted` that names a loop's
 * parent — and harness emits one per loop exactly once, at loop creation.
 * `join.ts` replays from 0; nothing forces another consumer to.
 *
 * ## Provenance of the wire strings
 *
 * Every `*_WIRE` constant is the VERBATIM stdout of `event.MarshalEvent` in
 * `github.com/looprig/harness@v0.30.0` — this module's pin, and the version
 * `contract/VERSION` records — driven by a throwaway main constructing real
 * `event.LoopStarted` / `event.StepDone` values against `core@v0.6.0` /
 * `inference@v0.12.0` (the versions the pin's graph resolves; a bare
 * `go mod tidy` picks v0.6.1/v0.12.1, which is NOT the pinned wire). They are
 * parsed with JSON.parse, so these tests consume bytes rather than object
 * literals encoding this author's beliefs about the wire.
 *
 * ## What the marshaller proved about LoopStarted's header
 *
 * `LoopStarted`'s identity profile FORBIDS a promoted turn or step: marshalling
 * one with either set fails with `event: invalid LoopStarted: TurnID must be
 * zero` / `... StepID must be zero`. The spawning loop/turn/step lives ONLY
 * under `cause`, so the parent link is read from `cause.loop_id` and never from
 * the promoted `loop_id`, which is the NEW loop. A root loop carries no `cause`
 * key at all (`ROOT_WIRE` below is exactly that, straight from the marshaller);
 * harness's own `findRootLoopStarted` uses the same "zero Cause = root" rule,
 * and restore fails closed without it — so every session's journal really does
 * carry a LoopStarted for its primary loop.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView, fold } from "../src/fold.js";
import { anchorOf } from "../src/rows.js";
import type { EventEnvelope } from "../src/types.js";
import {
  LOOP_A,
  LOOP_B,
  ZERO_UUID,
  aiMessageWire,
  envelope,
  history,
  resetSeq,
  textBlockWire,
  textDelta,
} from "./helpers.js";
import { run } from "./run.js";

/** A tool-spawned child: cause names the parent loop/turn/step, plus the anchor id. */
const CHILD_WIRE =
  '{"agent_name":"researcher","cause":{"session_id":"11111111-1111-4111-8111-111111111111","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","step_id":"55555555-5555-4555-8555-555555555555"},"created_at":"2026-08-27T10:00:00Z","display_name":"Research","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","parent_tool_use_id":"toolu_sub","session_id":"11111111-1111-4111-8111-111111111111","type":"LoopStarted","v":1}';

/** The same child with an empty DisplayName — an older journal: `display_name` is absent. */
const CHILD_NO_DISPLAY_WIRE =
  '{"agent_name":"researcher","cause":{"session_id":"11111111-1111-4111-8111-111111111111","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","step_id":"55555555-5555-4555-8555-555555555555"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","parent_tool_use_id":"toolu_sub","session_id":"11111111-1111-4111-8111-111111111111","type":"LoopStarted","v":1}';

/** The session's primary loop: NO `cause` key at all, and no anchor. */
const ROOT_WIRE =
  '{"agent_name":"primer","created_at":"2026-08-27T10:00:00Z","display_name":"primer","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","type":"LoopStarted","v":1}';

/** A NON-tool spawn: a real parent loop, but no `parent_tool_use_id` to hang from. */
const CHILD_NO_TOOL_WIRE =
  '{"agent_name":"researcher","cause":{"session_id":"11111111-1111-4111-8111-111111111111","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},"created_at":"2026-08-27T10:00:00Z","display_name":"Foreign","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","session_id":"11111111-1111-4111-8111-111111111111","type":"LoopStarted","v":1}';

/** The orchestrator step whose Subagent tool call is the child's anchor. */
const PARENT_STEP_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Text":"delegating","type":"text"},{"ID":"toolu_sub","Input":{"agent":"researcher"},"Name":"Subagent","type":"tool_use"}]},{"role":"tool","blocks":[{"Text":"child summary","type":"text"}],"tool_use_id":"toolu_sub"}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

function wireEnvelope(json: string): EventEnvelope {
  return JSON.parse(json) as EventEnvelope;
}

/** One committed assistant row for `loopId`, at an explicit journal_seq. */
function step(loopId: string, text: string, seq: number) {
  return history(
    envelope({
      type: "StepDone",
      loopId,
      payload: { messages: [aiMessageWire([textBlockWire(text)])] },
    }),
    seq,
  );
}

describe("rows: the loop tree", () => {
  it("records a child loop's parent, anchor and label from a REAL LoopStarted", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(CHILD_WIRE), 4)]);
    expect(view.loops.get(LOOP_B)).toStrictEqual({
      loopId: LOOP_B,
      parentLoopId: LOOP_A,
      parentToolUseId: "toolu_sub",
      label: "Research",
      observed: true,
    });
  });

  it("reads the parent from `cause`, never from the promoted loop_id, which is the NEW loop", () => {
    const raw = JSON.parse(CHILD_WIRE) as { loop_id: string; cause: { loop_id: string } };
    expect(raw.loop_id, "the promoted id is the child").toBe(LOOP_B);
    expect(raw.cause.loop_id, "the parent lives only under cause").toBe(LOOP_A);
    expect(Object.hasOwn(raw, "turn_id"), "loopProfile forbids a promoted turn").toBe(false);
    expect(Object.hasOwn(raw, "step_id"), "loopProfile forbids a promoted step").toBe(false);
  });

  it("records the ROOT loop with no parent and no anchor, from a LoopStarted carrying no cause", () => {
    expect(Object.hasOwn(JSON.parse(ROOT_WIRE) as object, "cause")).toBe(false);
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(ROOT_WIRE), 0)]);
    expect(view.loops.get(LOOP_A)).toStrictEqual({
      loopId: LOOP_A,
      parentLoopId: "",
      parentToolUseId: "",
      label: "primer",
      observed: true,
    });
    expect(anchorOf(view, LOOP_A)).toBeUndefined();
  });

  it("treats a SPELLED-OUT zero cause loop id as a root, not as a child of loop 000…0", () => {
    // harness's fixture normaliser REPLACES every uuid with the zero uuid, so
    // the all-zeros spelling is real wire. Reading it as a parent id would
    // build a tree rooted at a loop that does not exist.
    resetSeq();
    const view = run(emptySessionView(), [
      history(
        envelope({
          type: "LoopStarted",
          loopId: LOOP_A,
          agentName: "primer",
          cause: { loop_id: ZERO_UUID },
        }),
        0,
      ),
    ]);
    expect(view.loops.get(LOOP_A)?.parentLoopId).toBe("");
  });

  it("falls back to the header's agent_name when display_name is absent (older journals)", () => {
    expect(Object.hasOwn(JSON.parse(CHILD_NO_DISPLAY_WIRE) as object, "display_name")).toBe(false);
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(CHILD_NO_DISPLAY_WIRE), 4)]);
    expect(view.loops.get(LOOP_B)?.label).toBe("researcher");
  });

  it("commits NO transcript row for a LoopStarted, but still records the StatusEventMarker", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(CHILD_WIRE), 4)]);
    expect(view.rows).toStrictEqual([]);
    expect(view.statusEvents.map((m) => m.type)).toStrictEqual(["LoopStarted"]);
  });

  it("anchors a child's block at the parent tool row carrying the same tool-use id", () => {
    resetSeq();
    // The real order: the child's LoopStarted precedes the parent StepDone,
    // because the subagent runs before the step whose tool call contains it.
    const view = run(emptySessionView(), [
      history(wireEnvelope(CHILD_WIRE), 4),
      step(LOOP_B, "child work", 5),
      history(wireEnvelope(PARENT_STEP_WIRE), 9),
    ]);
    const anchor = anchorOf(view, LOOP_B);
    expect(anchor).toMatchObject({
      kind: "tool",
      loopId: LOOP_A,
      toolUseId: "toolu_sub",
      toolName: "Subagent",
      spawnedLoopId: LOOP_B,
    });
    // The anchor is a row of the PARENT's partition; the child's rows stay in
    // the child's, which is what the renderer nests under it.
    expect(view.rows.filter((r) => r.loopId === LOOP_B)).toHaveLength(1);
  });

  it("anchors retroactively when the LoopStarted arrives AFTER the parent's tool row", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(wireEnvelope(PARENT_STEP_WIRE), 9),
      history(wireEnvelope(CHILD_WIRE), 10),
    ]);
    expect(anchorOf(view, LOOP_B)).toMatchObject({ toolUseId: "toolu_sub", spawnedLoopId: LOOP_B });
  });

  it("stamps spawnedLoopId on ONLY the matching tool row", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(wireEnvelope(CHILD_WIRE), 4),
      history(
        envelope({
          type: "StepDone",
          loopId: LOOP_A,
          payload: {
            messages: [
              aiMessageWire([
                { type: "tool_use", ID: "toolu_other", Name: "Read", Input: {} },
                { type: "tool_use", ID: "toolu_sub", Name: "Subagent", Input: {} },
              ]),
            ],
          },
        }),
        9,
      ),
    ]);
    const tools = view.rows.filter((r) => r.kind === "tool");
    expect(tools.map((r) => (r.kind === "tool" ? [r.toolUseId, r.spawnedLoopId] : []))).toStrictEqual([
      ["toolu_other", ""],
      ["toolu_sub", LOOP_B],
    ]);
    // And the anchor is that row, not merely SOME tool row of the parent loop:
    // the unrelated call was committed first, so a lookup keyed on the loop
    // alone would pick it.
    expect(anchorOf(view, LOOP_B)).toMatchObject({ toolUseId: "toolu_sub" });
  });

  it("gives a NON-tool spawn no anchor, and does not call it orphaned", () => {
    // tui's loopSpawned skips an empty ParentToolUseID for the same reason: the
    // loop is real and its parent is known, there is simply no card to nest it
    // under. It renders top-level WITHOUT the orphan marker.
    resetSeq();
    const view = run(emptySessionView(), [
      history(wireEnvelope(CHILD_NO_TOOL_WIRE), 4),
      step(LOOP_B, "foreign work", 5),
    ]);
    expect(view.loops.get(LOOP_B)).toMatchObject({ parentLoopId: LOOP_A, parentToolUseId: "", observed: true });
    expect(anchorOf(view, LOOP_B)).toBeUndefined();
    expect(view.rows.every((r) => !r.orphanedLoop)).toBe(true);
  });

  it("returns no anchor for a loop nothing has ever mentioned", () => {
    expect(anchorOf(emptySessionView(), LOOP_B)).toBeUndefined();
  });
});

describe("rows: the orphaned-LoopStarted fallback", () => {
  it("marks an UNOBSERVED loop orphaned, keeps its rows, and gives it no anchor", () => {
    resetSeq();
    // The child's LoopStarted fell off the journal page: only its work is here.
    const view = run(emptySessionView(), [step(LOOP_B, "child work", 7)]);
    expect(view.loops.get(LOOP_B)).toStrictEqual({
      loopId: LOOP_B,
      parentLoopId: "",
      parentToolUseId: "",
      label: "",
      observed: false,
    });
    expect(anchorOf(view, LOOP_B)).toBeUndefined();
    const rows = view.rows.filter((r) => r.loopId === LOOP_B);
    expect(rows, "an unobserved loop's rows must never be dropped").toHaveLength(1);
    expect(rows[0]?.orphanedLoop).toBe(true);
  });

  it("marks an unobserved loop's LIVE rows orphaned too", () => {
    resetSeq();
    const view = run(emptySessionView(), [textDelta("streaming", LOOP_B)]);
    expect(view.rows.map((r) => [r.live, r.orphanedLoop])).toStrictEqual([[true, true]]);
  });

  it("un-orphans a loop's rows when its LoopStarted arrives later in the same replay", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      step(LOOP_B, "child work", 7),
      textDelta("streaming", LOOP_B),
      history(wireEnvelope(CHILD_WIRE), 8),
    ]);
    expect(view.loops.get(LOOP_B)?.observed).toBe(true);
    expect(view.rows.filter((r) => r.loopId === LOOP_B)).toHaveLength(2);
    expect(view.rows.every((r) => !r.orphanedLoop)).toBe(true);
  });

  it("un-orphans ONLY the loop the LoopStarted names", () => {
    resetSeq();
    const other = "99999999-9999-4999-8999-999999999999";
    const view = run(emptySessionView(), [
      step(LOOP_B, "child work", 7),
      step(other, "someone else", 8),
      history(wireEnvelope(CHILD_WIRE), 9),
    ]);
    expect(view.rows.map((r) => [r.loopId, r.orphanedLoop])).toStrictEqual([
      [LOOP_B, false],
      [other, true],
    ]);
  });

  it("keeps every untouched row's object identity while un-orphaning", () => {
    resetSeq();
    const seeded = run(emptySessionView(), [step(LOOP_A, "root work", 1), step(LOOP_B, "child work", 7)]);
    const rootRow = seeded.rows[0];
    const childRow = seeded.rows[1];
    const view = run(seeded, [history(wireEnvelope(CHILD_WIRE), 8)]);
    expect(view.rows[0], "an unrelated row was re-created, so every card re-renders").toBe(rootRow);
    expect(view.rows[1], "the un-orphaned row must be a NEW object").not.toBe(childRow);
    expect(childRow?.orphanedLoop, "the old row object was written through").toBe(true);
  });

  it("never marks a loop orphaned once its own LoopStarted has been observed", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(wireEnvelope(ROOT_WIRE), 0),
      step(LOOP_A, "root work", 3),
      textDelta("streaming", LOOP_A),
    ]);
    expect(view.rows).toHaveLength(2);
    expect(view.rows.every((r) => !r.orphanedLoop)).toBe(true);
  });

  it("leaves a session-scoped row (no loop) out of the loop tree entirely", () => {
    resetSeq();
    // "" is the loop id an optimistic pending row and a session-scoped frame
    // both carry; registering it would invent a loop that never existed.
    const view = run(emptySessionView(), [textDelta("streaming")]);
    expect(view.loops.size).toBe(0);
    expect(view.rows[0]?.orphanedLoop).toBe(false);
  });

  it("copies the loops map when a NEW loop is registered", () => {
    resetSeq();
    const before = run(emptySessionView(), [step(LOOP_A, "root work", 1)]);
    const loops = before.loops;
    const after = run(before, [history(wireEnvelope(CHILD_WIRE), 2)]);
    expect(before.loops, "the input view's loops map was replaced under it").toBe(loops);
    expect(before.loops.size, "the input view's loops map grew in place").toBe(1);
    expect(after.loops, "the new view reuses the input's loops map").not.toBe(loops);
    expect(after.loops.size).toBe(2);
  });

  it("copies the loops map when an ALREADY-registered loop is observed", () => {
    resetSeq();
    // The loop is registered (unobserved) by its own StepDone, so the entry
    // exists before the LoopStarted lands and no new key is added. Nothing else
    // copies the map on this path — the LoopStarted case is the only defence,
    // and writing through it would flip an older snapshot's `observed` too.
    const before = run(emptySessionView(), [step(LOOP_B, "child work", 7)]);
    const loops = before.loops;
    expect(before.loops.get(LOOP_B)?.observed).toBe(false);
    const after = run(before, [history(wireEnvelope(CHILD_WIRE), 8)]);
    expect(after.loops, "the new view reuses the input's loops map").not.toBe(loops);
    expect(before.loops, "the input view's loops map was replaced under it").toBe(loops);
    expect(
      before.loops.get(LOOP_B)?.observed,
      "the input view's LoopInfo was written through",
    ).toBe(false);
    expect(after.loops.get(LOOP_B)?.observed).toBe(true);
  });

  it("leaves the loop tree untouched on a failed fold", () => {
    resetSeq();
    const view = run(emptySessionView(), [step(LOOP_A, "root work", 1)]);
    const loops = view.loops;
    const result = fold(view, {
      segment: "live",
      frame: { type: "ephemeral", data: { kind: "token_delta", delta: { chunk_type: "nope" } } } as never,
    });
    expect(result.ok).toBe(false);
    expect(view.loops).toBe(loops);
    expect(view.loops.size).toBe(1);
  });
});
