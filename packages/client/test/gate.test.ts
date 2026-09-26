/**
 * The durable gate envelope, and the two PUBLIC gate events that carry it.
 *
 * ## Provenance
 *
 * `contract/fixtures/` has no gate envelope at all, so every `*_WIRE` constant
 * here is the VERBATIM stdout of `event.MarshalEvent` in
 * `github.com/looprig/harness@v0.30.0` — the version `contract/VERSION` pins —
 * driven by a throwaway main that built real `event.GateOpened` /
 * `event.GateResolved` values around real `gate.Gate`s. They are parsed with
 * `JSON.parse` so the tests consume bytes, not JS object literals.
 *
 * MarshalEvent validates identity before it will emit anything, so these bytes
 * also encode which coordinates each gate kind may legally carry: a loop-owned
 * (permission / ask-user) gate is held to the full step profile, while a
 * host-owned one (`resolver: "session"` — the form and open-url elicitations)
 * requires only a SessionID. An arrangement that violated that would have
 * failed to marshal rather than reaching this file.
 *
 * Cases labelled NOT REAL WIRE are shapes a corrupted or legacy record would
 * produce, kept so a decoder reading the wrong key could not pass this file.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeEnduring } from "../src/enduring.js";
import { acceptsResidentResponse } from "../src/gate-actions.js";
import {
  GATE_ANSWERABILITY_VALUES,
  GATE_KIND_ASK_USER,
  GATE_KIND_FORM,
  GATE_KIND_OPEN_URL,
  GATE_KIND_PERMISSION,
  GATE_PROJECTION_WIRE_FIELDS,
  decodeGate,
  decodeGateProjection,
  isAnswerableGate,
  isGateAnswerability,
} from "../src/gate.js";
import { factoryPublicGatePageSchema } from "../src/schema.js";
import type { EventEnvelope } from "../src/types.js";
import { LOOP_A, envelope } from "./helpers.js";

const GATE_1 = "9e2f0000-0000-4000-8000-000000000001";
const GATE_2 = "9e2f0000-0000-4000-8000-000000000002";
const TOOL_EXEC_1 = "99999999-9999-4999-8999-999999999999";
const TURN_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STEP_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CMD_1 = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function object(x: unknown): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(x)}`);
  }
  return x as Record<string, unknown>;
}

function wireEnvelope(json: string): EventEnvelope {
  return object(JSON.parse(json) as unknown) as unknown as EventEnvelope;
}

/** The `gate` sub-object of one marshalled GateOpened, straight from the bytes. */
function wireGateOf(json: string): unknown {
  return object(JSON.parse(json) as unknown)["gate"];
}

const GATE_OPENED_PERMISSION_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate":{"id":"9e2f0000-0000-4000-8000-000000000001","kind":"harness.permission","resolver":"loop","blocks":"tool_call","effect":"resume","criticality":"critical","subject":{"tool_execution_id":"99999999-9999-4999-8999-999999999999","tool_use_id":"toolu_1","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"},"prompt":{"title":"Allow Write?","body":"write /tmp/x","controls":[{"action":"Approve","label":"Approve"},{"action":"Approve always for this workspace","label":"Approve always for this workspace"},{"action":"Deny","label":"Deny"}]},"response_policy":{"timeout":60000000000,"on_timeout":"respond"},"restorable":true},"loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateOpened","v":1}';

const GATE_OPENED_ASK_USER_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate":{"id":"9e2f0000-0000-4000-8000-000000000002","kind":"harness.ask_user","resolver":"loop","blocks":"tool_call","effect":"resume","criticality":"non_critical","subject":{"tool_execution_id":"99999999-9999-4999-8999-999999999999","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","input_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"prompt":{"title":"Which branch?","body":"pick one"}},"loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateOpened","v":1}';

const GATE_OPENED_FORM_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate":{"id":"9e2f0000-0000-4000-8000-000000000002","kind":"harness.form","resolver":"session","blocks":"session","effect":"control","prompt":{"title":"Configure","schema":{"fields":[{"name":"token_name","label":"Name","kind":"text","required":true}]},"controls":[{"action":"submit","label":"Submit"}]}},"session_id":"11111111-1111-4111-8111-111111111111","type":"GateOpened","v":1}';

