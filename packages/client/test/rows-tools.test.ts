/**
 * §3b rule 3: live tool cards are keyed by `tool_execution_id`.
 *
 * §3c: "Rows are copy-on-write: completing a tool call replaces the row object,
 * never mutates it." The identity assertions below are the point of this file —
 * a mutating implementation passes every value assertion and fails only these,
 * and a write-through that preserves the value passes even a deep comparison,
 * which is why one case freezes the row and pins the throw.
 *
 * ## Provenance of the delta shapes
 *
 * `tool_call_started` / `tool_call_completed` deltas are harness's
 * `toolCallStartedDelta` / `toolCallCompletedDelta`
 * (`pkg/serve/ephemeral.go`, harness@v0.30.0 — this module's pin):
 *
 *     ToolExecutionID uuid.UUID `json:"tool_execution_id,omitzero"`
 *     ToolName        string    `json:"tool_name,omitempty"`
 *     Summary         string    `json:"summary,omitempty"`
 *     ToolExecutionID uuid.UUID `json:"tool_execution_id,omitzero"`
 *     IsError         bool      `json:"is_error,omitzero"`
 *     ResultPreview   string    `json:"result_preview,omitempty"`
 *
 * Two consequences the plan's fixtures missed, both pinned below. The id is a
 * `uuid.UUID`, not an opaque token. And a SUCCESSFUL completion with no preview
 * carries NEITHER `is_error` NOR `result_preview` — both are dropped by
 * omitzero/omitempty — so "ok" is the absence of a flag, never `false` on the
 * wire. harness's own `handlers_events_test.go` pins the populated spellings
 * (`"tool_name":"Bash"`, `"summary":"ls -la"`, `"is_error":true`,
 * `"result_preview":"boom"`).
 *
 * `event.ToolCallStarted`/`ToolCallCompleted` carry `toolProfile()`
 * (`pkg/event/validate.go`): SessionID, LoopID, TurnID, StepID and the tool
 * execution id are all REQUIRED, so a real frame always has a turn id and an
 * execution id. The id-less case below is therefore defensive, not a real
 * order.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView } from "../src/fold.js";
import {
  LOOP_A,
  LOOP_B,
  TURN_1,
  aiMessageWire,
  envelope,
  history,
  liveEphemeral,
  loopStarted,
  resetSeq,
  textBlockWire,
  textDelta,
} from "./helpers.js";
import { run } from "./run.js";

const TE_1 = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
const TE_2 = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";

function capturedStep(extraCapture: Record<string, unknown> = {}) {
  return history(envelope({
    type: "StepDone",
    loopId: LOOP_A,
    turnId: TURN_1,
    payload: {
      messages: [
        aiMessageWire([{ type: "tool_use", ID: "provider-call-1", Name: "Bash", Input: { command: "build" } }]),
        { role: "tool", tool_use_id: "provider-call-1", blocks: [textBlockWire("inline preview")] },
      ],
      captures: [{
        tool_execution_id: TE_1,
        tool_use_id: "provider-call-1",
        reference: {
          object_id: "object-1",
          signed_url: "https://secret.invalid/read",
          backend_key: "tenant/private/key",
          credential: "Bearer secret",
          raw_bytes: "PRIVATE",
        },
        captured_bytes: 10,
        original_bytes: 21,
        truncated: true,
        truncation_reason: "capture_ceiling",
        encoding: "utf-8",
        ...extraCapture,
      }],
    },
  }), 7);
}

function started(id: string, name: string, loopId?: string, summary = `${name}(...)`) {
  return liveEphemeral(
    "tool_call_started",
    { tool_execution_id: id, tool_name: name, summary },
    loopId,
    TURN_1,
  );
}

/** A FAILED completion: `is_error` is present exactly because it is true. */
function failed(id: string, preview: string, loopId?: string) {
  return liveEphemeral(
    "tool_call_completed",
    { tool_execution_id: id, is_error: true, result_preview: preview },
    loopId,
    TURN_1,
  );
}

/** A SUCCESSFUL completion, in the shape the wire really carries: no `is_error`. */
function succeeded(id: string, preview: string | undefined, loopId?: string) {
  const delta: Record<string, unknown> = { tool_execution_id: id };
  if (preview !== undefined) delta["result_preview"] = preview;
  return liveEphemeral("tool_call_completed", delta, loopId, TURN_1);
}

