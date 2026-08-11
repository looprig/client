/**
 * Coverage for the session state-machine fold (src/fold.ts).
 *
 * Section 1 covers each of the five `ephemeral_frame.schema.json` `kind`s
 * individually (task requirement: "one test case per ephemeral kind, 5
 * total minimum"). Section 2 covers the unknown-kind case — a `kind` value
 * outside the current five, simulating a future wire addition — and proves
 * it produces a typed `FoldError`, not a thrown exception or a silent
 * no-op. Section 3 proves a cold `StatusEvent` (from the real
 * `journal_page.json` fixture) and a live `enduring` `SseFrame` (from the
 * real `enduring_frame.sse` fixture, parsed through the REAL `sse.ts`
 * parser) fold into structurally comparable `StatusEventMarker`s — the
 * "one renderer, two segments" property this task exists to prove, not just
 * assert in theory. Section 4 covers a few supporting behaviors (heartbeat/
 * error live frames, malformed-delta payloads, tool-call started+completed
 * pairing) that round out `fold()` without being explicitly required by the
 * task's minimum test plan.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FoldError,
  emptySessionView,
  fold,
  type FoldInput,
  type SessionView,
} from "../src/fold.js";
import { SseFrameParser, type EnduringSseFrame, type SseFrame } from "../src/sse.js";
import { validateEphemeralFrame, validateEventJournalPage } from "../src/validate.js";
import type { EphemeralFrame, EventJournalPage } from "../src/types.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixtureBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(fixtureDir + file));
}

function readFixtureJson(file: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + file, "utf8"));
}

/** Parses one fixture's bytes as a single SSE frame and asserts it's the expected `type`. */
function parseOneFrame(bytes: Uint8Array): SseFrame {
  const parser = new SseFrameParser();
  const frames = [...parser.feed(bytes), ...parser.finish()];
  expect(frames).toHaveLength(1);
  return frames[0]!;
}

/** Wraps an already-ajv-validated `EphemeralFrame` as a `LiveInput` and folds it from a fresh view. */
function foldFreshEphemeral(frame: EphemeralFrame) {
  const input: FoldInput = { segment: "live", frame: { type: "ephemeral", data: frame } };
  return fold(emptySessionView(), input);
}

function expectOk(result: ReturnType<typeof fold>): SessionView {
  if (!result.ok) {
    throw new Error(`expected fold to succeed, got FoldError(${result.error.reason}): ${result.error.message}`);
  }
  return result.view;
}

// --- 1. One case per ephemeral kind ------------------------------------------

