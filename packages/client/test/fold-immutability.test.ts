/**
 * fold.ts's immutability contract. AMENDED, deliberately and once.
 *
 * The original pin was blanket: "fold returns a new SessionView and never
 * mutates `view` in place". Design §3c narrows it — "The outer array may be
 * appended in place" — because spreading `statusEvents` ran on EVERY enduring
 * event including the whole cold journal replay, which is O(M^2) before first
 * paint on exactly the path the row projection exists to serve.
 *
 * The narrowing is safe for one reason and it is checked, not assumed:
 * `joinSessionView` keeps ONE reassigned `view` variable, and the only place it
 * hands back a PREVIOUS view is a failed fold — which appends nothing, so
 * "previous" and "current" are the same value there. Nothing diffs two
 * SessionViews.
 *
 * The blanket assertion below is therefore SCOPED rather than deleted, and the
 * three properties the amendment does NOT touch are asserted explicitly so the
 * carve-out cannot quietly widen:
 *
 *  1. fold never mutates an EXISTING element of any array. Row objects are
 *     copy-on-write (test/rows.test.ts freezes them, so even a value-preserving
 *     write-through throws) and so are `toolCalls` cards.
 *  2. fold never mutates the Maps — `gates`, `loops`, `pending`,
 *     `commandOutcomes` — in place; each is copied on write.
 *  3. A FAILED fold appends nothing and changes nothing. This is what keeps the
 *     view `join.ts` yields on error correct, and it is the whole reason the
 *     amendment is safe at all.
 *
 * Only APPENDS are carved out. `replaceRow`, `dropLiveRows`,
 * `dropEmptyLiveProse`, `commitLiveRows` and `resolveCommand` still build a new
 * array: an append leaves any retained view holding a coherent PREFIX, while a
 * replacement or a removal would rewrite history it had already shown.
 *
 * The inputs below deliberately include ids that COLLIDE with the seeded
 * view's (`seed`), not just fresh ones. `foldEphemeral`'s
 * tool_call_started/tool_call_completed cases have a second branch that merges
 * into an existing card, and that branch — not the append — is the likeliest
 * place for an in-place write. An input set of fresh ids only ever exercises
 * the append, so it would stay green against
 * `toolCalls[matchIndex].status = "completed"`.
 */
import { describe, expect, it } from "vitest";
import { addPendingRow, emptySessionView, fold, type FoldInput, type SessionView } from "../src/fold.js";
import {
  LOOP_A,
  LOOP_B,
  aiMessageWire,
  envelope,
  history,
  liveEnduring,
  liveEphemeral,
  resetSeq,
  textBlockWire,
  textDelta,
  thinkingDelta,
  userMessageWire,
} from "./helpers.js";

/** A structural deep clone that survives Map/Set/undefined (JSON does not). */
function snapshot(view: SessionView): unknown {
  return structuredClone(view);
}

/**
 * Every `SessionView` array `seededView` fills. Named explicitly rather than
 * derived, so that a later task adding a field this seed set does NOT populate
 * has to decide about it here instead of silently weakening the fixture.
 */
const SEEDED_ARRAYS = [
  "content",
  "toolCalls",
  "queuedInputs",
  "compactions",
  "statusEvents",
  // rows must be seeded too, or "did not mutate rows" would be a claim about an
  // empty array. The seed's TurnStarted therefore carries a message: a turn
  // opener with no message commits no row at all.
  "rows",
] as const satisfies readonly (keyof SessionView)[];

/**
 * The gate this file's seeded view holds open. `gates` is the first non-array
 * field on `SessionView` and the FIRST one fold may remove from, so an in-place
 * `Map.delete` is a real risk an empty seed could not catch — the seed opens a
 * gate and `inputs()` below resolves it.
 */
const SEEDED_GATE_ID = "9e2f0000-0000-4000-8000-0000000000ff";