const GATE_OPENED_OPEN_URL_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate":{"id":"9e2f0000-0000-4000-8000-000000000002","kind":"harness.open_url","resolver":"session","blocks":"session","effect":"control","prompt":{"title":"Authorize GitHub","origin":"https://github.com"}},"session_id":"11111111-1111-4111-8111-111111111111","type":"GateOpened","v":1}';

const GATE_OPENED_BARE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate":{"id":"9e2f0000-0000-4000-8000-000000000001"},"loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateOpened","v":1}';

const GATE_RESOLVED_ANSWERED_WIRE =
  '{"action":"Approve","audit":{"kind":"permission","data":{"requirement_descriptions":["write file /tmp/x"],"candidate_descriptions":["allow writes under /tmp"]}},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate_id":"9e2f0000-0000-4000-8000-000000000001","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":"answered","resolver":"loop","session_id":"11111111-1111-4111-8111-111111111111","source":{"kind":"user"},"step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateResolved","v":1}';

const GATE_RESOLVED_ABANDONED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate_id":"9e2f0000-0000-4000-8000-000000000001","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":"abandoned","session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateResolved","v":1}';

const GATE_RESOLVED_POLICY_WIRE =
  '{"action":"Deny","created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","gate_id":"9e2f0000-0000-4000-8000-000000000002","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":"policy_response","resolver":"loop","session_id":"11111111-1111-4111-8111-111111111111","source":{"kind":"policy","reason":"timeout"},"step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"GateResolved","v":1}';

describe("decodeGate", () => {
  it("decodes a REAL permission gate's full durable envelope", () => {
    const gate = decodeGate(wireGateOf(GATE_OPENED_PERMISSION_WIRE));
    expect(gate).toStrictEqual({
      id: GATE_1,
      kind: GATE_KIND_PERMISSION,
      resolver: "loop",
      blocks: "tool_call",
      effect: "resume",
      criticality: "critical",
      restorable: true,
      subject: {
        toolExecutionId: TOOL_EXEC_1,
        toolUseId: "toolu_1",
        turnId: TURN_1,
        stepId: STEP_1,
        inputId: "",
      },
      prompt: {
        title: "Allow Write?",
        body: "write /tmp/x",
        origin: "",
        controls: [
          { action: "Approve", label: "Approve" },
          { action: "Approve always for this workspace", label: "Approve always for this workspace" },
          { action: "Deny", label: "Deny" },
        ],
      },
      // gate.ResponsePolicy.Timeout is a time.Duration, which marshals as an
      // integer count of NANOSECONDS. Reading 60000000000 as milliseconds would
      // put a one-minute gate two years in the future.
      responsePolicy: { timeoutNanos: 60_000_000_000, onTimeout: "respond" },
    });
  });

  it("carries gate.ApprovalControls()'s three exact actions, in order", () => {
    // Read off the bytes, not off GATE_APPROVAL_ACTIONS: harness matches the
    // submitted action EXACTLY (gate.ParseApprovalAction), so the wire's own
    // spelling is the contract. Note the real label for the workspace action is
    // the full action string, not a shortened "Always".
    const gate = decodeGate(wireGateOf(GATE_OPENED_PERMISSION_WIRE));
    expect(gate.prompt.controls.map((c) => c.action)).toStrictEqual([
      "Approve",
      "Approve always for this workspace",
      "Deny",
    ]);
    expect(gate.prompt.controls.map((c) => c.label)).toStrictEqual([
      "Approve",
      "Approve always for this workspace",
      "Deny",
    ]);
  });

  it("tolerates a REAL gate carrying nothing but its id", () => {
    const raw = object(wireGateOf(GATE_OPENED_BARE_WIRE));
    expect(Object.keys(raw)).toStrictEqual(["id"]);
    expect(decodeGate(raw)).toStrictEqual({
      id: GATE_1,
      kind: "",
      resolver: "",
      blocks: "",
      effect: "",
      criticality: "",
      restorable: false,
      subject: { toolExecutionId: "", toolUseId: "", turnId: "", stepId: "", inputId: "" },
      prompt: { title: "", body: "", origin: "", controls: [] },
      responsePolicy: { timeoutNanos: 0, onTimeout: "" },
    });
  });

  it("never returns undefined for a non-object, so a renderer cannot crash on junk", () => {
    // NOT REAL WIRE. `gate` is omitzero, so a corrupted or legacy record could
    // carry no gate at all; failing secure here means an empty envelope, which
    // isAnswerableGate then refuses, rather than a thrown TypeError mid-fold.
    for (const junk of [undefined, null, "gate", 7, []]) {
      const gate = decodeGate(junk);
      expect(gate.id).toBe("");
      expect(isAnswerableGate(gate)).toBe(false);
    }
  });

  it("keeps a control that is missing one half rather than dropping the pair", () => {
    // NOT REAL WIRE: gate.Control tags both fields omitempty, so a control with
    // an empty label is representable. Dropping the whole control would remove a
    // button the session still accepts.
    const gate = decodeGate({ prompt: { controls: [{ action: "Deny" }, "not-a-control", { label: "?" }] } });
    expect(gate.prompt.controls).toStrictEqual([
      { action: "Deny", label: "" },
      { action: "", label: "?" },
    ]);
  });
});

