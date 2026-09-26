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
 * `toolUseChunkDTO`/`refusalChunkDTO`/`imageChunkDTO`/`toolCallStartedDelta`/
 * `toolCallCompletedDelta`/`compactionStartedDelta` structs — all FIVE chunk
 * variants of `encodeChunkDelta`'s sealed union, because a variant this parser
 * does not know surfaces as a fold ERROR to a user who is only watching a
 * model stream), not from the vendored JSON Schema, and
 * are validated by hand-rolled runtime guards below rather than ajv (there is
 * no per-kind schema to compile). A malformed `delta` (present but missing an
 * expected field, wrong type) yields a typed `FoldError`
 * (`reason: "malformed_delta"`) rather than propagating `undefined`s or
 * throwing — same "never silently drop" discipline as sse.ts's
 * `SseFrameError`, extended one layer further into the payload sse.ts itself
 * does not (and per its own docs, deliberately does not) interpret.
 *
 * ## Gates ARE folded here — the map, not the marker
 *
 * This module used to say gates could not be folded, because
 * `event_envelope.schema.json` leaves the per-type payload wholly open and
 * there was no vendored schema to validate one against. That was a statement
 * about SCHEMAS, and it does not survive: `MarshalEvent` merges the full
 * type-specific payload into the envelope as sibling keys and the journal
 * replays those bytes verbatim, so the payload is a real durable contract with
 * or without a schema document. enduring.ts decodes it against bytes harness's
 * own codec produced, and gate.ts decodes the gate envelope those bytes carry.
 *
 * So `foldEnduringEnvelope` now does both: it appends the generic
 * `StatusEventMarker` exactly as before (nothing that reads `statusEvents`
 * regresses, and the long tail is still covered by it) AND routes the two
 * public gate events into `SessionView.gates`. That is the "kind-specific case
 * alongside the generic fallback, mirroring how `foldEphemeral` is structured"
 * this comment always named as the extension point — a widening, not a
 * redesign.
 *
 * `GatePrepared` is not handled and never needs to be: it is the private
 * prepared record, the replayer filters it out of journal pages, and it never
 * fans out to SSE.
 */
import type { EphemeralFrame, EventEnvelope, EventHeader, PublicGatePage, StatusEvent } from "./types.js";
import type { EnduringSseFrame, EphemeralSseFrame, SseFrame } from "./sse.js";
import { decodeEnduring, isZeroUUID, principalLabel, turnFailureText, type MessageInput } from "./enduring.js";
import { decodeGateProjection, type Gate, type PublicGateProjection } from "./gate.js";
import { str, type ContentBlock } from "./blocks.js";
import type { AssistantRow, LoopInfo, ToolRow, ToolRowStatus, TranscriptRow, TranscriptRowDraft, UserFrame } from "./rows.js";
import {
  narrationOf,
  redactedThinkingOf,
  refusalOf,
  splitStepGroup,
  thinkingOf,
  toolResultText,
  toolUsesOf,
} from "./rows.js";
import { toolUseSummary } from "./toolsummary.js";

// --- Session view -----------------------------------------------------------

/** A `token_delta` text chunk, folded from `content.TextChunk`'s tagged wire DTO. */
export interface TextContentDelta {
  chunkType: "text";
  text: string;
  header: EventHeader | undefined;
}

/** A `token_delta` thinking chunk, folded from `content.ThinkingChunk`'s tagged wire DTO. */
export interface ThinkingContentDelta {
  chunkType: "thinking";
  thinking: string;
  header: EventHeader | undefined;
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
  header: EventHeader | undefined;
}

/**
 * A `token_delta` refusal chunk, folded from `content.RefusalChunk`'s tagged
 * wire DTO. It carries its OWN `chunk_type` rather than riding on "text", and
 * harness's own comment says why: "a client that saw a refusal as text would
 * render the model answering a request it declined, and the two are not
 * interchangeable on the wire any more than they are in memory." The payload is
 * byte-identical to a text chunk's; the tag is the whole distinction.
 */
export interface RefusalContentDelta {
  chunkType: "refusal";
  text: string;
  header: EventHeader | undefined;
}

/**
 * A `token_delta` image chunk, folded from `content.ImageChunk`'s tagged wire
 * DTO (`imageChunkDTO`).
 *
 * It is a per-image FRAGMENT, not an image: `data` appends in arrival order and
 * `url` arrives whole and replaces any earlier value. `index` identifies WHICH
 * image of the response the fragment belongs to and is load-bearing in a way a
 * text chunk's absent index is not — core's own doc records that splicing one
 * image's bytes onto another's yields a corrupt file no decoder can recover and
 * no validation can detect. It is the one field with no `omitempty`.
 *
 * `data` is kept as the base64 string the JSON codec produced (Go `[]byte`), not
 * decoded: nothing in this layer reassembles images, and a renderer that wants
 * to has the exact bytes the wire carried.
 */
export interface ImageContentDelta {
  chunkType: "image";
  index: number;
  mediaType: string;
  url: string;
  data: string;
  header: EventHeader | undefined;
}

export type ContentDelta =
  | TextContentDelta
  | ThinkingContentDelta
  | ToolUseContentDelta
  | RefusalContentDelta
  | ImageContentDelta;

/**
 * One tool call's execution lifecycle, built by folding a `tool_call_started`
 * frame and (when it arrives) the matching `tool_call_completed` frame into a
 * single card. `toolExecutionId` is the join key when both frames carry it
 * (`omitzero` on the wire, so it can legitimately be absent); when a frame
 * can't be matched to a prior card for the same id (missing id, or arriving
 * without ever seeing the other half — e.g. mid-stream join), a new
 * single-sided card is appended rather than the update being dropped.
 *
 * Matching is symmetric and id-based (NOT status-based): both
 * `tool_call_started` and `tool_call_completed` search for ANY existing card
 * with the same `toolExecutionId`, regardless of that card's current
 * `status`, and merge into it in place rather than ever appending a second
 * card for an id already represented. This matters for two real event orders
 * this SDK cannot rule out (ephemeral frames are best-effort/at-least-once,
 * per sse.ts/fold.ts's own module comments, and a join-window race can
 * reorder arrival relative to real time — see join.ts):
 *  - `tool_call_completed` arriving BEFORE its `tool_call_started` counterpart:
 *    the completed-only card `tool_call_started` later matches against is
 *    filled in with the started-only fields (`toolName`/`summary`/
 *    `startedHeader`) without regressing `status` back to `"started"` —
 *    completion is the more advanced state and is never undone by a
 *    later-arriving start.
 *  - a duplicate `tool_call_started` (or `tool_call_completed`) for an id
 *    already represented: merged into the existing card (overwriting that
 *    frame's own fields with the newer occurrence) rather than orphaning a
 *    second card that can never be resolved. A true duplicate carries
 *    identical data anyway, so overwriting is always safe; a legitimately
 *    corrected resend is reflected rather than silently ignored.
 */
export interface ToolCallCard {
  toolExecutionId: string | undefined;
  status: "started" | "completed";
  toolName: string | undefined;
  summary: string | undefined;
  isError: boolean | undefined;
  resultPreview: string | undefined;
  startedHeader: EventHeader | undefined;
  completedHeader: EventHeader | undefined;
}

/** An `input_queued` marker. Per the schema, this kind carries no `delta` at all — only `header` (when the server sent one) is representable. */
export interface QueuedInputMarker {
  header: EventHeader | undefined;
}

