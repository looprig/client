/**
 * §3b rule 1: "Partition rows by `loop_id`. Never sort globally by
 * `journal_seq` — that is what makes 'a subagent's `TurnDone` has a lower seq
 * than the parent turn containing it' harmless."
 *
 * The hazard is concrete. `handlers_events.go` subscribes `LoopScope{All:
 * true}`, so a child loop's frames arrive on the SAME stream as its parent's,
 * and a subagent finishes BEFORE the parent step that contains its tool call —
 * so the child's rows carry journal_seqs that fall strictly INSIDE the parent
 * turn's span. `interleavedByGlobalSeq` below reads that property off the
 * fixture rather than asserting it as a belief, so the tests that follow are
 * demonstrably about a fixture where a global sort really would interleave.
 *
 * §3b rule 2 is the other half: "Within a loop, committed rows order by
 * `journal_seq` of the committing event." Both halves are pinned here.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView, type SessionView } from "../src/fold.js";
import { loopIdsInOrder, rowsForLoop, type TranscriptRow } from "../src/rows.js";
import {
  LOOP_A,
  LOOP_B,
  aiMessageWire,
  envelope,
  history,
  resetSeq,
  textBlockWire,
  textDelta,
  userMessageWire,
} from "./helpers.js";
import { run } from "./run.js";

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

/** One committed user row for `loopId`, at an explicit journal_seq. */
function userTurn(loopId: string, text: string, seq: number) {
  return history(
    envelope({
      type: "TurnStarted",
      loopId,
      payload: { message: userMessageWire([textBlockWire(text)]) },
    }),
    seq,
  );
}

/** The display text of a row, whatever its kind — enough to pin ORDER. */
function textOf(row: TranscriptRow): string {
  switch (row.kind) {
    case "assistant":
      return row.text;
    case "user":
      return row.blocks.map((b) => (b.type === "text" ? b.text : `<${b.type}>`)).join("");
    case "notice":
      return row.text;
    case "tool":
      return `tool:${row.toolName}`;
    case "tombstone":
      return "<tombstone>";
  }
}

/**
 * True when sorting EVERY row globally by journal_seq puts a foreign loop's row
 * between two rows of `loopId` — the interleaving §3b rule 1 exists to prevent.
 * Computed from the fixture so the tests below are not merely asserting that a
 * partition partitions.
 */
function interleavedByGlobalSeq(view: SessionView, loopId: string): boolean {
  const global = [...view.rows].sort((a, b) => (a.journalSeq ?? 0) - (b.journalSeq ?? 0));
  const first = global.findIndex((r) => r.loopId === loopId);
  let last = -1;
  for (let i = global.length - 1; i >= 0; i--) {
    if (global[i]?.loopId === loopId) {
      last = i;
      break;
    }
  }
  if (first === -1) return false;
  return global.slice(first, last + 1).some((r) => r.loopId !== loopId);
}

describe("rows: loop partitioning", () => {
  it("returns only that loop's rows, in journal_seq order", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      step(LOOP_A, "parent 1", 10),
      step(LOOP_B, "child 1", 11),
      step(LOOP_B, "child 2", 12),
      step(LOOP_A, "parent 2", 13),
    ]);
    expect(rowsForLoop(view, LOOP_A).map(textOf)).toStrictEqual(["parent 1", "parent 2"]);
    expect(rowsForLoop(view, LOOP_B).map(textOf)).toStrictEqual(["child 1", "child 2"]);
  });

  it("keeps a subagent's lower journal_seq harmless, where a global sort would interleave", () => {
    resetSeq();
    // The parent's turn spans seq 10..40. The child loop it spawned runs to
    // completion INSIDE that span (20, 25) — the real shape, because a subagent
    // finishes before the parent step whose tool call contains it.
    const view = run(emptySessionView(), [
      userTurn(LOOP_A, "do the thing", 10),
      step(LOOP_B, "child work", 20),
      step(LOOP_B, "child done", 25),
      step(LOOP_A, "here is what I found", 40),
    ]);
    // Read the hazard off the fixture: a global sort really does interleave.
    expect(interleavedByGlobalSeq(view, LOOP_A)).toBe(true);
    // The partition is what makes it harmless.
    expect(rowsForLoop(view, LOOP_A).map(textOf)).toStrictEqual([
      "do the thing",
      "here is what I found",
    ]);
    expect(rowsForLoop(view, LOOP_B).map(textOf)).toStrictEqual(["child work", "child done"]);
  });

  it("orders a loop's committed rows by journal_seq even when they arrived out of order", () => {
    resetSeq();
    const view = run(emptySessionView(), [step(LOOP_A, "second", 20), step(LOOP_A, "first", 10)]);
    expect(rowsForLoop(view, LOOP_A).map(textOf)).toStrictEqual(["first", "second"]);
  });

  it("places live rows (no journal_seq) after every committed row of the loop", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      step(LOOP_A, "committed", 10),
      textDelta("streaming", LOOP_A),
    ]);
    const rows = rowsForLoop(view, LOOP_A);
    expect(rows.map(textOf)).toStrictEqual(["committed", "streaming"]);
    expect(rows.at(-1)).toMatchObject({ live: true, journalSeq: undefined });
  });

  it("orders a live row after a committed row that arrived LATER in the array", () => {
    resetSeq();
    // The live row is appended FIRST, so plain array order would put it first.
    // The committing event is a TurnStarted rather than a StepDone: a StepDone
    // snaps its loop's live segment away, so it could not express this case.
    const view = run(emptySessionView(), [
      textDelta("streaming", LOOP_A),
      step(LOOP_B, "unrelated", 5),
    ]);
    const withLate = run(view, [userTurn(LOOP_A, "committed", 99)]);
    expect(withLate.rows.map(textOf), "the fixture must append the live row first").toStrictEqual([
      "streaming",
      "unrelated",
      "committed",
    ]);
    expect(rowsForLoop(withLate, LOOP_A).map(textOf)).toStrictEqual(["committed", "streaming"]);
  });

  it("returns an empty list for a loop that produced no rows", () => {
    resetSeq();
    const view = run(emptySessionView(), [step(LOOP_A, "only", 1)]);
    expect(rowsForLoop(view, LOOP_B)).toStrictEqual([]);
  });

  it("does not reorder or otherwise disturb the view's own rows array", () => {
    resetSeq();
    const view = run(emptySessionView(), [step(LOOP_A, "second", 20), step(LOOP_A, "first", 10)]);
    const before = [...view.rows];
    const sorted = rowsForLoop(view, LOOP_A);
    expect(sorted, "rowsForLoop handed back the view's own array").not.toBe(view.rows);
    expect(view.rows, "rowsForLoop sorted the view's array in place").toStrictEqual(before);
    expect(view.rows.map(textOf), "append order must survive").toStrictEqual(["second", "first"]);
  });

  it("lists loops in first-appearance order", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      step(LOOP_B, "b", 1),
      step(LOOP_A, "a", 2),
      step(LOOP_B, "b again", 3),
    ]);
    expect(loopIdsInOrder(view)).toStrictEqual([LOOP_B, LOOP_A]);
  });

  it("lists the session-scoped loop id \"\" like any other, without dropping it", () => {
    resetSeq();
    // A pending/optimistic row belongs to no loop; it must still be reachable.
    const view = run(emptySessionView(), [step(LOOP_A, "a", 1)]);
    expect(loopIdsInOrder(view)).toStrictEqual([LOOP_A]);
    expect(rowsForLoop(view, "")).toStrictEqual([]);
  });
});
