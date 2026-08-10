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
import { allSchemas } from "../src/schema.js";
import { ContractValidationError, validate, type SchemaName } from "../src/validate.js";

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
