/**
 * Session state-machine fold: turns the two independent event streams the SDK
 * can observe — a cold `StatusEvent[]` page replayed from
 * `GET /v1/sessions/{sid}/journal` and a live `SseFrame` stream from
 * `sse.ts`'s `SseFrameParser`/`parseSseStream` — into ONE accumulated
 * `SessionView` shape. This is the "single event DTO flows through both
 * history and live" seam: a renderer only ever needs to know `SessionView`,
 * never which segment (cold journal page vs. live SSE) an update came from.
 *
 * ## Why `fold()` takes a discriminated `HistoryInput | LiveInput`, not a bare
 * `StatusEvent | SseFrame` union
 *
 * `StatusEvent` (`additionalProperties: false`, only `journal_seq`/`event`)
 * never carries a `type` key, while every `SseFrame` variant's `type` is
 * required — so the two ARE structurally distinguishable without a wrapper.
 * A wrapper is used anyway because it makes the call site's intent
 * (`{ segment: "history", event }` vs. `{ segment: "live", frame }`)
 * self-documenting rather than relying on a reader noticing the absence of a
 * field, and it gives `fold()` an unambiguous compile-time discriminant to
 * switch on instead of a runtime structural sniff.
 *
 * ## The exhaustiveness guarantee (the reason this module exists)
 *
 * `ephemeral_frame.schema.json`'s `kind` is a proper TypeScript string-literal
 * union (`FromSchema` resolves its `enum` to
 * `"token_delta" | "tool_call_started" | "tool_call_completed" |
 * "input_queued" | "compaction_started"` — confirmed empirically, not
 * assumed), so `foldEphemeral`'s switch over `frame.kind` uses the standard
 * `never`-typed default-case idiom: if the schema's `kind` enum ever grows a
 * 6th value and this switch isn't updated to handle it, the assignment
 * `const exhaustive: never = frame.kind` in the default case stops compiling
 * — `npm run typecheck` fails BEFORE the gap can ship. Until that day, the
 * default case is unreachable in a well-typed caller, but a caller that
 * constructs a frame via `as`/`as any` (this module's own tests do exactly
 * that, to simulate a future wire addition) reaches it at runtime, where it
 * produces a typed `FoldError` (`reason: "unknown_ephemeral_kind"`) — never a
 * thrown generic exception, never a silent no-op. See fold.test.ts's
 * "unknown ephemeral kind" case and its throwaway verification (documented in
 * this task's report) that commenting out a real case actually breaks
 * `tsc`.
 *
 * `frame.delta`, in contrast, has NO such compile-time backing:
 * `ephemeral_frame.schema.json` types it as a bare `{"type":"object"}` with no
 * `properties`/`oneOf`-by-`kind`, so `FromSchema` resolves it to
 * `{ [x: string]: unknown } | undefined` regardless of `kind` — confirmed
 * empirically the same way. The kind-specific shapes below
 * (`TokenDeltaChunk`, `ToolCallStartedDelta`, `ToolCallCompletedDelta`,
 * `CompactionStartedDelta`) are hand-authored from harness's actual encoder
 * (`pkg/serve/ephemeral.go`'s `textChunkDTO`/`thinkingChunkDTO`/
 * `toolUseChunkDTO`/`toolCallStartedDelta`/`toolCallCompletedDelta`/
 * `compactionStartedDelta` structs), not from the vendored JSON Schema, and
 * are validated by hand-rolled runtime guards below rather than ajv (there is
 * no per-kind schema to compile). A malformed `delta` (present but missing an
 * expected field, wrong type) yields a typed `FoldError`
 * (`reason: "malformed_delta"`) rather than propagating `undefined`s or
 * throwing — same "never silently drop" discipline as sse.ts's
 * `SseFrameError`, extended one layer further into the payload sse.ts itself
 * does not (and per its own docs, deliberately does not) interpret.
 *
 * ## Gates are NOT folded here
 *
 * harness's Go event union (`pkg/event/validate.go`'s `classify`) includes
 * `GatePrepared`/`GateOpened`/`GateResolved` concrete types, so gate-shaped
 * events are real wire traffic in principle. But `event_journal_page.schema.json`
 * documents "GatePrepared never appears" in a journal page, and — more
 * fundamentally — `event_envelope.schema.json` types `event.type` as a bare
 * `string` (confirmed: not an enum) and documents the per-type payload as
 * wholly "open" (unconstrained). There is no vendored schema this SDK could
 * validate a gate payload against, and no TS shape `FromSchema` derives for
 * one — building kind-specific gate-folding logic here would mean inventing
 * a payload shape from nothing this contract actually pins down. So
 * `foldStatusEvent`/`foldEnduringEnvelope` below fold every enduring
 * `EventEnvelope` (gate-shaped or not) into the SAME generic
 * `StatusEventMarker` — `type` plus the envelope's identity fields plus the
 * envelope verbatim — rather than a `Gate`-specific case that doesn't exist
 * anywhere in this contract yet. When gate payloads get a real vendored
 * schema, `StatusEventMarker` is the natural extension point (a
 * `kind`-specific case alongside the generic fallback, mirroring how
 * `foldEphemeral` is structured), not a redesign.
 */
