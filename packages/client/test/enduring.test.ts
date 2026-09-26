/**
 * The enduring payload dispatch, and the zero-UUID rule the whole §3b user-row
 * gate rests on.
 *
 * ## Both wire spellings of a zero id are real, and both are in this repo
 *
 * `identity.Coordinates` and `identity.Cause` tag every id `omitzero`, and
 * `event.Header` tags the whole `Cause` struct `omitzero` as well (verified in
 * harness@v0.30.0's `pkg/identity/identifier_types.go` and `pkg/event/event.go`,
 * the version `contract/VERSION` pins). `uuid.UUID` is `[16]byte`, so its zero
 * value is the zero array and `omitzero` really does drop the key. PRODUCTION
 * therefore OMITS a zero id, and omits `cause` entirely when nothing in it is
 * set.
 *
 * The vendored fixtures spell the zero OUT anyway. harness's own
 * `pkg/serve/fixtures_test.go` drives the real handlers with real NON-zero ids
 * and then normalises the bodies with `uuidRE.ReplaceAll(b, []byte(zeroUUID))`
 * — a REPLACEMENT, so every key survives and its value becomes "000…0".
 *
 * Both forms consequently appear in one file: `journal_page.json`'s TurnDone
 * carries `"loop_id":"00000000-…"` spelled out, carries no `step_id` key at
 * all, and carries no `cause` key at all. Every claim about the two forms below
 * is READ OUT OF THOSE BYTES rather than written as a literal — a literal would
 * only re-assert the author's belief about the wire, which is exactly the
 * failure mode this task exists to avoid.
 *
 * Why it matters past cosmetics: §3b commits a user row only when
 * `Header.Cause.LoopID` is zero, and a non-zero cause loop id is a subagent
 * hand-back that must commit NO row. `cause.loop_id === undefined` alone passes
 * every hand-written case in this file and then mis-classifies the fixture,
 * rendering a phantom user message on every hand-back.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeEnduring, eventPrincipal, isZeroUUID, principalLabel, rejectReasonText } from "../src/enduring.js";
import type { EventEnvelope } from "../src/types.js";
import { LOOP_A, LOOP_B, ZERO_UUID, envelope, textBlockWire, userMessageWire } from "./helpers.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixtureJson(file: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + file, "utf8")) as unknown;
}

/** Narrows a parsed fixture node to an object, failing loudly rather than casting. */
function object(x: unknown): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(x)}`);
  }
  return x as Record<string, unknown>;
}

/**
 * Reads a wire id WITHOUT collapsing an absent key to "" — `undefined` here
 * means the key is genuinely missing from the bytes, which is the distinction
 * the whole file is about. (`str()` from blocks.ts deliberately does collapse
 * it, so it cannot be used to establish the difference.)
 */
function wireId(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
}

/** `journal_page.json`'s single TurnDone envelope, straight from the file. */
function fixtureTurnDone(): Record<string, unknown> {
  const page = object(readFixtureJson("journal_page.json"));
  const events = page["events"];
  if (!Array.isArray(events) || events.length !== 1) {
    throw new Error(`journal_page.json: expected exactly one event, got ${JSON.stringify(events)}`);
  }
  return object(object(events[0])["event"]);
}

/** `status_running.json`'s `last_step` StepDone envelope, straight from the file. */
function fixtureStepDone(): Record<string, unknown> {
  const status = object(readFixtureJson("status_running.json"));
  return object(object(status["last_step"])["event"]);
}

function asEnvelope(raw: Record<string, unknown>): EventEnvelope {
  return raw as unknown as EventEnvelope;
}

// --- isZeroUUID, against the two spellings the real corpus contains ---------

describe("isZeroUUID", () => {
  it("accepts the EXPLICIT all-zeros form the vendored fixtures actually carry", () => {
    const event = fixtureTurnDone();
    // The key is PRESENT with a spelled-out zero value. If this ever flips to
    // absent, the assertion below is the one that says so.
    expect(Object.hasOwn(event, "loop_id")).toBe(true);
    const loopId = wireId(event, "loop_id");
    expect(loopId).toBe(ZERO_UUID);
    expect(isZeroUUID(loopId)).toBe(true);
  });

  it("accepts an ABSENT coordinate — the fixture's TurnDone has no step_id key", () => {
    const event = fixtureTurnDone();
    // TurnDone is turn-scoped, so Header.Coordinates.StepID is the zero uuid and
    // `json:"step_id,omitzero"` drops the key. This is omitzero, observed.
    expect(Object.hasOwn(event, "step_id")).toBe(false);
    const stepId = wireId(event, "step_id");
    expect(stepId).toBeUndefined();
    expect(isZeroUUID(stepId)).toBe(true);
  });

  it("accepts an ABSENT cause id — the fixture carries no `cause` key at all", () => {
    const event = fixtureTurnDone();
    // Header.Cause is `json:"cause,omitzero"` over a comparable struct, so a
    // wholly-zero cause emits nothing. This is the exact read §3b performs.
    expect(Object.hasOwn(event, "cause")).toBe(false);
    const causeLoopId = wireId(object(event["cause"] ?? {}), "loop_id");
    expect(causeLoopId).toBeUndefined();
    expect(isZeroUUID(causeLoopId)).toBe(true);
  });

  it("accepts \"\", the shape decodeEnduring normalises an absent id to", () => {
    expect(isZeroUUID("")).toBe(true);
  });

  it("rejects a real id, including one a single nibble away from the fixture's zero", () => {
    const zero = wireId(fixtureTurnDone(), "loop_id");
    expect(zero).toBe(ZERO_UUID);
    const nearlyZero = `1${(zero ?? "").slice(1)}`;
    expect(nearlyZero).toHaveLength(36);
    expect(isZeroUUID(nearlyZero)).toBe(false);
    expect(isZeroUUID(LOOP_A)).toBe(false);
  });
});

describe("message input and stamped principal", () => {
  const alex = { tenant: "acme", subject: "user_alex", kind: "actor" };

  it("decodes TurnStarted input but does not project audit-only metadata", () => {
    const decoded = decodeEnduring(envelope({
      type: "TurnStarted",
      payload: {
        message: userMessageWire([textBlockWire("[from: Alex]"), textBlockWire("add milk")]),
        input: { principal: alex, metadata: { space: "family" }, prefix: 1 },
      },
    }));
    expect(decoded.payload).toMatchObject({ input: { principal: alex, prefix: 1, suffix: 0 } });
    expect((decoded.payload as { input: object }).input).not.toHaveProperty("metadata");
  });

  it("preserves the pre-feature payload shape when input is absent", () => {
    const decoded = decodeEnduring(envelope({ type: "TurnStarted", payload: { message: userMessageWire([textBlockWire("hi")]) } }));
    expect(decoded.payload).not.toHaveProperty("input");
  });

  it("decodes input on TurnFoldedInto and InputCancelled", () => {
    for (const type of ["TurnFoldedInto", "InputCancelled"]) {
      const decoded = decodeEnduring(envelope({ type, payload: { input: { principal: alex, suffix: 2 } } }));
      expect(decoded.payload).toMatchObject({ input: { principal: alex, prefix: 0, suffix: 2 } });
    }
  });

  it("decodes interrupt and gate principals but drops malformed principals", () => {
    expect(decodeEnduring(envelope({ type: "TurnInterrupted", payload: { principal: alex } })).payload)
      .toStrictEqual({ kind: "TurnInterrupted", turnIndex: 0, principal: alex });
    expect(decodeEnduring(envelope({ type: "GateResolved", payload: { gate_id: "g1", principal: alex } })).payload)
      .toMatchObject({ kind: "GateResolved", principal: alex });
    for (const bad of [{ tenant: "acme", subject: "", kind: "actor" }, { tenant: "acme", subject: "x", kind: "robot" }, "alex", null]) {
      expect(decodeEnduring(envelope({ type: "TurnInterrupted", payload: { principal: bad } })).payload)
        .not.toHaveProperty("principal");
    }
  });

  it("finds principals in public event bodies and labels service senders", () => {
    expect(eventPrincipal({ type: "TurnStarted", input: { principal: alex } })).toStrictEqual(alex);
    expect(eventPrincipal({ type: "GateResolved", principal: { ...alex, subject: "svc", kind: "service" } }))
      .toStrictEqual({ ...alex, subject: "svc", kind: "service" });
    expect(eventPrincipal({ type: "StepDone" })).toBeUndefined();
    expect(eventPrincipal("bad body")).toBeUndefined();
    expect(principalLabel({ ...alex, kind: "actor" })).toBe("user_alex");
    expect(principalLabel({ ...alex, subject: "svc", kind: "service" })).toBe("service svc");
  });
});

// --- the shared header projection -------------------------------------------

describe("decodeEnduring: the shared header projection", () => {
  it("projects the promoted header coordinates off a REAL fixture envelope", () => {
    const decoded = decodeEnduring(asEnvelope(fixtureTurnDone()));
    expect(decoded.type).toBe("TurnDone");
    expect(decoded.loopId).toBe(ZERO_UUID);
    expect(decoded.turnId).toBe(ZERO_UUID);
    expect(decoded.eventId).toBe(ZERO_UUID);
    expect(decoded.createdAt).toBe("2026-07-08T12:00:00Z");
    // Absent on the wire, "" after projection — never undefined.
    expect(decoded.stepId).toBe("");
    expect(decoded.agentName).toBe("");
    expect(decoded.causeLoopId).toBe("");
    expect(decoded.causeCommandId).toBe("");
  });

  it("projects distinct hand-authored coordinates onto every decoded payload", () => {
    const decoded = decodeEnduring(
      envelope({
        type: "ContextMeasured",
        loopId: LOOP_A,
        turnId: LOOP_B,
        stepId: ZERO_UUID,
        eventId: "e1",
        createdAt: "2026-08-27T10:00:00Z",
        agentName: "primer",
        cause: { loop_id: LOOP_B, command_id: "c1" },
      }),
    );
    expect(decoded.type).toBe("ContextMeasured");
    expect(decoded.loopId).toBe(LOOP_A);
    expect(decoded.turnId).toBe(LOOP_B);
    expect(decoded.stepId).toBe(ZERO_UUID);
    expect(decoded.eventId).toBe("e1");
    expect(decoded.createdAt).toBe("2026-08-27T10:00:00Z");
    expect(decoded.agentName).toBe("primer");
    expect(decoded.causeLoopId).toBe(LOOP_B);
    expect(decoded.causeCommandId).toBe("c1");
  });

  it("reports a missing cause as zero coordinates, not undefined", () => {
    const decoded = decodeEnduring(envelope({ type: "SessionIdle" }));
    expect(decoded.causeLoopId).toBe("");
    expect(decoded.causeCommandId).toBe("");
    expect(decoded.loopId).toBe("");
  });

  it("survives a null or non-object cause rather than throwing", () => {
    // `null` is the case the isRecord guard exists for: indexing it would throw,
    // and a thrown decoder on the render path blanks the whole transcript.
    const nullCause = decodeEnduring(
      envelope({ type: "SessionIdle", cause: null as unknown as Record<string, unknown> }),
    );
    expect(nullCause.causeLoopId).toBe("");
    const arrayCause = decodeEnduring(
      envelope({ type: "SessionIdle", cause: ["not", "an", "object"] as unknown as Record<string, unknown> }),
    );
    expect(arrayCause.causeLoopId).toBe("");
  });

  it("keeps the raw envelope on the decoded value so nothing is lost", () => {
    const env = envelope({ type: "SomethingBrandNew", loopId: LOOP_A });
    expect(decodeEnduring(env).envelope).toBe(env);
  });
});

// --- the §3b gate: decodeEnduring composed with isZeroUUID -------------------

describe("decodeEnduring + isZeroUUID (the §3b user-row gate)", () => {
  it("classifies the fixture's ABSENT cause as zero once projection has made it \"\"", () => {
    const decoded = decodeEnduring(asEnvelope(fixtureTurnDone()));
    expect(decoded.causeLoopId).toBe("");
    expect(isZeroUUID(decoded.causeLoopId)).toBe(true);
  });

  it("classifies a SPELLED-OUT zero cause as zero too — the fixture normalizer's shape", () => {
    // The fixture corpus proves this spelling is producible; re-use its own
    // bytes rather than a literal to build the cause the normalizer would leave.
    const zero = wireId(fixtureTurnDone(), "loop_id");
    const decoded = decodeEnduring(
      envelope({ type: "TurnFoldedInto", loopId: LOOP_A, cause: { loop_id: zero, command_id: "c1" } }),
    );
    expect(decoded.causeLoopId).toBe(ZERO_UUID);
    expect(isZeroUUID(decoded.causeLoopId)).toBe(true);
  });

  it("classifies a subagent hand-back's cause loop id as NON-zero", () => {
    const decoded = decodeEnduring(
      envelope({ type: "TurnFoldedInto", loopId: LOOP_A, cause: { loop_id: LOOP_B, command_id: "c2" } }),
    );
    expect(isZeroUUID(decoded.causeLoopId)).toBe(false);
  });
});

// --- the long-tail fallback --------------------------------------------------

describe("decodeEnduring: the untyped long tail", () => {
  it("falls back for ContextMeasured, design §3a's named long tail", () => {
    const decoded = decodeEnduring(envelope({ type: "ContextMeasured", loopId: LOOP_A }));
    expect(decoded.payload).toEqual({ kind: "other" });
  });

  it("falls back for a type this build has never heard of, rather than throwing", () => {
    const decoded = decodeEnduring(
      envelope({
        type: "SomethingBrandNew",
        loopId: LOOP_A,
        payload: { message: userMessageWire([textBlockWire("hello")]) },
      }),
    );
    expect(decoded.type).toBe("SomethingBrandNew");
    expect(decoded.payload).toEqual({ kind: "other" });
  });

  it("falls back for an envelope with no type at all", () => {
    const decoded = decodeEnduring({} as unknown as EventEnvelope);
    expect(decoded.type).toBe("");
    expect(decoded.payload).toEqual({ kind: "other" });
  });
});

// --- Task 3.5: the turn openers ---------------------------------------------

/**
 * ## Provenance of the wire strings from here down
 *
 * `contract/fixtures/` carries exactly TWO enduring envelopes — `journal_page
 * .json`'s TurnDone and `status_running.json`'s StepDone — so TurnStarted,
 * TurnFoldedInto, TurnRejected, TurnFailed, TurnInterrupted and InputCancelled
 * have NO fixture coverage at all. Hand-authoring them would only encode this
 * author's beliefs about the wire and pass happily if those beliefs were wrong
 * (the mistake blocks.test.ts's header describes).
 *
 * Every `*_WIRE` constant below is therefore the VERBATIM stdout of
 * `event.MarshalEvent` in `github.com/looprig/harness@v0.30.0` — this module's
 * pin, and the version `contract/VERSION` records — driven by a throwaway main
 * package that constructed the real event values. They are parsed with
 * JSON.parse so the tests consume bytes, not JS object literals. The two real
 * fixtures are still read from disk and asserted alongside them.
 *
 * Regenerate by marshalling the same values against that harness version. The
 * ids are helpers.ts's SESSION_ID / LOOP_A / LOOP_B plus the four below, so the
 * bytes line up with the rest of the suite.
 *
 * Cases labelled NOT REAL WIRE are exactly that: shapes a corrupted record or
 * a wrong assumption would produce, kept so a decoder reading the wrong key
 * could not pass this file.
 */
const TURN_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STEP_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EVENT_1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CMD_1 = "ffffffff-ffff-4fff-8fff-ffffffffffff";

/** Parses one real marshalled envelope, so the test decodes bytes, not a literal. */
function wireEnvelope(json: string): EventEnvelope {
  return asEnvelope(object(JSON.parse(json) as unknown));
}

const TURN_STARTED_WIRE =
  '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"do the thing","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":3,"type":"TurnStarted","v":1}';

const TURN_STARTED_BARE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"TurnStarted","v":1}';

const TURN_FOLDED_INTO_WIRE =
  '{"cause":{"loop_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"subagent result","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":4,"type":"TurnFoldedInto","v":1}';

describe("decodeEnduring: turn openers", () => {
  it("decodes a REAL TurnStarted's user message and turn_index", () => {
    const decoded = decodeEnduring(wireEnvelope(TURN_STARTED_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnStarted",
      turnIndex: 3,
      message: {
        role: "user",
        blocks: [{ type: "text", text: "do the thing" }],
        toolUseId: "",
        isError: false,
      },
    });
    // The header half the §3b gate reads. MarshalEvent emitted `cause` with a
    // command_id and NO loop_id, which is the genuine-user-input shape.
    expect(decoded.causeCommandId).toBe(CMD_1);
    expect(decoded.causeLoopId).toBe("");
    expect(isZeroUUID(decoded.causeLoopId)).toBe(true);
    expect(decoded.turnId).toBe(TURN_1);
    expect(decoded.eventId).toBe(EVENT_1);
  });

  it("decodes a REAL TurnFoldedInto under its own kind, with its own turn_index", () => {
    const decoded = decodeEnduring(wireEnvelope(TURN_FOLDED_INTO_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnFoldedInto",
      turnIndex: 4,
      message: {
        role: "user",
        blocks: [{ type: "text", text: "subagent result" }],
        toolUseId: "",
        isError: false,
      },
    });
    // A non-zero cause loop id is a subagent hand-back: §3b commits NO user row.
    expect(decoded.causeLoopId).toBe(LOOP_B);
    expect(isZeroUUID(decoded.causeLoopId)).toBe(false);
  });

  it("survives a REAL omitzero TurnStarted: no message key, no turn_index key", () => {
    // MarshalEvent of TurnStarted{Message: nil, TurnIndex: 0} — `omitzero` on
    // both fields drops both keys, and the wholly-zero Cause drops `cause` too.
    const raw = object(JSON.parse(TURN_STARTED_BARE_WIRE) as unknown);
    expect(Object.hasOwn(raw, "message")).toBe(false);
    expect(Object.hasOwn(raw, "turn_index")).toBe(false);
    expect(Object.hasOwn(raw, "cause")).toBe(false);
    const decoded = decodeEnduring(asEnvelope(raw));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnStarted",
      turnIndex: 0,
      message: undefined,
    });
  });

  it("reports a non-object message as absent rather than an empty row", () => {
    // NOT REAL WIRE: `message` is `*content.UserMessage`, so a corrupted record
    // is the only way `null` gets here. Returning a role-less empty message
    // would render a blank user row; `undefined` lets the projection skip it.
    const decoded = decodeEnduring(
      envelope({ type: "TurnStarted", loopId: LOOP_A, payload: { message: null } }),
    );
    expect(decoded.payload).toStrictEqual({ kind: "TurnStarted", turnIndex: 0, message: undefined });
  });

  it("reports a non-numeric turn_index as 0 rather than NaN", () => {
    // NOT REAL WIRE: TurnIndex is a Go int. NaN would poison every comparison
    // downstream, so a malformed value reads as the zero turn.
    const decoded = decodeEnduring(
      envelope({ type: "TurnFoldedInto", loopId: LOOP_A, payload: { turn_index: "3" } }),
    );
    expect(decoded.payload).toStrictEqual({
      kind: "TurnFoldedInto",
      turnIndex: 0,
      message: undefined,
    });
  });
});

// --- Task 3.6: StepDone, the authoritative commit point ----------------------

const STEP_DONE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Signature":"sig","Thinking":"plan","type":"thinking"},{"Text":"reading it now","type":"text"},{"ID":"toolu_1","Input":{"path":"/a"},"Name":"Read","type":"tool_use"}],"usage":{"InputTokens":10,"OutputTokens":4}},{"role":"tool","blocks":[{"Text":"file contents","type":"text"}],"tool_use_id":"toolu_1"}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

const STEP_DONE_TRUNCATED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Text":"partial answer","type":"text"},{"Text":"[response truncated: stream failed]","type":"text"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

describe("decodeEnduring: StepDone", () => {
  it("decodes a REAL finalized step group in order", () => {
    const decoded = decodeEnduring(wireEnvelope(STEP_DONE_WIRE));
    expect(decoded.stepId).toBe(STEP_1);
    expect(decoded.payload).toStrictEqual({
      kind: "StepDone",
      messages: [
        {
          role: "assistant",
          blocks: [
            { type: "thinking", thinking: "plan", signature: "sig", redacted: false },
            { type: "text", text: "reading it now" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } },
          ],
          toolUseId: "",
          isError: false,
        },
        {
          role: "tool",
          blocks: [{ type: "text", text: "file contents" }],
          toolUseId: "toolu_1",
          isError: false,
        },
      ],
    });
  });

  it("decodes the REAL vendored fixture's StepDone: one blockless AIMessage", () => {
    // status_running.json's `last_step` is the only StepDone in the vendored
    // corpus, and its group is a lone {"role":"assistant"} with NO blocks key.
    // Before this task it fell through to `other`, which is exactly why a
    // replayed session rendered blank.
    const stepDone = fixtureStepDone();
    expect(stepDone["type"]).toBe("StepDone");
    expect(decodeEnduring(asEnvelope(stepDone)).payload).toStrictEqual({
      kind: "StepDone",
      messages: [{ role: "assistant", blocks: [], toolUseId: "", isError: false }],
    });
  });

  it("keeps the AIMessage's OWN usage out of the decoded message", () => {
    // The real bytes above carry `"usage":{"InputTokens":10,"OutputTokens":4}`
    // inside the assistant message. decodeMessage deliberately drops it: turn
    // accounting comes from TurnDone's top-level `usage`, whose shape is
    // different (all five counters, never omitted), so decoding both would give
    // two easily double-counted sources. Read it out of the bytes rather than
    // asserting a belief that it is there.
    const messages = JSON.parse(STEP_DONE_WIRE) as { messages: Array<Record<string, unknown>> };
    expect(messages.messages[0]?.["usage"]).toEqual({ InputTokens: 10, OutputTokens: 4 });
    const decoded = decodeEnduring(wireEnvelope(STEP_DONE_WIRE));
    if (decoded.payload.kind !== "StepDone") throw new Error("unreachable");
    expect(Object.hasOwn(decoded.payload.messages[0] ?? {}, "usage")).toBe(false);
  });

  it("decodes a TRUNCATED step, whose group is a lone AIMessage ending in the notice", () => {
    // harness emits StepDone for a truncated step too: the loop commits the safe
    // prefix (text and sealed reasoning, never a partial tool call) so watched
    // content is not discarded, and the turn still ends on TurnFailed. The
    // notice is an ordinary text block — there is no distinguishing tag, so a
    // consumer that needs to tell the two apart reads the turn TERMINAL.
    const decoded = decodeEnduring(wireEnvelope(STEP_DONE_TRUNCATED_WIRE));
    if (decoded.payload.kind !== "StepDone") throw new Error("unreachable");
    expect(decoded.payload.messages).toHaveLength(1);
    expect(decoded.payload.messages[0]?.blocks).toStrictEqual([
      { type: "text", text: "partial answer" },
      { type: "text", text: "[response truncated: stream failed]" },
    ]);
  });

  it("decodes an absent `messages` as an empty group, though no producer emits one", () => {
    // NOT REAL WIRE. `messages` is omitempty, but MarshalEvent REFUSES a StepDone
    // whose Messages is empty: validateStepDoneMessages returns
    //   event: invalid StepDone: Messages is invalid
    // (verified by marshalling StepDone{Header: ...} against harness v0.30.0).
    // So "a step that decoded nothing usable emits no StepDone at all" is not
    // merely a convention — the durable write boundary enforces it, which is
    // why the turn terminals must commit any dangling live segment themselves.
    // This case is defensive only: an empty group must not throw on the render
    // path, and it must not be mistaken for a commit.
    const decoded = decodeEnduring(envelope({ type: "StepDone", loopId: LOOP_A }));
    expect(decoded.payload).toStrictEqual({ kind: "StepDone", messages: [] });
  });

  it("skips a null element rather than committing a blank row", () => {
    // marshalMessages can legitimately emit a null element for a nil message in
    // the slice; decodeMessages filters non-objects.
    const decoded = decodeEnduring(
      envelope({
        type: "StepDone",
        loopId: LOOP_A,
        payload: { messages: [null, { role: "assistant", blocks: [textBlockWire("kept")] }] },
      }),
    );
    if (decoded.payload.kind !== "StepDone") throw new Error("unreachable");
    expect(decoded.payload.messages).toHaveLength(1);
    expect(decoded.payload.messages[0]?.role).toBe("assistant");
  });

  it("reports a non-array `messages` as an empty group rather than throwing", () => {
    // NOT REAL WIRE: content.AgenticMessages always marshals to an array.
    const decoded = decodeEnduring(
      envelope({ type: "StepDone", loopId: LOOP_A, payload: { messages: { role: "assistant" } } }),
    );
    expect(decoded.payload).toStrictEqual({ kind: "StepDone", messages: [] });
  });
});

// --- Task 3.7: the turn terminals, TurnRejected and InputCancelled -----------

const TURN_DONE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"assistant","blocks":[{"Text":"done","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":1,"type":"TurnDone","usage":{"InputTokens":10,"OutputTokens":4,"CacheReadTokens":0,"CacheCreationTokens":0,"ReasoningTokens":0},"v":1}';

const TURN_DONE_ALL_USAGE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"assistant","blocks":[{"Text":"accounted for","type":"text"}],"usage":{"InputTokens":1,"OutputTokens":2}},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":9,"type":"TurnDone","usage":{"InputTokens":11,"OutputTokens":22,"CacheReadTokens":33,"CacheCreationTokens":44,"ReasoningTokens":5},"v":1}';

const TURN_DONE_ZERO_USAGE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"assistant","blocks":[{"Text":"quiet","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":2,"type":"TurnDone","v":1}';

const TURN_FAILED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","err":{"kind":"unknown","message":"provider exploded: upstream 500"},"event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":2,"type":"TurnFailed","v":1}';

const TURN_FAILED_TOOL_LIMIT_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","err":{"kind":"tool_limit","message":"tool limit reached: 12/12 iterations, 40/60 calls"},"event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":6,"type":"TurnFailed","v":1}';

const TURN_FAILED_NIL_ERR_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","err":{"kind":"unknown","message":""},"event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":8,"type":"TurnFailed","v":1}';

const TURN_INTERRUPTED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":5,"type":"TurnInterrupted","v":1}';

/** The four RejectReason values, each marshalled from the real Go constant. */
const TURN_REJECTED_WIRE: ReadonlyArray<{
  label: string;
  json: string;
  reason: number;
  reasonText: string;
}> = [
  {
    label: "RejectUnspecified (the zero sentinel, omitzero-dropped)",
    reasonText: "an unspecified reason",
    reason: 0,
    json: '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","type":"TurnRejected","v":1}',
  },
  {
    label: "RejectQueueFull",
    reasonText: "the loop's queue is full",
    reason: 1,
    json: '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":1,"session_id":"11111111-1111-4111-8111-111111111111","type":"TurnRejected","v":1}',
  },
  {
    label: "RejectShuttingDown",
    reasonText: "the loop is shutting down",
    reason: 2,
    json: '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":2,"session_id":"11111111-1111-4111-8111-111111111111","type":"TurnRejected","v":1}',
  },
  {
    label: "RejectInternal",
    reasonText: "a transient internal failure",
    reason: 3,
    json: '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":3,"session_id":"11111111-1111-4111-8111-111111111111","type":"TurnRejected","v":1}',
  },
];

const INPUT_CANCELLED_RETRACTED_WIRE =
  '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"never ran","type":"text"}]},"session_id":"11111111-1111-4111-8111-111111111111","type":"InputCancelled","v":1}';

const INPUT_CANCELLED_INTERRUPTED_WIRE =
  '{"cause":{"command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","blocks":[{"Text":"returned to sender","type":"text"}]},"reason":1,"session_id":"11111111-1111-4111-8111-111111111111","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","turn_index":7,"type":"InputCancelled","v":1}';

describe("decodeEnduring: TurnDone", () => {
  it("decodes a REAL TurnDone's complete AI message and its own five-counter usage", () => {
    const decoded = decodeEnduring(wireEnvelope(TURN_DONE_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnDone",
      turnIndex: 1,
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "done" }],
        toolUseId: "",
        isError: false,
      },
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
    });
  });

  it("carries all five counters, none of them collapsed into another", () => {
    // Five distinct values, so a decoder that read one key for another (or
    // dropped one) cannot pass. content.Usage has NO json tags and no codec, so
    // TurnDone's field marshals as a bare Go-cased struct.
    const decoded = decodeEnduring(wireEnvelope(TURN_DONE_ALL_USAGE_WIRE));
    if (decoded.payload.kind !== "TurnDone") throw new Error("unreachable");
    expect(decoded.payload.turnIndex).toBe(9);
    expect(decoded.payload.usage).toStrictEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreationTokens: 44,
      reasoningTokens: 5,
    });
  });

  it("reads TURN accounting from TurnDone's own usage, never the AIMessage's", () => {
    // The SAME bytes carry both usage shapes, and they disagree on purpose:
    //   top-level  usage {"InputTokens":11,...,"ReasoningTokens":5}  — all five,
    //              never dropped, because content.Usage is tag-free.
    //   message's  usage {"InputTokens":1,"OutputTokens":2}          — usageJSON's
    //              `json:",omitempty"` drops the three zeros.
    // Two incompatible shapes under one key name: they must not share a type.
    const raw = object(JSON.parse(TURN_DONE_ALL_USAGE_WIRE) as unknown);
    const messageUsage = object(object(raw["message"])["usage"] ?? {});
    expect(messageUsage).toEqual({ InputTokens: 1, OutputTokens: 2 });
    expect(Object.hasOwn(messageUsage, "CacheReadTokens")).toBe(false);
    expect(Object.keys(object(raw["usage"] ?? {}))).toHaveLength(5);

    const decoded = decodeEnduring(asEnvelope(raw));
    if (decoded.payload.kind !== "TurnDone") throw new Error("unreachable");
    expect(decoded.payload.usage.inputTokens).toBe(11);
    expect(decoded.payload.usage.outputTokens).toBe(22);
    // The message's own usage stays undecoded, so there is only one source.
    expect(Object.hasOwn(decoded.payload.message ?? {}, "usage")).toBe(false);
  });

  it("decodes a REAL wholly-zero usage from an ABSENT usage key (omitzero)", () => {
    // TurnDone.Usage is `json:"usage,omitzero"` over a comparable struct, so an
    // all-zero Usage drops the WHOLE key — verified by marshalling a real
    // TurnDone{}. Every counter must still project to 0, never undefined.
    const raw = object(JSON.parse(TURN_DONE_ZERO_USAGE_WIRE) as unknown);
    expect(Object.hasOwn(raw, "usage")).toBe(false);
    const decoded = decodeEnduring(asEnvelope(raw));
    if (decoded.payload.kind !== "TurnDone") throw new Error("unreachable");
    expect(decoded.payload.turnIndex).toBe(2);
    expect(decoded.payload.usage).toStrictEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("decodes the REAL vendored fixture's TurnDone: turn_index only, no message", () => {
    // journal_page.json carries the corpus's only TurnDone. It has turn_index 1
    // and neither a message nor a usage key. Before this task it fell through to
    // `other`.
    const decoded = decodeEnduring(asEnvelope(fixtureTurnDone()));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnDone",
      turnIndex: 1,
      message: undefined,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
    });
  });

  it("reports a snake_case usage key as zero, because content.Usage is Go-cased", () => {
    // NOT REAL WIRE: content.Usage declares no json tags at all, so
    // encoding/json emits the exported field names verbatim. A snake_case
    // assumption would silently report a free turn.
    const decoded = decodeEnduring(
      envelope({
        type: "TurnDone",
        loopId: LOOP_A,
        payload: { usage: { input_tokens: 10, output_tokens: 4 } },
      }),
    );
    if (decoded.payload.kind !== "TurnDone") throw new Error("unreachable");
    expect(decoded.payload.usage.inputTokens).toBe(0);
    expect(decoded.payload.usage.outputTokens).toBe(0);
  });
});

describe("decodeEnduring: TurnFailed and TurnInterrupted", () => {
  it("decodes a REAL TurnFailed's projected error, which DOES reach the wire", () => {
    // TurnFailed.Err is tagged `json:"-"`, but the struct tag is not the whole
    // story: marshalTurnFailed encodes turnFailedWire, which PROJECTS Err onto a
    // stable {kind,message} pair (projectError in harness/pkg/event/marshal.go).
    // Verified by marshalling a real TurnFailed against harness v0.30.0 — the
    // envelope carries an `err` object. A decoder that trusted the struct tag
    // alone would render "the turn failed" over a message the journal has.
    const decoded = decodeEnduring(wireEnvelope(TURN_FAILED_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnFailed",
      turnIndex: 2,
      errorKind: "unknown",
      errorMessage: "provider exploded: upstream 500",
    });
  });

  it("decodes a typed cause's stable kind string", () => {
    // ErrKind projects the in-package causes to stable strings that are part of
    // the durable contract: empty_response, tool_limit, turn_panic, unknown.
    // Provider/stream errors are deliberately NOT enumerated (the event package
    // is a leaf), so they arrive as "unknown" with their full text preserved.
    const decoded = decodeEnduring(wireEnvelope(TURN_FAILED_TOOL_LIMIT_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnFailed",
      turnIndex: 6,
      errorKind: "tool_limit",
      errorMessage: "tool limit reached: 12/12 iterations, 40/60 calls",
    });
  });

  it("decodes an absent cause as kind unknown with an empty message", () => {
    // projectError(nil) emits {"kind":"unknown","message":""} rather than
    // omitting `err`, so the pointer's omitempty never actually fires. An empty
    // message is the one case a renderer must fall back to generic wording.
    const decoded = decodeEnduring(wireEnvelope(TURN_FAILED_NIL_ERR_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnFailed",
      turnIndex: 8,
      errorKind: "unknown",
      errorMessage: "",
    });
  });

  it("survives an entirely missing err object rather than throwing", () => {
    // NOT REAL WIRE for v0.30.0 (projectError never returns nil), but `err` is
    // `omitempty` on the wire struct, so a future or legacy record could omit it.
    const decoded = decodeEnduring(envelope({ type: "TurnFailed", loopId: LOOP_A }));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnFailed",
      turnIndex: 0,
      errorKind: "",
      errorMessage: "",
    });
  });

  it("decodes a REAL TurnInterrupted, which carries a turn_index and nothing else", () => {
    const decoded = decodeEnduring(wireEnvelope(TURN_INTERRUPTED_WIRE));
    expect(decoded.payload).toStrictEqual({ kind: "TurnInterrupted", turnIndex: 5 });
  });
});

describe("decodeEnduring: TurnRejected", () => {
  it.each(TURN_REJECTED_WIRE)("decodes $label off real wire", ({ json, reason, reasonText }) => {
    const decoded = decodeEnduring(wireEnvelope(json));
    if (decoded.payload.kind !== "TurnRejected") throw new Error("unreachable");
    expect(decoded.payload.reason).toBe(reason);
    // The expected wording is a LITERAL in the table above, not
    // rejectReasonText(reason) — comparing the decoder's label to the very
    // function that produced it would pass however wrong both were.
    expect(decoded.payload.reasonText).toBe(reasonText);
    // A rejected submit must never silently vanish: §3b drops the optimistic
    // pending row (paired by Cause.CommandID) and commits an error notice.
    expect(decoded.causeCommandId).toBe(CMD_1);
    // TurnRejected rejects a turn-scoped header — TurnID must be zero.
    expect(isZeroUUID(decoded.turnId)).toBe(true);
  });

  it("labels each RejectReason constant distinctly, in declaration order", () => {
    expect(rejectReasonText(1)).toBe("the loop's queue is full");
    expect(rejectReasonText(2)).toBe("the loop is shutting down");
    expect(rejectReasonText(3)).toBe("a transient internal failure");
    expect(new Set([1, 2, 3].map(rejectReasonText)).size).toBe(3);
  });

  it("labels an unknown or zero RejectReason without inventing one", () => {
    // RejectUnspecified is the zero-value sentinel the loop NEVER produces, and
    // `omitzero` drops it, so an absent key and an unrecognized future value
    // both land here. Neither may borrow another reason's wording.
    expect(rejectReasonText(0)).toBe("an unspecified reason");
    expect(rejectReasonText(99)).toBe("an unspecified reason");
    const decoded = decodeEnduring(envelope({ type: "TurnRejected", loopId: LOOP_A }));
    expect(decoded.payload).toStrictEqual({
      kind: "TurnRejected",
      reason: 0,
      reasonText: "an unspecified reason",
    });
  });
});

describe("decodeEnduring: InputCancelled", () => {
  it("decodes a REAL client retraction: reason 0, omitzero-dropped, with its message", () => {
    // CancelClientRetracted is 0 and IS a real reason — unlike RejectUnspecified,
    // whose 0 is a sentinel. `omitzero` drops the key either way, so an absent
    // `reason` here means "client retracted", not "unknown".
    const raw = object(JSON.parse(INPUT_CANCELLED_RETRACTED_WIRE) as unknown);
    expect(Object.hasOwn(raw, "reason")).toBe(false);
    expect(Object.hasOwn(raw, "turn_index")).toBe(false);
    const decoded = decodeEnduring(asEnvelope(raw));
    expect(decoded.payload).toStrictEqual({
      kind: "InputCancelled",
      turnIndex: 0,
      reason: 0,
      message: {
        role: "user",
        blocks: [{ type: "text", text: "never ran" }],
        toolUseId: "",
        isError: false,
      },
    });
    expect(decoded.causeCommandId).toBe(CMD_1);
  });

  it("decodes a REAL return after an interrupted turn: reason 1 and a turn_index", () => {
    const decoded = decodeEnduring(wireEnvelope(INPUT_CANCELLED_INTERRUPTED_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "InputCancelled",
      turnIndex: 7,
      reason: 1,
      message: {
        role: "user",
        blocks: [{ type: "text", text: "returned to sender" }],
        toolUseId: "",
        isError: false,
      },
    });
    expect(decoded.turnId).toBe(TURN_1);
  });

  it("survives an InputCancelled with no message", () => {
    // NOT REAL WIRE from the loop (it always returns the message it dequeued),
    // but Message is `*content.UserMessage` with omitzero, so the key can be
    // absent in principle.
    const decoded = decodeEnduring(envelope({ type: "InputCancelled", loopId: LOOP_A }));
    expect(decoded.payload).toStrictEqual({
      kind: "InputCancelled",
      turnIndex: 0,
      reason: 0,
      message: undefined,
    });
  });
});

/**
 * ## Provenance of the permission wire strings
 *
 * No fixture covers PermissionRequested or PermissionDecided either, so both
 * constants below are the VERBATIM stdout of `event.MarshalEvent` in
 * harness@v0.30.0, driven by a throwaway main that built real
 * `event.PermissionRequested` / `event.PermissionDecided` values carrying a
 * real `tool.Request`.
 *
 * The PermissionRequested value the first constant came from was constructed
 * with `Preview: &tool.MutationPreview{}` SET. There is no `preview` key in the
 * bytes: `marshalPermissionRequested` encodes `permissionRequestedWire`, which
 * has Header, ToolExecutionID and Request and nothing else. That is the
 * evidence for `hasPreview: false` below — not the struct tag, which says the
 * same thing about `Request` and is wrong about it.
 */
const PERMISSION_REQUESTED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","request":{"tool_name":"Write","summary":"write /tmp/x","requirements":[{"kind":"file.write","scope":"workspace","match":"/tmp/x","description":"write file /tmp/x","candidates":[{"kind":"file.write","match":"/tmp/**","description":"allow writes under /tmp"}]}]},"session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","tool_execution_id":"99999999-9999-4999-8999-999999999999","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"PermissionRequested","v":1}';

const PERMISSION_REQUESTED_COMMAND_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","request":{"tool_name":"Bash","summary":"run go test","execution_id":"exec-1","command":"go test ./...","working_directory":"/work","expires_at_unix_milli":1772186400000,"requirements":[{"kind":"command.execute","scope":"","match":"go test ./...","description":"run go test ./...","grant_class":"command.start.v1","grant_target":"go test ./...","candidates":[{"kind":"command.execute","match":"go test ./...","description":"always allow go test ./...","grant_class":"command.start.v1","grant_target":"go test ./..."}]}]},"session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","tool_execution_id":"99999999-9999-4999-8999-999999999999","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"PermissionRequested","v":1}';

const PERMISSION_REQUESTED_EMPTY_REQUEST_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","request":{},"session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","tool_execution_id":"99999999-9999-4999-8999-999999999999","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"PermissionRequested","v":1}';

const PERMISSION_DECIDED_DENY_WIRE =
  '{"audit":"denied by workspace rule","created_at":"2026-08-27T10:00:00Z","effect":"deny","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":"policy","session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","subject":"Write(/etc/passwd)","tool_execution_id":"99999999-9999-4999-8999-999999999999","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"PermissionDecided","v":1}';

const PERMISSION_DECIDED_APPROVE_BARE_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","effect":"approve","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","tool_execution_id":"99999999-9999-4999-8999-999999999999","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"PermissionDecided","v":1}';

const TOOL_EXEC_1 = "99999999-9999-4999-8999-999999999999";

/** An all-empty prepared request — what `"request":{}` decodes to. */
const EMPTY_REQUEST = {
  toolName: "",
  summary: "",
  executionId: "",
  command: "",
  workingDirectory: "",
  expiresAtUnixMilli: 0,
  requirements: [],
};

describe("decodeEnduring: permission events", () => {
  it("has no `preview` key in a REAL PermissionRequested whose Preview was set", () => {
    // The producer set Preview to a non-nil *tool.MutationPreview. Read the
    // bytes rather than asserting the decoder's constant: `hasPreview: false`
    // is only honest if the wire really carries nothing.
    const raw = object(JSON.parse(PERMISSION_REQUESTED_WIRE) as unknown);
    expect(Object.hasOwn(raw, "preview")).toBe(false);
    expect(Object.keys(raw).some((k) => k.toLowerCase().includes("preview"))).toBe(false);
  });

  it("decodes a REAL PermissionRequested's typed prepared request", () => {
    const decoded = decodeEnduring(wireEnvelope(PERMISSION_REQUESTED_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "PermissionRequested",
      toolExecutionId: TOOL_EXEC_1,
      request: {
        toolName: "Write",
        summary: "write /tmp/x",
        executionId: "",
        command: "",
        workingDirectory: "",
        expiresAtUnixMilli: 0,
        requirements: [
          {
            kind: "file.write",
            scope: "workspace",
            match: "/tmp/x",
            description: "write file /tmp/x",
            grantClass: "",
            grantTarget: "",
            candidates: [
              {
                kind: "file.write",
                match: "/tmp/**",
                description: "allow writes under /tmp",
                grantClass: "",
                grantTarget: "",
              },
            ],
          },
        ],
      },
      hasPreview: false,
    });
    expect(decoded.turnId).toBe(TURN_1);
    expect(decoded.stepId).toBe(STEP_1);
  });

  it("decodes a REAL command-grant request's execution binding", () => {
    // A requirement that asks for a grant forces ValidateRequest to demand the
    // execution binding quartet (execution_id/command/working_directory/
    // expires_at_unix_milli). Dropping any of them would leave the card unable
    // to say WHAT command is being authorized.
    const decoded = decodeEnduring(wireEnvelope(PERMISSION_REQUESTED_COMMAND_WIRE));
    if (decoded.payload.kind !== "PermissionRequested") throw new Error("unreachable");
    expect(decoded.payload.request).toStrictEqual({
      toolName: "Bash",
      summary: "run go test",
      executionId: "exec-1",
      command: "go test ./...",
      workingDirectory: "/work",
      expiresAtUnixMilli: 1772186400000,
      requirements: [
        {
          kind: "command.execute",
          scope: "",
          match: "go test ./...",
          description: "run go test ./...",
          grantClass: "command.start.v1",
          grantTarget: "go test ./...",
          // A candidate's grant pair must equal its requirement's exactly
          // (tool.validateRuleCandidate), so this is the only shape in which a
          // NON-empty candidate grantClass/grantTarget can reach the wire.
          candidates: [
            {
              kind: "command.execute",
              match: "go test ./...",
              description: "always allow go test ./...",
              grantClass: "command.start.v1",
              grantTarget: "go test ./...",
            },
          ],
        },
      ],
    });
  });

  it("projects every key a REAL prepared request puts on the wire", () => {
    // Derived from the bytes, not from a literal: a field harness adds to
    // tool.Request and this decoder ignores fails HERE rather than being
    // silently dropped from the permission card.
    const request = object(object(JSON.parse(PERMISSION_REQUESTED_COMMAND_WIRE) as unknown)["request"]);
    expect(Object.keys(request).sort()).toStrictEqual([
      "command",
      "execution_id",
      "expires_at_unix_milli",
      "requirements",
      "summary",
      "tool_name",
      "working_directory",
    ]);
    const requirement = object((request["requirements"] as unknown[])[0]);
    expect(Object.keys(requirement).sort()).toStrictEqual([
      "candidates",
      "description",
      "grant_class",
      "grant_target",
      "kind",
      "match",
      "scope",
    ]);
    const candidate = object((requirement["candidates"] as unknown[])[0]);
    expect(Object.keys(candidate).sort()).toStrictEqual([
      "description",
      "grant_class",
      "grant_target",
      "kind",
      "match",
    ]);
  });

  it("decodes a REAL pure tool's empty request, which is `{}` and never absent", () => {
    // json.RawMessage's omitempty cannot fire on the two bytes "{}", so
    // marshalPermissionRequested ALWAYS emits a `request` key even for a
    // zero tool.Request. A decoder must not treat "no requirements" as "no
    // request".
    const raw = object(JSON.parse(PERMISSION_REQUESTED_EMPTY_REQUEST_WIRE) as unknown);
    expect(raw["request"]).toStrictEqual({});
    const decoded = decodeEnduring(asEnvelope(raw));
    if (decoded.payload.kind !== "PermissionRequested") throw new Error("unreachable");
    expect(decoded.payload.request).toStrictEqual(EMPTY_REQUEST);
  });

  it("survives an entirely absent request rather than throwing", () => {
    // NOT REAL WIRE for v0.30.0 (see above), but `request` is omitempty on the
    // wire struct, so a legacy record could lack it.
    const decoded = decodeEnduring(
      envelope({ type: "PermissionRequested", loopId: LOOP_A, payload: { tool_execution_id: TOOL_EXEC_1 } }),
    );
    expect(decoded.payload).toStrictEqual({
      kind: "PermissionRequested",
      toolExecutionId: TOOL_EXEC_1,
      request: EMPTY_REQUEST,
      hasPreview: false,
    });
  });

  it("decodes a REAL PermissionDecided's effect, reason, subject and audit", () => {
    const decoded = decodeEnduring(wireEnvelope(PERMISSION_DECIDED_DENY_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "PermissionDecided",
      toolExecutionId: TOOL_EXEC_1,
      effect: "deny",
      reason: "policy",
      subject: "Write(/etc/passwd)",
      audit: "denied by workspace rule",
    });
  });

  it("decodes a REAL bare approve, whose omitempty strings are all absent", () => {
    const raw = object(JSON.parse(PERMISSION_DECIDED_APPROVE_BARE_WIRE) as unknown);
    for (const key of ["reason", "subject", "audit"]) {
      expect(Object.hasOwn(raw, key)).toBe(false);
    }
    expect(decodeEnduring(asEnvelope(raw)).payload).toStrictEqual({
      kind: "PermissionDecided",
      toolExecutionId: TOOL_EXEC_1,
      effect: "approve",
      reason: "",
      subject: "",
      audit: "",
    });
  });
});

/**
 * ## Provenance of the LoopStarted wire strings
 *
 * Same producer, same harness@v0.30.0: real `event.LoopStarted` values through
 * `event.MarshalEvent`. LoopStarted's identity profile is `loopProfile()` —
 * SessionID+LoopID required, TurnID/StepID FORBIDDEN on the header — while the
 * SPAWNING loop/turn/step ride on `Header.Cause.Coordinates`, which is why the
 * child constant below carries a full quartet under `cause` and none of it at
 * the top level. MarshalEvent would have refused the other arrangement.
 */
const LOOP_STARTED_CHILD_WIRE =
  '{"agent_name":"researcher","cause":{"session_id":"11111111-1111-4111-8111-111111111111","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","command_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"},"created_at":"2026-08-27T10:00:00Z","description":"reads the docs","display_name":"Research","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","initial_mode":"plan","loop_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","parent_tool_use_id":"toolu_sub_1","runtime":{"key":{"Provider":"anthropic","Model":"claude-opus-4"},"limits":{"WindowTokens":200000,"MaxInputTokens":180000,"MaxOutputTokens":64000},"effort":"high"},"session_id":"11111111-1111-4111-8111-111111111111","type":"LoopStarted","v":1}';

const LOOP_STARTED_ROOT_WIRE =
  '{"agent_name":"primer","created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-1111-4111-8111-111111111111","type":"LoopStarted","v":1}';

const LOOP_STARTED_FOREIGN_WIRE =
  '{"agent_name":"claude","agent_runtime":{"harness":"claude-code","profile":"default","credential_mode":"native-auth","source":"native","selection_kind":"harness-managed","model_alias":""},"cause":{"session_id":"11111111-1111-4111-8111-111111111111","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","step_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"},"created_at":"2026-08-27T10:00:00Z","display_name":"Claude","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","foreign_sid":"sess_abc123","initial_request_id":"ffffffff-ffff-4fff-8fff-ffffffffffff","loop_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","parent_tool_use_id":"toolu_sub_2","session_id":"11111111-1111-4111-8111-111111111111","type":"LoopStarted","v":1}';

describe("decodeEnduring: LoopStarted", () => {
  it("decodes a REAL child loop's anchor and presentation labels", () => {
    const decoded = decodeEnduring(wireEnvelope(LOOP_STARTED_CHILD_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "LoopStarted",
      parentToolUseId: "toolu_sub_1",
      displayName: "Research",
      description: "reads the docs",
      foreignSid: "",
      initialMode: "plan",
    });
    // Header.Coordinates is the NEW loop; Header.Cause.Coordinates is the
    // SPAWNING one. Swapping them would parent every subagent to itself.
    expect(decoded.loopId).toBe(LOOP_B);
    expect(decoded.causeLoopId).toBe(LOOP_A);
    expect(decoded.agentName).toBe("researcher");
    // loopProfile() forbids TurnID/StepID on the header — the spawn's turn and
    // step are reachable only through `cause`.
    expect(decoded.turnId).toBe("");
    expect(decoded.stepId).toBe("");
  });

  it("keeps the spawning turn/step out of the header and inside `cause`", () => {
    const raw = object(JSON.parse(LOOP_STARTED_CHILD_WIRE) as unknown);
    expect(Object.hasOwn(raw, "turn_id")).toBe(false);
    expect(Object.hasOwn(raw, "step_id")).toBe(false);
    expect(object(raw["cause"])["turn_id"]).toBe(TURN_1);
    expect(object(raw["cause"])["step_id"]).toBe(STEP_1);
  });

  it("decodes a REAL foreign loop's session handle and its own display name", () => {
    const decoded = decodeEnduring(wireEnvelope(LOOP_STARTED_FOREIGN_WIRE));
    expect(decoded.payload).toStrictEqual({
      kind: "LoopStarted",
      parentToolUseId: "toolu_sub_2",
      displayName: "Claude",
      description: "",
      foreignSid: "sess_abc123",
      initialMode: "",
    });
  });

  it("decodes a REAL primary/root loop, which has no parent tool use and no cause loop", () => {
    const raw = object(JSON.parse(LOOP_STARTED_ROOT_WIRE) as unknown);
    // Every one of the payload's five fields is omitzero, so a root's envelope
    // carries none of them at all — not empty strings.
    for (const key of ["parent_tool_use_id", "display_name", "description", "foreign_sid", "initial_mode", "cause"]) {
      expect(Object.hasOwn(raw, key)).toBe(false);
    }
    const decoded = decodeEnduring(asEnvelope(raw));
    expect(decoded.causeLoopId).toBe("");
    expect(decoded.agentName).toBe("primer");
    expect(decoded.payload).toStrictEqual({
      kind: "LoopStarted",
      parentToolUseId: "",
      displayName: "",
      description: "",
      foreignSid: "",
      initialMode: "",
    });
  });

  it("carries a `runtime` whose WRAPPERS are snake_case and whose CONTENTS are Go-cased", () => {
    // ModelRuntime tags key/limits/effort/api_format/base_url, but model.ModelKey
    // and model.ContextLimits declare NO json tags at all, so encoding/json emits
    // Provider/Model/WindowTokens/MaxInputTokens/MaxOutputTokens verbatim. The
    // same casing split blocks.ts pins for content blocks, one level deeper.
    //
    // It is DELIBERATELY not projected onto LoopStartedPayload: §3b's loop tree
    // needs the parent anchor and the labels, not the model identity, and a
    // field nothing reads is a field nothing keeps correct. This assertion
    // exists so the omission stays a decision — and so the casing is recorded
    // for whoever does need it.
    const runtime = object(object(JSON.parse(LOOP_STARTED_CHILD_WIRE) as unknown)["runtime"]);
    expect(Object.keys(runtime).sort()).toStrictEqual(["effort", "key", "limits"]);
    expect(object(runtime["key"])).toStrictEqual({ Provider: "anthropic", Model: "claude-opus-4" });
    expect(object(runtime["limits"])).toStrictEqual({
      WindowTokens: 200000,
      MaxInputTokens: 180000,
      MaxOutputTokens: 64000,
    });
  });

  it("leaves `agent_runtime` and `initial_request_id` on the envelope, unprojected", () => {
    // Both are real wire on a delegated loop. Neither is projected, for the same
    // reason as `runtime`; DecodedEnduring.envelope keeps the verbatim bytes, so
    // nothing is lost, only undecoded.
    const raw = object(JSON.parse(LOOP_STARTED_FOREIGN_WIRE) as unknown);
    expect(object(raw["agent_runtime"])["harness"]).toBe("claude-code");
    expect(raw["initial_request_id"]).toBe(CMD_1);
    const decoded = decodeEnduring(asEnvelope(raw));
    expect(decoded.envelope).toBe(raw);
  });
});
