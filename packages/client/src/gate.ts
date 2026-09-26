/**
 * The durable gate envelope (harness/pkg/gate's `Gate`) as it arrives on the
 * wire.
 *
 * ## Gates are NOT polled
 *
 * `GateOpened` and `GateResolved` are PUBLIC enduring events: they fan out to
 * SSE subscribers AND appear in the journal page, each carrying the full
 * `gate.Gate` — id, kind, prompt, subject, response policy. Everything needed
 * to render a gate and to answer it is in the event. Only `GatePrepared`, the
 * private prepared record, is journal-only and never fans out (the replayer
 * filters it). Gate latency is therefore one SSE frame, and concurrent gates
 * from parallel loops work by construction.
 *
 * `GET /status`'s `waiting_gate_id` is not an alternative to this and is not
 * used as one. It is a single last-writer-wins slot on the session catalog
 * meta: `GateOpened` overwrites it and `GateResolved` clears it
 * UNCONDITIONALLY, whichever gate resolved (verified in harness@v0.30.0's
 * `pkg/sessionstore/catalog.go`), so two concurrent subagent gates lose one
 * permanently and answering either erases the other. It is also a bare UUID
 * with no prompt, no subject and no controls, so nothing could be rendered
 * from it. It is a reconnect reconciliation hint at best. There is no
 * `GET .../gates` route.
 *
 * ## Only a permission gate is answerable here
 *
 * `gate.Kind` has four values and wui can complete exactly one of them. The
 * other three are answered out-of-band (in the TUI), so `isAnswerableGate`
 * exists to make a renderer state that rather than offering Approve/Deny for a
 * gate whose resolver never declared those actions.
 */
import { isRecord, str } from "./blocks.js";

/**
 * `gate.Kind`'s four values, spelled exactly as `pkg/gate/gate.go` declares
 * them. harness matches these strings verbatim; never invent a variant.
 */
export const GATE_KIND_PERMISSION = "harness.permission";
export const GATE_KIND_ASK_USER = "harness.ask_user";
export const GATE_KIND_FORM = "harness.form";
export const GATE_KIND_OPEN_URL = "harness.open_url";

/**
 * The work item a gate is about. For a permission gate this is the parked tool
 * call, which is what lets a renderer put the gate on the right tool card
 * instead of at the bottom of the transcript.
 */
export interface GateSubject {
  toolExecutionId: string;
  toolUseId: string;
  turnId: string;
  stepId: string;
  inputId: string;
}

/**
 * One offered response action. `action` is submitted VERBATIM in a
 * `GateResponseRequest` — for a permission gate it is one of the three exact
 * `gate.ApprovalAction` strings mirrored in gate-actions.ts, and harness
 * rejects anything else with `gate_action_invalid`. `label` is display text
 * and may differ; render `label`, submit `action`.
 */
export interface GateControl {
  action: string;
  label: string;
}

export interface GatePrompt {
  title: string;
  body: string;
  /**
   * A VALIDATED BARE ORIGIN, for an open-url gate only — scheme and host, no
   * path, query, fragment or userinfo, enforced by `gate.ValidateGate` on the
   * open path. It is what the human's trust decision is made on, so it can be
   * displayed as an origin structurally rather than by convention. It is never
   * the action URL: that lives only on the private `OpenURLPayload` and reaches
   * no durable record. Other kinds leave it empty.
   */
  origin: string;
  controls: GateControl[];
}

/**
 * `gate.ResponsePolicy`'s automatic handling for an unresolved gate.
 *
 * The `response` template and `model_decision` policy are real wire and are
 * deliberately not projected: both describe how the SERVER may auto-resolve a
 * gate, which is not something a browser renders or acts on.
 */
export interface GateResponsePolicy {
  /**
   * `gate.ResponsePolicy.Timeout` is a `time.Duration`, which marshals as an
   * integer count of NANOSECONDS — 60000000000 is one minute. The name says so
   * because reading it as milliseconds is silent and enormous.
   */
  timeoutNanos: number;
  onTimeout: string;
}

/**
 * The full public gate envelope. `kind`, `resolver`, `blocks`, `effect` and
 * `criticality` stay plain strings rather than literal unions: each is a
 * `string`-based Go type whose value set can grow, and an unrecognized value
 * must survive decoding so a renderer can say "unknown gate" instead of
 * silently reading it as one of the known ones.
 *
 * `prompt.schema` (a form gate's typed fields) is real wire and deliberately
 * not projected — a form is answered out-of-band, so wui renders the title and
 * says so rather than building inputs it will not submit.
 */