import type { EphemeralFrame, EventEnvelope, StatusEvent } from "./types.js";
import type { EnduringSseFrame, EphemeralSseFrame, SseFrame } from "./sse.js";

// --- Session view -----------------------------------------------------------

/** A `token_delta` text chunk, folded from `content.TextChunk`'s tagged wire DTO. */
export interface TextContentDelta {
  chunkType: "text";
  text: string;
  header: EventEnvelope | undefined;
}

/** A `token_delta` thinking chunk, folded from `content.ThinkingChunk`'s tagged wire DTO. */
export interface ThinkingContentDelta {
  chunkType: "thinking";
  thinking: string;
  header: EventEnvelope | undefined;
}

/**
 * A `token_delta` tool-use chunk: the model's in-progress tool-call
 * construction streaming into the message content (index/id/name/partial
 * JSON), folded from `content.ToolUseChunk`'s tagged wire DTO. This is
 * DISTINCT from `ToolCallCard` below — this is streamed message content
 * (what the model is generating); `ToolCallCard` is the execution lifecycle
 * (`tool_call_started`/`tool_call_completed`, what actually ran).
 */
export interface ToolUseContentDelta {
  chunkType: "tool_use";
  index: number;
  id: string;
  name: string;
  inputJson: string;
  header: EventEnvelope | undefined;
}

export type ContentDelta = TextContentDelta | ThinkingContentDelta | ToolUseContentDelta;

/**
 * One tool call's execution lifecycle, built by folding a `tool_call_started`
 * frame and (when it arrives) the matching `tool_call_completed` frame into a
 * single card. `toolExecutionId` is the join key when both frames carry it
 * (`omitzero` on the wire, so it can legitimately be absent); when a
 * `tool_call_completed` can't be matched to a prior `started` card (missing
 * id, or arriving without ever seeing a `started` — e.g. mid-stream join), a
 * new completed-only card is appended rather than the update being dropped.
 */
export interface ToolCallCard {
  toolExecutionId: string | undefined;
  status: "started" | "completed";
  toolName: string | undefined;
  summary: string | undefined;
  isError: boolean | undefined;
  resultPreview: string | undefined;
  startedHeader: EventEnvelope | undefined;
  completedHeader: EventEnvelope | undefined;
}

/** An `input_queued` marker. Per the schema, this kind carries no `delta` at all — only `header` (when the server sent one) is representable. */
export interface QueuedInputMarker {
  header: EventEnvelope | undefined;
}

/** A `compaction_started` marker: the attempt id, reason, and context basis the compaction started from. */
export interface CompactionMarker {
  attemptId: string;
  /** `event.CompactionReason`: 0 = unspecified, 1 = manual, 2 = automatic (no wire-side symbolic encoding — harness marshals the bare `uint8`). */
  reason: number;
  basis: { revision: number; throughEventId: string };
  header: EventEnvelope | undefined;
}

/**
 * A durable/enduring event, folded generically from either a cold
 * `StatusEvent` (journal replay) or a live `EnduringSseFrame`. `type` is
 * whatever `event.MarshalEvent` stamped (`"TurnDone"`, `"StepDone"`,
 * `"SessionIdle"`, ... — see harness's `pkg/event/validate.go`'s `classify`
 * for the full sealed set), kept as a plain `string` because that's exactly
 * what `event_envelope.schema.json` types it as: not a schema-backed enum.
 * `journalSeq` is present for both sources (a replayed page's `journal_seq`
 * and a live enduring frame's SSE `id:` line both stamp the durable
 * sequence) — this is the field that proves history and live fold into
 * structurally comparable output, not just superficially similar output.
 */
