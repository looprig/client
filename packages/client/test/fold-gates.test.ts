/**
 * §3c: GateOpened/GateResolved fold into a `gates` map, opened on the first and
 * REMOVED on the second.
 *
 * The properties this file exists to hold, in order of what they buy:
 *
 *  - Concurrent gates from parallel loops coexist. That is precisely what
 *    `GET /status`'s single `waiting_gate_id` slot cannot do — it is
 *    last-writer-wins and any GateResolved clears it, so the earlier of two
 *    open gates is lost permanently. A map keyed by gate id is the fix, and it
 *    is only a fix if BOTH entries survive and each resolve removes only its
 *    own.
 *  - The key is the GATE id, not the loop id and not the tool execution id. Two
 *    gates in one loop, or two gates over one tool call, must not collide.
 *  - History and live fold identically, so a reconnect that replays the journal
 *    lands on the same open-gate set as a session watched from the start.
 *
 * The wire shapes below are the same verbatim `event.MarshalEvent` bytes
 * test/gate.test.ts uses, with the ids rewritten per case; see that file's
 * provenance note.
 */
import { describe, expect, it } from "vitest";
import {
  emptyPublicGateBoard,
  emptySessionView,
  fold,
  foldPublicGateEvent,
  foldPublicGatePage,
  publicGateKey,
  publicGates,
  type FoldInput,
  type PublicGateBoard,
  type SessionView,
} from "../src/fold.js";
import { acceptsResidentResponse } from "../src/gate-actions.js";
import { GATE_PROJECTION_WIRE_FIELDS } from "../src/gate.js";
import type { EventEnvelope, PublicGatePage } from "../src/types.js";
import { validatePublicGatePage } from "../src/validate.js";
import {
  LOOP_A,
  LOOP_B,
  SESSION_ID,
  envelope,
  history,
  liveEnduring,
  liveEphemeral,
  resetSeq,
} from "./helpers.js";

const GATE_A = "9e2f0000-0000-4000-8000-00000000000a";
const GATE_B = "9e2f0000-0000-4000-8000-00000000000b";
const TOOL_EXEC_1 = "99999999-9999-4999-8999-999999999999";

/**
 * A real permission gate envelope, with `id` and the owning loop substituted.
 * Built from the marshalled bytes rather than hand-written so the fold is
 * exercised against the shape harness actually emits.
 */
function gateOpened(gateId: string, loopId: string, extra?: Record<string, unknown>): EventEnvelope {
  return envelope({
    type: "GateOpened",
    loopId,
    payload: {
      gate: {
        id: gateId,
        kind: "harness.permission",
        resolver: "loop",
        blocks: "tool_call",
        effect: "resume",
        criticality: "critical",
        subject: { tool_execution_id: TOOL_EXEC_1, tool_use_id: "toolu_1" },
        prompt: {
          title: "Allow Write?",
          body: "write /tmp/x",
          controls: [{ action: "Approve", label: "Approve" }],
        },
        response_policy: { timeout: 60000000000, on_timeout: "respond" },
        restorable: true,
        ...extra,
      },
    },
  });
}

function gateResolved(gateId: string, loopId: string, action = "Approve"): EventEnvelope {
  return envelope({
    type: "GateResolved",
    loopId,
    payload: { gate_id: gateId, resolver: "loop", reason: "answered", action, source: { kind: "user" } },
  });
}

function run(view: SessionView, inputs: FoldInput[]): SessionView {
  let out = view;
  for (const input of inputs) {
    const result = fold(out, input);
    if (!result.ok) throw result.error;
    out = result.view;
  }
  return out;
}