describe("rows: live tool cards", () => {
  it("appends a fully-specified running tool row on tool_call_started", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      started(TE_1, "Read", LOOP_A),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "tool",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: undefined,
        live: true,
        orphanedLoop: false,
        toolUseId: "",
        toolExecutionId: TE_1,
        toolName: "Read",
        summary: "Read(...)",
        status: "running",
        result: "",
        spawnedLoopId: "",
      },
    ]);
    expect(view.nextOrdinal).toBe(1);
  });

  it("REPLACES the row object on completion — never mutates it", () => {
    resetSeq();
    let view = run(emptySessionView(), [started(TE_1, "Read", LOOP_A)]);
    const before = view.rows.find((r) => r.kind === "tool");
    view = run(view, [succeeded(TE_1, "3 lines", LOOP_A)]);
    const after = view.rows.find((r) => r.kind === "tool");

    // The identity assertion: Object.is must see a different object, or a
    // per-row selector never re-renders the completed card.
    expect(after).not.toBe(before);
    // And the ORIGINAL object must be untouched, which is what a memoised
    // selector still holding it compares against.
    expect(before).toMatchObject({ status: "running", result: "" });
    expect(after).toMatchObject({ status: "ok", result: "3 lines" });
    // The started-only fields survive the merge — a completed card that lost
    // its name renders as an anonymous box.
    expect(after).toMatchObject({ toolName: "Read", summary: "Read(...)", ordinal: 0 });
  });

  it("never writes THROUGH a live tool row, even a write that preserves its value", () => {
    // The freeze is the guard a deep comparison cannot be. The card is already
    // COMPLETED here, so the duplicate completion below writes exactly the
    // values the row already holds: toEqual sees nothing, a per-row Object.is
    // selector sees nothing, and only the frozen object catches the write.
    // A duplicate is real — ephemeral frames are best-effort/at-least-once.
    resetSeq();
    const first = run(emptySessionView(), [started(TE_1, "Read", LOOP_A), succeeded(TE_1, "3 lines", LOOP_A)]);
    first.rows.forEach((row) => Object.freeze(row));
    const second = run(first, [succeeded(TE_1, "3 lines", LOOP_A)]);
    expect(second.rows[0]).not.toBe(first.rows[0]);
    expect(second.rows[0]).toStrictEqual(first.rows[0]);
  });

  it("reads a successful completion off the ABSENCE of is_error, and an errored one off its presence", () => {
    resetSeq();
    const ok = run(emptySessionView(), [started(TE_1, "Bash", LOOP_A), succeeded(TE_1, undefined, LOOP_A)]);
    expect(ok.rows.find((r) => r.kind === "tool")).toMatchObject({ status: "ok", result: "" });

    resetSeq();
    const bad = run(emptySessionView(), [started(TE_1, "Bash", LOOP_A), failed(TE_1, "exit 1", LOOP_A)]);
    expect(bad.rows.find((r) => r.kind === "tool")).toMatchObject({ status: "error", result: "exit 1" });
  });

  it("keeps one row per tool_execution_id under duplicates and out-of-order arrival", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      // completed BEFORE started — a real order, per fold.ts's ToolCallCard doc.
      succeeded(TE_1, "done", LOOP_A),
      started(TE_1, "Read", LOOP_A),
      started(TE_1, "Read", LOOP_A),
    ]);
    const tools = view.rows.filter((r) => r.kind === "tool");
    expect(tools).toHaveLength(1);
    // Completion is the more advanced state and is never undone by a
    // later-arriving start.
    expect(tools[0]).toMatchObject({ status: "ok", toolName: "Read", result: "done" });
  });

  it("keeps the started-only fields when a duplicate start omits them", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      started(TE_1, "Read", LOOP_A),
      liveEphemeral("tool_call_started", { tool_execution_id: TE_1 }, LOOP_A, TURN_1),
    ]);
    expect(view.rows.filter((r) => r.kind === "tool")).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ toolName: "Read", summary: "Read(...)" });
  });

  it("appends a distinct row when the frame carries no tool_execution_id", () => {
    // Defensive: toolProfile() REQUIRES the execution id, so harness cannot emit
    // this. Merging two id-less frames would collapse unrelated calls into one
    // card, which is worse than showing two.
    resetSeq();
    const view = run(emptySessionView(), [
      liveEphemeral("tool_call_started", { tool_name: "A" }, LOOP_A, TURN_1),
      liveEphemeral("tool_call_started", { tool_name: "B" }, LOOP_A, TURN_1),
    ]);
    const tools = view.rows.filter((r) => r.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.map((r) => (r.kind === "tool" ? r.toolExecutionId : ""))).toStrictEqual(["", ""]);
  });

  it("preserves interleaved arrival order across buckets: text, tool, text", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("first ", LOOP_A, TURN_1),
      started(TE_1, "Read", LOOP_A),
      succeeded(TE_1, "ok", LOOP_A),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["assistant", "tool"]);
    // A second prose burst after the tool must NOT merge back into the first
    // assistant row — that is the interleaving separate buckets destroy.
    const after = run(view, [textDelta("second", LOOP_A, TURN_1)]);
    expect(after.rows.map((r) => r.kind)).toStrictEqual(["assistant", "tool", "assistant"]);
    expect(after.rows.at(-1)).toMatchObject({ text: "second", live: true, ordinal: 2 });
    expect(after.rows[0]).toMatchObject({ text: "first " });
  });

  it("keys cards per loop, so two loops running the same tool do not collide", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      started(TE_1, "Read", LOOP_A),
      started(TE_1, "Read", LOOP_B),
      failed(TE_1, "boom", LOOP_B),
    ]);
    const tools = view.rows.filter((r) => r.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ loopId: LOOP_A, status: "running" });
    expect(tools[1]).toMatchObject({ loopId: LOOP_B, status: "error" });
  });

  it("a completion for an id no card ever opened stands alone rather than being dropped", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      succeeded(TE_2, "orphan result", LOOP_A),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "tool",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: undefined,
        live: true,
        orphanedLoop: false,
        toolUseId: "",
        toolExecutionId: TE_2,
        toolName: "",
        summary: "",
        status: "ok",
        result: "orphan result",
        spawnedLoopId: "",
      },
    ]);
  });

  it("still folds the legacy toolCalls bucket, unchanged", () => {
    resetSeq();
    const view = run(emptySessionView(), [started(TE_1, "Read", LOOP_A), failed(TE_1, "boom", LOOP_A)]);
    expect(view.toolCalls).toHaveLength(1);
    expect(view.toolCalls[0]).toMatchObject({
      toolExecutionId: TE_1,
      status: "completed",
      toolName: "Read",
      summary: "Read(...)",
      isError: true,
      resultPreview: "boom",
    });
  });
});