/**
 * The command ids the seeded view holds. `pending` and `commandOutcomes` are
 * the other two non-array fields fold may DELETE from and write to, and both
 * are copy-on-write; an unseeded pair would make "did not mutate them" a claim
 * about empty maps. SEEDED_PENDING_CMD is resolved by `inputs()` below (which
 * is the delete), SEEDED_ORPHAN_CMD is left dangling.
 */
const SEEDED_PENDING_CMD = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SEEDED_ORPHAN_CMD = "dddddddd-1111-4111-8111-111111111111";

function gateOpenedWire(gateId: string): Record<string, unknown> {
  return { gate: { id: gateId, kind: "harness.permission", prompt: { title: "Allow?" } } };
}

/**
 * A view with every one of `SEEDED_ARRAYS` non-empty, so "did not
 * mutate" is a claim about real entries rather than about empty arrays, and so
 * the merge branches below have something to merge into.
 */
function seededView(): SessionView {
  resetSeq();
  let view = emptySessionView();
  const seeds: FoldInput[] = [
    history(envelope({ type: "TurnStarted", loopId: LOOP_A, payload: { message: userMessageWire([textBlockWire("seed")]) } })),
    textDelta("seed", LOOP_A),
    liveEphemeral("tool_call_started", { tool_execution_id: "seed", tool_name: "Bash" }, LOOP_A),
    liveEphemeral("input_queued", undefined, LOOP_A),
    liveEphemeral(
      "compaction_started",
      { attempt_id: "seed", reason: 1, basis: { revision: 1, through_event_id: "e0" } },
      LOOP_A,
    ),
    history(envelope({ type: "GateOpened", loopId: LOOP_A, payload: gateOpenedWire(SEEDED_GATE_ID) })),
  ];
  for (const seed of seeds) {
    const seeded = fold(view, seed);
    expect(seeded.ok, "a seed input must fold cleanly").toBe(true);
    if (seeded.ok) view = seeded.view;
  }
  view = addPendingRow(view, SEEDED_PENDING_CMD, [{ type: "text", text: "pending" }]);
  view = addPendingRow(view, SEEDED_ORPHAN_CMD, [{ type: "text", text: "orphan" }]);
  for (const key of SEEDED_ARRAYS) {
    expect(view[key].length, `seeded view leaves ${key} empty`).toBeGreaterThan(0);
  }
  expect(view.gates.size, "seeded view leaves gates empty").toBeGreaterThan(0);
  expect(view.pending.size, "seeded view leaves pending empty").toBe(2);
  return view;
}