export interface Gate {
  id: string;
  kind: string;
  resolver: string;
  blocks: string;
  effect: string;
  criticality: string;
  restorable: boolean;
  subject: GateSubject;
  prompt: GatePrompt;
  responsePolicy: GateResponsePolicy;
}

/** `omitzero`/`omitempty` drop a zero number, and a non-number reads as 0. */
function num(x: unknown): number {
  return typeof x === "number" ? x : 0;
}

/**
 * Decodes one wire `gate.Gate`. Every nested object is optional on the wire
 * (`subject`, `prompt` and `response_policy` are all `omitzero` over
 * comparable structs), so each missing branch collapses to its zero value
 * rather than to undefined — a caller never has to null-check its way down to
 * a title.
 *
 * A non-object input yields the all-empty gate rather than throwing:
 * `isAnswerableGate` then refuses it, which fails secure, where a thrown
 * TypeError inside the fold would take down the whole session view.
 */
export function decodeGate(raw: unknown): Gate {
  const g = isRecord(raw) ? raw : {};
  const subject = isRecord(g["subject"]) ? g["subject"] : {};
  const prompt = isRecord(g["prompt"]) ? g["prompt"] : {};
  const policy = isRecord(g["response_policy"]) ? g["response_policy"] : {};
  const controls = Array.isArray(prompt["controls"]) ? prompt["controls"] : [];
  return {
    id: str(g["id"]),
    kind: str(g["kind"]),
    resolver: str(g["resolver"]),
    blocks: str(g["blocks"]),
    effect: str(g["effect"]),
    criticality: str(g["criticality"]),
    // `restorable` is omitzero, so false is an absent key. Anything that is not
    // literally true reads as false: a gate is treated as non-restorable unless
    // the wire says otherwise.
    restorable: g["restorable"] === true,
    subject: {
      toolExecutionId: str(subject["tool_execution_id"]),
      toolUseId: str(subject["tool_use_id"]),
      turnId: str(subject["turn_id"]),
      stepId: str(subject["step_id"]),
      inputId: str(subject["input_id"]),
    },
    prompt: {
      title: str(prompt["title"]),
      body: str(prompt["body"]),
      origin: str(prompt["origin"]),
      controls: controls
        .filter(isRecord)
        .map((c) => ({ action: str(c["action"]), label: str(c["label"]) })),
    },
    responsePolicy: {
      timeoutNanos: num(policy["timeout"]),
      onTimeout: str(policy["on_timeout"]),
    },
  };
}

/**
 * True for the one gate kind wui can answer. Any other kind — including one a
 * later harness adds — renders an "answer this in the TUI" card instead. The
 * default is the un-answerable side on purpose: offering Approve/Deny for a
 * gate whose resolver never declared those actions submits an action harness
 * rejects, and worse, tells the user they resolved something they did not.
 */
export function isAnswerableGate(gate: Gate): boolean {
  return gate.kind === GATE_KIND_PERMISSION;
}

// --- The COLD public gate projection ----------------------------------------

/**
 * `Factory`'s answerability enum, spelled exactly as
 * `public_gate_page.schema.json` declares it and meaning exactly what the
 * durable gate companion's §5.3 table says:
 *
 *   resident    a live Host owns the gate and can apply a response
 *   suspended   a committed continuation can accept a cold response
 *   submitted   a response is durably accepted and awaiting application
 *   unavailable the prompt is in history, but no live waiter or valid
 *               continuation exists
 *   expired     the response deadline passed; a new answer will be rejected
 *
 * This is Factory's state, not a property of the prompt. An open journal event
 * proves PRESENTATION and never answerability, so a gate this SDK knows only
 * from a `GateOpened` carries no answerability at all (`""`).
 */
export const GATE_ANSWERABILITY_VALUES = [
  "resident",
  "suspended",
  "submitted",
  "unavailable",
  "expired",
] as const;

/** One of the five values above. See `PublicGateProjection.answerability` for why the field is not typed as this. */
export type GateAnswerability = (typeof GATE_ANSWERABILITY_VALUES)[number];

/** True for a value this build recognises. A `false` here is "not known", never "not allowed". */
export function isGateAnswerability(value: unknown): value is GateAnswerability {
  return typeof value === "string" && (GATE_ANSWERABILITY_VALUES as readonly string[]).includes(value);
}

