/**
 * Conformance suite for the vendored harness wire contract (`contract/`).
 *
 * This is half of the cross-repo drift guard the contract is built around:
 * harness's own `pkg/serve` tests validate these exact fixtures against these
 * exact schemas from the Go side (`fixtures_test.go`'s `TestFixtures`); this
 * file validates the same fixtures against the same schemas from the
 * TypeScript side. A wire change that breaks one side's fixture almost always
 * breaks the other's too.
 *
 * Three things are checked here:
 *  1. Schema drift guard: every literal in src/schema.ts is structurally
 *     identical to the vendored file it mirrors (see schema.ts's module
 *     comment for why the mirrors exist and how they could drift).
 *  2. Fixture conformance: every non-SSE fixture in contract/fixtures/
 *     validates against its mapped schema.
 *  3. Negative case: a mutated, schema-violating copy of a valid fixture is
 *     correctly REJECTED — proving the validator can actually fail closed,
 *     not just pass everything.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allSchemas, bffErrorResponseSchema, errorResponseSchema, factorySchemas } from "../src/schema.js";
import { CSRFRejectedError, OriginNotAllowedError, errorFromResponse } from "../src/errors.js";
import {
  ContractValidationError,
  validate,
  validateFactory,
  validateBFFErrorResponse,
  type FactorySchemaName,
  type SchemaName,
} from "../src/validate.js";

const schemaDir = fileURLToPath(new URL("../../../contract/schema/", import.meta.url));
const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(dir + file, "utf8"));
}

// --- 1. Schema drift guard -------------------------------------------------
//
// src/schema.ts hand-mirrors each vendored schema as a TypeScript `as const`
// literal (see that file's module comment for why: FromSchema needs literal
// types a JSON import can't provide). That mirror is only trustworthy if it's
// proven identical to the real vendored bytes, every run — this is that proof.

describe("schema mirrors match the vendored contract", () => {
  const vendoredFiles = readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"));

  it("src/schema.ts's allSchemas has no extra or missing entries versus contract/schema/", () => {
    const vendoredStems = vendoredFiles.map((f) => f.replace(/\.schema\.json$/, "")).sort();
    const mirroredStems = Object.keys(allSchemas).sort();
    expect(mirroredStems).toEqual(vendoredStems);
  });

  for (const file of vendoredFiles) {
    const stem = file.replace(/\.schema\.json$/, "") as SchemaName;

    it(`${file} is byte-for-content identical to allSchemas["${stem}"]`, () => {
      const vendored = readJson(schemaDir, file);
      expect(allSchemas[stem]).toEqual(vendored);
    });
  }
});

describe("Factory boundary schema subset", () => {
  it("is byte-for-content identical to and validates every corresponding Core fixture", () => {
    for (const [stem, schema] of Object.entries(factorySchemas)) {
      expect(schema, `${stem} schema drifted`).toEqual(readJson(schemaDir, `${stem}.schema.json`));
      expect(() => validateFactory(stem as FactorySchemaName, readJson(fixtureDir, `${stem}.json`))).not.toThrow();
    }
  });

  it("has a same-stem Core fixture for every Factory schema mirror", () => {
    const fixtures = new Set(readdirSync(fixtureDir));
    const missing = Object.keys(factorySchemas).filter((stem) => !fixtures.has(`${stem}.json`));
    expect(missing).toEqual([]);
  });

  it("validates the seven principal and metadata request variants and refuses invalid members", () => {
    const variants: Record<string, FactorySchemaName> = {
      "create_request_principal.json": "create_request",
      "input_request_principal.json": "input_request",
      "interrupt_request_principal.json": "interrupt_request",
      "restore_request_principal.json": "restore_request",
      "gate_response_request_principal.json": "gate_response_request",
      "create_request_metadata.json": "create_request",
      "input_request_metadata.json": "input_request",
    };
    const files = readdirSync(fixtureDir).filter((file) => /_request_(principal|metadata)\.json$/.test(file)).sort();
    expect(files).toEqual(Object.keys(variants).sort());
    for (const [file, schema] of Object.entries(variants)) {
      expect(() => validateFactory(schema, readJson(fixtureDir, file)), file).not.toThrow();
    }
    const input = readJson(fixtureDir, "input_request_metadata.json") as Record<string, unknown>;
    const interrupt = readJson(fixtureDir, "interrupt_request.json") as Record<string, unknown>;
    const principal = (readJson(fixtureDir, "input_request_principal.json") as Record<string, unknown>)["principal"];
    expect(() => validateFactory("interrupt_request", { ...interrupt, metadata: { space: "family" } }))
      .toThrow(ContractValidationError);
    expect(() => validateFactory("input_request", { ...input, metadata: { space: 1 } }))
      .toThrow(ContractValidationError);
    expect(() => validateFactory("input_request", { ...input, metadata: null }))
      .toThrow(ContractValidationError);
    expect(() => validateFactory("input_request", { ...input, metadata: {} }))
      .toThrow(ContractValidationError);
    expect(() => validateFactory("interrupt_request", {
      ...interrupt,
      principal: { ...(principal as Record<string, unknown>), display_name: "Alex" },
    })).toThrow(ContractValidationError);
    // Ajv's strictRequired lint must be off to compile this Core schema, but
    // its oneOf still strictly enforces exactly one optimistic gate identity.
    const gate = readJson(fixtureDir, "gate_response_request.json") as Record<string, unknown>;
    expect(() => validateFactory("gate_response_request", {
      ...gate, expected_open_journal_seq: 6,
    })).toThrow(ContractValidationError);
    const { expected_open_event_id: _eventId, ...withoutOpen } = gate;
    expect(() => validateFactory("gate_response_request", withoutOpen)).toThrow(ContractValidationError);
  });

  it("rejects malformed data through the Factory validator rather than casting it", () => {
    expect(() => validateFactory("command_status", { status: "accepted" })).toThrow(ContractValidationError);
    expect(() => validateFactory("enduring_publication", { type: "enduring_publication" })).toThrow(
      ContractValidationError,
    );
    expect(() => validateFactory("recent_session_page", { sessions: "not-an-array" })).toThrow(
      ContractValidationError,
    );
  });

  it("enforces Core decoder invariants that JSON Schema cannot express", () => {
    expect(() => validateFactory("session_reset", {
      type: "session.reset",
      tenant_id: "tenant-1",
      session_id: "session-1",
      last_contiguous: 2,
      journal_tip: 1,
    })).toThrow(ContractValidationError);

    const command = readJson(fixtureDir, "command_status.json") as Record<string, unknown>;
    expect(() => validateFactory("command_status", { ...command, status: "accepted" }))
      .toThrow(ContractValidationError);

    const recent = readJson(fixtureDir, "recent_session_page.json") as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(() => validateFactory("recent_session_page", {
      ...recent,
      sessions: [
        { ...recent.sessions[0], last_active_at: "2026-08-28T09:00:00-04:00" },
        { ...recent.sessions[0], last_active_at: "2026-08-28T14:00:00Z" },
      ],
    })).toThrow(ContractValidationError);

    const journal = readJson(fixtureDir, "public_journal_page.json") as Record<string, unknown>;
    expect(() => validateFactory("public_journal_page", { ...journal, covered_through: 999, journal_tip: 1 }))
      .toThrow(ContractValidationError);

    const ephemeral = readJson(fixtureDir, "ephemeral_publication.json") as Record<string, unknown>;
    expect(() => validateFactory("ephemeral_publication", { ...ephemeral, event_id: "event-1" }))
      .toThrow(ContractValidationError);

    const gates = readJson(fixtureDir, "public_gate_page.json") as Record<string, unknown>;
    expect(() => validateFactory("public_gate_page", { ...gates, open_gate_count: 0 }))
      .toThrow(ContractValidationError);

    const agent = readJson(fixtureDir, "agent_capability_summary.json") as Record<string, unknown>;
    expect(() => validateFactory("agent_capability_summary", { ...agent, agent_id: "x".repeat(257) }))
      .toThrow(ContractValidationError);

    const status = readJson(fixtureDir, "session_status.json") as Record<string, unknown>;
    expect(() => validateFactory("session_status", { ...status, updated_at: "2026-02-30T00:00:00Z" }))
      .toThrow(ContractValidationError);
  });

  it("rejects journal coordinates that cannot be represented exactly by JavaScript", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const mutations: Array<[FactorySchemaName, Record<string, unknown>]> = [
      ["session_status", { ...(readJson(fixtureDir, "session_status.json") as object), journal_tip: unsafe }],
      ["journal_tip", { ...(readJson(fixtureDir, "journal_tip.json") as object), journal_tip: unsafe }],
      ["session_reset", {
        ...(readJson(fixtureDir, "session_reset.json") as object),
        last_contiguous: unsafe,
        journal_tip: unsafe,
      }],
      ["enduring_publication", {
        ...(readJson(fixtureDir, "enduring_publication.json") as object),
        journal_seq: unsafe,
        covered_through: unsafe,
      }],
      ["public_journal_page", {
        ...(readJson(fixtureDir, "public_journal_page.json") as object),
        journal_tip: unsafe,
        covered_through: unsafe,
        events: [{ event_id: "event-unsafe", journal_seq: unsafe, body: {} }],
      }],
    ];
    for (const [schema, value] of mutations) {
      expect(() => validateFactory(schema, value), schema).toThrow(ContractValidationError);
    }
  });
});

// --- 1b. The BFF error superset ----------------------------------------------
//
// bffErrorResponseSchema is deliberately absent from `allSchemas`, so §1 above
// cannot see it: it has no vendored counterpart to be identical to. But it is
// still DEFINED relative to the vendored one — its doc promises "every code
// serve's own error_response.schema.json enumerates, plus the two BFF-local
// codes" — and nothing was checking that promise. Vendoring harness v0.30.0
// proved the cost: serve had added `unauthorized`, both enums silently lacked
// it, and only the mirror (which §1 does cover) failed. Had `unauthorized`
// arrived in a release that changed nothing else, HostTransport would have
// rejected a legitimate 401 envelope as invalid at runtime with §1 still green.

describe("the BFF error superset tracks the vendored error codes", () => {
  const serveCodes = errorResponseSchema.properties.error.properties.code.enum;
  const bffCodes: readonly string[] = bffErrorResponseSchema.properties.error.properties.code.enum;
  const bffLocalCodes = ["csrf_invalid", "origin_not_allowed"];

  it("covers every code serve's own error_response schema enumerates", () => {
    expect(bffCodes).toEqual(expect.arrayContaining([...serveCodes]));
  });

  it("adds exactly the two BFF-local codes and nothing else", () => {
    const extra = bffCodes.filter((code) => !(serveCodes as readonly string[]).includes(code));
    expect(extra.sort()).toEqual([...bffLocalCodes].sort());
  });

  it("maps both BFF-local literals to distinct typed client errors", () => {
    const csrf = errorFromResponse(403, validateBFFErrorResponse({ error: { code: bffLocalCodes[0], message: "invalid token", retryable: true } }));
    const origin = errorFromResponse(403, validateBFFErrorResponse({ error: { code: bffLocalCodes[1], message: "origin denied", retryable: false } }));
    expect(csrf).toBeInstanceOf(CSRFRejectedError);
    expect(origin).toBeInstanceOf(OriginNotAllowedError);
    expect(csrf.code).not.toBe(origin.code);
  });
});

// --- 2. Fixture conformance --------------------------------------------------
//
// Maps every fixture filename to the schema it should validate against. Not a
// simple 1:1 by naming convention (see contract/fixtures/capabilities_read_only.json,
// which validates against capabilities.schema.json despite the different stem) so
// this table is explicit rather than derived. Cross-checked against harness's own
// pkg/serve/fixtures_test.go table.
const fixtureSchema: Record<string, SchemaName> = {
  "capabilities.json": "capabilities",
  "capabilities_read_only.json": "capabilities",
  "create_idle.json": "create_response",
  "create_with_command.json": "create_response",
  "error_400.json": "error_response",
  "error_404.json": "error_response",
  "error_409.json": "error_response",
  "error_500.json": "error_response",
  "error_503.json": "error_response",
  "gate_accepted.json": "gate_accepted_response",
  "input.json": "input_response",
  "interrupt.json": "interrupt_response",
  "journal_page.json": "event_journal_page",
  "restore.json": "restore_response",
  // Both restore fixtures share one schema: restore.json is the rebuilt-from-
  // history case (restored: true) and restore_attached.json the reuse-an-
  // already-live-session case (restored: false). Same 200 body, one bit apart.
  "restore_attached.json": "restore_response",
  "session_list.json": "session_list",
  "status_running.json": "session_status",
};

// SSE fixtures (enduring_frame.sse, ephemeral_token_delta.sse) carry an SSE-framed
// `data:` payload (plus `event:`/`id:` lines), not a bare JSON document — the whole
// file cannot validate against a JSON Schema as-is. Parsing out just the `data:`
// line's JSON and validating THAT against enduring_frame.schema.json /
// ephemeral_frame.schema.json is possible, but the SSE line-framing parser itself is
// explicitly Task 22's job (per the task description), and this suite's job is raw
// JSON Schema conformance. Building a one-off ad hoc SSE-line splitter here to reach
// into these two fixtures would duplicate parsing logic Task 22 needs to own for
// real (multi-line data:, comments, retry:, id: reset semantics, etc.) and would let
// this test pass without that parser ever being exercised for real. So: skipped here,
// deliberately, and re-covered for real once the SSE parser exists.
const skippedSseFixtures = ["enduring_frame.sse", "ephemeral_token_delta.sse"];

describe("fixture conformance", () => {
  const allFixtureFiles = readdirSync(fixtureDir);
  const jsonFixtureFiles = allFixtureFiles.filter((f) => f.endsWith(".json"));
  const sseFixtureFiles = allFixtureFiles.filter((f) => f.endsWith(".sse"));

  it("every .sse fixture is accounted for by the documented skip list", () => {
    expect(sseFixtureFiles.sort()).toEqual([...skippedSseFixtures].sort());
  });

  it("every JSON fixture file is mapped to a schema", () => {
    expect(jsonFixtureFiles.sort()).toEqual(Object.keys(fixtureSchema).sort());
  });

  for (const [file, schemaName] of Object.entries(fixtureSchema)) {
    it(`${file} validates against ${schemaName}.schema.json`, () => {
      const data = readJson(fixtureDir, file);
      expect(() => validate(schemaName, data)).not.toThrow();
    });
  }
});

// --- 3. Negative cases --------------------------------------------------------
//
// A conformance suite that only ever validates valid fixtures can't prove
// the validator actually rejects anything (it would pass even if `validate`
// were a no-op). Each case below takes a real, valid fixture and mutates it
// to violate its schema in a specific way, then asserts rejection.

describe("validation rejects schema violations", () => {
  it("rejects a capabilities body missing the required 'protocol' field", () => {
    const valid = readJson(fixtureDir, "capabilities.json") as Record<string, unknown>;
    const { protocol: _protocol, ...missingProtocol } = valid;

    expect(() => validate("capabilities", missingProtocol)).toThrow(ContractValidationError);
    try {
      validate("capabilities", missingProtocol);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const validationError = err as ContractValidationError;
      expect(validationError.schemaName).toBe("capabilities");
      expect(validationError.errors.some((e) => e.keyword === "required")).toBe(true);
    }
  });

  it("rejects a capabilities body with the wrong type on 'version'", () => {
    const valid = readJson(fixtureDir, "capabilities.json") as Record<string, unknown>;
    const wrongType = { ...valid, version: "1" };

    expect(() => validate("capabilities", wrongType)).toThrow(ContractValidationError);
  });

  it("rejects a capabilities body with an out-of-enum feature", () => {
    const valid = readJson(fixtureDir, "capabilities.json") as Record<string, unknown>;
    const badEnum = { ...valid, features: ["not_a_real_feature"] };

    expect(() => validate("capabilities", badEnum)).toThrow(ContractValidationError);
  });

  it("rejects a session_status body whose session_id is not a UUID", () => {
    const valid = readJson(fixtureDir, "status_running.json") as Record<string, unknown>;
    const badUuid = { ...valid, session_id: "not-a-uuid" };

    expect(() => validate("session_status", badUuid)).toThrow(ContractValidationError);
  });

  it("rejects an error_response body with an unknown additional property", () => {
    const valid = readJson(fixtureDir, "error_400.json") as { error: Record<string, unknown> };
    const withExtra = { error: { ...valid.error, unexpected_field: true } };

    expect(() => validate("error_response", withExtra)).toThrow(ContractValidationError);
  });

  it("rejects completely malformed input (wrong top-level shape)", () => {
    expect(() => validate("capabilities", "not even an object")).toThrow(ContractValidationError);
    expect(() => validate("capabilities", null)).toThrow(ContractValidationError);
    expect(() => validate("capabilities", [])).toThrow(ContractValidationError);
  });
});