describe("gate kinds", () => {
  it("decodes each of gate.Kind's four values distinctly, off real wire", () => {
    const kinds = [
      GATE_OPENED_PERMISSION_WIRE,
      GATE_OPENED_ASK_USER_WIRE,
      GATE_OPENED_FORM_WIRE,
      GATE_OPENED_OPEN_URL_WIRE,
    ].map((json) => decodeGate(wireGateOf(json)).kind);
    expect(kinds).toStrictEqual([
      GATE_KIND_PERMISSION,
      GATE_KIND_ASK_USER,
      GATE_KIND_FORM,
      GATE_KIND_OPEN_URL,
    ]);
    expect(new Set(kinds).size).toBe(4);
  });

  it("spells each constant exactly as harness's gate.Kind does", () => {
    // The literals are the contract; comparing a constant to itself would pass
    // however wrong it was.
    expect(GATE_KIND_PERMISSION).toBe("harness.permission");
    expect(GATE_KIND_ASK_USER).toBe("harness.ask_user");
    expect(GATE_KIND_FORM).toBe("harness.form");
    expect(GATE_KIND_OPEN_URL).toBe("harness.open_url");
  });

  it("answers ONLY a permission gate; every other kind renders an out-of-band card", () => {
    expect(isAnswerableGate(decodeGate(wireGateOf(GATE_OPENED_PERMISSION_WIRE)))).toBe(true);
    for (const json of [GATE_OPENED_ASK_USER_WIRE, GATE_OPENED_FORM_WIRE, GATE_OPENED_OPEN_URL_WIRE]) {
      expect(isAnswerableGate(decodeGate(wireGateOf(json)))).toBe(false);
    }
    // A kind harness adds later must fall on the un-answerable side, not the
    // answerable one: offering Approve/Deny for an unknown gate would submit an
    // action its resolver never declared.
    expect(isAnswerableGate(decodeGate({ id: "g", kind: "harness.something_new" }))).toBe(false);
  });

  it("decodes an ask-user gate's subject, whose input_id no permission gate sets", () => {
    // Subject.InputID is the fifth subject id and the only one the permission
    // fixture leaves zero, so it needs its own real-wire case — otherwise a
    // decoder that hardcoded "" for it would stay green.
    const gate = decodeGate(wireGateOf(GATE_OPENED_ASK_USER_WIRE));
    expect(gate.subject).toStrictEqual({
      toolExecutionId: TOOL_EXEC_1,
      toolUseId: "",
      turnId: TURN_1,
      stepId: STEP_1,
      inputId: CMD_1,
    });
  });

  it("decodes an open-url gate's validated bare origin, and no action target", () => {
    // Prompt.Origin is the thing the human's trust decision is made on, and
    // ValidateGate proves it is a bare origin. The action URL lives only on the
    // private OpenURLPayload and reaches no durable record — so there is nothing
    // here to mistake for one.
    const gate = decodeGate(wireGateOf(GATE_OPENED_OPEN_URL_WIRE));
    expect(gate.prompt.origin).toBe("https://github.com");
    expect(gate.prompt.body).toBe("");
    const raw = object(object(wireGateOf(GATE_OPENED_OPEN_URL_WIRE))["prompt"]);
    expect(Object.hasOwn(raw, "url")).toBe(false);
    // An open-url gate can never be Restorable (ValidateGate refuses it).
    expect(gate.restorable).toBe(false);
  });

  it("leaves a form gate's prompt.schema on the envelope, unprojected", () => {
    // Real wire, and deliberately undecoded: a form is answered in the TUI, so
    // wui renders the title and says so rather than building an input for a
    // schema it will not submit.
    const prompt = object(object(wireGateOf(GATE_OPENED_FORM_WIRE))["prompt"]);
    expect(object(prompt["schema"])["fields"]).toBeInstanceOf(Array);
    expect(decodeGate(wireGateOf(GATE_OPENED_FORM_WIRE)).prompt.title).toBe("Configure");
  });
});