/**
 * Every property `public_gate_page.schema.json` declares on a gate record, on
 * its prompt, and on one prompt control — PARTITIONED into what
 * `decodeGateProjection` carries and what it deliberately drops.
 *
 * This exists because redaction is a claim about a SET, and the vendored record
 * is `additionalProperties: true` at all three of those levels. A decoder that
 * filtered a denylist would forward whatever a Factory (or a compromised one)
 * chose to add; `decodeGateProjection` instead builds a fresh object from named
 * keys.
 *
 * `projected` maps each WIRE name to the name it is projected under, rather
 * than merely listing the wire names, and that is what makes the table a guard
 * in BOTH directions instead of documentation in one. test/gate.test.ts pins
 * `Object.keys(projected) ∪ withheld` against the schema's own property set, so
 * a property Core adds later is classified here or the test fails; and it pins
 * `Object.values(projected)` against the decoder's actual output key paths, so
 * moving a name from `projected` to `withheld` while the decoder still carries
 * it — the table claiming a redaction that is not happening — fails too.
 *
 * `prompt.schema` is the one declared-but-withheld field, for the reason
 * `GatePrompt` already gives for the live envelope: a form gate is answered
 * out-of-band, so wui renders the title rather than building inputs it will not
 * submit. Redacting it here keeps the two paths saying the same thing.
 */
export const GATE_PROJECTION_WIRE_FIELDS = {
  gate: {
    projected: {
      gate_id: "gateId",
      kind: "kind",
      prompt: "prompt",
      opened_event_id: "openedEventId",
      opened_journal_seq: "openedJournalSeq",
      deadline: "deadline",
      answerability: "answerability",
    },
    withheld: [],
  },
  prompt: {
    projected: { title: "title", body: "body", origin: "origin", controls: "controls" },
    withheld: ["schema"],
  },
  control: { projected: { action: "action", label: "label" }, withheld: [] },
} as const;

/**
 * One gate as Factory's durable read plane projects it — the shape a client
 * renders when NO Host is reachable and there is no live stream to fold.
 *
 * The prompt is the same `GatePrompt` the live envelope decodes to, because a
 * renderer must not care which source a gate arrived from.
 *
 * `kind` and `answerability` stay plain strings rather than literal unions, for
 * the same reason `Gate.kind` does: an unrecognized value must survive decoding
 * so a caller can say "unknown" instead of silently reading it as one of the
 * values this build happens to know. `""` additionally means "Factory has
 * attested nothing about this gate" — see `acceptsResidentResponse`.
 */
export interface PublicGateProjection {
  gateId: string;
  kind: string;
  prompt: GatePrompt;
  /** The `event_id` of the durable `GateOpened` this projection was built from. */
  openedEventId: string;
  /** That event's durable journal sequence. Part of the board's public ordering. */
  openedJournalSeq: number;
  /** The EFFECTIVE response deadline, RFC 3339. Empty when no page has attested one. */
  deadline: string;
  /** Factory's answerability state, verbatim. Empty when no page has attested one. */
  answerability: string;
}

/**
 * Decodes one gate record from `GET /v1/sessions/{sid}/gates`.
 *
 * Every field is read by NAME from `GATE_PROJECTION_WIRE_FIELDS.*.projected`
 * into a fresh object; nothing is spread. That is what makes the output's field
 * set a constant rather than a function of the input, which is the property the
 * redaction claim is actually about.
 *
 * A non-object, or a nested non-object, collapses to its zero value rather than
 * throwing — the same fail-secure rule `decodeGate` follows, and for the same
 * reason: one bad record must not take down a whole gate list, and an empty
 * projection is not `resident`, so nothing is offered for it.
 */
export function decodeGateProjection(raw: unknown): PublicGateProjection {
  const g = isRecord(raw) ? raw : {};
  const prompt = isRecord(g["prompt"]) ? g["prompt"] : {};
  const controls = Array.isArray(prompt["controls"]) ? prompt["controls"] : [];
  return {
    gateId: str(g["gate_id"]),
    kind: str(g["kind"]),
    prompt: {
      title: str(prompt["title"]),
      body: str(prompt["body"]),
      origin: str(prompt["origin"]),
      controls: controls
        .filter(isRecord)
        .map((c) => ({ action: str(c["action"]), label: str(c["label"]) })),
    },
    openedEventId: str(g["opened_event_id"]),
    openedJournalSeq: num(g["opened_journal_seq"]),
    deadline: str(g["deadline"]),
    answerability: str(g["answerability"]),
  };
}