/** A `compaction_started` marker: the attempt id, reason, and context basis the compaction started from. */
export interface CompactionMarker {
  attemptId: string;
  /** `event.CompactionReason`: 0 = unspecified, 1 = manual, 2 = automatic (no wire-side symbolic encoding — harness marshals the bare `uint8`). */
  reason: number;
  basis: { revision: number; throughEventId: string };
  header: EventHeader | undefined;
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

/**
 * The single accumulated session shape both history and live segments fold
 * into. The arrays are append-only: fold() never removes an entry, only appends
 * or (for `ToolCallCard`) updates one in place. `gates` is the exception, and
 * deliberately so — a gate's whole lifecycle is open-then-close. `loops` grows
 * only, but an entry is REPLACED when the loop's `LoopStarted` finally turns up.
 */
export interface SessionView {
  content: ContentDelta[];
  toolCalls: ToolCallCard[];
  queuedInputs: QueuedInputMarker[];
  compactions: CompactionMarker[];
  statusEvents: StatusEventMarker[];
  /**
   * The OPEN gates, keyed by gate id. Opened on `GateOpened`, removed on
   * `GateResolved`. This is the map the UI answers from; gates are never
   * polled — see gate.ts's module comment for why `GET /status`'s
   * `waiting_gate_id` is not an alternative.
   *
   * A Map rather than an array because the resolve is a keyed removal, and the
   * key is the GATE id rather than the loop id or the subject's tool execution
   * id: two gates can be open in one loop, and two can be open over one tool
   * call, so either of those keys would silently drop a gate a human still has
   * to answer.
   *
   * Non-answerable kinds (ask-user, form, open-url) are kept here too. They
   * still block progress, so a renderer must show them — with
   * `isAnswerableGate` deciding whether to offer controls or an "answer this in
   * the TUI" card.
   */
  gates: Map<string, Gate>;
  /**
   * The session's loop tree, keyed by loop id: who spawned each loop, which
   * tool call anchors it, and whether its `LoopStarted` was actually observed.
   * See rows.ts's `LoopInfo` for the field contract and `anchorOf` for the
   * lookup a renderer nests through.
   *
   * A loop is registered the first time ANY event or frame names it, so a loop
   * whose `LoopStarted` fell off the journal page is present-but-unobserved
   * rather than absent — which is what keeps its rows in the transcript with an
   * "orphaned subagent" marker instead of dropping them (§3b).
   *
   * The session-scoped loop id "" is never registered: it is the id an
   * optimistic pending row and a session-scoped frame both carry, and it names
   * no loop.
   */
  loops: Map<string, LoopInfo>;
  /**
   * The append-only transcript row projection: ONE array preserving the
   * cross-bucket arrival order `content` and `toolCalls` cannot express. See
   * rows.ts for the shape, the copy-on-write rule and the ordering rule.
   */
  rows: TranscriptRow[];
  /** The next ordinal to allocate. Monotonic; never reused, never reset. */
  nextOrdinal: number;
  /**
   * Ordinals of the optimistic pending user rows this tab is holding, keyed by
   * the submit's command id.
   *
   * PER-TAB by construction. `input_queued` is ephemeral and carries no `delta`
   * and therefore no text — it announces that something was queued, not what —
   * so the submitted blocks exist only in the composer that sent them. The row
   * enters through `addPendingRow`, never through a fold input, and a second
   * tab (or the TUI) sees nothing for this submit until `TurnStarted`.
   */
  pending: Map<string, number>;
  /**
   * What the server did with each command id it ACKNOWLEDGED, from
   * `Header.Cause.CommandID` on `TurnStarted` / `TurnFoldedInto` /
   * `TurnRejected` / `InputCancelled` — the four events §3b names as resolving
   * the optimistic pending row.
   *
   * This is the only place pending-row resolution is observable. Scanning
   * `rows` cannot do it: `TurnRejected` commits a NOTICE row rather than a user
   * row, and `InputCancelled` commits no row at all, so a consumer would have
   * to find the command id on three different row kinds — and on a row kind
   * that does not carry it. Keyed by exactly the key `addPendingRow` files
   * under, so `outcome = view.commandOutcomes.get(commandId)` is the whole
   * consumer-side protocol.
   *
   * Last write wins. The four events are mutually exclusive terminals for one
   * submit, so the only repeat in practice is the same event redelivered across
   * the journal/live join window, which is idempotent.
   */
  commandOutcomes: Map<string, CommandOutcome>;
}

/**
 * What became of one submitted command. `"started"` covers both `TurnStarted`
 * and `TurnFoldedInto`: §3b treats them identically, and from the composer's
 * side both mean "the server took it and the authoritative row is in `rows`
 * now" — a folded input is still the user's input.
 */
export type CommandOutcome = "started" | "rejected" | "cancelled";

export function emptySessionView(): SessionView {
  return {
    content: [],
    toolCalls: [],
    queuedInputs: [],
    compactions: [],
    statusEvents: [],
    gates: new Map(),
    loops: new Map(),
    rows: [],
    nextOrdinal: 0,
    pending: new Map(),
    commandOutcomes: new Map(),
  };
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
interface RefusalChunkDelta {
  chunkType: "refusal";
  text: string;
}
interface ImageChunkDelta {
  chunkType: "image";
  index: number;
  mediaType: string;
  url: string;
  data: string;
}
type TokenDeltaChunk =
  | TextChunkDelta
  | ThinkingChunkDelta
  | ToolUseChunkDelta
  | RefusalChunkDelta
  | ImageChunkDelta;

type GuardResult<T> = { ok: true; value: T } | { ok: false; error: FoldError };

/**
 * Parses a `token_delta` frame's `delta` into its tagged chunk shape.
 * `chunk_type` has NO schema backing at all (unlike the outer `kind`), so
 * this switch is runtime-only — an unrecognized `chunk_type` (a genuinely
 * new chunk variant, not just a malformed one) gets its own reason so a
 * caller can tell "the wire sent something never-before-seen" apart from
 * "the wire sent a known kind with a broken payload".
 *
 * All FIVE variants of harness's sealed chunk union are here — text, thinking,
 * tool_use, refusal and image (`pkg/serve/ephemeral.go`'s `encodeChunkDelta`).
 * The version inherited from `client/sdk/core` knew only the first three, so a
 * streamed refusal came back as an `unknown_chunk_type` fold error and its text
 * appeared only later via the `StepDone` snap: a user watching a refusal stream
 * saw an error, then the text. A frame the transport legitimately emits must
 * never surface as an error notice, which is why the last two are parsed even
 * though only one of them opens a row.
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
    case "refusal":
      if (typeof delta["text"] !== "string") {
        return { ok: false, error: new FoldError("malformed_delta", 'token_delta "refusal" chunk is missing a string "text" field') };
      }
      return { ok: true, value: { chunkType: "refusal", text: delta["text"] } };
    case "image": {
      // `index` is the ONLY field imageChunkDTO does not tag omitempty, so it
      // is always on the wire, and it is the one a fragment cannot be placed
      // without. media_type/url/data are legitimately absent.
      const index = delta["index"];
      if (typeof index !== "number") {
        return { ok: false, error: new FoldError("malformed_delta", 'token_delta "image" chunk is missing a numeric "index" field') };
      }
      return {
        ok: true,
        value: {
          chunkType: "image",
          index,
          mediaType: optionalString(delta["media_type"]) ?? "",
          url: optionalString(delta["url"]) ?? "",
          data: optionalString(delta["data"]) ?? "",
        },
      };
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

/**
 * Finds the index of an existing `ToolCallCard` sharing `toolExecutionId`,
 * regardless of that card's current `status` — shared by both
 * `tool_call_started` and `tool_call_completed` so pairing is symmetric (see
 * the `ToolCallCard` doc comment). Returns -1 (always append a new card,
 * never merge) when the id is absent, matching the pre-existing behavior for
 * frames that carry no `tool_execution_id` at all.
 */
function findToolCallCardIndex(view: SessionView, toolExecutionId: string | undefined): number {
  if (toolExecutionId === undefined) return -1;
  return view.toolCalls.findIndex((c) => c.toolExecutionId === toolExecutionId);
}

// --- The legacy toolCalls bucket ------------------------------------------------

/**
 * Folds a `tool_call_started` frame into the legacy `toolCalls` bucket. Lifted
 * verbatim out of `foldEphemeral` so the case can drive both the bucket and the
 * row; nothing about the bucket's behaviour changed (test/fold.test.ts pins it).
 */
function foldToolCallStartedCard(
  view: SessionView,
  header: EventHeader | undefined,
  toolExecutionId: string | undefined,
  toolName: string | undefined,
  summary: string | undefined,
): SessionView {
  const matchIndex = findToolCallCardIndex(view, toolExecutionId);
  if (matchIndex === -1) {
    const card: ToolCallCard = {
      toolExecutionId,
      status: "started",
      toolName,
      summary,
      isError: undefined,
      resultPreview: undefined,
      startedHeader: header,
      completedHeader: undefined,
    };
    view.toolCalls.push(card);
    return { ...view };
  }

  // A card for this id already exists (see the ToolCallCard doc comment for why
  // this branch exists at all): merge the started-only fields rather than
  // appending a second card. `status` is intentionally NOT reset to "started" —
  // if the existing card is already "completed" (the completed frame arrived
  // first), that is the more advanced state and must not regress.
  const toolCalls = [...view.toolCalls];
  const prior = toolCalls[matchIndex]!;
  toolCalls[matchIndex] = { ...prior, toolName, summary, startedHeader: header };
  return { ...view, toolCalls };
}

/** Folds a `tool_call_completed` frame into the legacy `toolCalls` bucket. */
function foldToolCallCompletedCard(
  view: SessionView,
  header: EventHeader | undefined,
  toolExecutionId: string | undefined,
  isError: boolean | undefined,
  resultPreview: string | undefined,
): SessionView {
  const matchIndex = findToolCallCardIndex(view, toolExecutionId);
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
    view.toolCalls.push(card);
    return { ...view };
  }

  const toolCalls = [...view.toolCalls];
  const prior = toolCalls[matchIndex]!;
  toolCalls[matchIndex] = { ...prior, status: "completed", isError, resultPreview, completedHeader: header };
  return { ...view, toolCalls };
}

// --- The live segment (design §3b rule 3) ---------------------------------------

/**
 * The loop's live assistant row: the in-flight turn's provisional prose. There
 * is at most ONE per loop, and it is DISCARDED WHOLESALE at that loop's
 * StepDone (the snap) or committed at a turn terminal.
 *
 * The row is only EXTENDABLE while it is the loop's LAST row. Once a tool row
 * lands after it the prose row is closed, and the next delta opens a new one —
 * which is exactly the "text -> tool call -> text within a turn" interleaving
 * that the separate `content`/`toolCalls` buckets cannot express (§3c).
 *
 * That wholesale replacement is what makes the absent `step_id` irrelevant.
 * harness's `stampStepID` stamps `StepID` on exactly five event types and
 * `TokenDelta` is not one of them — `stampLoopHeader` fills a TokenDelta header
 * turn-scoped, so a delta carries session/loop/turn and no step. A delta
 * therefore cannot be grouped by step; it does not need to be, because it
 * always belongs to its loop's CURRENT in-flight step, and the enduring commit
 * replaces the accumulation rather than merging with it. Deduplication needs no
 * shared key at all.
 */
function liveAssistantIndex(view: SessionView, loopId: string): number {
  for (let i = view.rows.length - 1; i >= 0; i--) {
    const row = view.rows[i]!;
    if (row.loopId !== loopId) continue;
    return row.live && row.kind === "assistant" ? i : -1;
  }
  return -1;
}

/**
 * The live tool row for `toolExecutionId` within `loopId`, whatever its current
 * status — matching is symmetric and id-based, so a completed frame arriving
 * BEFORE its started counterpart still merges rather than orphaning a second
 * card (fold.ts's ToolCallCard doc records both real orders). An absent id never
 * matches: two id-less frames are unrelated calls, and collapsing them into one
 * card is worse than showing two.
 *
 * The loop is part of the key: two loops running the same tool are two cards,
 * and `handlers_events.go` subscribes `LoopScope{All: true}` so both streams
 * arrive here interleaved.
 */
function liveToolIndex(view: SessionView, loopId: string, toolExecutionId: string): number {
  if (toolExecutionId === "") return -1;
  return view.rows.findIndex(
    (r) => r.live && r.kind === "tool" && r.loopId === loopId && r.toolExecutionId === toolExecutionId,
  );
}

/**
 * Replaces the row at `index` with `next`. COPY-ON-WRITE: the row object is
 * REPLACED, never mutated, so a `useSyncExternalStore` per-row selector
 * comparing with `Object.is` actually re-renders. Mutating in place would leave
 * the row identity unchanged and the update would never reach the screen. See
 * rows.ts's module comment, and test/rows.test.ts's Object.freeze guard, which
 * catches even a write-through that preserves the value.
 */
function replaceRow(view: SessionView, index: number, next: TranscriptRow): SessionView {
  const rows = [...view.rows];
  rows[index] = next;
  return { ...view, rows };
}

/** The producing loop of an ephemeral frame; "" for a session-scoped frame. */
function frameLoopId(header: EventHeader | undefined): string {
  return header?.loop_id ?? "";
}

/**
 * The producing turn of an ephemeral frame; "" when the frame carries none.
 * Every frame the live segment folds is turn-scoped on the wire
 * (`fillTurnScoped` stamps TokenDelta, ToolCallStarted and ToolCallCompleted
 * with the loop's active TurnID), so this is normally populated — it is what
 * lets a turn terminal commit a live row that already knows its turn.
 */
function frameTurnId(header: EventHeader | undefined): string {
  return header?.turn_id ?? "";
}

/**
 * Folds one streamed chunk into the loop's live assistant segment, creating the
 * segment when the loop has none.
 *
 * TWO of the five chunk types are deliberately skipped. Both still reach
 * `view.content`, and neither burns an ordinal:
 *
 *  - `tool_use` is the model's in-progress tool-call CONSTRUCTION
 *    (index/id/name/partial JSON — harness's `toolUseChunkDTO`), not an
 *    execution, and it has no committable display form. The
 *    `tool_call_started`/`tool_call_completed` frames drive the live tool card.
 *  - `image` is a per-image FRAGMENT whose reassembly this layer does not do
 *    and has nowhere to put: no row variant carries an image, and the enduring
 *    `StepDone` commits the finished ImageBlock regardless. Skipping it is not
 *    the same as rejecting it — rejecting it turned a legitimate frame into a
 *    fold error, which is the bug this arm exists to not have.
 *
 * A refusal accumulates into `refusal`, never `text`. A RefusalBlock's payload
 * is byte-identical to a TextBlock's, so folding one into the other would show
 * a viewer the model answering a request it declined — the same reason harness
 * gives the chunk its own `chunk_type`.
 *
 * An extending chunk keeps the segment's `ordinal` (its stable render key) and
 * the `turnId` it opened with.
 */
function applyLiveChunk(view: SessionView, header: EventHeader | undefined, chunk: TokenDeltaChunk): SessionView {
  if (chunk.chunkType === "tool_use" || chunk.chunkType === "image") return view;
  const loopId = frameLoopId(header);
  const index = liveAssistantIndex(view, loopId);
  if (index === -1) {
    return appendRow(view, {
      kind: "assistant",
      loopId,
      turnId: frameTurnId(header),
      journalSeq: undefined,
      live: true,
      orphanedLoop: isOrphanLoop(view, loopId),
      thinking: chunk.chunkType === "thinking" ? chunk.thinking : "",
      text: chunk.chunkType === "text" ? chunk.text : "",
      refusal: chunk.chunkType === "refusal" ? chunk.text : "",
      // Never true on a live row, and not a placeholder: harness's ephemeral
      // thinkingChunkDTO is {chunk_type, thinking} — provider state is not on
      // the streaming wire at all — so redaction is only ever learned at the
      // enduring commit, where the StepDone snap replaces this row anyway.
      redactedThinking: false,
    });
  }
  const prior = view.rows[index] as AssistantRow;
  let next: AssistantRow;
  if (chunk.chunkType === "thinking") {
    next = { ...prior, thinking: prior.thinking + chunk.thinking };
  } else if (chunk.chunkType === "refusal") {
    next = { ...prior, refusal: prior.refusal + chunk.text };
  } else {
    next = { ...prior, text: prior.text + chunk.text };
  }
  return replaceRow(view, index, next);
}

// --- Ephemeral fold -----------------------------------------------------------

/**
 * Folds one `EphemeralFrame` into `view`, exhaustively over all five `kind`s.
 * See the module comment for the compile-time-vs-runtime exhaustiveness
 * split: `frame.kind`'s switch is compile-time guarded (a `never`-typed
 * default case); the shape checks inside each case are runtime-only.
 */
function foldEphemeral(input: SessionView, frame: EphemeralFrame): FoldResult {
  const header = frame.header;
  const delta = frame.delta;
  // Register the producing loop BEFORE any case can append a row for it, so an
  // unobserved loop's live rows are tagged orphaned rather than dropped. This
  // is copy-on-write and only ever fires once per loop.
  const view = ensureLoop(input, frameLoopId(header));

  switch (frame.kind) {
    case "token_delta": {
      const parsed = parseTokenDeltaChunk(delta);
      if (!parsed.ok) return parsed;
      const entry: ContentDelta = { ...parsed.value, header };
      // In place, and only AFTER the parse succeeded -- a failed fold must
      // append nothing (see appendRow).
      view.content.push(entry);
      const withContent: SessionView = { ...view };
      return { ok: true, view: applyLiveChunk(withContent, header, parsed.value) };
    }

    case "tool_call_started": {
      const toolExecutionId = optionalString(delta?.["tool_execution_id"]);
      const toolName = optionalString(delta?.["tool_name"]);
      const summary = optionalString(delta?.["summary"]);
      const withCard = foldToolCallStartedCard(view, header, toolExecutionId, toolName, summary);

      const loopId = frameLoopId(header);
      const index = liveToolIndex(withCard, loopId, toolExecutionId ?? "");
      if (index === -1) {
        return {
          ok: true,
          view: appendRow(withCard, {
            kind: "tool",
            loopId,
            turnId: frameTurnId(header),
            journalSeq: undefined,
            live: true,
            orphanedLoop: isOrphanLoop(withCard, loopId),
            toolUseId: "",
            toolExecutionId: toolExecutionId ?? "",
            toolName: toolName ?? "",
            summary: summary ?? "",
            status: "running",
            result: "",
            spawnedLoopId: "",
          }),
        };
      }
      // Merge the started-only fields. `status` is deliberately NOT reset:
      // completion is the more advanced state and must not regress, and a
      // duplicate start that omits a field must not blank it.
      const prior = withCard.rows[index] as ToolRow;
      return {
        ok: true,
        view: replaceRow(withCard, index, {
          ...prior,
          toolName: toolName ?? prior.toolName,
          summary: summary ?? prior.summary,
        }),
      };
    }

    case "tool_call_completed": {
      const toolExecutionId = optionalString(delta?.["tool_execution_id"]);
      const isError = optionalBoolean(delta?.["is_error"]);
      const resultPreview = optionalString(delta?.["result_preview"]);
      const withCard = foldToolCallCompletedCard(view, header, toolExecutionId, isError, resultPreview);

      const loopId = frameLoopId(header);
      // `is_error` is `omitzero` on the wire, so a SUCCESSFUL completion carries
      // no flag at all: "ok" is the absence of the key, never `false`.
      const status: ToolRowStatus = isError === true ? "error" : "ok";
      const index = liveToolIndex(withCard, loopId, toolExecutionId ?? "");
      if (index === -1) {
        return {
          ok: true,
          view: appendRow(withCard, {
            kind: "tool",
            loopId,
            turnId: frameTurnId(header),
            journalSeq: undefined,
            live: true,
            orphanedLoop: isOrphanLoop(withCard, loopId),
            toolUseId: "",
            toolExecutionId: toolExecutionId ?? "",
            toolName: "",
            summary: "",
            status,
            result: resultPreview ?? "",
            spawnedLoopId: "",
          }),
        };
      }
      const prior = withCard.rows[index] as ToolRow;
      return {
        ok: true,
        view: replaceRow(withCard, index, { ...prior, status, result: resultPreview ?? prior.result }),
      };
    }

    case "input_queued": {
      const marker: QueuedInputMarker = { header };
      view.queuedInputs.push(marker);
      return { ok: true, view: { ...view } };
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
      // After both shape checks: a rejected frame appends nothing.
      view.compactions.push(marker);
      return { ok: true, view: { ...view } };
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
  // Appended IN PLACE (design §3c). This runs on EVERY enduring event including
  // the whole cold journal replay, so spreading the array here was O(M^2)
  // before first paint -- the dominant cost on the "open a session that already
  // ran" path. See appendRow for the full carve-out and what still holds.
  view.statusEvents.push(marker);
  // Register the producing loop next to the marker: a loop first seen through
  // an ordinary event is recorded UNOBSERVED, which is what keeps its rows and
  // tags them rather than dropping them when its LoopStarted never arrives.
  const next: SessionView = ensureLoop({ ...view }, envelope.loop_id ?? "");

  // Kind-specific cases alongside the generic fallback — this module's own
  // documented extension point (see the "Gates are NOT folded here" section
  // above, which this supersedes now that enduring.ts decodes the payloads).
  // The marker above is RETAINED for the long tail and for any consumer already
  // reading statusEvents, so nothing regresses.
  const decoded = decodeEnduring(envelope);
  switch (decoded.payload.kind) {
    // One case for both openers: decodePayload already gives them the same
    // TurnOpenerPayload shape, and §3b treats them identically — TurnFoldedInto
    // is queued input folded into a mandatory tool-continuation, which is still
    // the user's input and still subject to the same cause gate.
    case "TurnStarted":
    case "TurnFoldedInto": {
      // §3b rule 2: a user row ONLY when Header.Cause.LoopID is zero. A
      // NON-ZERO cause loop id is a subagent hand-back — handlers_events.go
      // subscribes LoopScope{All: true}, so a parent loop sees every child's
      // frames, and a hand-back arrives as a turn opener on the PARENT loop
      // whose cause loop id is the CHILD's. Committing a row for it renders a
      // phantom user message on every hand-back.
      //
      // isZeroUUID, never `cause?.loop_id === undefined`: production OMITS a
      // zero id, but harness's fixture normaliser REPLACES ids, so the
      // all-zeros spelling is equally real wire. Both must gate identically.
      //
      // The ACKNOWLEDGEMENT is recorded before that gate, not inside it: the
      // turn started whether or not this event commits a user row, and a
      // pending row left behind a hand-back (or behind an opener carrying no
      // message) would dangle live forever.
      const resolved = resolveCommand(next, decoded.causeCommandId, "started");
      const message = decoded.payload.message;
      if (!isZeroUUID(decoded.causeLoopId) || message === undefined) {
        return { ok: true, view: resolved };
      }
      const framed = frameOf(message.blocks, decoded.payload.input);
      const principal = decoded.payload.input?.principal;
      return {
        ok: true,
        view: appendRow(resolved, {
          kind: "user",
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(resolved, decoded.loopId),
          blocks: framed.blocks,
          ...(framed.frame === undefined ? {} : { frame: framed.frame }),
          ...(principal === undefined ? {} : { principal }),
        }),
      };
    }
    case "StepDone": {
      // SNAP. The enduring commit replaces the ephemeral accumulation
      // WHOLESALE, which is why a delta needs no step_id: it always belongs to
      // its loop's CURRENT in-flight step, so deduplication needs no shared key
      // at all. It is also the repair for an outage — ephemeral frames carry no
      // journal_seq and are never persisted, so the deltas emitted while a
      // client was disconnected are simply gone, and this is what restores the
      // step's prose from the durable record.
      //
      // The discard happens even when the group commits nothing, which the
      // durable boundary cannot actually produce (validateStepDoneMessages
      // rejects an empty Messages): the segment belonged to a step that has
      // ended, and keeping it would dangle it into the next one.
      const snapped = dropLiveRows(next, decoded.loopId);
      const { assistant, results } = splitStepGroup(decoded.payload.messages);
      if (assistant === undefined) return { ok: true, view: snapped };
      const thinking = thinkingOf(assistant.blocks);
      const text = narrationOf(assistant.blocks);
      const refusal = refusalOf(assistant.blocks);
      const redactedThinking = redactedThinkingOf(assistant.blocks);
      let out = snapped;
      // A pure-tool step commits NO assistant row: its tool cards stand alone.
      // A truncated step is NOT special here — its notice is an ordinary text
      // block with no distinguishing tag, so it commits as narration and the
      // turn TERMINAL is what tells a truncated group from a clean one.
      //
      // `redactedThinking` is a fourth reason to commit, not a decoration on
      // the other three: a redacted block projects thinking === "" and matched
      // every one of them, so a step whose ONLY content was withheld reasoning
      // used to commit nothing at all and the turn rendered with a hole in it.
      if (thinking !== "" || text !== "" || refusal !== "" || redactedThinking) {
        out = appendRow(out, {
          kind: "assistant",
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(out, decoded.loopId),
          thinking,
          text,
          refusal,
          redactedThinking,
        });
      }
      // Block order, paired by ToolUseID. The step shape is one AIMessage
      // followed by its ToolResultMessages, so the pairing key is the block's ID
      // against ToolResultMessage.ToolUseID — NOT the ephemeral
      // tool_execution_id, which never reaches the journal, and NOT the results'
      // own order, which is the order they completed in. The prose row is
      // committed first however late in the block order its text sits: the
      // narration introduces the calls it accompanies.
      for (const use of toolUsesOf(assistant)) {
        const result = results.get(use.id);
        const capture = decoded.payload.captures?.get(use.id);
        out = appendRow(out, {
          kind: "tool",
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(out, decoded.loopId),
          toolUseId: use.id,
          toolExecutionId: "",
          toolName: use.name,
          // Derived, not carried: the enduring record has no Summary field (it
          // is the EPHEMERAL ToolCallStarted that carries one), so a replayed
          // card would otherwise show a name and a result and nothing about
          // what the call was for. tui's storedStepToolCard derives it the same
          // way, from the same input, so the two transcripts agree — and the
          // derivation redacts, which is why this is not ToolRow.input.
          summary: toolUseSummary(use.name, use.input),
          // A missing result is a call whose outcome the group does not carry;
          // "ok" matches tui's storedStepToolCard rather than inventing an error.
          status: result?.isError === true ? "error" : "ok",
          result: toolResultText(result),
          ...(capture === undefined ? {} : { capture }),
          // The child normally announced itself BEFORE this step was finalized —
          // a subagent runs to completion inside the call that spawned it — so
          // the anchor is usually known here. The reverse order (a LoopStarted
          // arriving after the parent's step) is stamped by the LoopStarted case.
          spawnedLoopId: childLoopFor(out, decoded.loopId, use.id),
        });
      }
      return { ok: true, view: out };
    }
    case "TurnDone":
      // Defensive, and only defensive: every completed step already committed
      // through its own StepDone. What survives here is a step that decoded
      // nothing usable and so emitted no StepDone at all. A still-running card
      // at a SUCCESSFUL terminal resolves "ok" — the step finalized.
      return {
        ok: true,
        view: commitTerminalSegment(next, decoded.loopId, journalSeq, "ok"),
      };
    case "TurnInterrupted": {
      // Order: the partial work stays VISIBLE and the tombstone marks where it
      // stopped. A still-running card is CANCELLED, not ok — the interrupt is
      // exactly what stopped it.
      //
      // Swapping these two STATEMENTS is currently an equivalent mutation, and
      // deliberately so: commitLiveRows REPLACES each live row in place, so the
      // segment's positions and ordinals are already fixed before the tombstone
      // is appended. The order is written and asserted anyway because it stops
      // being equivalent the moment anyone commits by re-appending instead of
      // replacing, which is the implementation the transcript would actually
      // render wrong (tombstone above the work it terminates).
      const committed = commitTerminalSegment(next, decoded.loopId, journalSeq, "cancelled");
      return {
        ok: true,
        view: appendRow(committed, {
          kind: "tombstone",
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(committed, decoded.loopId),
          ...(decoded.payload.principal === undefined ? {} : { principal: decoded.payload.principal }),
        }),
      };
    }
    case "TurnRejected": {
      // A rejected submit must never silently vanish. The optimistic row goes,
      // so something has to say why it went — and an error NOTICE, not a user
      // row, is what says it, which is exactly why commandOutcomes exists: a
      // consumer scanning `rows` for its command id would find nothing here.
      //
      // `turnId` is always "": MarshalEvent REFUSES a TurnRejected carrying a
      // non-zero TurnID ("event: invalid TurnRejected: TurnID must be zero"),
      // because the rejection is a reply to a submit that never opened a turn.
      // It is projected from the header anyway rather than hardcoded, so the
      // notice keeps saying what the envelope said.
      const resolved = resolveCommand(next, decoded.causeCommandId, "rejected");
      return {
        ok: true,
        view: appendRow(resolved, {
          kind: "notice",
          level: "error",
          text: `input rejected: ${decoded.payload.reasonText}`,
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(resolved, decoded.loopId),
        }),
      };
    }
    case "InputCancelled":
      // A client retract, or a queued input returned after an abnormal turn
      // end. It never entered history, so it commits NO row — but the
      // affordance still has to go, and the outcome still has to be observable,
      // which is the other half of what commandOutcomes is for.
      return { ok: true, view: resolveCommand(next, decoded.causeCommandId, "cancelled") };
    case "TurnFailed": {
      // A truncated step commits its safe prefix through its own StepDone — and
      // that StepDone's notice is an ordinary TextBlock with no distinguishing
      // tag, so it commits as plain narration. THIS event is what tells a
      // truncated group from a clean one. A step that decoded nothing usable
      // emitted no StepDone at all, so its live segment is committed here,
      // before the notice, with a still-running card resolved to "error".
      const committed = commitTerminalSegment(next, decoded.loopId, journalSeq, "error");
      // The failure reason IS on the wire. TurnFailed.Err is tagged json:"-",
      // but marshalTurnFailed marshals turnFailedWire, which projects Err
      // through projectError onto {kind,message} — neither key omitempty, and
      // projectError(nil) yields {"unknown",""} rather than nil. Rendering no
      // reason would be this layer discarding what harness took care to keep.
      const reason = turnFailureText(decoded.payload.errorKind, decoded.payload.errorMessage);
      return {
        ok: true,
        view: appendRow(committed, {
          kind: "notice",
          level: "error",
          text: reason,
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(committed, decoded.loopId),
        }),
      };
    }
    case "LoopStarted": {
      // The durable loop-tree record, and the ONLY place `observed` becomes
      // true. The parent is read from `cause`, never from the promoted
      // `loop_id` (which is the NEW loop) — LoopStarted's identity profile
      // forbids a promoted turn or step for exactly that reason. A zero cause
      // loop id means ROOT, and it is normalised to "" through isZeroUUID
      // rather than compared to undefined: harness's fixture normaliser spells
      // the zero out, and reading "000…0" as a parent would root the tree at a
      // loop that never existed.
      const loops = new Map(next.loops);
      loops.set(decoded.loopId, {
        loopId: decoded.loopId,
        parentLoopId: isZeroUUID(decoded.causeLoopId) ? "" : decoded.causeLoopId,
        parentToolUseId: decoded.payload.parentToolUseId,
        // DisplayName when non-empty, else the header's AgentName — the same
        // fallback tui's loopStartedLabel applies for older journals.
        label: decoded.payload.displayName !== "" ? decoded.payload.displayName : decoded.agentName,
        observed: true,
      });
      const rows = relinkLoop(next.rows, decoded.loopId, {
        parentLoopId: isZeroUUID(decoded.causeLoopId) ? "" : decoded.causeLoopId,
        parentToolUseId: decoded.payload.parentToolUseId,
      });
      return { ok: true, view: { ...next, loops, rows } };
    }
    case "GateOpened": {
      // Copy-on-write, like every other branch here: fold() must never mutate
      // the view it was handed (test/fold-immutability.test.ts pins that, and
      // join.ts yields the prior view on a failed fold).
      const gates = new Map(view.gates);
      gates.set(decoded.payload.gate.id, decoded.payload.gate);
      return { ok: true, view: { ...next, gates } };
    }
    case "GateResolved": {
      const answeredBy = decoded.payload.principal;
      const withNotice = answeredBy === undefined ? next : appendRow(next, {
        kind: "notice",
        level: "info",
        text: `gate ${decoded.payload.action === "" ? "closed" : decoded.payload.action} by ${principalLabel(answeredBy)}`,
        loopId: decoded.loopId,
        turnId: decoded.turnId,
        journalSeq,
        live: false,
        orphanedLoop: isOrphanLoop(next, decoded.loopId),
        principal: answeredBy,
      });
      // A close for a gate this view never opened (a mid-stream join) removes
      // nothing and copies nothing — it is not an error.
      if (!view.gates.has(decoded.payload.gateId)) return { ok: true, view: withNotice };
      const gates = new Map(view.gates);
      gates.delete(decoded.payload.gateId);
      return { ok: true, view: { ...withNotice, gates } };
    }
    default:
      return { ok: true, view: next };
  }
}

/**
 * True for a row that belongs to `loopId`'s in-flight LIVE SEGMENT — the thing a
 * StepDone snaps and a turn terminal commits.
 *
 * A live USER row is deliberately excluded. The only live user row is an
 * optimistic pending row, which is per-tab, belongs to no loop (its `loopId` is
 * "", the same value a session-scoped frame folds under) and is resolved by
 * command id and by nothing else. Without this exclusion, any snap or terminal
 * that happened to carry no loop id would stamp the composer's unsent text into
 * the transcript as though the server had accepted it, or discard it silently.
 */
function isLiveSegmentRow(row: TranscriptRow, loopId: string): boolean {
  return row.live && row.loopId === loopId && row.kind !== "user";
}

/**
 * Drops every live row belonging to `loopId`, leaving other loops untouched —
 * the discard half of the StepDone snap. Rows that survive are carried over BY
 * REFERENCE, so a per-row Object.is selector does not re-render them, and a
 * loop with nothing live returns the very same view.
 */
function dropLiveRows(view: SessionView, loopId: string): SessionView {
  if (!view.rows.some((r) => isLiveSegmentRow(r, loopId))) return view;
  return { ...view, rows: view.rows.filter((r) => !isLiveSegmentRow(r, loopId)) };
}

/**
 * True for a live assistant row of `loopId` that carries no prose at all.
 *
 * `applyLiveChunk` opens a segment on the FIRST chunk it sees whatever that
 * chunk's length, so a zero-length delta leaves an empty row behind; committing
 * it would put a blank assistant bubble in the transcript. All three prose
 * fields are checked, not just `text` — a refusal-only segment is not empty,
 * and dropping it would erase a declined turn entirely (`refusalOf`'s doc
 * comment in rows.ts is the same argument one layer up).
 */
function isEmptyLiveProse(row: TranscriptRow, loopId: string): boolean {
  return (
    row.live &&
    row.loopId === loopId &&
    row.kind === "assistant" &&
    row.thinking === "" &&
    row.text === "" &&
    row.refusal === ""
  );
}

/**
 * Discards `loopId`'s live prose row when it accumulated nothing. Called by
 * every terminal BEFORE `commitLiveRows`, so "commit any NON-EMPTY live
 * segment" (§3b rule 2) is literally what happens.
 */
function dropEmptyLiveProse(view: SessionView, loopId: string): SessionView {
  if (!view.rows.some((r) => isEmptyLiveProse(r, loopId))) return view;
  return { ...view, rows: view.rows.filter((r) => !isEmptyLiveProse(r, loopId)) };
}

/**
 * Commits every live row of `loopId` in place of discarding it: each row is
 * REPLACED (copy-on-write) with `live: false` and the terminal's `journalSeq`,
 * keeping its ordinal and its position, so a per-row `Object.is` selector sees
 * the transition and the transcript's order is unchanged.
 *
 * This is §3b rule 2's "every turn terminal first commits any non-empty live
 * segment, then resets it". It matters because a step that decoded nothing
 * usable emits NO `StepDone` at all — harness's `MarshalEvent` refuses a
 * `StepDone` with empty `Messages` — and `StepDone` is the only other place a
 * live segment is snapped. Without this, an abnormal terminal would silently
 * discard the partial work and dangle the segment into the next turn.
 *
 * `resolveRunning` decides what a still-RUNNING tool card becomes: `"ok"` at a
 * successful terminal (the step finalized — tui's `stepToolCard` applies the
 * same rule), `"cancelled"` on an interrupt, `"error"` on a failure. A card
 * that already resolved keeps its own status: blanket-assigning would rewrite a
 * real tool failure as a success.
 */
function commitLiveRows(
  view: SessionView,
  loopId: string,
  journalSeq: number | undefined,
  resolveRunning: ToolRowStatus,
): SessionView {
  if (!view.rows.some((r) => isLiveSegmentRow(r, loopId))) return view;
  const rows = view.rows.map((row): TranscriptRow => {
    if (!isLiveSegmentRow(row, loopId)) return row;
    if (row.kind === "tool") {
      return {
        ...row,
        live: false,
        journalSeq,
        status: row.status === "running" ? resolveRunning : row.status,
      };
    }
    return { ...row, live: false, journalSeq };
  });
  return { ...view, rows };
}

/**
 * The shared terminal prologue: drop an empty live prose row, then commit every
 * remaining live row of the loop. Every turn terminal calls this FIRST, before
 * appending anything of its own — a tombstone or an error notice appended
 * before the partial work would read as work done after the turn ended.
 */
function commitTerminalSegment(
  view: SessionView,
  loopId: string,
  journalSeq: number | undefined,
  resolveRunning: ToolRowStatus,
): SessionView {
  return commitLiveRows(dropEmptyLiveProse(view, loopId), loopId, journalSeq, resolveRunning);
}

/**
 * Registers `loopId` in the loop tree if it is not there yet, as UNOBSERVED —
 * "this loop exists and we have no LoopStarted for it". Called before anything
 * that could append a row for a loop, so `isOrphanLoop` below has an entry to
 * read and an orphan's rows are kept and TAGGED rather than dropped.
 *
 * A ZERO loop id is never registered — neither the absent spelling "" nor the
 * all-zeros one harness's fixture normaliser produces. Both mean "no loop": ""
 * is what a session-scoped frame and an optimistic pending row carry, and
 * registering "000…0" would invent a loop that never ran. isZeroUUID, not
 * `=== ""`, for the same reason §3b's cause gate uses it.
 *
 * Copy-on-write, and a loop already known returns the very same view, so this
 * costs one Map copy per loop for the whole session.
 */
function ensureLoop(view: SessionView, loopId: string): SessionView {
  if (isZeroUUID(loopId) || view.loops.has(loopId)) return view;
  const loops = new Map(view.loops);
  loops.set(loopId, { loopId, parentLoopId: "", parentToolUseId: "", label: "", observed: false });
  return { ...view, loops };
}

/**
 * True when `loopId` names a loop whose `LoopStarted` has not been seen — the
 * value every row appended for that loop carries as `orphanedLoop`. "" (a
 * session-scoped row) is never orphaned: it belongs to no loop, so there is no
 * missing record.
 */
function isOrphanLoop(view: SessionView, loopId: string): boolean {
  return view.loops.get(loopId)?.observed === false;
}

/**
 * The child loop `toolUseId` spawned from `parentLoopId`, or "" if none is
 * known yet. Read at StepDone-commit time so a tool row lands with its
 * `spawnedLoopId` already set — the ordinary order, because a subagent runs to
 * completion (and so announces itself) before the parent step containing its
 * call is finalized. The reverse order is handled by the LoopStarted case,
 * which stamps the anchor onto an already-committed row.
 */
function childLoopFor(view: SessionView, parentLoopId: string, toolUseId: string): string {
  if (toolUseId === "") return "";
  for (const info of view.loops.values()) {
    if (info.observed && info.parentLoopId === parentLoopId && info.parentToolUseId === toolUseId) {
      return info.loopId;
    }
  }
  return "";
}

/**
 * Applies a newly-observed `LoopStarted` to rows that were already committed
 * before it arrived — the trimmed-page order, where the child's work is on the
 * page but the record naming its parent is not.
 *
 * Two edits, one pass:
 *  - every row of `loopId` loses its `orphanedLoop` marker, because the loop is
 *    no longer missing a record;
 *  - the parent's tool row carrying `parentToolUseId` gains `spawnedLoopId`, so
 *    a renderer can nest the child's block under the card that spawned it.
 *
 * Rows that need neither are carried over BY REFERENCE and the array itself is
 * handed straight back when nothing changed, so a per-row `Object.is` selector
 * does not re-render the whole transcript on every loop announcement.
 */
function relinkLoop(
  rows: TranscriptRow[],
  loopId: string,
  parent: { parentLoopId: string; parentToolUseId: string },
): TranscriptRow[] {
  const unOrphans = (row: TranscriptRow): boolean => row.loopId === loopId && row.orphanedLoop;
  const anchors = (row: TranscriptRow): boolean =>
    row.kind === "tool" &&
    parent.parentToolUseId !== "" &&
    row.loopId === parent.parentLoopId &&
    row.toolUseId === parent.parentToolUseId &&
    row.spawnedLoopId !== loopId;
  if (!rows.some((row) => unOrphans(row) || anchors(row))) return rows;
  return rows.map((row): TranscriptRow => {
    // An anchor row belongs to the PARENT loop and an un-orphaned row to the
    // child, so the two never describe the same row; they are still applied in
    // one pass so a row is rebuilt at most once.
    if (row.kind === "tool" && anchors(row)) return { ...row, spawnedLoopId: loopId };
    if (unOrphans(row)) return { ...row, orphanedLoop: false };
    return row;
  });
}

/**
 * Appends `draft` to `view.rows` IN PLACE, allocating its ordinal here so no
 * caller can pick one.
 *
 * ## The one place fold writes through its input, and why it is safe
 *
 * Design §3c: "The outer array may be appended in place." Copying it per event
 * made a cold journal replay O(M^2) before first paint, which is the exact path
 * the row projection exists to serve. It is safe because NOTHING holds an older
 * `SessionView` and expects it frozen: `joinSessionView` keeps one reassigned
 * `view` variable, and the only place it hands back a PREVIOUS view is a failed
 * fold -- which appends nothing, so "previous" and "current" are the same value
 * there anyway. No consumer diffs two views.
 *
 * The consequence is real and deliberate: a caller that DOES retain an older
 * view sees the newer rows through it, while that stale object's `nextOrdinal`
 * stays where it was. Retaining a view is therefore not supported; retaining a
 * ROW is, and that is what the per-row selectors actually do.
 *
 * ## What stays copy-on-write, and is asserted
 *
 * - Row OBJECTS. Completing a tool card or extending the live segment builds a
 *   NEW object (`replaceRow`), so a `useSyncExternalStore` per-row selector
 *   comparing with `Object.is` re-renders exactly the row that changed.
 *   test/rows.test.ts freezes committed rows, so even a value-preserving
 *   write-through throws.
 * - The Maps (`gates`, `loops`, `pending`, `commandOutcomes`).
 * - Every NON-append edit: `replaceRow`, `dropLiveRows`, `dropEmptyLiveProse`,
 *   `commitLiveRows` and `resolveCommand` all build a new array. The carve-out
 *   is for APPENDS only, and narrowly so: an append leaves an older view
 *   holding a coherent PREFIX, while a replacement or a removal would rewrite
 *   history it had already shown.
 * - A FAILED fold appends nothing. Every push above happens after the case's
 *   validation, which is what keeps the view `join.ts` yields on error correct.
 */
function appendRow(view: SessionView, draft: TranscriptRowDraft): SessionView {
  const committed = { ...draft, ordinal: view.nextOrdinal };
  view.rows.push(committed);
  return { ...view, nextOrdinal: view.nextOrdinal + 1 };
}

/** Preserve all user content if a corrupt record's presenter counts cannot fit. */
function frameOf(blocks: ContentBlock[], input: MessageInput | undefined): { blocks: ContentBlock[]; frame?: UserFrame } {
  if (input === undefined || (input.prefix === 0 && input.suffix === 0)) return { blocks };
  if (input.prefix + input.suffix > blocks.length) return { blocks };
  return {
    blocks: blocks.slice(input.prefix, blocks.length - input.suffix),
    frame: { prefix: blocks.slice(0, input.prefix), suffix: blocks.slice(blocks.length - input.suffix) },
  };
}

/**
 * Records an optimistic pending user row for a just-submitted input: the blocks
 * the composer sent, filed under the command id `POST /v1/sessions/{sid}/input`
 * returned.
 *
 * This is a caller-driven entry point rather than a fold case because the text
 * is not on the wire to fold: `input_queued` carries no `delta`, so the only
 * copy of what was typed is in the composer that typed it. The row is
 * `live: true` with no loop and no turn — it is not part of any loop's live
 * segment (see `isLiveSegmentRow`) — and is resolved by `fold` on the submit's
 * `TurnStarted` / `TurnFoldedInto` / `TurnRejected` / `InputCancelled`, each of
 * which also records a `commandOutcomes` entry the caller can read.
 */
export function addPendingRow(
  view: SessionView,
  commandId: string,
  blocks: ContentBlock[],
): SessionView {
  const ordinal = view.nextOrdinal;
  const appended = appendRow(view, {
    kind: "user",
    loopId: "",
    turnId: "",
    journalSeq: undefined,
    live: true,
    // Never orphaned: the row belongs to no loop at all (loopId ""), so there
    // is no missing LoopStarted for it to be missing.
    orphanedLoop: false,
    blocks,
  });
  const pending = new Map(appended.pending);
  pending.set(commandId, ordinal);
  return { ...appended, pending };
}

/**
 * Resolves one command id: records `outcome` and removes this tab's pending row
 * for it, if it has one. Copy-on-write in both maps; a view that changes
 * neither is handed straight back, so a per-map selector does not churn.
 *
 * An empty command id records nothing. Not every event carrying a `Cause` has a
 * command behind it, and a "" key would collapse every such event into one
 * entry that no composer could ever match.
 */
function resolveCommand(view: SessionView, commandId: string, outcome: CommandOutcome): SessionView {
  if (commandId === "") return view;
  const commandOutcomes = new Map(view.commandOutcomes);
  commandOutcomes.set(commandId, outcome);
  const ordinal = view.pending.get(commandId);
  if (ordinal === undefined) return { ...view, commandOutcomes };
  const pending = new Map(view.pending);
  pending.delete(commandId);
  return { ...view, commandOutcomes, pending, rows: view.rows.filter((r) => r.ordinal !== ordinal) };
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

// --- The public gate board ---------------------------------------------------

/**
 * ## Why this is not `SessionView.gates`
 *
 * `SessionView.gates` is the per-session LIVE fold: it exists only where a
 * journal replay or an SSE stream exists, and it holds the full runtime
 * `gate.Gate` envelope. The board below answers a different question — what
 * gates are open, across sessions, for a client that has just loaded and has
 * no Host, no live subscription and no journal at all. Its only required source
 * is `GET /v1/sessions/{sid}/gates`, which spec §7 makes a pure durable read.
 *
 * Two consequences follow, and both are why this is a separate structure
 * rather than a second map on `SessionView`:
 *
 *  - it is keyed by `(SessionID, GateID)`, because it spans sessions and a
 *    GateID is only unique within one;
 *  - it holds the REDACTED `PublicGateProjection`, not `Gate`, because the cold
 *    source is `additionalProperties: true` at every level and the only safe
 *    thing to keep is a named allowlist (see gate.ts's
 *    `GATE_PROJECTION_WIRE_FIELDS`).
 *
 * ## Merge rules
 *
 * An entry has three parts, each with its own writer:
 *
 *  - IDENTITY AND OPEN POSITION (`sessionId`, `gateId`, `openedEventId`,
 *    `openedJournalSeq`) are written ONCE, on first observation, and never
 *    rewritten. They are facts about one durable `GateOpened`. Writing them
 *    once is also what makes the public order stable under a duplicate.
 *  - ATTESTED STATE (`deadline`, `answerability`) is written ONLY by a gate
 *    page, last page wins. A live journal event never writes it: an open event
 *    proves presentation and never answerability, so a gate seen only live is
 *    unattested and `acceptsResidentResponse` refuses it.
 *  - PRESENTATION (`kind`, `prompt`) is written by a page, and by a live open
 *    only when the entry is new.
 *
 * A live `GateResolved` removes its own key. A page merge never removes: a gate
 * that resolved while this client was offline stays until its `GateResolved` is
 * folded or the board is rebuilt from `emptyPublicGateBoard()`. That is a
 * stated limitation, pinned by test, not an oversight — a page can be one
 * cursor page of several, so "absent from this page" does not mean "closed".
 */
export interface PublicGateEntry extends PublicGateProjection {
  sessionId: string;
}

/**
 * The open public gates, keyed by `publicGateKey(sessionId, gateId)`.
 *
 * There is deliberately no stored order. `publicGates` sorts on read, so the
 * presentation order is a pure function of the entries and cannot drift from
 * them the way a maintained index can.
 */
export interface PublicGateBoard {
  entries: ReadonlyMap<string, PublicGateEntry>;
}

/**
 * The board key: `(SessionID, GateID)`.
 *
 * LENGTH-PREFIXED, not joined with a separator. Both ids are opaque wire
 * strings (`minLength: 1` and nothing else), so `${sessionId}:${gateId}` maps
 * `("a:b","c")` and `("a","b:c")` to one key — and a collision here silently
 * drops a gate a human still has to answer, which is precisely the failure the
 * pair key exists to prevent.
 */
export function publicGateKey(sessionId: string, gateId: string): string {
  return `${sessionId.length}:${sessionId}:${gateId}`;
}

export function emptyPublicGateBoard(): PublicGateBoard {
  return { entries: new Map() };
}

/**
 * Merges one `GET /v1/sessions/{sid}/gates` page into the board.
 *
 * `sessionId` is a parameter because the page does not carry one: it is
 * addressed by URL, so only the caller knows which session it read. An empty
 * one is a caller error and throws — folding two sessions' pages under `""`
 * would merge them, which is the exact confusion the pair key exists to stop.
 * (A gate EVENT, by contrast, names its own session, so `foldPublicGateEvent`
 * reads it from the envelope and never takes it from a caller.)
 *
 * RETURNS THE IDENTICAL BOARD when the page applies nothing — every record
 * already present and equal, or every record unkeyable, or no records at all.
 * This is not a micro-optimisation, and the sentence is here because it is
 * asserted with `toBe`, not because it reads well. The page path is the one a
 * cold client POLLS, and `packages/react`'s `useStore` requires a selector to
 * return something already in the snapshot, so a consumer derives its list as
 * `useMemo(() => publicGates(board), [board])`. A board rebuilt on every
 * unchanged poll produces a fresh array and re-renders every gate card
 * forever. The live duplicate has the same guarantee for the same reason.
 *
 * ### The in-flight page race, which is NOT handled here
 *
 * A page merge never removes (see `PublicGateBoard`), and the inverse race is
 * real too: a page fetched BEFORE a `GateResolved` but merged AFTER it
 * RESURRECTS the resolved gate, complete with whatever `answerability` the
 * page attested — so `acceptsResidentResponse` can report a closed gate as
 * answerable, and only another `GateResolved` (which will never arrive) or a
 * rebuild removes it. This module cannot fix it: it sees no fetch time and no
 * tip ordering. The poll loop above it must choose — a tombstone keyed by
 * `(SessionID, GateID)` that suppresses a page record older than the observed
 * resolve, or a rebuild from `emptyPublicGateBoard()` per page set. The
 * behaviour is pinned by test so the choice is made deliberately at cutover
 * rather than discovered as a stuck card.
 */
export function foldPublicGatePage(
  board: PublicGateBoard,
  page: PublicGatePage,
  sessionId: string,
): PublicGateBoard {
  if (sessionId === "") {
    throw new RangeError("a public gate page must be folded under the session id it was read for");
  }
  const records: unknown = (page as unknown as Record<string, unknown>)["gates"];
  if (!Array.isArray(records) || records.length === 0) return board;
  const entries = new Map(board.entries);
  let changed = false;
  for (const record of records) {
    const projection = decodeGateProjection(record);
    // Unkeyable. `gate_id` has minLength 1, so this is not real wire; keying it
    // under "" would make two such records overwrite each other.
    if (projection.gateId === "") continue;
    const key = publicGateKey(sessionId, projection.gateId);
    const prior = entries.get(key);
    const entry: PublicGateEntry =
      prior === undefined
        ? { sessionId, ...projection }
        : {
            ...projection,
            sessionId,
            // Identity and open position are written once. Both records
            // describe the same durable GateOpened, so a disagreement is a
            // Factory bug rather than a move; keeping the first keeps the
            // public order stable across a reload.
            openedEventId: prior.openedEventId,
            openedJournalSeq: prior.openedJournalSeq,
          };
    if (prior !== undefined && samePublicGateEntry(prior, entry)) continue;
    changed = true;
    entries.set(key, entry);
  }
  return changed ? { entries } : board;
}

/**
 * Whether a re-merged record would change anything a consumer can observe.
 *
 * Field-by-field rather than a structural walk, because it must be exactly the
 * fields `PublicGateEntry` HAS: a comparator that silently ignored a field
 * added later would make `foldPublicGatePage` swallow a real update, which is
 * the worse direction of the identity guarantee. test/fold-gates.test.ts
 * enumerates every projected leaf name from `GATE_PROJECTION_WIRE_FIELDS` and
 * partitions it into the ones that must change the board and the ones that
 * must not, so this list cannot fall behind the projection.
 *
 * FOUR of the twelve comparisons are UNREACHABLE at the one call site, for two
 * different reasons, and all four are named because declaring SOME dead
 * comparisons implies the rest are live — a partial list is a claim, not a
 * courtesy. Each is an equivalent mutant: removing it survives the suite, and
 * that is the expected result rather than a gap. The other eight are live and
 * each dies on the leaf-partition case.
 *
 *  - `sessionId` and `gateId` are established by the KEY. `prior` is read from
 *    `publicGateKey(sessionId, gateId)`, which is injective, and `b` is built
 *    from those same two values, so two entries under one key agree on both.
 *    They stay because their disagreement is exactly the "entries from
 *    different keys were compared" confusion the pair key exists to stop.
 *  - `openedEventId` and `openedJournalSeq` are established by ASSIGNMENT, more
 *    directly still: in the `prior !== undefined` branch the candidate is
 *    literally built with `openedEventId: prior.openedEventId` and
 *    `openedJournalSeq: prior.openedJournalSeq`, so it cannot differ. They
 *    become LIVE the moment the write-once rule above is dropped, which is
 *    precisely why they should stay — they are the comparator's half of that
 *    rule. test/fold-gates.test.ts's `immutable` partition asserts the FOLD
 *    behaves this way; it cannot reach the comparator, and nothing here
 *    pretends otherwise.
 */
function samePublicGateEntry(a: PublicGateEntry, b: PublicGateEntry): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.gateId === b.gateId &&
    a.kind === b.kind &&
    a.openedEventId === b.openedEventId &&
    a.openedJournalSeq === b.openedJournalSeq &&
    a.deadline === b.deadline &&
    a.answerability === b.answerability &&
    a.prompt.title === b.prompt.title &&
    a.prompt.body === b.prompt.body &&
    a.prompt.origin === b.prompt.origin &&
    a.prompt.controls.length === b.prompt.controls.length &&
    a.prompt.controls.every(
      (control, index) =>
        control.action === b.prompt.controls[index]?.action &&
        control.label === b.prompt.controls[index]?.label,
    )
  );
}

/**
 * Folds one journal item — cold `history` or live `enduring` — into the board.
 * Anything that is not a public gate event returns the SAME board object.
 *
 * The session id is read from the event's own envelope. An event that names no
 * session is IGNORED rather than keyed under `""`, which would merge every
 * unaddressed gate in the process into one bucket.
 */
export function foldPublicGateEvent(board: PublicGateBoard, input: FoldInput): PublicGateBoard {
  // This decodes the envelope a second time when a caller also runs `fold`
  // (measured at ~3% of a 4 000-envelope replay). That is deliberate, not an
  // oversight to collapse later: the second decode is what gives a board entry
  // its OWN `prompt` object rather than one aliasing `SessionView.gates`. The
  // board is copy-on-write and hands entries to a renderer; sharing the object
  // with the live fold would make the two structures mutate together.
  const item = enduringItemOf(input);
  if (item === undefined) return board;
  const sessionId = str((item.envelope as unknown as Record<string, unknown>)["session_id"]);
  if (sessionId === "") return board;
  const decoded = decodeEnduring(item.envelope);
  if (decoded.payload.kind === "GateOpened") {
    const gate = decoded.payload.gate;
    if (gate.id === "") return board;
    const key = publicGateKey(sessionId, gate.id);
    // A duplicate: identity and open position are already written and the
    // attestation is not this source's to touch, so there is nothing to apply.
    // Returning the identical board keeps a subscriber from re-rendering.
    if (board.entries.has(key)) return board;
    const entries = new Map(board.entries);
    entries.set(key, {
      sessionId,
      gateId: gate.id,
      kind: gate.kind,
      prompt: gate.prompt,
      openedEventId: decoded.eventId,
      openedJournalSeq: item.journalSeq,
      // Unattested. An open journal event proves presentation, never that
      // anyone can apply a response.
      deadline: "",
      answerability: "",
    });
    return { entries };
  }
  if (decoded.payload.kind === "GateResolved") {
    const key = publicGateKey(sessionId, decoded.payload.gateId);
    if (!board.entries.has(key)) return board;
    const entries = new Map(board.entries);
    entries.delete(key);
    return { entries };
  }
  return board;
}

/**
 * The board's entries in STABLE PUBLIC ORDER: ascending over the triple
 * `(sessionId, openedJournalSeq, gateId)`.
 *
 * It is a total order — the first and third components are the map key, so no
 * two entries tie on all three — and it is a pure function of the entry set, so
 * it does not depend on arrival order and cannot be stale.
 *
 * Strings are compared by code unit, deliberately NOT with `localeCompare`: an
 * order that varies with the browser's locale is not a stable public order.
 */
export function publicGates(board: PublicGateBoard): PublicGateEntry[] {
  return [...board.entries.values()].sort(comparePublicGates);
}

function comparePublicGates(a: PublicGateEntry, b: PublicGateEntry): number {
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  if (a.openedJournalSeq !== b.openedJournalSeq) return a.openedJournalSeq - b.openedJournalSeq;
  if (a.gateId !== b.gateId) return a.gateId < b.gateId ? -1 : 1;
  return 0;
}

/** The durable envelope and journal sequence of one enduring item, from either segment. */
function enduringItemOf(input: FoldInput): { envelope: EventEnvelope; journalSeq: number } | undefined {
  // `event` is optional on both `status_event.schema.json` and
  // `enduring_frame.schema.json`. An item carrying none names no gate and no
  // session, so there is nothing to fold.
  if (input.segment === "history") {
    const envelope = input.event.event;
    return envelope === undefined ? undefined : { envelope, journalSeq: input.event.journal_seq };
  }
  if (input.frame.type !== "enduring") return undefined;
  const envelope = input.frame.data.event;
  return envelope === undefined ? undefined : { envelope, journalSeq: input.frame.journalSeq };
}