export interface StatusEventMarker {
  type: string;
  journalSeq: number | undefined;
  sessionId: string | undefined;
  loopId: string | undefined;
  turnId: string | undefined;
  stepId: string | undefined;
  eventId: string | undefined;
  createdAt: string | undefined;
  envelope: EventEnvelope;
}

/** The single accumulated session shape both history and live segments fold into. Append-only: fold() never removes an entry, only appends or (for `ToolCallCard`) updates one in place. */
export interface SessionView {
  content: ContentDelta[];
  toolCalls: ToolCallCard[];
  queuedInputs: QueuedInputMarker[];
  compactions: CompactionMarker[];
  statusEvents: StatusEventMarker[];
}

export function emptySessionView(): SessionView {
  return { content: [], toolCalls: [], queuedInputs: [], compactions: [], statusEvents: [] };
}

// --- Fold input / result -----------------------------------------------------

/** One item from a cold journal page. */
export interface HistoryInput {
  segment: "history";
  event: StatusEvent;
}

/** One frame from the live SSE stream (any `SseFrame` variant — `fold()` handles all four). */
export interface LiveInput {
  segment: "live";
  frame: SseFrame;
}

export type FoldInput = HistoryInput | LiveInput;

/**
 * Why a fold failed. `unknown_ephemeral_kind` is the case this module exists
 * to guarantee never happens silently (see the module comment); the other
 * three cover payload-shape problems one layer deeper than sse.ts's own
 * `SseFrameError` reaches (sse.ts validates the frame ENVELOPE against ajv;
 * it does not, and per its own module comment cannot via the vendored
 * schema, validate `delta`'s kind-specific interior).
 */
export type FoldErrorReason =
  | "unknown_ephemeral_kind"
  | "unknown_chunk_type"
  | "malformed_delta"
  | "upstream_frame_error";

/** Thrown — well, carried, never thrown; see FoldResult — for one input that could not be folded. Always typed and always surfaced; fold() never drops an input silently. */
export class FoldError extends Error {
  readonly reason: FoldErrorReason;

  constructor(reason: FoldErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FoldError";
    this.reason = reason;
  }
}

/**
 * Result of one `fold()` call. Modeled the same way sse.ts models a
 * malformed frame (`ErrorSseFrame`, yielded in-band rather than thrown): a
 * long-lived fold loop over a whole session's history plus a live stream
 * should not have to wrap every single call in try/catch to keep running
 * past one bad input, but the caller must still get a fully typed, non-silent
 * signal it can inspect, log, or escalate on its own policy — see `reason`
 * above for exactly what it can switch on.
 */
export type FoldResult = { ok: true; view: SessionView } | { ok: false; error: FoldError };

// --- Runtime delta guards (no schema backs these — see module comment) ------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

interface TextChunkDelta {
  chunkType: "text";
  text: string;
}
interface ThinkingChunkDelta {
  chunkType: "thinking";
  thinking: string;
}
interface ToolUseChunkDelta {
  chunkType: "tool_use";
  index: number;
  id: string;
  name: string;
  inputJson: string;
}
type TokenDeltaChunk = TextChunkDelta | ThinkingChunkDelta | ToolUseChunkDelta;

type GuardResult<T> = { ok: true; value: T } | { ok: false; error: FoldError };

/**
 * Parses a `token_delta` frame's `delta` into its tagged chunk shape.
 * `chunk_type` has NO schema backing at all (unlike the outer `kind`), so
 * this switch is runtime-only — an unrecognized `chunk_type` (a genuinely
 * new chunk variant, not just a malformed one) gets its own reason so a
 * caller can tell "the wire sent something never-before-seen" apart from
 * "the wire sent a known kind with a broken payload".
 */