describe("decodeEnduring: gate events", () => {
  it("decodes a REAL GateOpened's full gate", () => {
    const decoded = decodeEnduring(wireEnvelope(GATE_OPENED_PERMISSION_WIRE));
    expect(decoded.payload.kind).toBe("GateOpened");
    if (decoded.payload.kind !== "GateOpened") throw new Error("unreachable");
    expect(decoded.payload.gate).toStrictEqual(decodeGate(wireGateOf(GATE_OPENED_PERMISSION_WIRE)));
    expect(decoded.payload.gate.prompt.title).toBe("Allow Write?");
    expect(decoded.payload.gate.id).toBe(GATE_1);
    // A loop-owned gate parks a tool call, so it carries the full step quartet.
    expect(decoded.loopId).toBe(LOOP_A);
    expect(decoded.turnId).toBe(TURN_1);
    expect(decoded.stepId).toBe(STEP_1);
  });

  it("decodes a REAL host-owned GateOpened, which carries only a session id", () => {
    const decoded = decodeEnduring(wireEnvelope(GATE_OPENED_FORM_WIRE));
    if (decoded.payload.kind !== "GateOpened") throw new Error("unreachable");
    expect(decoded.payload.gate.resolver).toBe("session");
    expect(decoded.loopId).toBe("");
    expect(decoded.turnId).toBe("");
    expect(decoded.stepId).toBe("");
  });

  it("decodes a REAL answered GateResolved's id, action, close reason and source", () => {
    const decoded = decodeEnduring(wireEnvelope(GATE_RESOLVED_ANSWERED_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "GateResolved",
      gateId: GATE_1,
      resolver: "loop",
      reason: "answered",
      action: "Approve",
      source: { kind: "user", reason: "" },
    });
  });

  it("decodes a REAL policy-resolved close, whose source names the reason", () => {
    const decoded = decodeEnduring(wireEnvelope(GATE_RESOLVED_POLICY_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "GateResolved",
      gateId: GATE_2,
      resolver: "loop",
      reason: "policy_response",
      action: "Deny",
      source: { kind: "policy", reason: "timeout" },
    });
  });

  it("decodes a REAL non-answer close, which carries an empty action", () => {
    const raw = object(JSON.parse(GATE_RESOLVED_ABANDONED_WIRE) as unknown);
    // Action, resolver and source are all omitempty/omitzero and genuinely
    // absent on an abandon — reason alone says what happened.
    for (const key of ["action", "resolver", "source"]) {
      expect(Object.hasOwn(raw, key)).toBe(false);
    }
    expect(decodeEnduring(raw as unknown as EventEnvelope).payload).toStrictEqual({
      kind: "GateResolved",
      gateId: GATE_1,
      resolver: "",
      reason: "abandoned",
      action: "",
      source: { kind: "", reason: "" },
    });
  });

  it("carries an `audit` object on a REAL answered close — it IS on the wire", () => {
    // GateResolved.Audit is tagged json:"-", exactly like TurnFailed.Err, and
    // exactly like TurnFailed.Err the tag is not the whole story:
    // marshalGateResolved projects it through gate.MarshalResponseAudit into a
    // sibling {kind,data} key. Asserting its presence here keeps
    // GateResolvedPayload's "deliberately not projected" comment honest — it is
    // a choice about what a browser needs, not a claim about the wire.
    const raw = object(JSON.parse(GATE_RESOLVED_ANSWERED_WIRE) as unknown);
    const audit = object(raw["audit"]);
    expect(audit["kind"]).toBe("permission");
    expect(object(audit["data"])["requirement_descriptions"]).toStrictEqual(["write file /tmp/x"]);
  });

  it("survives a GateOpened with no gate at all rather than throwing", () => {
    // NOT REAL WIRE (`gate` is omitzero over a struct whose ID is never zero in
    // practice), but a decoder must not crash the whole fold on one bad record.
    const decoded = decodeEnduring(envelope({ type: "GateOpened", loopId: LOOP_A }));
    if (decoded.payload.kind !== "GateOpened") throw new Error("unreachable");
    expect(decoded.payload.gate.id).toBe("");
    expect(isAnswerableGate(decoded.payload.gate)).toBe(false);
  });
});

