/**
 * Per-type decoding of the ENDURING event payloads.
 *
 * Before this module, fold.ts folded every enduring envelope into one opaque
 * StatusEventMarker, so opening a session that already ran rendered a blank
 * transcript: the prose lives in StepDone.Messages and TurnDone.Message,
 * inside that payload. fold.ts's own module comment names this as the
 * intended extension point:
 *
 *   "When gate payloads get a real vendored schema, `StatusEventMarker` is the
 *    natural extension point (a `kind`-specific case alongside the generic
 *    fallback, mirroring how `foldEphemeral` is structured), not a redesign."
 *
 * This is that extension. The payload is not opaque ON THE WIRE — MarshalEvent
 * merges the full type-specific payload into the envelope as sibling keys
 * (mergeEnvelope in harness/pkg/event/marshal.go) and the journal replays
 * those bytes verbatim — so these decoders document an existing durable
 * contract rather than inventing one. Per-type JSON Schemas are authored in
 * harness (design §8) and vendored into wui/contract/; the fixtures are
 * validated against them by the contract suite, not here.
 *
 * The long tail (ContextMeasured, hustle and workflow events) is deliberately
 * NOT decoded: it keeps the generic `other` payload, exactly as before.
 */
import type { EventEnvelope } from "./types.js";
import type { SseFrame } from "./sse.js";
import { decodeMessage, decodeMessages, isRecord, str, type ConversationMessage } from "./blocks.js";
import { decodeGate, type Gate } from "./gate.js";
import { toolResultCaptures, type ToolResultCaptureSummary } from "./toolsummary.js";

/** The canonical all-zeros uuid, as `uuid.UUID.String()` renders `[16]byte{}`. */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * True when a wire id means "unset".
 *
 * harness tags every uuid `omitzero` (identity.Coordinates / identity.Cause,
 * and event.Header tags its whole `Cause identity.Cause` field that way too), and
 * uuid.UUID is a `[16]byte` whose zero value is the zero array — so the
 * ORDINARY production encoding of a zero id is an ABSENT KEY, not "000…0".
 *
 * The all-zeros spelling is real anyway. harness's own
 * pkg/serve/fixtures_test.go normalises its golden bodies with a regexp that
 * REPLACES every uuid with the zero uuid, so the fixtures vendored into
 * wui/contract/ carry the key with a spelled-out zero value. Both forms are
 * in this repo, in the same file, and both mean the same thing.
 *
 * "" is accepted as well, because decodeEnduring below projects an absent id
 * onto "" — a caller reading `decoded.causeLoopId` never sees `undefined`.
 *
 * §3b's "commit a user row only when Header.Cause.LoopID is zero" rule is
 * exactly this predicate. Writing `cause?.loop_id === undefined` instead would
 * render a phantom user message on any hand-back whose producer spelled the
 * zero out. Any other STRING — a real loop id, or a near-miss like a zero uuid
 * with one digit flipped — reads as NON-zero and suppresses the user row.
 *
 * A non-string value never reaches this predicate at all: decodeEnduring
 * projects every id through `str()`, so a corrupted `"loop_id": 42` arrives as
 * "" and reads as ZERO, committing the row. That is the decoder's uniform
 * malformed-reads-as-the-zero-value rule (the same one that projects a
 * non-numeric `turn_index` onto 0), not a special case for this gate, and it is
 * pinned in test/rows-handback.test.ts. Only a corrupted journal record can
 * produce it — `uuid.UUID` always marshals to a string.
 */
export function isZeroUUID(id: string | undefined): boolean {
  return id === undefined || id === "" || id === ZERO_UUID;
}

/** The sender Factory verified and stamped; display names are not identity. */
export interface MessagePrincipal {
  tenant: string;
  subject: string;
  kind: "actor" | "service";
}

/** Public journal projection of harness v0.41.0 MessageInput. Metadata is audit-only. */
export interface MessageInput {
  principal?: MessagePrincipal;
  prefix: number;
  suffix: number;
}

export function decodePrincipal(raw: unknown): MessagePrincipal | undefined {
  if (!isRecord(raw)) return undefined;
  const tenant = str(raw["tenant"]);
  const subject = str(raw["subject"]);
  const kind = str(raw["kind"]);
  if (tenant === "" || subject === "" || (kind !== "actor" && kind !== "service")) return undefined;
  return { tenant, subject, kind };
}

