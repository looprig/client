import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  decodeFactoryLiveDelta,
  decodeFactoryLiveToolStep,
  liveToolRows,
  MAX_FACTORY_LIVE_TOOL_RESULT_BYTES,
  MAX_FACTORY_LIVE_TOOL_SUMMARY_BYTES,
} from "../src/index.js";

// Golden public bodies from harness (branch fix/harness-livetool, released as
// v0.42.0): pkg/sessionwire/testdata/tool_call_{started,completed}{,_v0.41}.json.
// The *_v0.41 bodies are what an older runtime projects: no tool_use_id, and
// on Completed no tool_name or elapsed_ms.
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/harness-livetool/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
}

const SESSION = "01010101-0101-0101-0101-010101010101";
const COMMON = {
  loopId: "02020202-0202-0202-0202-020202020202",
  turnId: "03030303-0303-0303-0303-030303030303",
  stepId: "04040404-0404-0404-0404-040404040404",
  toolExecutionId: "06060606-0606-0606-0606-060606060606",
};

test("decodes harness v0.42.0 ToolCallStarted and ToolCallCompleted bodies", () => {
  expect(decodeFactoryLiveToolStep(fixture("tool_call_started"), SESSION)).toStrictEqual({
    phase: "started", ...COMMON, toolUseId: "toolu_01", toolName: "Bash", summary: "go test ./...",
    isError: false, resultPreview: "",
  });
  expect(decodeFactoryLiveToolStep(fixture("tool_call_completed"), SESSION)).toStrictEqual({
    phase: "completed", ...COMMON, toolUseId: "toolu_01", toolName: "Bash", summary: "",
    isError: true, resultPreview: "FAIL\n… [truncated]", elapsedMs: 1234,
  });
});

test("decodes older (harness v0.41) bodies without the join key, name or elapsed time", () => {
  expect(decodeFactoryLiveToolStep(fixture("tool_call_started_v0.41"), SESSION)).toStrictEqual({
    phase: "started", ...COMMON, toolUseId: "", toolName: "Bash", summary: "go test ./...",
    isError: false, resultPreview: "",
  });
  const completed = decodeFactoryLiveToolStep(fixture("tool_call_completed_v0.41"), SESSION);
  expect(completed).toStrictEqual({
    phase: "completed", ...COMMON, toolUseId: "", toolName: "", summary: "",
    isError: true, resultPreview: "FAIL\n… [truncated]",
  });
  expect(completed).not.toHaveProperty("elapsedMs");
});

test("the 0.2.0 text decoder ignores every tool body", () => {
  for (const name of ["tool_call_started", "tool_call_completed", "tool_call_started_v0.41", "tool_call_completed_v0.41"]) {
    expect(decodeFactoryLiveDelta(fixture(name), SESSION)).toBeNull();
  }
});

test("returns null for TokenDelta and unrelated bodies", () => {
  const delta = { v: 1, type: "TokenDelta", session_id: SESSION, loop_id: COMMON.loopId, turn_id: COMMON.turnId,
    chunk: { chunk_type: "text", text: "hi" } };
  expect(decodeFactoryLiveToolStep(delta, SESSION)).toBeNull();
  expect(decodeFactoryLiveToolStep(null, SESSION)).toBeNull();
  expect(decodeFactoryLiveToolStep([], SESSION)).toBeNull();
  expect(decodeFactoryLiveToolStep({ ...fixture("tool_call_started"), type: "StepDone" }, SESSION)).toBeNull();
});

test.each<[string, Record<string, unknown>]>([
  ["another session", { session_id: "other" }],
  ["wrong version", { v: 2 }],
  ["missing loop id", { loop_id: undefined }],
  ["non-uuid turn id", { turn_id: "turn" }],
  ["missing execution id", { tool_execution_id: undefined }],
  ["non-uuid execution id", { tool_execution_id: "exec" }],
  ["non-uuid step id", { step_id: "step" }],
  ["non-string tool_use_id", { tool_use_id: 7 }],
  ["non-string tool_name", { tool_name: false }],
  ["non-string summary", { summary: {} }],
  ["oversized summary", { summary: "s".repeat(MAX_FACTORY_LIVE_TOOL_SUMMARY_BYTES + 1) }],
])("refuses a Started with %s", (_name, patch) => {
  const body = { ...fixture("tool_call_started"), ...patch };
  expect(decodeFactoryLiveToolStep(JSON.parse(JSON.stringify(body)), SESSION)).toBeNull();
});

test.each<[string, Record<string, unknown>]>([
  ["non-boolean is_error", { is_error: "yes" }],
  ["non-string result_preview", { result_preview: 3 }],
  ["oversized result_preview", { result_preview: "r".repeat(MAX_FACTORY_LIVE_TOOL_RESULT_BYTES + 1) }],
  ["negative elapsed_ms", { elapsed_ms: -1 }],
  ["fractional elapsed_ms", { elapsed_ms: 1.5 }],
  ["string elapsed_ms", { elapsed_ms: "12" }],
])("refuses a Completed with %s", (_name, patch) => {
  expect(decodeFactoryLiveToolStep({ ...fixture("tool_call_completed"), ...patch }, SESSION)).toBeNull();
});

test("accepts the size bounds exactly, counting UTF-8 bytes", () => {
  const summary = "é".repeat(MAX_FACTORY_LIVE_TOOL_SUMMARY_BYTES / 2);
  expect(decodeFactoryLiveToolStep({ ...fixture("tool_call_started"), summary }, SESSION)?.summary).toBe(summary);
  expect(decodeFactoryLiveToolStep({ ...fixture("tool_call_started"), summary: `${summary}x` }, SESSION)).toBeNull();
  const resultPreview = "r".repeat(MAX_FACTORY_LIVE_TOOL_RESULT_BYTES);
  expect(decodeFactoryLiveToolStep({ ...fixture("tool_call_completed"), result_preview: resultPreview }, SESSION)?.resultPreview)
    .toBe(resultPreview);
});

test("refuses a body beyond the live body ceiling", () => {
  expect(decodeFactoryLiveToolStep({ ...fixture("tool_call_started"), padding: "x".repeat(102_401) }, SESSION)).toBeNull();
});

test("a Completed without is_error is a success", () => {
  const { is_error: _omitted, ...body } = fixture("tool_call_completed");
  expect(decodeFactoryLiveToolStep(body, SESSION)?.isError).toBe(false);
});

test("liveToolRows maps each phase to a live ToolRow", () => {
  const started = decodeFactoryLiveToolStep(fixture("tool_call_started"), SESSION)!;
  const failed = decodeFactoryLiveToolStep(fixture("tool_call_completed"), SESSION)!;
  const ok = { ...failed, isError: false, toolExecutionId: "08080808-0808-0808-0808-080808080808" };
  const rows = liveToolRows([started, failed, ok]);
  expect(rows[0]).toStrictEqual({
    kind: "tool", ordinal: -1, loopId: COMMON.loopId, turnId: COMMON.turnId, journalSeq: undefined,
    live: true, orphanedLoop: false, toolUseId: "toolu_01", toolExecutionId: COMMON.toolExecutionId,
    toolName: "Bash", summary: "go test ./...", status: "running", result: "", spawnedLoopId: "",
  });
  expect(rows.map((row) => [row.status, row.result])).toEqual([
    ["running", ""], ["error", "FAIL\n… [truncated]"], ["ok", "FAIL\n… [truncated]"],
  ]);
});