/**
 * ## The COLD gate projection (`public_gate_page.schema.json`'s gate record)
 *
 * Everything above this line reads the durable gate envelope off a journal
 * event. The cases below read the OTHER source of the same gate: Factory's
 * `GET /v1/sessions/{sid}/gates` page, which is a pure durable read and is
 * therefore the only source available when no Host is reachable at all.
 *
 * Two properties are load-bearing and are asserted rather than described.
 *
 * REDACTION IS A CLAIM ABOUT A SET, not about the fields someone remembered.
 * The vendored record is `additionalProperties: true` at every level — gate,
 * prompt and control — so a Factory that put a prepared payload, a raw answer,
 * a grant, a credential or a continuation pointer on the wire would hand it
 * straight to a renderer if this decoder filtered a denylist. It does not: it
 * builds a fresh object from a NAMED allowlist, and the allowlist is pinned
 * against the schema's own declared property set in both directions, so a
 * property Core adds later is either classified here or fails
 * "partitions every property".
 *
 * ANSWERABILITY IS NOT THE PROMPT. An open journal event proves presentation,
 * never that anyone can apply a response (gate companion §5.3). So the
 * projection carries Factory's `answerability` verbatim as a plain string —
 * an unrecognized value must survive decoding, exactly as `kind` does — and
 * `acceptsResidentResponse` reads it as permission for ONE thing only.
 */
