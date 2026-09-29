import { MAX_FACTORY_LIVE_TEXT_BODY_BYTES } from "./factory-live-text.js";

/**
 * One transient tool-call step: harness's public `ToolCallStarted` or
 * `ToolCallCompleted` body, carried by Host inside an `EphemeralPublication`.
 *
 * It is a preview, never history. `toolExecutionId` identifies the live step;
 * `toolUseId` (harness ≥ v0.42.0) is the model's `tool_use` block id and is the
 * key a committed `StepDone` replaces it by. Older runtimes send neither
 * `tool_use_id` nor, on Completed, `tool_name`/`elapsed_ms`; those decode as
 * `""` / absent and the step still renders, scoped by loop, turn and step.
 */
export interface FactoryLiveToolStep {
  readonly phase: "started" | "completed";
  readonly loopId: string;
  readonly turnId: string;
  /** "" when the body carries no step id. */
  readonly stepId: string;
  readonly toolExecutionId: string;
  /** "" from a runtime older than harness v0.42.0. */
  readonly toolUseId: string;
  /** "" on a Completed from a runtime older than harness v0.42.0. */
  readonly toolName: string;
  /** The tool's redacted audit summary (or ""); only a Started carries it. */
  readonly summary: string;
  readonly isError: boolean;
  /** A bounded preview of the result; only a Completed carries it. */
  readonly resultPreview: string;
  /** Execution wall time; absent when the call failed before running or the runtime is older. */
  readonly elapsedMs?: number;
}

/** Host caps the summary at 1 KiB; the client accepts up to 4 KiB. */
export const MAX_FACTORY_LIVE_TOOL_SUMMARY_BYTES = 4_096;
/** Harness caps the result preview at 2 KiB; the client accepts up to 16 KiB. */
export const MAX_FACTORY_LIVE_TOOL_RESULT_BYTES = 16_384;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

/**
 * Decodes a public tool-call body correlated to `publicSessionId`. Returns
 * null for anything else — including a `TokenDelta` — and for a malformed or
 * oversized tool body: a tool step accumulates nothing, so unlike text there
 * is no key to suppress, and the committed `StepDone` is the truth anyway.
 */
export function decodeFactoryLiveToolStep(body: unknown, publicSessionId: string): FactoryLiveToolStep | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const type = value["type"];
  if (value["v"] !== 1 || (type !== "ToolCallStarted" && type !== "ToolCallCompleted")) return null;
  const sessionId = value["session_id"];
  const loopId = value["loop_id"];
  const turnId = value["turn_id"];
  const toolExecutionId = value["tool_execution_id"];
  if (typeof sessionId !== "string" || sessionId !== publicSessionId
    || typeof loopId !== "string" || !uuid.test(loopId)
    || typeof turnId !== "string" || !uuid.test(turnId)
    || typeof toolExecutionId !== "string" || !uuid.test(toolExecutionId)) return null;
  const stepId = optionalString(value["step_id"]);
  const toolUseId = optionalString(value["tool_use_id"]);
  const toolName = optionalString(value["tool_name"]);
  if (stepId === null || (stepId !== "" && !uuid.test(stepId)) || toolUseId === null || toolName === null) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(body);
  } catch {
    return null;
  }
  if (encoder.encode(encoded).byteLength > MAX_FACTORY_LIVE_TEXT_BODY_BYTES) return null;
  const common = { loopId, turnId, stepId, toolExecutionId, toolUseId, toolName };
  if (type === "ToolCallStarted") {
    const summary = optionalString(value["summary"]);
    if (summary === null || encoder.encode(summary).byteLength > MAX_FACTORY_LIVE_TOOL_SUMMARY_BYTES) return null;
    return { phase: "started", ...common, summary, isError: false, resultPreview: "" };
  }
  const resultPreview = optionalString(value["result_preview"]);
  // Only an absent member defaults; an explicit null is malformed, not success.
  const rawIsError = value["is_error"];
  const isError = rawIsError === undefined ? false : rawIsError;
  const elapsed = value["elapsed_ms"];
  if (resultPreview === null || encoder.encode(resultPreview).byteLength > MAX_FACTORY_LIVE_TOOL_RESULT_BYTES
    || typeof isError !== "boolean"
    || (elapsed !== undefined && (typeof elapsed !== "number" || !Number.isSafeInteger(elapsed) || elapsed < 0))) return null;
  return {
    phase: "completed", ...common, summary: "", isError, resultPreview,
    ...(elapsed === undefined ? {} : { elapsedMs: elapsed }),
  };
}

/** An absent member is ""; a present non-string member is malformed (null). */
function optionalString(value: unknown): string | null {
  if (value === undefined) return "";
  return typeof value === "string" ? value : null;
}