describe("fold: gate state", () => {
  it("opens a gate on GateOpened, carrying the full decoded envelope", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(gateOpened(GATE_A, LOOP_A))]);
    expect([...view.gates.keys()]).toStrictEqual([GATE_A]);
    const gate = view.gates.get(GATE_A);
    // The whole envelope, not just an id — this is the point of folding the
    // event rather than polling a slot.
    expect(gate?.prompt.title).toBe("Allow Write?");
    expect(gate?.prompt.controls).toStrictEqual([{ action: "Approve", label: "Approve" }]);
    expect(gate?.kind).toBe("harness.permission");
    expect(gate?.subject.toolExecutionId).toBe(TOOL_EXEC_1);
    expect(gate?.responsePolicy.timeoutNanos).toBe(60_000_000_000);
  });

  it("removes the gate on GateResolved", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateResolved(GATE_A, LOOP_A)),
    ]);
    expect(view.gates.size).toBe(0);
    expect(view.gates.has(GATE_A)).toBe(false);
  });

  it("holds concurrent gates from parallel loops independently", () => {
    resetSeq();
    let view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateOpened(GATE_B, LOOP_B)),
    ]);
    // Both open at once. A last-writer-wins slot has already lost GATE_A here.
    expect([...view.gates.keys()].sort()).toStrictEqual([GATE_A, GATE_B].sort());

    view = run(view, [history(gateResolved(GATE_A, LOOP_A))]);
    // Resolving one must remove ONLY that one — not clear the set.
    expect([...view.gates.keys()]).toStrictEqual([GATE_B]);
    expect(view.gates.get(GATE_B)?.id).toBe(GATE_B);

    view = run(view, [history(gateResolved(GATE_B, LOOP_B))]);
    expect(view.gates.size).toBe(0);
  });

  it("holds two gates raised by the SAME loop over the SAME tool call", () => {
    // Keyed by gate id, so neither loop_id nor subject.tool_execution_id may be
    // the key: both collide here, and a collision would silently drop a gate a
    // human still has to answer.
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateOpened(GATE_B, LOOP_A)),
    ]);
    expect(view.gates.size).toBe(2);
    expect(view.gates.get(GATE_A)?.id).toBe(GATE_A);
    expect(view.gates.get(GATE_B)?.id).toBe(GATE_B);
  });

  it("removes only the resolved gate when both were raised by one loop", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateOpened(GATE_B, LOOP_A)),
      history(gateResolved(GATE_B, LOOP_A)),
    ]);
    expect([...view.gates.keys()]).toStrictEqual([GATE_A]);
  });

  it("ignores a GateResolved for a gate it never saw", () => {
    // A mid-stream join sees the close without the open. Removing nothing is
    // correct; throwing or clearing the map is not.
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateResolved(GATE_B, LOOP_B)),
    ]);
    expect([...view.gates.keys()]).toStrictEqual([GATE_A]);
  });

  it("keeps a non-permission gate in the map so the UI can say where to answer it", () => {
    // Only a permission gate is answerable in wui, but an unanswerable one still
    // blocks the session and must be visible — filtering it out here would make
    // an ask-user gate look like nothing was happening.
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A, { kind: "harness.ask_user" })),
    ]);
    expect(view.gates.get(GATE_A)?.kind).toBe("harness.ask_user");
  });

  it("arrives identically over live SSE and the cold journal", () => {
    resetSeq();
    const live = run(emptySessionView(), [liveEnduring(gateOpened(GATE_A, LOOP_A))]);
    resetSeq();
    const cold = run(emptySessionView(), [history(gateOpened(GATE_A, LOOP_A))]);
    expect(live.gates.get(GATE_A)).toStrictEqual(cold.gates.get(GATE_A));
    expect(live.gates.get(GATE_A)?.id).toBe(GATE_A);

    resetSeq();
    const liveResolved = run(live, [liveEnduring(gateResolved(GATE_A, LOOP_A))]);
    expect(liveResolved.gates.size).toBe(0);
  });

  it("never mutates the input view's gate map, on open OR on resolve", () => {
    resetSeq();
    const empty = emptySessionView();
    const opened = run(empty, [history(gateOpened(GATE_A, LOOP_A))]);
    expect(empty.gates.size).toBe(0);

    const resolved = fold(opened, history(gateResolved(GATE_A, LOOP_A)));
    if (!resolved.ok) throw resolved.error;
    // The prior view still holds the gate: join.ts yields the PRIOR view on a
    // failed fold, which is only sound if a successful one left it untouched.
    expect(opened.gates.size).toBe(1);
    expect(resolved.view.gates.size).toBe(0);
    expect(resolved.view.gates).not.toBe(opened.gates);
  });

  it("still appends the generic StatusEventMarker for a gate event", () => {
    // The kind-specific cases sit ALONGSIDE the generic fallback; nothing that
    // already read statusEvents regresses.
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(gateResolved(GATE_A, LOOP_A)),
    ]);
    expect(view.statusEvents.map((e) => e.type)).toStrictEqual(["GateOpened", "GateResolved"]);
    expect(view.statusEvents.map((e) => e.journalSeq)).toStrictEqual([0, 1]);
  });

  it("leaves the gate map alone for every other enduring type", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(gateOpened(GATE_A, LOOP_A)),
      history(envelope({ type: "TurnDone", loopId: LOOP_A, payload: { turn_index: 1 } })),
      history(envelope({ type: "SessionIdle", loopId: LOOP_A })),
      history(envelope({ type: "StepDone", loopId: LOOP_A, payload: { messages: [] } })),
    ]);
    expect([...view.gates.keys()]).toStrictEqual([GATE_A]);
    expect(view.statusEvents).toHaveLength(4);
  });
});