describe("decodeGateProjection", () => {
  const PAGE_GATE_SCHEMA = factoryPublicGatePageSchema.$defs.gate;
  const PROMPT_SCHEMA = factoryPublicGatePageSchema.$defs.prompt;
  const CONTROL_SCHEMA = factoryPublicGatePageSchema.$defs.prompt.properties.controls.items;

  const SCHEMA_LEVELS = {
    gate: Object.keys(PAGE_GATE_SCHEMA.properties),
    prompt: Object.keys(PROMPT_SCHEMA.properties),
    control: Object.keys(CONTROL_SCHEMA.properties),
  } as const;

  /** The vendored page fixture's single gate record — real Core bytes. */
  function fixtureGateRecord(): Record<string, unknown> {
    const page = object(
      JSON.parse(
        readFileSync(fileURLToPath(new URL("../../../contract/fixtures/public_gate_page.json", import.meta.url)), "utf8"),
      ) as unknown,
    );
    const gates = page["gates"];
    if (!Array.isArray(gates) || gates.length !== 1) throw new Error("fixture shape changed");
    return object(gates[0]);
  }

  /**
   * A shape signature: every key path reachable in `value`, with array indices
   * collapsed to `[]`. Two values with the same signature expose the same set
   * of fields regardless of what either one CONTAINS, which is the property a
   * redaction claim is actually about.
   */
  function keyPaths(value: unknown, prefix = ""): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
    if (typeof value !== "object" || value === null) return [];
    return Object.keys(value).flatMap((key) => {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return [path, ...keyPaths((value as Record<string, unknown>)[key], path)];
    });
  }

  function shape(value: unknown): string[] {
    return [...new Set(keyPaths(value))].sort();
  }

  /**
   * The key paths `GATE_PROJECTION_WIRE_FIELDS` CLAIMS the decoder emits.
   * Everything, including the two container prefixes, is read out of the table:
   * renaming `prompt` or `controls` there moves the derived paths with it, so
   * the comparison against `shape()` stays honest.
   */
  function projectedKeyPaths(): string[] {
    const { gate, prompt, control } = GATE_PROJECTION_WIRE_FIELDS;
    const promptPath = gate.projected.prompt;
    const controlsPath = `${promptPath}.${prompt.projected.controls}`;
    return [
      ...Object.values(gate.projected),
      ...Object.values(prompt.projected).map((name) => `${promptPath}.${name}`),
      ...Object.values(control.projected).map((name) => `${controlsPath}[].${name}`),
    ];
  }

  /**
   * Every private thing the spec names (§13's "Private gate payloads, raw
   * answers, tool secrets, and signed action URLs stay in private storage",
   * §16's "raw gate answers and other private command payloads are not exposed
   * by the public journal") plus the continuation pointer the gate companion
   * adds, each under a UNIQUE sentinel so a leak names itself.
   */
  const PRIVATE_POISON: Record<string, unknown> = {
    prepared: "SENTINEL-prepared-record",
    prepared_payload: { secret: "SENTINEL-prepared-payload" },
    payload: "SENTINEL-private-payload",
    answer: "SENTINEL-raw-answer",
    raw_answer: "SENTINEL-raw-answer-2",
    response: { action: "SENTINEL-submitted-response" },
    grant: "SENTINEL-grant",
    grants: ["SENTINEL-grants"],
    credential: "SENTINEL-credential",
    credentials: { token: "SENTINEL-credentials" },
    continuation: { pointer: "SENTINEL-continuation" },
    continuation_token: "SENTINEL-continuation-token",
    url: "https://example.invalid/SENTINEL-signed-url",
    signed_url: "https://example.invalid/SENTINEL-signed-url-2",
    audit: { data: "SENTINEL-audit" },
  };

  /** The fixture record, poisoned at all three levels of the record. */
  function poisonedRecord(): Record<string, unknown> {
    const record = fixtureGateRecord();
    const prompt = object(record["prompt"]);
    const controls = (prompt["controls"] as unknown[]).map((c) => ({ ...object(c), ...PRIVATE_POISON }));
    return {
      ...record,
      ...PRIVATE_POISON,
      prompt: { ...prompt, ...PRIVATE_POISON, controls },
    };
  }

  it("decodes the vendored Core gate page fixture's record", () => {
    expect(decodeGateProjection(fixtureGateRecord())).toStrictEqual({
      gateId: "gate-1",
      kind: GATE_KIND_ASK_USER,
      prompt: {
        title: "Continue?",
        body: "Choose a public option.",
        origin: "https://example.test",
        controls: [
          { action: "approve", label: "Approve" },
          { action: "cancel", label: "Cancel" },
        ],
      },
      openedEventId: "event-6",
      openedJournalSeq: 6,
      deadline: "2026-08-29T13:00:00Z",
      answerability: "resident",
    });
  });

  it("partitions every property the vendored schema declares, at all three levels", () => {
    // The anti-drift half. If Core adds a property to the gate record, the
    // prompt or a control, it is either named `projected` (and then the
    // decoder must carry it) or named `withheld` (and then it is redacted on
    // purpose) — never silently neither.
    for (const level of ["gate", "prompt", "control"] as const) {
      const { projected, withheld } = GATE_PROJECTION_WIRE_FIELDS[level];
      const declared = SCHEMA_LEVELS[level];
      expect(declared.length, `${level}: schema declares no properties`).toBeGreaterThan(0);
      expect(
        [...Object.keys(projected), ...withheld].sort(),
        `${level}: allowlist/withheld does not partition the schema`,
      ).toStrictEqual([...declared].sort());
      expect(
        Object.keys(projected).filter((name) => (withheld as readonly string[]).includes(name)),
        `${level}: a property is both projected and withheld`,
      ).toStrictEqual([]);
    }
  });

  it("withholds at least one DECLARED property, so the withheld side is not vacuous", () => {
    // `prompt.schema` is real, public, and deliberately not projected: a form
    // is answered out-of-band, so wui renders the title rather than building
    // inputs it will not submit (see the `Gate` decoder's own note). Without
    // this case the partition test would pass with every `withheld` list
    // empty and prove only that nothing was dropped.
    expect(GATE_PROJECTION_WIRE_FIELDS.prompt.withheld).toStrictEqual(["schema"]);
    const record = fixtureGateRecord();
    expect(Object.hasOwn(object(record["prompt"]), "schema")).toBe(true);
    expect(shape(decodeGateProjection(record))).not.toContain("prompt.schema");
  });

  it("emits the SAME field set whatever the record carries, at every level", () => {
    // `additionalProperties: true` at all three levels means the input space is
    // unbounded, so the assertion is on the OUTPUT: its key-path signature is a
    // constant, independent of the input. A decoder that copied unknown keys
    // through — or spread the record — cannot satisfy this.
    //
    // The expected set is DERIVED from the table, including the two container
    // names used as prefixes, so this is the table's second direction: naming a
    // field `withheld` while the decoder still carries it fails here. Pinned
    // against the literal list below so the derivation cannot be vacuous.
    const expected = [...projectedKeyPaths()].sort();
    expect(expected).toStrictEqual([
      "answerability",
      "deadline",
      "gateId",
      "kind",
      "openedEventId",
      "openedJournalSeq",
      "prompt",
      "prompt.body",
      "prompt.controls",
      "prompt.controls[].action",
      "prompt.controls[].label",
      "prompt.origin",
      "prompt.title",
    ]);
    for (const record of [fixtureGateRecord(), poisonedRecord()]) {
      expect(shape(decodeGateProjection(record))).toStrictEqual(expected);
    }
  });

  it("leaks no private field the spec names — gate, prompt or control level", () => {
    const decoded = JSON.stringify(decodeGateProjection(poisonedRecord()));
    // Anti-vacuity: the poison really is in the input, at all three levels.
    const poisoned = JSON.stringify(poisonedRecord());
    for (const key of Object.keys(PRIVATE_POISON)) {
      expect(Object.hasOwn(poisonedRecord(), key), `poison missing from the gate level: ${key}`).toBe(true);
    }
    expect(poisoned.match(/SENTINEL-/g)?.length ?? 0).toBeGreaterThanOrEqual(3 * Object.keys(PRIVATE_POISON).length);
    expect(decoded).not.toMatch(/SENTINEL-/);
  });

  it("collapses a junk record to the empty projection instead of throwing", () => {
    // NOT REAL WIRE. Same fail-secure rule decodeGate follows: a renderer must
    // not lose the whole session view to one bad record, and an empty
    // projection is not `resident`, so nothing is offered for it.
    for (const junk of [undefined, null, "gate", 7, [], { prompt: 5, gate_id: 9 }]) {
      const projection = decodeGateProjection(junk);
      expect(projection.gateId).toBe("");
      expect(projection.openedJournalSeq).toBe(0);
      expect(projection.prompt.controls).toStrictEqual([]);
      expect(acceptsResidentResponse(projection)).toBe(false);
    }
    // A control that is not an object is DROPPED, not coerced to an empty
    // pair: `{action:"",label:""}` would render a nameless button that harness
    // rejects with `gate_action_invalid`. (`decodeGate` drops the same way.)
    expect(
      decodeGateProjection({ prompt: { controls: ["approve", null, 7, { action: "Deny" }] } }).prompt.controls,
    ).toStrictEqual([{ action: "Deny", label: "" }]);
  });
});