describe("foldEphemeral: one case per kind", () => {
  it("token_delta (text chunk) appends a TextContentDelta to content", () => {
    const frame = validateEphemeralFrame({
      v: 1,
      kind: "token_delta",
      delta: { chunk_type: "text", text: "Hello" },
    });
    const view = expectOk(foldFreshEphemeral(frame));
    expect(view.content).toEqual([{ chunkType: "text", text: "Hello", header: undefined }]);
    expect(view.toolCalls).toEqual([]);
    expect(view.queuedInputs).toEqual([]);
    expect(view.compactions).toEqual([]);
    expect(view.statusEvents).toEqual([]);
  });

  it("token_delta (thinking chunk) appends a ThinkingContentDelta to content", () => {
    const frame = validateEphemeralFrame({
      v: 1,
      kind: "token_delta",
      delta: { chunk_type: "thinking", thinking: "considering..." },
    });
    const view = expectOk(foldFreshEphemeral(frame));
    expect(view.content).toEqual([{ chunkType: "thinking", thinking: "considering...", header: undefined }]);
  });

  it("token_delta (tool_use chunk) appends a ToolUseContentDelta to content, distinct from a ToolCallCard", () => {
    const frame = validateEphemeralFrame({
      v: 1,
      kind: "token_delta",
      delta: { chunk_type: "tool_use", index: 0, id: "call_1", name: "bash", input_json: '{"cmd":"ls' },
    });
    const view = expectOk(foldFreshEphemeral(frame));
    expect(view.content).toEqual([
      { chunkType: "tool_use", index: 0, id: "call_1", name: "bash", inputJson: '{"cmd":"ls', header: undefined },
    ]);
    expect(view.toolCalls).toEqual([]); // tool_use content is NOT a tool call lifecycle event
  });

  it("tool_call_started appends a started ToolCallCard", () => {
    const frame = validateEphemeralFrame({
      v: 1,
      kind: "tool_call_started",
      delta: { tool_execution_id: "11111111-1111-1111-1111-111111111111", tool_name: "bash", summary: "ls -la" },
    });
    const view = expectOk(foldFreshEphemeral(frame));
    expect(view.toolCalls).toEqual([
      {
        toolExecutionId: "11111111-1111-1111-1111-111111111111",
        status: "started",
        toolName: "bash",
        summary: "ls -la",
        isError: undefined,
        resultPreview: undefined,
        startedHeader: undefined,
        completedHeader: undefined,
      },
    ]);
  });

  it("tool_call_completed appends a completed-only ToolCallCard when no prior started card exists", () => {
    const frame = validateEphemeralFrame({
      v: 1,
      kind: "tool_call_completed",
      delta: { tool_execution_id: "11111111-1111-1111-1111-111111111111", is_error: false, result_preview: "ok" },
    });
    const view = expectOk(foldFreshEphemeral(frame));
    expect(view.toolCalls).toEqual([
      {
        toolExecutionId: "11111111-1111-1111-1111-111111111111",
        status: "completed",
        toolName: undefined,
        summary: undefined,
        isError: false,
        resultPreview: "ok",
        startedHeader: undefined,
        completedHeader: undefined,
      },
    ]);
  });

  it("input_queued appends a QueuedInputMarker with no delta payload (per schema: this kind carries no delta at all)", () => {
    const frame = validateEphemeralFrame({ v: 1, kind: "input_queued" });
    expect(frame).not.toHaveProperty("delta");
    const view = expectOk(foldFreshEphemeral(frame));
    expect(view.queuedInputs).toEqual([{ header: undefined }]);
  });

  it("compaction_started appends a CompactionMarker with attempt id, reason, and basis", () => {
    const frame = validateEphemeralFrame({
      v: 1,
      kind: "compaction_started",
      delta: {
        attempt_id: "22222222-2222-2222-2222-222222222222",
        reason: 2, // event.CompactionReasonAutomatic
        basis: { revision: 7, through_event_id: "33333333-3333-3333-3333-333333333333" },
      },
    });
    const view = expectOk(foldFreshEphemeral(frame));
    expect(view.compactions).toEqual([
      {
        attemptId: "22222222-2222-2222-2222-222222222222",
        reason: 2,
        basis: { revision: 7, throughEventId: "33333333-3333-3333-3333-333333333333" },
        header: undefined,
      },
    ]);
  });

  it("an ephemeral frame's header (when present) is threaded into the folded entry", () => {
    const frame = validateEphemeralFrame({
      v: 1,
      kind: "token_delta",
      header: { session_id: "44444444-4444-4444-4444-444444444444" },
      delta: { chunk_type: "text", text: "hi" },
    });
    const view = expectOk(foldFreshEphemeral(frame));
    expect(view.content[0]!.header).toEqual({ session_id: "44444444-4444-4444-4444-444444444444" });
  });
});

// --- 2. Unknown ephemeral kind: typed, surfaced error, never silent ---------

describe("foldEphemeral: unknown kind", () => {
  it("a kind outside the current 5-value enum produces a typed FoldError, not a thrown exception or a silent no-op", () => {
    // The schema's `kind` is a real TypeScript string-literal union (verified in
    // fold.ts's module comment), so constructing this requires a type-escape
    // hatch — exactly as the task anticipates: "a future wire addition" can't be
    // expressed as a legally-typed EphemeralFrame today.
    const futureFrame = { v: 1, kind: "agent_handoff_started", delta: { foo: "bar" } } as unknown as EphemeralFrame;
    const input: FoldInput = { segment: "live", frame: { type: "ephemeral", data: futureFrame } };

    let threw = false;
    let result: ReturnType<typeof fold>;
    try {
      result = fold(emptySessionView(), input);
    } catch {
      threw = true;
      result = { ok: false, error: new FoldError("unknown_ephemeral_kind", "unreachable") };
    }

    expect(threw).toBe(false); // never a thrown generic exception
    expect(result.ok).toBe(false); // never a silent no-op
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBeInstanceOf(FoldError);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.reason).toBe("unknown_ephemeral_kind"); // a caller can switch on this
    expect(result.error.message).toContain("agent_handoff_started");
    expect(result.error.name).toBe("FoldError");
  });

  it("an unrecognized token_delta chunk_type (no schema backing at all, unlike kind) also produces a typed error, not a silent drop", () => {
    const frame = validateEphemeralFrame({
      v: 1,
      kind: "token_delta",
      delta: { chunk_type: "image", data: "..." },
    });
    const result = foldFreshEphemeral(frame);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBeInstanceOf(FoldError);
    expect(result.error.reason).toBe("unknown_chunk_type");
  });

  it("an unrecognized live SseFrame.type also produces a typed error via the same never-guarded pattern", () => {
    const futureFrame = { type: "control" } as unknown as SseFrame;
    const result = fold(emptySessionView(), { segment: "live", frame: futureFrame });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBeInstanceOf(FoldError);
    expect(result.error.reason).toBe("upstream_frame_error");
  });
});