function inputs(): FoldInput[] {
  resetSeq();
  return [
    history(envelope({ type: "TurnStarted", loopId: LOOP_A })),
    // Commits a row onto the already-seeded rows array: the append path, not
    // just the no-op path.
    history(envelope({ type: "TurnStarted", loopId: LOOP_B, payload: { message: userMessageWire([textBlockWire("input")]) } })),
    history(
      envelope({
        type: "StepDone",
        loopId: LOOP_A,
        payload: { messages: [aiMessageWire([textBlockWire("hi")])] },
      }),
    ),
    history(envelope({ type: "TurnDone", loopId: LOOP_A })),
    liveEnduring(envelope({ type: "GateOpened", loopId: LOOP_A })),
    // Opens a second gate, then removes the seeded one: the two branches that
    // copy `gates`, one of which DELETES from it.
    history(envelope({ type: "GateOpened", loopId: LOOP_B, payload: gateOpenedWire("9e2f0000-0000-4000-8000-0000000000ee") })),
    history(envelope({ type: "GateResolved", loopId: LOOP_A, payload: { gate_id: SEEDED_GATE_ID, action: "Approve" } })),
    // The three command-resolving branches: one that DELETES from `pending`
    // while writing `commandOutcomes`, one that writes `commandOutcomes` only,
    // and one that must touch neither (no command id at all).
    history(
      envelope({
        type: "TurnStarted",
        loopId: LOOP_A,
        cause: { command_id: SEEDED_PENDING_CMD },
        payload: { message: userMessageWire([textBlockWire("acknowledged")]) },
      }),
    ),
    history(envelope({ type: "TurnRejected", loopId: LOOP_A, cause: { command_id: SEEDED_PENDING_CMD }, payload: { reason: 1 } })),
    history(envelope({ type: "InputCancelled", loopId: LOOP_A, cause: { command_id: "9e2f0000-0000-4000-8000-00000000000c" } })),
    history(envelope({ type: "InputCancelled", loopId: LOOP_A })),
    history(envelope({ type: "TurnInterrupted", loopId: LOOP_A })),
    history(envelope({ type: "TurnFailed", loopId: LOOP_A, payload: { err: { kind: "tool_limit", message: "too many" } } })),
    textDelta("tok", LOOP_A),
    thinkingDelta("think", LOOP_A),
    liveEphemeral("tool_call_started", { tool_execution_id: "t1", tool_name: "Read" }, LOOP_A),
    liveEphemeral("tool_call_completed", { tool_execution_id: "t1", is_error: false }, LOOP_A),
    // The merge branches: these ids match the seeded card, so fold takes the
    // matchIndex !== -1 path rather than appending.
    liveEphemeral("tool_call_started", { tool_execution_id: "seed", tool_name: "Zsh" }, LOOP_A),
    liveEphemeral("tool_call_completed", { tool_execution_id: "seed", is_error: true }, LOOP_A),
    liveEphemeral("input_queued", undefined, LOOP_A),
    liveEphemeral(
      "compaction_started",
      { attempt_id: "a1", reason: 2, basis: { revision: 1, through_event_id: "e1" } },
      LOOP_A,
    ),
    // Failure paths: fold returns ok:false and MUST leave the view untouched.
    liveEphemeral("token_delta", { chunk_type: "nonesuch" }, LOOP_A),
    liveEphemeral("token_delta", undefined, LOOP_A),
    liveEphemeral("compaction_started", { attempt_id: "a1" }, LOOP_A),
    { segment: "live", frame: { type: "heartbeat" } as never },
    {
      segment: "live",
      frame: { type: "error", error: new Error("upstream") } as never,
    },
    { segment: "history", event: { journal_seq: 99 } as never },
  ];
}

/**
 * Every `SessionView` key EXCEPT the append-only arrays §3c carves out. A field
 * added to `SessionView` later is not silently exempt: it has to be listed here
 * or in APPEND_ONLY_ARRAYS, which is a decision rather than an omission.
 */
const APPEND_ONLY_ARRAYS = [
  "content",
  "toolCalls",
  "queuedInputs",
  "compactions",
  "statusEvents",
  "rows",
] as const satisfies readonly (keyof SessionView)[];

/** The view with the carved-out arrays replaced by their LENGTH. */
function protectedPart(view: SessionView): unknown {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(view) as Array<keyof SessionView>) {
    out[key] = (APPEND_ONLY_ARRAYS as readonly string[]).includes(key)
      ? undefined
      : structuredClone(view[key]);
  }
  return out;
}