function parseTokenDeltaChunk(delta: Record<string, unknown> | undefined): GuardResult<TokenDeltaChunk> {
  if (!isRecord(delta)) {
    return { ok: false, error: new FoldError("malformed_delta", 'token_delta frame is missing its "delta" payload') };
  }
  const chunkType = delta["chunk_type"];
  switch (chunkType) {
    case "text":
      if (typeof delta["text"] !== "string") {
        return { ok: false, error: new FoldError("malformed_delta", 'token_delta "text" chunk is missing a string "text" field') };
      }
      return { ok: true, value: { chunkType: "text", text: delta["text"] } };
    case "thinking":
      if (typeof delta["thinking"] !== "string") {
        return { ok: false, error: new FoldError("malformed_delta", 'token_delta "thinking" chunk is missing a string "thinking" field') };
      }
      return { ok: true, value: { chunkType: "thinking", thinking: delta["thinking"] } };
    case "tool_use": {
      const { index, id, name, input_json: inputJson } = delta;
      if (typeof index !== "number" || typeof id !== "string" || typeof name !== "string" || typeof inputJson !== "string") {
        return { ok: false, error: new FoldError("malformed_delta", 'token_delta "tool_use" chunk is missing one of its required fields (index/id/name/input_json)') };
      }
      return { ok: true, value: { chunkType: "tool_use", index, id, name, inputJson } };
    }
    default:
      return { ok: false, error: new FoldError("unknown_chunk_type", `token_delta frame has an unrecognized "chunk_type": ${JSON.stringify(chunkType)}`) };
  }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optionalBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

// --- Ephemeral fold -----------------------------------------------------------

/**
 * Folds one `EphemeralFrame` into `view`, exhaustively over all five `kind`s.
 * See the module comment for the compile-time-vs-runtime exhaustiveness
 * split: `frame.kind`'s switch is compile-time guarded (a `never`-typed
 * default case); the shape checks inside each case are runtime-only.
 */
function foldEphemeral(view: SessionView, frame: EphemeralFrame): FoldResult {
  const header = frame.header;
  const delta = frame.delta;

  switch (frame.kind) {
    case "token_delta": {
      const parsed = parseTokenDeltaChunk(delta);
      if (!parsed.ok) return parsed;
      const entry: ContentDelta = { ...parsed.value, header };
      return { ok: true, view: { ...view, content: [...view.content, entry] } };
    }

    case "tool_call_started": {
      const toolExecutionId = optionalString(delta?.["tool_execution_id"]);
      const card: ToolCallCard = {
        toolExecutionId,
        status: "started",
        toolName: optionalString(delta?.["tool_name"]),
        summary: optionalString(delta?.["summary"]),
        isError: undefined,
        resultPreview: undefined,
        startedHeader: header,
        completedHeader: undefined,
      };
      return { ok: true, view: { ...view, toolCalls: [...view.toolCalls, card] } };
    }

    case "tool_call_completed": {
      const toolExecutionId = optionalString(delta?.["tool_execution_id"]);
      const isError = optionalBoolean(delta?.["is_error"]);
      const resultPreview = optionalString(delta?.["result_preview"]);

      const matchIndex =
        toolExecutionId === undefined
          ? -1
          : view.toolCalls.findIndex((c) => c.status === "started" && c.toolExecutionId === toolExecutionId);

      if (matchIndex === -1) {
        const card: ToolCallCard = {
          toolExecutionId,
          status: "completed",
          toolName: undefined,
          summary: undefined,
          isError,
          resultPreview,
          startedHeader: undefined,
          completedHeader: header,
        };
        return { ok: true, view: { ...view, toolCalls: [...view.toolCalls, card] } };
      }

      const toolCalls = [...view.toolCalls];
      const prior = toolCalls[matchIndex]!;
      toolCalls[matchIndex] = { ...prior, status: "completed", isError, resultPreview, completedHeader: header };
      return { ok: true, view: { ...view, toolCalls } };
    }

    case "input_queued": {
      const marker: QueuedInputMarker = { header };
      return { ok: true, view: { ...view, queuedInputs: [...view.queuedInputs, marker] } };
    }

    case "compaction_started": {
      if (!isRecord(delta) || typeof delta["attempt_id"] !== "string" || typeof delta["reason"] !== "number") {
        return { ok: false, error: new FoldError("malformed_delta", 'compaction_started frame is missing a valid "delta.attempt_id"/"delta.reason"') };
      }
      const basis = delta["basis"];
      if (!isRecord(basis) || typeof basis["revision"] !== "number" || typeof basis["through_event_id"] !== "string") {
        return { ok: false, error: new FoldError("malformed_delta", 'compaction_started frame\'s "delta.basis" is missing "revision"/"through_event_id"') };
      }
      const marker: CompactionMarker = {
        attemptId: delta["attempt_id"],
        reason: delta["reason"],
        basis: { revision: basis["revision"], throughEventId: basis["through_event_id"] },
        header,
      };
      return { ok: true, view: { ...view, compactions: [...view.compactions, marker] } };
    }

    default: {
      // Compile-time exhaustiveness: `frame.kind`'s type is the schema's literal
      // enum union (verified empirically — see the module comment), so if every
      // case above is handled, `frame.kind` here is narrowed to `never` and this
      // assignment type-checks. Add a 6th `kind` to the schema/schema.ts mirror
      // without adding a case above, and THIS LINE fails `tsc` — that's the
      // point, not an accident.
      const exhaustive: never = frame.kind;
      return { ok: false, error: new FoldError("unknown_ephemeral_kind", `unrecognized ephemeral frame kind: ${JSON.stringify(exhaustive)}`) };
    }
  }
}

// --- Enduring / StatusEvent fold ---------------------------------------------

/**
 * Folds one durable `EventEnvelope` into `view`, tagged with `journalSeq`
 * when known. Shared by both `foldStatusEvent` (cold) and the `"enduring"`
 * case of `fold()` (live) so the two sources produce identically-shaped
 * `StatusEventMarker`s — see the module comment on `StatusEventMarker` for
 * why this is generic rather than per-`type`.
 */
function foldEnduringEnvelope(view: SessionView, envelope: EventEnvelope, journalSeq: number | undefined): FoldResult {
  const marker: StatusEventMarker = {
    type: envelope.type,
    journalSeq,
    sessionId: envelope.session_id,
    loopId: envelope.loop_id,
    turnId: envelope.turn_id,
    stepId: envelope.step_id,
    eventId: envelope.event_id,
    createdAt: envelope.created_at,
    envelope,
  };
  return { ok: true, view: { ...view, statusEvents: [...view.statusEvents, marker] } };
}

function foldStatusEvent(view: SessionView, event: StatusEvent): FoldResult {
  if (event.event === undefined) {
    // event_envelope is technically optional in status_event.schema.json (not
    // listed in "required"); a journal_seq with no event carries nothing this
    // view can represent. Not an error — there is genuinely nothing to fold.
    return { ok: true, view };
  }
  return foldEnduringEnvelope(view, event.event, event.journal_seq);
}

// --- Top-level fold -----------------------------------------------------------

/**
 * Folds one `HistoryInput` or `LiveInput` into `view`, returning a new
 * `SessionView` (never mutates `view` in place) or a typed `FoldError`.
 * This is the ONE function a caller drives over both a journal page's items
 * (wrapped as `HistoryInput`) and a live `parseSseStream()`'s frames (wrapped
 * as `LiveInput`) to build up a single `SessionView`.
 */
export function fold(view: SessionView, input: FoldInput): FoldResult {
  if (input.segment === "history") {
    return foldStatusEvent(view, input.event);
  }
  return foldLiveFrame(view, input.frame);
}

function foldLiveFrame(view: SessionView, frame: SseFrame): FoldResult {
  switch (frame.type) {
    case "enduring":
      return foldEnduringEnvelopeFrame(view, frame);
    case "ephemeral":
      return foldEphemeralFrame(view, frame);
    case "heartbeat":
      // A liveness signal, not session state — nothing to fold.
      return { ok: true, view };
    case "error":
      // sse.ts already produced a typed SseFrameError for this frame (bad
      // JSON, ajv rejection, unrecognized event:); fold() surfaces it as a
      // FoldError too, rather than silently skipping it, so a caller that
      // only looks at FoldResult (not the raw SseFrame stream) still sees it.
      return { ok: false, error: new FoldError("upstream_frame_error", "upstream SSE frame failed to parse/validate", { cause: frame.error }) };
    default: {
      const exhaustive: never = frame;
      return { ok: false, error: new FoldError("upstream_frame_error", `unrecognized SseFrame type: ${JSON.stringify((exhaustive as { type?: unknown }).type)}`) };
    }
  }
}

function foldEnduringEnvelopeFrame(view: SessionView, frame: EnduringSseFrame): FoldResult {
  return foldEnduringEnvelope(view, frame.data.event, frame.journalSeq);
}

function foldEphemeralFrame(view: SessionView, frame: EphemeralSseFrame): FoldResult {
  return foldEphemeral(view, frame.data);
}