// --- 3. History and live fold into structurally comparable output -----------

describe("history (cold StatusEvent) and live (SSE enduring frame) fold into the same shape", () => {
  it("the journal_page.json fixture's StatusEvent and the enduring_frame.sse fixture's live frame both fold to a comparable StatusEventMarker", () => {
    // Both fixtures carry the SAME underlying TurnDone event content (byte-for-content
    // identical event object; only journal_seq legitimately differs: 3 in the cold
    // page vs. 42 stamped on the live SSE frame's id: line) — see contract/fixtures/.
    const page = validateEventJournalPage(readFixtureJson("journal_page.json")) as EventJournalPage;
    expect(page.events).toHaveLength(1);
    const statusEvent = page.events[0]!;

    const enduringBytes = readFixtureBytes("enduring_frame.sse");
    const liveFrame = parseOneFrame(enduringBytes);
    expect(liveFrame.type).toBe("enduring");
    const enduringFrame = liveFrame as EnduringSseFrame;

    const historyResult = fold(emptySessionView(), { segment: "history", event: statusEvent });
    const liveResult = fold(emptySessionView(), { segment: "live", frame: enduringFrame });

    const historyView = expectOk(historyResult);
    const liveView = expectOk(liveResult);

    expect(historyView.statusEvents).toHaveLength(1);
    expect(liveView.statusEvents).toHaveLength(1);
    const historyMarker = historyView.statusEvents[0]!;
    const liveMarker = liveView.statusEvents[0]!;

    // Structurally comparable: identical key sets (same SessionView shape
    // regardless of source)...
    expect(Object.keys(historyMarker).sort()).toEqual(Object.keys(liveMarker).sort());

    // ...and, since the two fixtures carry the same underlying event, identical
    // field-for-field EXCEPT journalSeq (which legitimately differs by source).
    const { journalSeq: historyJournalSeq, ...historyRest } = historyMarker;
    const { journalSeq: liveJournalSeq, ...liveRest } = liveMarker;
    expect(historyRest).toEqual(liveRest);
    expect(historyJournalSeq).toBe(3);
    expect(liveJournalSeq).toBe(42);

    // And both correctly surfaced the real event content.
    expect(historyMarker.type).toBe("TurnDone");
    expect(historyMarker.sessionId).toBe("00000000-0000-0000-0000-000000000000");
    expect(historyMarker.createdAt).toBe("2026-07-08T12:00:00Z");
  });
});

// --- 4. Supporting behaviors ---------------------------------------------------