function count(raw: unknown): number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

function decodeInput(raw: unknown): MessageInput | undefined {
  if (!isRecord(raw)) return undefined;
  const principal = decodePrincipal(raw["principal"]);
  return { ...(principal === undefined ? {} : { principal }), prefix: count(raw["prefix"]), suffix: count(raw["suffix"]) };
}

/** Sender named by a public event body, if it carries a valid principal. */
export function eventPrincipal(body: unknown): MessagePrincipal | undefined {
  if (!isRecord(body)) return undefined;
  const input = body["input"];
  return decodePrincipal(isRecord(input) ? input["principal"] : undefined) ?? decodePrincipal(body["principal"]);
}

export function principalLabel(principal: MessagePrincipal): string {
  return principal.kind === "service" ? `service ${principal.subject}` : principal.subject;
}

/**
 * TurnStarted is the first enduring turn event, carrying the exact UserMessage
 * committed as the turn's first message. TurnFoldedInto is the same shape for
 * queued input folded into a mandatory tool-continuation.
 *
 * Neither payload tells you whether to render a user row: that is decided by
 * Header.Cause.LoopID (zero = genuine user input; non-zero = a subagent
 * hand-back), which lives on the shared header, not here. isZeroUUID above is
 * that predicate, and DecodedEnduring.causeLoopId is what it reads.
 *
 * Both fields are `omitzero` on the wire, so a nil *content.UserMessage and a
 * zero TurnIndex are ABSENT keys, not nulls or zeros — verified by marshalling
 * a real TurnStarted{} (see test/enduring.test.ts's provenance note).
 */
export interface TurnOpenerPayload {
  kind: "TurnStarted" | "TurnFoldedInto";
  turnIndex: number;
  message: ConversationMessage | undefined;
  /** Present only when the additive harness v0.41.0 member was on the wire. */
  input?: MessageInput;
}

/**
 * StepDone is the authoritative commit point AND the self-heal anchor: its
 * Messages is exactly the group that entered history — one AIMessage followed
 * by its ToolResultMessages — emitted once the commit handshake lands, so it
 * never claims a commit that did not happen. This is where the cold journal's
 * prose lives.
 *
 * A TRUNCATED step emits StepDone too: the loop commits the safe prefix of the
 * response (text and sealed reasoning, never a partial or unpaired tool call)
 * so watched content is not discarded, and the turn still ends on TurnFailed.
 * The truncation notice is an ordinary text block with no distinguishing tag, so
 * a consumer that must tell a truncated group from a clean one reads the turn
 * TERMINAL, not this payload.
 *
 * A step that decoded nothing usable emits NO StepDone at all — and that is
 * enforced, not merely conventional: MarshalEvent refuses a StepDone with an
 * empty Messages (validateStepDoneMessages). This is why the turn terminals
 * must commit any dangling live segment themselves.
 *
 * The AIMessage's own `usage` key is inside these messages on the wire and is
 * deliberately dropped by decodeMessage; turn accounting reads TurnDone's
 * top-level `usage`, which is a different shape.
 */
export interface StepDonePayload {
  kind: "StepDone";
  messages: ConversationMessage[];
  /** Present only when the additive capture field was present on the wire. */
  captures?: Map<string, ToolResultCaptureSummary>;
}

/**
 * TurnDone's own token accounting: the checked sum of every completed request
 * in the turn.
 *
 * The wire names are the Go FIELD names. content.Usage declares no json tags
 * and no codec at all, so `json:"usage,omitzero"` on TurnDone marshals it as a
 * bare struct and ALL FIVE counters are always present — a zero one included.
 * `omitzero` still drops the whole `usage` key when every counter is zero, so
 * an absent key means "no tokens", which projects to five zeros here, never to
 * undefined.
 *
 * This must NOT share a type with an AIMessage's own `usage`. That one goes
 * through content.usageJSON, whose `json:",omitempty"` DROPS zero counters, so
 * the two shapes disagree under the same key name in the same bytes (pinned in
 * test/enduring.test.ts against one real TurnDone carrying both). blocks.ts
 * therefore does not decode the message-level usage at all: turn accounting has
 * exactly one source, which is this.
 */