/**
 * ## The COLD gate board: Factory's gate page merged with live journal events
 *
 * `SessionView.gates` above is the per-session live fold. It cannot answer the
 * question this section is about, because it is built from journal events —
 * and a client that has just loaded a session may have no journal stream, no
 * live subscription and no Host at all. The durable
 * `GET /v1/sessions/{sid}/gates` page is a pure durable read (spec §7: "`list`,
 * `status`, `journal`, and initial gate rendering are pure durable reads") and
 * is the only source in that state.
 *
 * ### What the key is, and why it is a pair
 *
 * `(SessionID, GateID)`. A GateID is unique within its session and nothing
 * says it is unique across sessions, so a board that spans sessions — which
 * this one does, because a cold client renders a gate inbox before it has
 * picked a session — must carry both. `publicGateKey` length-prefixes the
 * session id so no pair of ids can collide by containing the delimiter.
 *
 * ### What "stable public order" MEANS
 *
 * The order is the ascending total order over the triple
 * `(sessionId, openedJournalSeq, gateId)`. It is total because the first and
 * third components are the map key, so no two entries tie on all three. It is
 * a pure function of the entry SET — `publicGates` sorts on read and stores no
 * order — so it cannot diverge from the entries the way a maintained index
 * would, and it does not depend on arrival order.
 *
 * That leaves exactly three ways an entry's sort position could move, and each
 * has a case below: a duplicate arrival (the open position is written once, on
 * first observation, and never rewritten), a live resolution (a removal, which
 * preserves the relative order of everything else), and a reload (re-applying
 * a page, which is idempotent on the sort fields).
 *
 * ### What is NOT promised
 *
 * A page merge never REMOVES. A gate that resolved while this client was
 * offline stays on the board until its `GateResolved` is folded or the board
 * is rebuilt from `emptyPublicGateBoard()`. That is pinned below rather than
 * left to a reader's assumption.
 */