describe("foldEphemeral: tool call pairing across started + completed", () => {
  it("a tool_call_completed with a matching tool_execution_id updates the SAME card in place rather than appending a second one", () => {
    const started = validateEphemeralFrame({
      v: 1,
      kind: "tool_call_started",
      delta: { tool_execution_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", tool_name: "bash" },
    });
    const completed = validateEphemeralFrame({
      v: 1,
      kind: "tool_call_completed",
      delta: { tool_execution_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", is_error: true, result_preview: "boom" },
    });

    const afterStarted = expectOk(fold(emptySessionView(), { segment: "live", frame: { type: "ephemeral", data: started } }));
    const afterCompleted = expectOk(fold(afterStarted, { segment: "live", frame: { type: "ephemeral", data: completed } }));

    expect(afterCompleted.toolCalls).toHaveLength(1);
    expect(afterCompleted.toolCalls[0]).toEqual({
      toolExecutionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      status: "completed",
      toolName: "bash",
      summary: undefined,
      isError: true,
      resultPreview: "boom",
      startedHeader: undefined,
      completedHeader: undefined,
    });
  });

  it("a tool_call_completed that arrives BEFORE its tool_call_started (join-window race / event reordering) still resolves to exactly 1 card, not 2 — regression for the one-directional pairing bug", () => {
    const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const completed = validateEphemeralFrame({
      v: 1,
      kind: "tool_call_completed",
      delta: { tool_execution_id: id, is_error: false, result_preview: "done" },
    });
    const started = validateEphemeralFrame({
      v: 1,
      kind: "tool_call_started",
      delta: { tool_execution_id: id, tool_name: "bash", summary: "ls -la" },
    });

    // Before the fix: `completed` (no match) appends a completed-only card;
    // `started` (unconditionally appends) then adds a SECOND, permanently
    // "started" card — 2 cards for 1 execution.
    const afterCompleted = expectOk(fold(emptySessionView(), { segment: "live", frame: { type: "ephemeral", data: completed } }));
    const afterStarted = expectOk(fold(afterCompleted, { segment: "live", frame: { type: "ephemeral", data: started } }));

    expect(afterStarted.toolCalls).toHaveLength(1);
    expect(afterStarted.toolCalls[0]).toEqual({
      toolExecutionId: id,
      status: "completed", // completion is not regressed by a later-arriving started
      toolName: "bash", // filled in from the started frame
      summary: "ls -la", // filled in from the started frame
      isError: false, // preserved from the completed frame
      resultPreview: "done", // preserved from the completed frame
      startedHeader: undefined,
      completedHeader: undefined,
    });
  });

  it("a duplicate tool_call_started for the same id merges into the existing card instead of orphaning it — regression for the one-directional pairing bug", () => {
    const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const started1 = validateEphemeralFrame({
      v: 1,
      kind: "tool_call_started",
      delta: { tool_execution_id: id, tool_name: "bash", summary: "ls -la" },
    });
    const started2 = validateEphemeralFrame({
      v: 1,
      kind: "tool_call_started",
      delta: { tool_execution_id: id, tool_name: "bash", summary: "ls -la" }, // at-least-once redelivery
    });
    const completed = validateEphemeralFrame({
      v: 1,
      kind: "tool_call_completed",
      delta: { tool_execution_id: id, is_error: false, result_preview: "ok" },
    });

    // Before the fix: the completed-handler's findIndex only ever matches the
    // FIRST "started" card it finds; a duplicate started card is invisible to
    // it (findIndex stops at the first match), so `started2` would be
    // orphaned — stuck at status "started" forever, never resolved by the
    // eventual completed frame.
    const afterFirst = expectOk(fold(emptySessionView(), { segment: "live", frame: { type: "ephemeral", data: started1 } }));
    const afterSecond = expectOk(fold(afterFirst, { segment: "live", frame: { type: "ephemeral", data: started2 } }));
    expect(afterSecond.toolCalls).toHaveLength(1); // duplicate started merged, not appended

    const afterCompleted = expectOk(fold(afterSecond, { segment: "live", frame: { type: "ephemeral", data: completed } }));
    expect(afterCompleted.toolCalls).toHaveLength(1); // still exactly 1: correctly resolved to completed
    expect(afterCompleted.toolCalls[0]).toEqual({
      toolExecutionId: id,
      status: "completed",
      toolName: "bash",
      summary: "ls -la",
      isError: false,
      resultPreview: "ok",
      startedHeader: undefined,
      completedHeader: undefined,
    });
  });
});

describe("fold(): live heartbeat and error SseFrames", () => {
  it("a heartbeat frame is a no-op fold (returns the same view unchanged, not an error)", () => {
    const view = emptySessionView();
    const result = fold(view, { segment: "live", frame: { type: "heartbeat" } });
    expect(result).toEqual({ ok: true, view });
  });

  it("an upstream ErrorSseFrame (sse.ts's own parse/validation failure) folds to a typed FoldError, not a silent skip", () => {
    const badBytes = new TextEncoder().encode('event: enduring\nid: 7\ndata: {not json}\n\n');
    const frame = parseOneFrame(badBytes);
    expect(frame.type).toBe("error");
    const result = fold(emptySessionView(), { segment: "live", frame });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.reason).toBe("upstream_frame_error");
    expect(result.error.cause).toBe((frame as Extract<SseFrame, { type: "error" }>).error);
  });
});

describe("foldEphemeral: malformed delta payloads (no schema backs the interior shape)", () => {
  it("compaction_started with a malformed basis produces a typed malformed_delta error", () => {
    const frame = validateEphemeralFrame({
      v: 1,
      kind: "compaction_started",
      delta: { attempt_id: "22222222-2222-2222-2222-222222222222", reason: 1, basis: { revision: "not-a-number" } },
    });
    const result = foldFreshEphemeral(frame);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.reason).toBe("malformed_delta");
  });

  it("token_delta with no delta at all produces a typed malformed_delta error (distinct from input_queued's legitimate no-delta case)", () => {
    // Hand-built rather than via validateEphemeralFrame: the schema doesn't
    // forbid an absent delta on token_delta (delta isn't in `required`), so this
    // is schema-valid but semantically incomplete — exactly the gap fold()'s
    // runtime guard exists to catch since ajv can't.
    const frame = validateEphemeralFrame({ v: 1, kind: "token_delta" });
    const result = foldFreshEphemeral(frame);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.reason).toBe("malformed_delta");
  });
});

// --- 5. emptySessionView() sanity --------------------------------------------

describe("emptySessionView", () => {
  it("returns a fresh, fully-empty SessionView", () => {
    expect(emptySessionView()).toEqual({
      content: [],
      toolCalls: [],
      queuedInputs: [],
      compactions: [],
      statusEvents: [],
    });
  });

  it("returns a distinct object each call (fold() never mutates its input, so callers must not assume a shared reference either)", () => {
    expect(emptySessionView()).not.toBe(emptySessionView());
  });
});