describe("gate answerability", () => {
  it("mirrors the vendored schema's enum exactly, in order", () => {
    expect(GATE_ANSWERABILITY_VALUES).toStrictEqual([
      "resident",
      "suspended",
      "submitted",
      "unavailable",
      "expired",
    ]);
    // And the literals above are not just a copy of themselves: they are the
    // schema's own enum, so a Core rename fails here rather than in a renderer.
    expect([...GATE_ANSWERABILITY_VALUES]).toStrictEqual([
      ...factoryPublicGatePageSchema.$defs.gate.properties.answerability.enum,
    ]);
  });

  it("keeps an unrecognized answerability rather than normalising it away", () => {
    // Same rule as `kind`: the value set can grow, and a value this build does
    // not know must survive decoding so a renderer can say "unknown" instead of
    // silently reading it as one of the five.
    expect(decodeGateProjection({ answerability: "quarantined" }).answerability).toBe("quarantined");
    expect(isGateAnswerability("quarantined")).toBe(false);
    for (const value of GATE_ANSWERABILITY_VALUES) expect(isGateAnswerability(value)).toBe(true);
    for (const junk of [undefined, null, 7, ["resident"], { answerability: "resident" }]) {
      expect(isGateAnswerability(junk)).toBe(false);
    }
  });

  it("exposes a resident response for `resident` and for NOTHING else", () => {
    // The whole declared space is five values; it is small, so it is enumerated
    // rather than sampled. "" is the sixth case and is not wire: it is what a
    // gate observed only through a journal event carries, because an open event
    // proves presentation and never answerability (gate companion §5.3).
    //
    // `suspended` is the interesting negative. It IS the state in which a cold
    // answer can resume — and it is still false here, because this task exposes
    // the RESIDENT capability only. Widening it is a separate change with its
    // own continuation requirements.
    const permitted = GATE_ANSWERABILITY_VALUES.filter((value) => acceptsResidentResponse({ answerability: value }));
    expect(permitted).toStrictEqual(["resident"]);
    for (const value of ["", "Resident", "RESIDENT", "resident ", "quarantined", "suspended"]) {
      expect(acceptsResidentResponse({ answerability: value }), `answerability ${JSON.stringify(value)}`).toBe(
        value === "resident",
      );
    }
  });
});