export interface UsageValue {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/** The terminal SUCCESS event for a turn. §3b closes the turn normally on it. */
export interface TurnDonePayload {
  kind: "TurnDone";
  turnIndex: number;
  message: ConversationMessage | undefined;
  usage: UsageValue;
}

/**
 * The terminal event for non-cancellation LLM/provider errors.
 *
 * TurnFailed.Err is tagged `json:"-"`, and reading the struct alone would say
 * no failure text reaches the wire. It does. marshalTurnFailed encodes
 * turnFailedWire, which PROJECTS Err through projectError onto a stable
 * {kind, message} pair, so a real TurnFailed envelope always carries an `err`
 * object (projectError(nil) yields kind "unknown" with an empty message rather
 * than nil, so the pointer's `omitempty` never fires). Verified by marshalling
 * real TurnFailed values against harness v0.30.0.
 *
 * `errorKind` is one of ErrKind's stable durable strings — "empty_response",
 * "tool_limit", "turn_panic", "unknown" — and never renames; provider/stream
 * errors are deliberately not enumerated (the event package is a leaf) and
 * arrive as "unknown" with their full text in `errorMessage`. Only an EMPTY
 * message needs generic fallback wording from the renderer.
 *
 * `errorMessage` is UNTRUSTED display text: it can be an arbitrary provider
 * error string. Render it as text, never as markup.
 *
 * The wire's `model_facing` / `model_facing_detail` pair is deliberately not
 * projected. It marks an error as safe to hand back to the MODEL, which is a
 * decision about a replay path wui does not have; it says nothing about
 * display, and forwarding it to a browser would have no reader.
 */
export interface TurnFailedPayload {
  kind: "TurnFailed";
  turnIndex: number;
  errorKind: string;
  errorMessage: string;
}

/** The terminal event when the turn context is cancelled. */
export interface TurnInterruptedPayload {
  kind: "TurnInterrupted";
  turnIndex: number;
  /** Present only when Factory stamped the sender. */
  principal?: MessagePrincipal;
}

/**
 * The Enduring Reply event for a UserInput the loop refused. Enduring exactly
 * because a rejected user message must never silently vanish: §3b drops the
 * optimistic pending row (paired by Header.Cause.CommandID) and commits an
 * error notice carrying this reason.
 *
 * event.RejectReason is a bare uint8 with no symbolic encoding, so `reason` is
 * the raw number and `reasonText` is this module's rendering of it.
 */
export interface TurnRejectedPayload {
  kind: "TurnRejected";
  reason: number;
  reasonText: string;
}

/**
 * A queued input that left the loop queue without committing — a client
 * retract, or a return after an abnormal turn end.
 *
 * event.CancelReason is likewise a bare uint8, but its zero is NOT a sentinel:
 * 0 is CancelClientRetracted, a real reason the loop really produces (1 is
 * CancelTurnInterrupted, 2 CancelTurnFailed). `omitzero` drops the key for 0
 * just the same, so an absent `reason` here means "client retracted" — the
 * opposite of what an absent TurnRejected reason means. Never label one with
 * rejectReasonText.
 */
export interface InputCancelledPayload {
  kind: "InputCancelled";
  turnIndex: number;
  reason: number;
  message: ConversationMessage | undefined;
  /** Present only when the additive harness v0.41.0 member was on the wire. */
  input?: MessageInput;
}

/**
 * One reusable allow rule that was DISPLAYED to the user and offered for
 * durable persistence behind the "Approve always for this workspace" action.
 *
 * tool.RuleCandidate carries no grant or token material by construction:
 * GrantClass and GrantTarget describe only the structural enforcement contract
 * a future match must preserve, and both are `omitempty` (absent for a
 * direct-enforcement rule), so they project to "" rather than undefined.
 */
export interface PermissionRuleCandidate {
  kind: string;
  match: string;
  description: string;
  grantClass: string;
  grantTarget: string;
}

/**
 * One normalized capability the prepared tool call needs.
 *
 * `kind`, `scope`, `match` and `description` carry NO `omitempty` on
 * tool.Requirement, so all four are always present on the wire — `scope` is
 * emitted as `""` for a global capability rather than dropped. `grantClass`
 * and `grantTarget` are an all-or-nothing `omitempty` pair.
 */
export interface PermissionRequirement {
  kind: string;
  scope: string;
  match: string;
  description: string;
  grantClass: string;
  grantTarget: string;
  candidates: PermissionRuleCandidate[];
}

/**
 * The typed, validated prepared access request (harness's tool.Request) the
 * permission card renders.
 *
 * It is a TYPED struct on both sides, not an opaque bag: harness validates it
 * with tool.ValidateRequest on marshal and the strict gate.DecodeRequest on
 * unmarshal, so a malformed or token-bearing record can neither be journaled
 * nor restored. It has no grant-token field and no raw-tool-arguments field to
 * leak — permission evaluation never parses raw arguments (see pkg/tool's
 * package comment).
 *
 * The execution binding — `executionId`, `command`, `workingDirectory`,
 * `expiresAtUnixMilli` — is REQUIRED by ValidateRequest whenever any
 * requirement asks for a grant, and absent otherwise. It is what lets the card
 * name the exact command being authorized instead of just its summary.
 */
export interface PermissionRequest {
  toolName: string;
  summary: string;
  executionId: string;
  command: string;
  workingDirectory: string;
  expiresAtUnixMilli: number;
  requirements: PermissionRequirement[];
}

/**
 * PermissionRequested carries the typed prepared tool.Request, projected into
 * a sibling "request" key by the marshaler (the struct tag is `json:"-"`; see
 * permissionRequestedWire in harness/pkg/event/marshal.go). It never carries
 * grant tokens or raw tool arguments.
 *
 * `request` is NOT optional in practice and is not modelled as such:
 * marshalPermissionRequested always sets the raw field to the two bytes `{}`
 * for a zero tool.Request, and `omitempty` cannot fire on a non-empty
 * json.RawMessage — so a pure tool's PermissionRequested still carries
 * `"request":{}`. An absent key (only reachable from a legacy or corrupted
 * record) decodes to the same all-empty value, so a consumer never has to
 * distinguish "no requirements" from "no request".
 *
 * PermissionRequested.Preview is DELIBERATELY not projected: it reaches
 * neither the journal nor any wire, so the web permission card has no mutation
 * preview. That is a declared limitation of this design (§3a), not a decoding
 * gap — `hasPreview` exists so a renderer states it rather than silently
 * showing an empty diff. This is NOT an inference from the `json:"-"` tag:
 * `Request` carries the same tag and IS projected. It was verified by
 * marshalling a real PermissionRequested whose Preview was set and reading the
 * absence of the key out of the bytes (test/enduring.test.ts).
 */
export interface PermissionRequestedPayload {
  kind: "PermissionRequested";
  toolExecutionId: string;
  request: PermissionRequest;
  hasPreview: false;
}

/**
 * A NON-gated approve/deny — the rule engine resolved it without asking a
 * human. A gated ask is GateOpened/GateResolved instead, which is why
 * `effect` is only ever "approve" or "deny" and never "ask".
 *
 * `subject` and `audit` are redacted summaries by contract (event/tool.go:
 * "grant tokens and raw args must never appear here"), but they are still
 * UNTRUSTED display text — render them as text, never as markup.
 */
export interface PermissionDecidedPayload {
  kind: "PermissionDecided";
  toolExecutionId: string;
  effect: string;
  reason: string;
  subject: string;
  audit: string;
}

/**
 * LoopStarted is the durable loop-tree record. Header.Coordinates is the NEW
 * loop; Header.Cause.Coordinates is the SPAWNING loop/turn/step (zero for the
 * primary/root). The header itself carries NO turn or step — LoopStarted's
 * identity profile (loopProfile) forbids them — so a consumer that wants the
 * spawning step reads `cause`, never the promoted coordinates.
 *
 * ParentToolUseID is the durable provider tool-use id
 * (content.ToolUseBlock.ID) of the agent tool call that spawned this loop —
 * the join key that anchors a child loop's transcript block at the parent's
 * subagent tool card (§3b rule 1). It is empty for a root.
 *
 * The presentation label is DisplayName when non-empty, else the header's
 * AgentName (older journals carry no DisplayName) — the same fallback tui's
 * loopStartedLabel applies. That fallback is NOT applied here: AgentName lives
 * on the shared header, not in this payload, so it belongs to a consumer that
 * has the whole DecodedEnduring.
 *
 * Three real wire fields are deliberately left undecoded: `runtime` (the
 * resolved model identity), `agent_runtime` (a delegated foreign runtime's
 * secret-free identity) and `initial_request_id`. None of them is loop-tree or
 * label data, and DecodedEnduring.envelope keeps the verbatim bytes for any
 * consumer that later needs one. `runtime`'s shape is recorded in
 * test/enduring.test.ts because it is a casing trap: the `key`/`limits`
 * wrappers are snake_case while their CONTENTS are Go-cased
 * (`Provider`/`Model`/`WindowTokens`/...), since model.ModelKey and
 * model.ContextLimits declare no json tags.
 */
export interface LoopStartedPayload {
  kind: "LoopStarted";
  parentToolUseId: string;
  displayName: string;
  description: string;
  foreignSid: string;
  initialMode: string;
}

/**
 * GateOpened is the PUBLIC activation event: it carries the whole public gate
 * envelope and no private payload, it fans out to SSE AND lands in the journal,
 * and it is what makes a gate listable and answerable. Nothing polls for it —
 * see gate.ts's module comment for why GET /status's waiting_gate_id is not an
 * alternative.
 */
export interface GateOpenedPayload {
  kind: "GateOpened";
  gate: Gate;
}

/**
 * The single atomic close-with-answer record.
 *
 * `action` stays in the clear (for a permission gate it is one of the three
 * exact gate.ApprovalAction strings); a non-answer close — abandoned, owner
 * closed, restore unavailable — sets `reason` with `action` empty. `source`
 * names who produced the answer: "user", "policy", "model" or "classifier",
 * with an optional free-text reason, which is what lets a resolved card say
 * "denied by policy" rather than implying the human did it.
 *
 * `audit` IS on the wire and is deliberately not projected. The struct tags
 * `Audit json:"-"`, but so does TurnFailed.Err, and reading the tag as "not on
 * the wire" is exactly the mistake that dropped the reason from every failed
 * turn: marshalGateResolved projects the sealed gate.ResponseAudit through
 * gate.MarshalResponseAudit into a sibling {kind,data} key (pinned in
 * test/gate.test.ts). It is skipped because a browser has no use for it, not
 * because it is absent — for a permission gate it restates requirement and
 * candidate descriptions the open gate already carried, and for a form gate it
 * is FormAudit's verbatim user answers, which wui does not render. The verbatim
 * bytes stay on DecodedEnduring.envelope either way.
 */
export interface GateResolvedPayload {
  kind: "GateResolved";
  gateId: string;
  resolver: string;
  reason: string;
  action: string;
  source: { kind: string; reason: string };
  /** Present only when Factory stamped the sender. */
  principal?: MessagePrincipal;
}

/** The type-specific half of a decoded enduring event. Extended per task. */
export type EnduringPayload =
  | TurnOpenerPayload
  | StepDonePayload
  | TurnDonePayload
  | TurnFailedPayload
  | TurnInterruptedPayload
  | TurnRejectedPayload
  | InputCancelledPayload
  | PermissionRequestedPayload
  | PermissionDecidedPayload
  | LoopStartedPayload
  | GateOpenedPayload
  | GateResolvedPayload
  | { kind: "other" };

/**
 * A decoded enduring event: the shared header coordinates (promoted onto the
 * envelope by MarshalEvent) plus the type-specific payload plus the verbatim
 * envelope, so no consumer is ever forced back to the raw bytes.
 *
 * Every id is a string, never `string | undefined`: an omitted id projects to
 * "", which isZeroUUID reads as zero. Consumers switch on the value, not on
 * its presence.
 */
export interface DecodedEnduring {
  type: string;
  loopId: string;
  turnId: string;
  stepId: string;
  eventId: string;
  createdAt: string;
  agentName: string;
  causeLoopId: string;
  causeCommandId: string;
  payload: EnduringPayload;
  envelope: EventEnvelope;
}

export function decodeEnduring(envelope: EventEnvelope): DecodedEnduring {
  const raw = envelope as unknown as Record<string, unknown>;
  const cause = isRecord(raw["cause"]) ? raw["cause"] : {};
  return {
    type: str(raw["type"]),
    loopId: str(raw["loop_id"]),
    turnId: str(raw["turn_id"]),
    stepId: str(raw["step_id"]),
    eventId: str(raw["event_id"]),
    createdAt: str(raw["created_at"]),
    agentName: str(raw["agent_name"]),
    causeLoopId: str(cause["loop_id"]),
    causeCommandId: str(cause["command_id"]),
    payload: decodePayload(str(raw["type"]), raw),
    envelope,
  };
}

function decodePayload(type: string, raw: Record<string, unknown>): EnduringPayload {
  switch (type) {
    case "TurnStarted":
    case "TurnFoldedInto": {
      const input = decodeInput(raw["input"]);
      return {
        kind: type,
        turnIndex: num(raw["turn_index"]),
        message: isRecord(raw["message"]) ? decodeMessage(raw["message"]) : undefined,
        ...(input === undefined ? {} : { input }),
      };
    }
    case "StepDone":
      return {
        kind: "StepDone",
        messages: decodeMessages(raw["messages"]),
        ...(Array.isArray(raw["captures"]) ? { captures: toolResultCaptures(raw["captures"]) } : {}),
      };
    case "TurnDone":
      return {
        kind: "TurnDone",
        turnIndex: num(raw["turn_index"]),
        message: isRecord(raw["message"]) ? decodeMessage(raw["message"]) : undefined,
        // TurnDone's OWN usage, never raw["message"]["usage"] — a different shape.
        usage: decodeUsage(raw["usage"]),
      };
    case "TurnFailed": {
      const err = isRecord(raw["err"]) ? raw["err"] : {};
      return {
        kind: "TurnFailed",
        turnIndex: num(raw["turn_index"]),
        errorKind: str(err["kind"]),
        errorMessage: str(err["message"]),
      };
    }
    case "TurnInterrupted": {
      const principal = decodePrincipal(raw["principal"]);
      return { kind: "TurnInterrupted", turnIndex: num(raw["turn_index"]), ...(principal === undefined ? {} : { principal }) };
    }
    case "TurnRejected": {
      const reason = num(raw["reason"]);
      return { kind: "TurnRejected", reason, reasonText: rejectReasonText(reason) };
    }
    case "InputCancelled": {
      const input = decodeInput(raw["input"]);
      return {
        kind: "InputCancelled",
        turnIndex: num(raw["turn_index"]),
        reason: num(raw["reason"]),
        message: isRecord(raw["message"]) ? decodeMessage(raw["message"]) : undefined,
        ...(input === undefined ? {} : { input }),
      };
    }
    case "GateOpened":
      return { kind: "GateOpened", gate: decodeGate(raw["gate"]) };
    case "GateResolved": {
      const source = isRecord(raw["source"]) ? raw["source"] : {};
      const principal = decodePrincipal(raw["principal"]);
      return {
        kind: "GateResolved",
        gateId: str(raw["gate_id"]),
        resolver: str(raw["resolver"]),
        reason: str(raw["reason"]),
        action: str(raw["action"]),
        source: { kind: str(source["kind"]), reason: str(source["reason"]) },
        ...(principal === undefined ? {} : { principal }),
      };
    }
    case "LoopStarted":
      return {
        kind: "LoopStarted",
        parentToolUseId: str(raw["parent_tool_use_id"]),
        displayName: str(raw["display_name"]),
        description: str(raw["description"]),
        foreignSid: str(raw["foreign_sid"]),
        initialMode: str(raw["initial_mode"]),
      };
    case "PermissionRequested":
      return {
        kind: "PermissionRequested",
        toolExecutionId: str(raw["tool_execution_id"]),
        request: decodePermissionRequest(raw["request"]),
        // Not a decoding gap: Preview reaches neither journal nor wire.
        hasPreview: false,
      };
    case "PermissionDecided":
      return {
        kind: "PermissionDecided",
        toolExecutionId: str(raw["tool_execution_id"]),
        effect: str(raw["effect"]),
        reason: str(raw["reason"]),
        subject: str(raw["subject"]),
        audit: str(raw["audit"]),
      };
    default:
      // The long tail keeps the generic marker, per design §3a.
      return { kind: "other" };
  }
}

/**
 * Decodes the projected tool.Request. Every field is read under the snake_case
 * json tag tool.Request declares; an absent `request` (legacy only — see
 * PermissionRequestedPayload) and an empty `{}` both yield the same all-empty
 * value rather than undefined.
 */
function decodePermissionRequest(raw: unknown): PermissionRequest {
  const r = isRecord(raw) ? raw : {};
  const requirements = Array.isArray(r["requirements"]) ? r["requirements"] : [];
  return {
    toolName: str(r["tool_name"]),
    summary: str(r["summary"]),
    executionId: str(r["execution_id"]),
    command: str(r["command"]),
    workingDirectory: str(r["working_directory"]),
    expiresAtUnixMilli: num(r["expires_at_unix_milli"]),
    requirements: requirements.filter(isRecord).map(decodePermissionRequirement),
  };
}

function decodePermissionRequirement(raw: Record<string, unknown>): PermissionRequirement {
  const candidates = Array.isArray(raw["candidates"]) ? raw["candidates"] : [];
  return {
    kind: str(raw["kind"]),
    scope: str(raw["scope"]),
    match: str(raw["match"]),
    description: str(raw["description"]),
    grantClass: str(raw["grant_class"]),
    grantTarget: str(raw["grant_target"]),
    candidates: candidates.filter(isRecord).map((c) => ({
      kind: str(c["kind"]),
      match: str(c["match"]),
      description: str(c["description"]),
      grantClass: str(c["grant_class"]),
      grantTarget: str(c["grant_target"]),
    })),
  };
}

/**
 * `omitzero` drops a zero numeric field, so an absent value means 0. A
 * non-number reads as 0 too rather than NaN: a NaN turn index would poison
 * every downstream comparison silently, where 0 is at least a real turn.
 */
function num(x: unknown): number {
  return typeof x === "number" ? x : 0;
}

/**
 * content.Usage is tag-free, so every counter is read under its Go field name.
 * An absent `usage` key (the `omitzero` all-zero case) yields five zeros rather
 * than undefined, so a consumer never has to distinguish "no tokens" from
 * "no key".
 */
function decodeUsage(raw: unknown): UsageValue {
  const u = isRecord(raw) ? raw : {};
  return {
    inputTokens: num(u["InputTokens"]),
    outputTokens: num(u["OutputTokens"]),
    cacheReadTokens: num(u["CacheReadTokens"]),
    cacheCreationTokens: num(u["CacheCreationTokens"]),
    reasoningTokens: num(u["ReasoningTokens"]),
  };
}

/**
 * ErrKind's catch-all: the durable string a failure carries when the event
 * package — a leaf that deliberately does not enumerate provider or stream
 * errors — could not classify it. It is the ABSENCE of a classification, not
 * one, so `turnFailureText` never prints it as a label.
 */
export const ERROR_KIND_UNKNOWN = "unknown";

/**
 * The user-facing sentence for a TurnFailed, from the `{kind, message}` pair
 * `marshalTurnFailed` always writes. Both parts are rendered, because both
 * carry information the other does not: `errorKind` is a stable durable string
 * that never renames ("empty_response", "tool_limit", "turn_panic"), while
 * `errorMessage` is the arbitrary provider text that says what actually
 * happened. A notice showing neither is the bug — a failed turn must never read
 * as a turn that simply stopped.
 *
 * "unknown" is suppressed as a label (see ERROR_KIND_UNKNOWN); an empty message
 * degrades to the kind alone, and an empty pair — which no marshalled event
 * produces, but a corrupted record could — degrades to the bare statement.
 *
 * The message is UNTRUSTED display text. This returns a plain string and does
 * no escaping: rendering it as text rather than as markup is the renderer's
 * obligation, and is stated on TurnFailedPayload.errorMessage.
 */
export function turnFailureText(errorKind: string, errorMessage: string): string {
  const labelled = errorKind !== "" && errorKind !== ERROR_KIND_UNKNOWN;
  const head = labelled ? `the turn failed (${errorKind})` : "the turn failed";
  return errorMessage === "" ? head : `${head}: ${errorMessage}`;
}

/**
 * event.RejectReason's constants, in declaration order: 0 RejectUnspecified (a
 * zero-value sentinel the loop NEVER produces), 1 RejectQueueFull,
 * 2 RejectShuttingDown, 3 RejectInternal. An unrecognized value — including a
 * reason a later harness adds — falls back to the unspecified wording rather
 * than borrowing another reason's, because a wrong explanation is worse than
 * none for a submit the user watched disappear.
 *
 * This is RejectReason ONLY. event.CancelReason shares the uint8 spelling and
 * none of the meanings.
 */
export function rejectReasonText(reason: number): string {
  switch (reason) {
    case 1:
      return "the loop's queue is full";
    case 2:
      return "the loop is shutting down";
    case 3:
      return "a transient internal failure";
    default:
      return "an unspecified reason";
  }
}

// --- Frame classes: what backpressure may drop, and what it may not ----------

/**
 * The frame classes, as a pair of TYPES rather than a convention.
 *
 * This lives in `enduring.ts` because it is the same distinction this module
 * already exists to make: an enduring event is durable, sequenced content whose
 * loss has no in-band repair, and everything decoded above is exactly that
 * content. Backpressure needs the distinction as a value-level predicate and as
 * a type, so both are stated here, once, next to the definition they enforce.
 *
 * `DroppableFrame` is what a bounded live queue may evict:
 *
 *  - `heartbeat` — a keepalive carrying no content at all;
 *  - `ephemeral` — unsequenced best-effort deltas. Losing one is ALREADY a
 *    tolerated condition: a reconnect replays enduring frames only, so deltas
 *    emitted during an outage are lost regardless, and the following `StepDone`
 *    snaps the live segment wholesale and repairs the transcript (design §9).
 *
 * Everything else — `enduring`, and `error` — is outside that domain.
 * `enduring` because there is no repair short of re-reading the journal, and
 * `error` because a frame that FAILED TO PARSE may have been an enduring one
 * and nothing can tell after the fact; dropping it would lose durable content
 * with no report that it happened. Both are refused, and the refusal is
 * reported as a binding-level `repair_required` (see store.ts).
 *
 * The type is what `selectFrameToDrop` takes, so no TypeScript call site can
 * hand the eviction policy a frame outside the domain. That is enforced by
 * `npm run typecheck` (which compiles `test/` too) and by nothing else: types
 * are erased, so widening the parameter back to `SseFrame` leaves every runtime
 * test passing — measured, not assumed.
 *
 * The runtime half is `selectFrameToDrop` returning -1 rather than an index for
 * a buffer with no droppable frame in it, which is what makes the queue repair.
 * `AsyncQueue` also re-checks `isDroppableFrame` on the exact item it is about
 * to splice, but that condition is unreachable with the module's own wiring —
 * see the note at that line for why it is kept anyway.
 */
export type DroppableFrame = Extract<SseFrame, { type: "heartbeat" } | { type: "ephemeral" }>;

/** The one narrowing predicate. Everything not named here is durable. */
export function isDroppableFrame(frame: SseFrame): frame is DroppableFrame {
  return frame.type === "heartbeat" || frame.type === "ephemeral";
}

/**
 * The DECLARED coalescing key of a droppable frame: the `kind` the producer
 * put on the wire (`ephemeral_frame.schema.json`'s five-value enum —
 * `token_delta`, `tool_call_started`, `tool_call_completed`, `input_queued`,
 * `compaction_started`) plus the producing event's identity from `header`.
 *
 * It is the DECLARED kind, never an inference from the payload: two
 * `token_delta` frames on one loop share a key however different their text is,
 * and a `token_delta` never shares a key with a `tool_call_started` on the same
 * loop. That is what makes eviction coalescing rather than truncation — one
 * fast token stream is thinned against itself, and a quiet peer stream on
 * another loop is not charged for it.
 *
 * A frame whose `kind` or `header` is missing or malformed keys as its own
 * `"ephemeral"` bucket rather than throwing: it is still droppable (its TYPE
 * said so), and an unkeyable frame must not be able to make the queue give up.
 */
export function ephemeralDropKey(frame: DroppableFrame): string {
  if (frame.type === "heartbeat") return "heartbeat";
  const raw = frame.data as unknown;
  const data: Record<string, unknown> = isRecord(raw) ? raw : {};
  const kind = str(data["kind"]);
  if (kind === "") return "ephemeral";
  const header: Record<string, unknown> = isRecord(data["header"]) ? data["header"] : {};
  return `${kind}|${str(header["loop_id"])}|${str(header["turn_id"])}|${str(header["step_id"])}`;
}