describe("rows: durable tool-result captures", () => {
  it("folds the inline preview and only the privacy-safe capture projection", () => {
    resetSeq();
    const view = run(emptySessionView(), [loopStarted(LOOP_A), capturedStep()]);
    const row = view.rows.find((candidate) => candidate.kind === "tool");

    expect(row).toMatchObject({
      result: "inline preview",
      capture: {
        toolExecutionId: TE_1,
        objectId: "object-1",
        capturedBytes: 10,
        originalBytes: 21,
        originalBytesLowerBound: undefined,
        capturedBytesAtCeiling: 10,
        truncated: true,
        truncationReason: "capture_ceiling",
        encoding: "utf-8",
      },
    });
    const rendered = JSON.stringify(row);
    for (const forbidden of ["signed_url", "secret.invalid", "backend_key", "private/key", "credential", "Bearer secret", "raw_bytes", "PRIVATE"]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it("pairs captures by provider tool-use id rather than capture-array position", () => {
    resetSeq();
    const step = history(envelope({
      type: "StepDone",
      loopId: LOOP_A,
      turnId: TURN_1,
      payload: {
        messages: [
          aiMessageWire([
            { type: "tool_use", ID: "use-a", Name: "Bash", Input: { command: "a" } },
            { type: "tool_use", ID: "use-b", Name: "Bash", Input: { command: "b" } },
          ]),
          { role: "tool", tool_use_id: "use-a", blocks: [textBlockWire("preview a")] },
          { role: "tool", tool_use_id: "use-b", blocks: [textBlockWire("preview b")] },
        ],
        captures: [
          { tool_execution_id: TE_2, tool_use_id: "use-b", captured_bytes: 2, original_bytes: 2, truncated: false, encoding: "binary" },
          { tool_execution_id: TE_1, tool_use_id: "use-a", reference: { object_id: "object-a" }, captured_bytes: 1, original_bytes: 1, truncated: false, encoding: "utf-8" },
        ],
      },
    }), 8);
    const rows = run(emptySessionView(), [step]).rows.filter((row) => row.kind === "tool");
    expect(rows.map((row) => [row.toolUseId, row.result, row.capture?.toolExecutionId, row.capture?.objectId])).toStrictEqual([
      ["use-a", "preview a", TE_1, "object-a"],
      ["use-b", "preview b", TE_2, undefined],
    ]);
  });
});
