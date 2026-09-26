/** Core v0.12.0 Factory boundary conformance against unchanged published fixtures. */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { factorySchemas } from "../src/schema.js";
import { ContractValidationError, validateFactory, type FactorySchemaName } from "../src/validate.js";
const schemaDir = fileURLToPath(new URL("../../../contract/schema/", import.meta.url));
const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));
function readJson(dir: string, file: string): unknown { return JSON.parse(readFileSync(dir + file, "utf8")); }
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