describe("public gate board: cold projections merged with live events", () => {
  const SESSION_2 = "22222222-2222-4222-8222-222222222222";
  const GATE_C = "9e2f0000-0000-4000-8000-00000000000c";

  function gateRecord(
    gateId: string,
    seq: number,
    answerability: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      gate_id: gateId,
      kind: "harness.ask_user",
      prompt: {
        title: `Gate ${gateId}`,
        body: "pick one",
        origin: "https://example.test",
        controls: [{ action: "approve", label: "Approve" }],
        // Real, declared, public — and deliberately not projected.
        schema: { fields: [{ name: "f", label: "F", kind: "text", required: true }] },
      },
      opened_event_id: `event-${seq}`,
      opened_journal_seq: seq,
      deadline: "2026-08-29T13:00:00Z",
      answerability,
      ...extra,
    };
  }

  /**
   * A REAL page: built through the vendored schema's own validator, which is
   * stricter than the schema document. `validate.ts`'s `public_gate_page`
   * semantics require `opened_journal_seq` to be STRICTLY INCREASING across the
   * page and bounded by `journal_tip`, so every `page(...)` below lists its
   * records in ascending open order — a conformant Factory page already is.
   */
  function page(records: Array<Record<string, unknown>>, journalTip = 100): PublicGatePage {
    return validatePublicGatePage({
      journal_tip: journalTip,
      open_gate_count: records.length,
      gates: records,
    });
  }

  /**
   * NOT REAL WIRE: bypasses the validator. Used only where the case is about
   * the fold not DEPENDING on a property the validator already enforces (page
   * order) or about a shape the validator rejects (a sequence tie, a missing
   * gate id). Defence in depth: the board is also fed by live events, which no
   * page validator sees.
   */
  function malformedPage(records: Array<Record<string, unknown>>, journalTip = 100): PublicGatePage {
    return { journal_tip: journalTip, open_gate_count: records.length, gates: records } as unknown as PublicGatePage;
  }

  /** The same envelope re-addressed to another session. */
  function inSession(env: EventEnvelope, sessionId: string): EventEnvelope {
    return { ...(env as unknown as Record<string, unknown>), session_id: sessionId } as unknown as EventEnvelope;
  }

  function keysOf(board: PublicGateBoard): string[] {
    return publicGates(board).map((entry) => `${entry.sessionId}/${entry.gateId}`);
  }

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
    );
  }

  it("loads ZERO public gates from a cold page while no Host is reachable", () => {
    // Nothing live is folded anywhere in this case: this is exactly the state a
    // client is in when Factory answers and no Host exists.
    const board = foldPublicGatePage(emptyPublicGateBoard(), page([]), SESSION_ID);
    expect(publicGates(board)).toStrictEqual([]);
    expect(board.entries.size).toBe(0);
  });

  it("loads ONE public gate cold, keyed by (SessionID, GateID) and redacted", () => {
    const board = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 6, "resident")]), SESSION_ID);
    expect(keysOf(board)).toStrictEqual([`${SESSION_ID}/${GATE_A}`]);
    const entry = board.entries.get(publicGateKey(SESSION_ID, GATE_A));
    expect(entry).toStrictEqual({
      sessionId: SESSION_ID,
      gateId: GATE_A,
      kind: "harness.ask_user",
      prompt: {
        title: `Gate ${GATE_A}`,
        body: "pick one",
        origin: "https://example.test",
        controls: [{ action: "approve", label: "Approve" }],
      },
      openedEventId: "event-6",
      openedJournalSeq: 6,
      deadline: "2026-08-29T13:00:00Z",
      answerability: "resident",
    });
    // The page really did carry the withheld field, so its absence is a result.
    expect(Object.hasOwn(gateRecord(GATE_A, 6, "resident")["prompt"] as object, "schema")).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("fields");
  });

  it("loads MULTIPLE public gates cold from one REAL page, in ascending open order", () => {
    const board = foldPublicGatePage(
      emptyPublicGateBoard(),
      page([gateRecord(GATE_B, 7, "suspended"), gateRecord(GATE_C, 8, "expired"), gateRecord(GATE_A, 9, "resident")]),
      SESSION_ID,
    );
    expect(publicGates(board).map((g) => g.gateId)).toStrictEqual([GATE_B, GATE_C, GATE_A]);
    // Ascending by opened_journal_seq, NOT by gate id: sorted by id these three
    // are A, B, C, and the board puts A last — so a comparator that ignored the
    // sequence could not produce this.
    expect([GATE_C, GATE_A, GATE_B].sort()).toStrictEqual([GATE_A, GATE_B, GATE_C]);
  });

  it("orders by the entry SET, not by arrival: all 3! page orderings agree", () => {
    // The order is a pure function of the entries, so every ordering of the
    // page's own array must land identically. The space is small: enumerate it
    // rather than sampling one shuffle. Five of the six are not conformant
    // pages (the validator requires ascending `opened_journal_seq`), which is
    // exactly why this uses `malformedPage`: the guarantee asserted here is the
    // FOLD's, and the board is also fed by live events no page validator sees.
    const records = [gateRecord(GATE_A, 9, "resident"), gateRecord(GATE_B, 7, "suspended"), gateRecord(GATE_C, 8, "expired")];
    const orderings = permutations(records);
    expect(orderings).toHaveLength(6);
    for (const ordering of orderings) {
      const board = foldPublicGatePage(emptyPublicGateBoard(), malformedPage(ordering), SESSION_ID);
      expect(
        publicGates(board).map((g) => g.gateId),
        `page ordering ${JSON.stringify(ordering.map((r) => r["opened_journal_seq"]))}`,
      ).toStrictEqual([GATE_B, GATE_C, GATE_A]);
    }
  });

  it("orders by (sessionId, openedJournalSeq, gateId), breaking a sequence tie by gate id", () => {
    // Two gates opened at the same journal sequence is not real wire, but the
    // comparator must still be TOTAL or the order is not a definition.
    let board = foldPublicGatePage(emptyPublicGateBoard(), malformedPage([gateRecord(GATE_B, 5, "resident"), gateRecord(GATE_A, 5, "resident")]), SESSION_2);
    board = foldPublicGatePage(board, page([gateRecord(GATE_C, 4, "resident")]), SESSION_ID);
    expect(keysOf(board)).toStrictEqual([
      `${SESSION_ID}/${GATE_C}`,
      `${SESSION_2}/${GATE_A}`,
      `${SESSION_2}/${GATE_B}`,
    ]);
  });

  it("orders by CODE UNIT, not by the runtime's locale collation", () => {
    // The doc comment on `publicGates` claims the order does not vary with the
    // environment's collator, and `localeCompare` is the one-character change
    // that would break it. ICU's default collation orders lowercase before
    // uppercase and code units order the other way, so this pair separates
    // them; the first assertion is the anti-vacuity half — if a future ICU
    // stopped disagreeing, this case would otherwise pass for no reason.
    //
    // NOT REAL WIRE: both ids are UUIDs today. The schema constrains neither
    // beyond `minLength: 1`, and a public presentation order that depends on
    // the browser's locale is not one Factory and wui can both name.
    expect("A".localeCompare("a")).toBeGreaterThan(0);
    const byGate = foldPublicGatePage(
      emptyPublicGateBoard(),
      malformedPage([gateRecord("a", 5, "resident"), gateRecord("A", 5, "resident")]),
      SESSION_ID,
    );
    expect(publicGates(byGate).map((g) => g.gateId)).toStrictEqual(["A", "a"]);

    let bySession = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 5, "resident")]), "a");
    bySession = foldPublicGatePage(bySession, page([gateRecord(GATE_A, 5, "resident")]), "A");
    expect(publicGates(bySession).map((g) => g.sessionId)).toStrictEqual(["A", "a"]);
  });

  it("holds the SAME GateID in two sessions as two independent gates", () => {
    // This is the whole reason the key is a pair. A gate-id-only key silently
    // drops one of these, and it is the other session's human who never sees a
    // prompt.
    let board = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 3, "resident")]), SESSION_ID);
    board = foldPublicGatePage(board, page([gateRecord(GATE_A, 3, "unavailable")]), SESSION_2);
    expect(board.entries.size).toBe(2);
    expect(keysOf(board)).toStrictEqual([`${SESSION_ID}/${GATE_A}`, `${SESSION_2}/${GATE_A}`]);
  });

  it("cannot collide two different (SessionID, GateID) pairs that share a delimiter", () => {
    // NOT REAL WIRE (both ids are UUIDs today), but a key built by joining two
    // attacker-influenced strings with a separator is a real class of bug, and
    // the schema constrains neither id beyond minLength 1.
    expect(publicGateKey("a:b", "c")).not.toBe(publicGateKey("a", "b:c"));
    expect(publicGateKey("a", "b")).toBe(publicGateKey("a", "b"));
  });

  it("takes a DUPLICATE cold page without changing the key set or the order", () => {
    const records = [gateRecord(GATE_B, 7, "suspended"), gateRecord(GATE_A, 9, "resident")];
    const once = foldPublicGatePage(emptyPublicGateBoard(), page(records), SESSION_ID);
    const twice = foldPublicGatePage(once, page(records), SESSION_ID);
    expect(keysOf(twice)).toStrictEqual(keysOf(once));
    expect(publicGates(twice)).toStrictEqual(publicGates(once));
  });

  it("treats a DUPLICATE cold page as a referential no-op, like the live duplicate", () => {
    // The page path is the one a cold client POLLS, so this is the identity
    // that actually matters: `packages/react`'s useStore derives a list as
    // `useMemo(() => publicGates(board), [board])`, and a board rebuilt on
    // every unchanged poll re-renders every gate card forever.
    const records = [gateRecord(GATE_B, 7, "suspended"), gateRecord(GATE_A, 9, "resident")];
    const once = foldPublicGatePage(emptyPublicGateBoard(), page(records), SESSION_ID);
    expect(foldPublicGatePage(once, page(records), SESSION_ID)).toBe(once);
    // A page whose every record is unkeyable applies nothing either.
    expect(foldPublicGatePage(once, malformedPage([{ opened_journal_seq: 1 }]), SESSION_ID)).toBe(once);
    // Anti-vacuity: it is not that this function always returns its argument.
    expect(foldPublicGatePage(once, page([gateRecord(GATE_C, 8, "resident")]), SESSION_ID)).not.toBe(once);
  });

  it("changes board identity for EVERY mutable projected field, and for no immutable one", () => {
    // `samePublicGateEntry` is a hand-written field list, so its completeness
    // is the risk: a field it forgot would make a real update vanish. The leaf
    // names are therefore read out of GATE_PROJECTION_WIRE_FIELDS and
    // partitioned, and the partition is asserted to cover them exactly — a
    // field added to the projection lands in neither list and fails here.
    const { gate, prompt, control } = GATE_PROJECTION_WIRE_FIELDS;
    const leaves = [
      ...Object.keys(gate.projected).filter((n) => n !== "prompt"),
      ...Object.keys(prompt.projected).filter((n) => n !== "controls").map((n) => `prompt.${n}`),
      ...Object.keys(control.projected).map((n) => `prompt.controls[].${n}`),
    ].sort();

    type Edit = (record: Record<string, unknown>) => Record<string, unknown>;
    const withPrompt = (record: Record<string, unknown>, patch: Record<string, unknown>) => ({
      ...record,
      prompt: { ...(record["prompt"] as Record<string, unknown>), ...patch },
    });
    const withControl = (record: Record<string, unknown>, patch: Record<string, unknown>) =>
      withPrompt(record, {
        controls: ((record["prompt"] as Record<string, unknown>)["controls"] as Array<Record<string, unknown>>).map(
          (c) => ({ ...c, ...patch }),
        ),
      });

    // A change a consumer can observe must produce a NEW board.
    const mutable: Record<string, Edit> = {
      "kind": (r) => ({ ...r, kind: "harness.form" }),
      "deadline": (r) => ({ ...r, deadline: "2026-08-30T13:00:00Z" }),
      "answerability": (r) => ({ ...r, answerability: "expired" }),
      "prompt.title": (r) => withPrompt(r, { title: "Different" }),
      "prompt.body": (r) => withPrompt(r, { body: "different" }),
      "prompt.origin": (r) => withPrompt(r, { origin: "https://other.test" }),
      "prompt.controls[].action": (r) => withControl(r, { action: "deny" }),
      "prompt.controls[].label": (r) => withControl(r, { label: "Deny" }),
    };
    // The open position is written once, so a page disagreeing about it applies
    // nothing — and must therefore NOT churn identity either.
    const immutable: Record<string, Edit> = {
      "opened_event_id": (r) => ({ ...r, opened_event_id: "event-99" }),
      "opened_journal_seq": (r) => ({ ...r, opened_journal_seq: 42 }),
    };
    // A different gate id is a different key, so it adds an entry.
    const rekeys: Record<string, Edit> = { "gate_id": (r) => ({ ...r, gate_id: GATE_C }) };

    expect([...Object.keys(mutable), ...Object.keys(immutable), ...Object.keys(rekeys)].sort()).toStrictEqual(leaves);

    const base = gateRecord(GATE_A, 6, "resident");
    const board = foldPublicGatePage(emptyPublicGateBoard(), page([base]), SESSION_ID);
    for (const [name, edit] of Object.entries(mutable)) {
      const after = foldPublicGatePage(board, malformedPage([edit(base)]), SESSION_ID);
      expect(after, `${name} did not change the board`).not.toBe(board);
      expect(after.entries.size).toBe(1);
    }
    for (const [name, edit] of Object.entries(immutable)) {
      expect(
        foldPublicGatePage(board, malformedPage([edit(base)]), SESSION_ID),
        `${name} churned board identity`,
      ).toBe(board);
    }
    for (const [name, edit] of Object.entries(rekeys)) {
      const after = foldPublicGatePage(board, malformedPage([edit(base)]), SESSION_ID);
      expect(after, `${name} did not add an entry`).not.toBe(board);
      expect(after.entries.size).toBe(2);
    }
    // Cardinality is not a leaf name and would otherwise go unchecked — in
    // BOTH directions. `every` over the prior's controls already catches a
    // control being removed (the new list indexes past its end), so only the
    // ADDED direction reaches the length comparison; testing the shrink alone
    // left dropping that comparison alive.
    const fewer = withPrompt(base, { controls: [] });
    expect(foldPublicGatePage(board, malformedPage([fewer]), SESSION_ID)).not.toBe(board);
    const noControls = foldPublicGatePage(emptyPublicGateBoard(), malformedPage([fewer]), SESSION_ID);
    expect(foldPublicGatePage(noControls, malformedPage([fewer]), SESSION_ID)).toBe(noControls);
    expect(foldPublicGatePage(noControls, malformedPage([base]), SESSION_ID)).not.toBe(noControls);
  });

  it("RESURRECTS a resolved gate from a page that was in flight across the resolve", () => {
    // The inverse of the never-removes limitation, and it is NOT covered by it:
    // the page here is not stale-because-offline, it is a read that crossed a
    // live GateResolved. The gate comes back with its attested `resident`, so
    // `acceptsResidentResponse` reports a closed gate as answerable and nothing
    // will ever remove it. Pinned, not fixed: this module sees no fetch time
    // and no tip ordering, so the poll loop must choose a tombstone or a
    // rebuild — see foldPublicGatePage's comment.
    const inFlight = page([gateRecord(GATE_A, 6, "resident")]);
    let board = foldPublicGatePage(emptyPublicGateBoard(), inFlight, SESSION_ID);
    resetSeq();
    board = foldPublicGateEvent(board, liveEnduring(gateResolved(GATE_A, LOOP_A)));
    expect(board.entries.size).toBe(0);
    board = foldPublicGatePage(board, inFlight, SESSION_ID);
    expect(publicGates(board).map((g) => g.gateId)).toStrictEqual([GATE_A]);
    expect(acceptsResidentResponse(publicGates(board)[0]!)).toBe(true);
    // And a second copy of the same resolve does not clear it, because the
    // board never saw the gate re-open — it is only removable by an event that
    // will not come again.
    resetSeq();
    const rebuilt = foldPublicGateEvent(board, liveEnduring(gateResolved(GATE_A, LOOP_A)));
    expect(rebuilt.entries.size).toBe(0);
  });

  it("treats a DUPLICATE live GateOpened for a board gate as a referential no-op", () => {
    // Not merely equal — the identical object. A duplicate that rebuilt the map
    // would re-render every gate card in a subscriber, and (worse) is the
    // shape in which an attestation could be silently overwritten.
    resetSeq();
    const board = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 6, "resident")]), SESSION_ID);
    const after = foldPublicGateEvent(board, history(gateOpened(GATE_A, LOOP_A), 6));
    expect(after).toBe(board);
    expect(after.entries.get(publicGateKey(SESSION_ID, GATE_A))?.answerability).toBe("resident");
  });

  it("removes only its own (SessionID, GateID) on a live GateResolved", () => {
    resetSeq();
    let board = foldPublicGatePage(
      emptyPublicGateBoard(),
      page([gateRecord(GATE_A, 6, "resident"), gateRecord(GATE_B, 7, "resident")]),
      SESSION_ID,
    );
    board = foldPublicGatePage(board, page([gateRecord(GATE_A, 6, "resident")]), SESSION_2);
    board = foldPublicGateEvent(board, liveEnduring(gateResolved(GATE_A, LOOP_A)));
    expect(keysOf(board)).toStrictEqual([`${SESSION_ID}/${GATE_B}`, `${SESSION_2}/${GATE_A}`]);
  });

  it("does not let one session's GateResolved close another session's same GateID", () => {
    resetSeq();
    const board = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 6, "resident")]), SESSION_2);
    const after = foldPublicGateEvent(board, liveEnduring(gateResolved(GATE_A, LOOP_A)));
    expect(after).toBe(board);
    expect(keysOf(after)).toStrictEqual([`${SESSION_2}/${GATE_A}`]);
  });

  it("ignores a GateResolved for a gate the board never held", () => {
    const board = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 6, "resident")]), SESSION_ID);
    resetSeq();
    expect(foldPublicGateEvent(board, history(gateResolved(GATE_B, LOOP_B)))).toBe(board);
  });

  it("keeps the order stable across duplicate arrival, live resolution AND reload", () => {
    // The three operations named in the order definition, composed, against the
    // order the same set has when it is loaded once from cold.
    const records = [gateRecord(GATE_B, 7, "resident"), gateRecord(GATE_C, 8, "resident"), gateRecord(GATE_A, 9, "resident")];
    const survivors = [gateRecord(GATE_C, 8, "resident"), gateRecord(GATE_A, 9, "resident")];
    const reference = publicGates(foldPublicGatePage(emptyPublicGateBoard(), page(survivors), SESSION_ID)).map(
      (g) => g.gateId,
    );
    expect(reference).toStrictEqual([GATE_C, GATE_A]);

    resetSeq();
    let board = foldPublicGatePage(emptyPublicGateBoard(), page(records), SESSION_ID);
    board = foldPublicGatePage(board, page(records), SESSION_ID); // duplicate
    board = foldPublicGateEvent(board, history(gateOpened(GATE_A, LOOP_A), 9)); // duplicate, live
    board = foldPublicGateEvent(board, liveEnduring(gateResolved(GATE_B, LOOP_B))); // live resolution
    board = foldPublicGatePage(board, page(survivors), SESSION_ID); // reload
    expect(publicGates(board).map((g) => g.gateId)).toStrictEqual(reference);
  });

  it("writes an entry's open position ONCE, so a disagreeing later page cannot reorder it", () => {
    resetSeq();
    let board = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 2, "resident"), gateRecord(GATE_B, 3, "resident")]), SESSION_ID);
    expect(publicGates(board).map((g) => g.gateId)).toStrictEqual([GATE_A, GATE_B]);
    // A second page claiming a different opened sequence for GATE_A. The open
    // position is an identity fact about one durable GateOpened; the later
    // claim is not applied, so the order cannot move under a reload.
    board = foldPublicGatePage(board, page([gateRecord(GATE_A, 99, "suspended")]), SESSION_ID);
    const a = board.entries.get(publicGateKey(SESSION_ID, GATE_A));
    expect(a?.openedJournalSeq).toBe(2);
    expect(a?.openedEventId).toBe("event-2");
    // The MUTABLE half did move: attestation is the page's to restate.
    expect(a?.answerability).toBe("suspended");
    expect(publicGates(board).map((g) => g.gateId)).toStrictEqual([GATE_A, GATE_B]);
  });

  it("never lets a live journal event write the Factory attestation", () => {
    // Divergence mode 1. An open journal event proves PRESENTATION, never that
    // anyone can apply a response (gate companion §5.3). A gate the board knows
    // only from the journal is therefore unattested and not answerable.
    resetSeq();
    const board = foldPublicGateEvent(emptyPublicGateBoard(), history(gateOpened(GATE_A, LOOP_A), 4));
    const entry = board.entries.get(publicGateKey(SESSION_ID, GATE_A));
    expect(entry?.openedJournalSeq).toBe(4);
    expect(entry?.answerability).toBe("");
    expect(entry?.deadline).toBe("");
    expect(acceptsResidentResponse(entry!)).toBe(false);
    // And the PRESENTATION half of the same rule: a live open is the only
    // writer of `kind`/`prompt` for an entry no page has ever attested, so this
    // is the entire content a renderer has for it. Without these four
    // expectations a board fed only by live events renders blank cards — no
    // title, no body, no buttons — and this case would still pass, because
    // everything above it asserts what the entry must NOT say.
    expect(entry?.kind).toBe("harness.permission");
    expect(entry?.prompt).toStrictEqual({
      title: "Allow Write?",
      body: "write /tmp/x",
      origin: "",
      controls: [{ action: "Approve", label: "Approve" }],
    });
  });

  it("downgrades a stale `resident` when a later page says otherwise", () => {
    // Divergence mode 2. The Host that owned this gate is gone; the board must
    // stop offering the answer form, not keep the first attestation forever.
    let board = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 6, "resident")]), SESSION_ID);
    expect(acceptsResidentResponse(board.entries.get(publicGateKey(SESSION_ID, GATE_A))!)).toBe(true);
    for (const next of ["suspended", "submitted", "unavailable", "expired"]) {
      const after = foldPublicGatePage(board, page([gateRecord(GATE_A, 6, next)]), SESSION_ID);
      expect(
        acceptsResidentResponse(after.entries.get(publicGateKey(SESSION_ID, GATE_A))!),
        `answerability ${next} still offered a resident response`,
      ).toBe(false);
    }
  });

  it("does not let one gate's `resident` speak for its sibling or for another session", () => {
    // Divergence modes 4 and 5, together: attestation is per (SessionID, GateID)
    // and is read from the entry, never from the board.
    let board = foldPublicGatePage(
      emptyPublicGateBoard(),
      page([gateRecord(GATE_A, 6, "resident"), gateRecord(GATE_B, 7, "unavailable")]),
      SESSION_ID,
    );
    board = foldPublicGatePage(board, page([gateRecord(GATE_A, 6, "unavailable")]), SESSION_2);
    expect(publicGates(board).map((g) => acceptsResidentResponse(g))).toStrictEqual([true, false, false]);
  });

  it("has nothing left to report answerable once the gate resolves", () => {
    // Divergence mode 6. A negative assertion placed after the removal would be
    // satisfied by a board that dropped everything, so the surviving sibling is
    // asserted in the same breath.
    resetSeq();
    let board = foldPublicGatePage(
      emptyPublicGateBoard(),
      page([gateRecord(GATE_A, 6, "resident"), gateRecord(GATE_B, 7, "resident")]),
      SESSION_ID,
    );
    board = foldPublicGateEvent(board, liveEnduring(gateResolved(GATE_A, LOOP_A)));
    expect(board.entries.get(publicGateKey(SESSION_ID, GATE_A))).toBeUndefined();
    expect(publicGates(board).map((g) => g.gateId)).toStrictEqual([GATE_B]);
    expect(acceptsResidentResponse(publicGates(board)[0]!)).toBe(true);
  });

  it("ignores a gate event that names no session, rather than keying it under ''", () => {
    // NOT REAL WIRE — MarshalEvent will not emit a gate event without a session
    // id — but "" is the one session id that would merge every unaddressed gate
    // in the process into one bucket, so it fails closed.
    resetSeq();
    const anonymous = inSession(gateOpened(GATE_A, LOOP_A), "");
    expect(foldPublicGateEvent(emptyPublicGateBoard(), history(anonymous))).toStrictEqual(emptyPublicGateBoard());
    const board = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 6, "resident")]), SESSION_ID);
    resetSeq();
    expect(foldPublicGateEvent(board, history(inSession(gateResolved(GATE_A, LOOP_A), "")))).toBe(board);
  });

  it("skips a page record with no gate id rather than keying it under ''", () => {
    // NOT REAL WIRE (`gate_id` has minLength 1), so the record bypasses the
    // validator — but two such records would otherwise overwrite each other.
    const board = foldPublicGatePage(
      emptyPublicGateBoard(),
      malformedPage([{ opened_journal_seq: 1 }, { opened_journal_seq: 2 }]),
      SESSION_ID,
    );
    expect(board.entries.size).toBe(0);
  });

  it("refuses to fold a page under an empty session id", () => {
    // A caller error, not wire: the page is addressed by URL and carries no
    // session id of its own, so folding it under "" would merge two sessions.
    expect(() => foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 6, "resident")]), "")).toThrow(
      RangeError,
    );
  });

  it("never removes on a page merge — a gate resolved while offline stays until its event", () => {
    // The stated limitation, pinned so it cannot quietly become a promise. A
    // client that wants a page to be authoritative rebuilds from
    // emptyPublicGateBoard().
    let board = foldPublicGatePage(
      emptyPublicGateBoard(),
      page([gateRecord(GATE_A, 6, "resident"), gateRecord(GATE_B, 7, "resident")]),
      SESSION_ID,
    );
    board = foldPublicGatePage(board, page([gateRecord(GATE_B, 7, "resident")]), SESSION_ID);
    expect(publicGates(board).map((g) => g.gateId)).toStrictEqual([GATE_A, GATE_B]);
    const rebuilt = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_B, 7, "resident")]), SESSION_ID);
    expect(publicGates(rebuilt).map((g) => g.gateId)).toStrictEqual([GATE_B]);
  });

  it("leaves the board identical for every input that is not a public gate event", () => {
    resetSeq();
    const board = foldPublicGatePage(emptyPublicGateBoard(), page([gateRecord(GATE_A, 6, "resident")]), SESSION_ID);
    const inputs: FoldInput[] = [
      history(envelope({ type: "TurnDone", loopId: LOOP_A, payload: { turn_index: 1 } })),
      liveEnduring(envelope({ type: "SessionIdle", loopId: LOOP_A })),
      liveEphemeral("token_delta", { chunk_type: "text", text: "hi" }, LOOP_A),
      { segment: "live", frame: { type: "heartbeat" } },
      // NOT REAL WIRE: `event` is optional on enduring_frame.schema.json, so a
      // frame with none is representable and names no gate and no session.
      { segment: "live", frame: { type: "enduring", journalSeq: 3, data: {} as never } },
    ];
    for (const input of inputs) expect(foldPublicGateEvent(board, input)).toBe(board);
  });

  it("never mutates the board it was handed, on page merge, open OR resolve", () => {
    resetSeq();
    const empty = emptyPublicGateBoard();
    const loaded = foldPublicGatePage(empty, page([gateRecord(GATE_A, 6, "resident")]), SESSION_ID);
    expect(empty.entries.size).toBe(0);
    const opened = foldPublicGateEvent(loaded, history(gateOpened(GATE_B, LOOP_A), 7));
    expect(loaded.entries.size).toBe(1);
    expect(opened.entries.size).toBe(2);
    resetSeq();
    const resolved = foldPublicGateEvent(opened, liveEnduring(gateResolved(GATE_A, LOOP_A)));
    expect(opened.entries.size).toBe(2);
    expect(resolved.entries.size).toBe(1);
    expect(resolved.entries).not.toBe(opened.entries);
  });
});
