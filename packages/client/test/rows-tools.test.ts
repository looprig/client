/** Durable tool result captures retain the inline preview and only privacy-safe metadata. */
import { describe, expect, it } from "vitest";
import { emptySessionView } from "../src/fold.js";
import { LOOP_A, TURN_1, aiMessageWire, envelope, history, loopStarted, resetSeq, textBlockWire } from "./helpers.js";
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