describe("fold immutability contract", () => {
  it("does not mutate anything outside the append-only arrays, for any input kind", () => {
    for (const input of inputs()) {
      const view = seededView();
      const before = protectedPart(view);
      fold(view, input);
      expect(
        protectedPart(view),
        `input mutated the view: ${JSON.stringify(input).slice(0, 120)}`,
      ).toEqual(before);
    }
  });

  it("APPENDS to the carved-out arrays and never edits or shortens them", () => {
    // The compensating assertion for the amendment: an append-in-place is
    // allowed, an in-place EDIT of an element already there is not, and neither
    // is a removal. structuredClone of the prefix, not the identities: this is
    // about the values a retained view would read back.
    for (const input of inputs()) {
      const view = seededView();
      const prefixes = APPEND_ONLY_ARRAYS.map((key) => structuredClone(view[key]));
      fold(view, input);
      APPEND_ONLY_ARRAYS.forEach((key, i) => {
        const prefix = prefixes[i]!;
        expect(
          view[key].length,
          `${key} was shortened by ${JSON.stringify(input).slice(0, 80)}`,
        ).toBeGreaterThanOrEqual(prefix.length);
        expect(
          structuredClone(view[key]).slice(0, prefix.length),
          `${key}'s existing entries were edited by ${JSON.stringify(input).slice(0, 80)}`,
        ).toEqual(prefix);
      });
    }
  });

  it("never mutates a row or tool card OBJECT already in the view", () => {
    // Identity-level, not value-level: freezing is what catches a write-through
    // that preserves the value, which no deep compare can see. Phase 4's
    // per-row Object.is selectors depend on exactly this.
    for (const input of inputs()) {
      const view = seededView();
      view.rows.forEach((row) => Object.freeze(row));
      view.toolCalls.forEach((card) => Object.freeze(card));
      expect(
        () => fold(view, input),
        `input wrote through a frozen row or card: ${JSON.stringify(input).slice(0, 120)}`,
      ).not.toThrow();
    }
  });

  it("returns a view object distinct from its input whenever it accepts an input", () => {
    for (const input of inputs()) {
      const view = seededView();
      const result = fold(view, input);
      if (!result.ok) continue;
      if (result.view === view) {
        // The only accepted inputs allowed to hand the same object back are
        // the documented no-ops (heartbeat, and a StatusEvent with no event).
        expect(
          JSON.stringify(input),
          `accepted input reused the input view object without being a no-op: ${JSON.stringify(input).slice(0, 120)}`,
        ).toMatch(/"heartbeat"|"journal_seq":99/);
        continue;
      }
      // The original rule here was "every array that grew must be a NEW array
      // object". The amendment inverts it for the carved-out arrays — they are
      // now SHARED with the input by design — and it cannot simply be flipped,
      // because a non-append edit (replaceRow, dropLiveRows, resolveCommand)
      // legitimately does hand back a new array. "Appended in place" is a
      // PERFORMANCE property and it is pinned where it belongs, on the pure
      // append paths, in test/fold-perf.test.ts. What survives here is the
      // safety half: the prefix is never edited (above) and the Maps below.
      // Same rule for the Maps, each of which can shrink as well as grow —
      // `loops` only ever grows, but it is copy-on-write for the same reason.
      const maps = ["gates", "pending", "commandOutcomes", "loops"] as const;
      for (const key of maps) {
        if (result.view[key].size !== view[key].size) {
          expect(result.view[key], `${key} changed but reuses the input's Map object`).not.toBe(
            view[key],
          );
        }
      }
    }
  });

  it("returns the input view identity on a no-op input", () => {
    const view = emptySessionView();
    const heartbeat = fold(view, { segment: "live", frame: { type: "heartbeat" } as never });
    expect(heartbeat.ok).toBe(true);
    if (heartbeat.ok) expect(heartbeat.view).toBe(view);
  });

  it("leaves the view ENTIRELY untouched on a failed fold, which is what join.ts relies on", () => {
    // Unscoped on purpose: a failed fold may not append either. This is the
    // assertion the whole append-in-place amendment rests on, so it keeps the
    // original full-view snapshot compare.
    const failures: FoldInput[] = [
      liveEphemeral("token_delta", { chunk_type: "nonesuch" }, LOOP_A),
      liveEphemeral("token_delta", undefined, LOOP_A),
      liveEphemeral("compaction_started", { attempt_id: "a1" }, LOOP_A),
      liveEphemeral("compaction_started", { attempt_id: "a1", reason: 1 }, LOOP_A),
      { segment: "live", frame: { type: "error", error: new Error("upstream") } as never },
    ];
    for (const input of failures) {
      const view = seededView();
      const before = snapshot(view);
      const result = fold(view, input);
      expect(result.ok, `expected a FAILED fold for ${JSON.stringify(input).slice(0, 80)}`).toBe(false);
      expect(snapshot(view), `a failed fold changed the view: ${JSON.stringify(input).slice(0, 80)}`).toEqual(before);
    }
  });
});
