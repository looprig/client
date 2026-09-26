/**
 * Shared fixture builders for the protocol tests. Envelopes are built the way
 * harness's event.MarshalEvent actually emits them (see 03-protocol.md "Read
 * this before Task 3.1", verified against harness/pkg/event/marshal.go's
 * mergeEnvelope and harness/pkg/identity/identifier_types.go): a "type"/"v"
 * discriminator merged as SIBLING keys into the promoted Header fields plus
 * the type-specific payload, with every zero-valued UUID ABSENT rather than
 * all-zeros — `identity.Coordinates` and `identity.Cause` tag every id
 * `omitzero`.
 *
 * Block payloads are Go-cased (core/content's TextBlock/ThinkingBlock/
 * ToolUseBlock/RefusalBlock carry no snake_case json tags, so encoding/json
 * emits the exported field name verbatim), while message-level fields are
 * snake_case (message.go marshals through tagged wire structs). ToolResultBlock
 * is the exception in the other direction — it has a hand-written codec over a
 * tagged struct and is fully snake_case.
 */
import type { EventEnvelope, EventHeader, EphemeralFrame, StatusEvent } from "../src/types.js";
import type { FoldInput } from "../src/fold.js";

export const SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const LOOP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const LOOP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
export const TURN_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const TURN_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

export interface EnvelopeOptions {
  type: string;
  loopId?: string;
  turnId?: string;
  stepId?: string;
  eventId?: string;
  createdAt?: string;
  agentName?: string;
  cause?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export function envelope(options: EnvelopeOptions): EventEnvelope {
  const out: Record<string, unknown> = {
    type: options.type,
    v: 1,
    session_id: SESSION_ID,
  };
  if (options.loopId !== undefined) out["loop_id"] = options.loopId;
  if (options.turnId !== undefined) out["turn_id"] = options.turnId;
  if (options.stepId !== undefined) out["step_id"] = options.stepId;
  if (options.eventId !== undefined) out["event_id"] = options.eventId;
  if (options.createdAt !== undefined) out["created_at"] = options.createdAt;
  if (options.agentName !== undefined) out["agent_name"] = options.agentName;
  if (options.cause !== undefined) out["cause"] = options.cause;
  Object.assign(out, options.payload ?? {});
  return out as unknown as EventEnvelope;
}

let nextSeq = 0;
export function resetSeq(): void {
  nextSeq = 0;
}

/** One cold-journal item, auto-numbered unless `journalSeq` is given. */
export function history(env: EventEnvelope, journalSeq?: number): FoldInput {
  const seq = journalSeq ?? nextSeq++;
  if (journalSeq !== undefined) nextSeq = Math.max(nextSeq, journalSeq + 1);
  const event: StatusEvent = { journal_seq: seq, event: env } as StatusEvent;
  return { segment: "history", event };
}

/** One live enduring frame carrying the same envelope shape. */
export function liveEnduring(env: EventEnvelope, journalSeq?: number): FoldInput {
  const seq = journalSeq ?? nextSeq++;
  if (journalSeq !== undefined) nextSeq = Math.max(nextSeq, journalSeq + 1);
  return {
    segment: "live",
    frame: { type: "enduring", journalSeq: seq, data: { event: env } as never },
  };
}

/**
 * One ephemeral frame header. `turn_id` is a real wire field on every frame the
 * live segment folds: harness's stampLoopHeader fills a TokenDelta,
 * ToolCallStarted and ToolCallCompleted header with fillTurnScoped
 * (SessionID + LoopID + TurnID), and the tool pair additionally carries the
 * StepID stampStepID stamps. `event_header.schema.json` declares all of them.
 */
export function header(loopId?: string, turnId?: string): EventHeader {
  const h: Record<string, unknown> = { session_id: SESSION_ID };
  if (loopId !== undefined) h["loop_id"] = loopId;
  if (turnId !== undefined) h["turn_id"] = turnId;
  return h as unknown as EventHeader;
}

/** One live ephemeral frame. `kind` is the schema's enum value. */
export function liveEphemeral(
  kind: string,
  delta: Record<string, unknown> | undefined,
  loopId?: string,
  turnId?: string,
): FoldInput {
  const frameData: Record<string, unknown> = { kind };
  if (delta !== undefined) frameData["delta"] = delta;
  if (loopId !== undefined || turnId !== undefined) frameData["header"] = header(loopId, turnId);
  return {
    segment: "live",
    frame: { type: "ephemeral", data: frameData as unknown as EphemeralFrame },
  };
}

export function textDelta(text: string, loopId?: string, turnId?: string): FoldInput {
  return liveEphemeral("token_delta", { chunk_type: "text", text }, loopId, turnId);
}

export function thinkingDelta(thinking: string, loopId?: string, turnId?: string): FoldInput {
  return liveEphemeral("token_delta", { chunk_type: "thinking", thinking }, loopId, turnId);
}

/**
 * harness's `refusalChunkDTO` — its own `chunk_type`, deliberately NOT riding
 * on "text", because a client that rendered a refusal as text would show the
 * model answering a request it declined.
 */
export function refusalDelta(text: string, loopId?: string, turnId?: string): FoldInput {
  return liveEphemeral("token_delta", { chunk_type: "refusal", text }, loopId, turnId);
}

/**
 * harness's `imageChunkDTO`. `index` is the only field with no omitempty, so
 * the caller passes exactly the keys the wire would carry.
 */
export function imageDelta(
  delta: Record<string, unknown>,
  loopId?: string,
  turnId?: string,
): FoldInput {
  return liveEphemeral("token_delta", { chunk_type: "image", ...delta }, loopId, turnId);
}

/** A Go-cased text content block, as core/content.TextBlock encodes. */
export function textBlockWire(text: string): Record<string, unknown> {
  return { type: "text", Text: text };
}

/** A snake_case assistant message wrapping Go-cased blocks. */
export function aiMessageWire(blocks: Array<Record<string, unknown>>): Record<string, unknown> {
  return { role: "assistant", blocks };
}

export function userMessageWire(blocks: Array<Record<string, unknown>>): Record<string, unknown> {
  return { role: "user", blocks };
}

/**
 * A ROOT `LoopStarted` for `loopId` — the record harness emits once per loop at
 * creation, including for the session's primary loop (`findRootLoopStarted`
 * locates it by "zero Cause", and restore fails closed without it).
 *
 * A fixture that omits it describes a loop the client has no loop-tree record
 * for, which `fold` marks `orphanedLoop`. Prepending this is what makes a
 * fixture a full replay rather than a trimmed page.
 *
 * It deliberately does NOT advance the shared `nextSeq` counter: it exists to be
 * prepended to an EXISTING fixture, and renumbering that fixture's events would
 * change what the test around it is asserting. A LoopStarted commits no
 * transcript row, so its own journal_seq is never observable.
 */
export function loopStarted(loopId: string, agentName = "primer"): FoldInput {
  const event: StatusEvent = {
    journal_seq: 0,
    event: envelope({ type: "LoopStarted", loopId, agentName }),
  } as StatusEvent;
  return { segment: "history", event };
}
