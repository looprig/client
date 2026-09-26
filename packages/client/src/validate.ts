import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { factorySchemas } from "./schema.js";
import type { AgentCapabilitySummary, CommandStatus, CoreErrorEnvelope, DepartmentCapabilitySummary, FactorySessionStatus, FactoryCreateRequest, FactoryInputRequest, FactoryInterruptRequest, FactoryRestoreRequest, FactoryGateResponseRequest, FactoryPrincipal, EnduringPublication, EphemeralPublication, JournalTip, ObjectMetadata, PublicGatePage, PublicJournalPage, RecentSessionPage, SessionReset, VersionNegotiationRequest, VersionNegotiationResponse } from "./types.js";

/** RFC3339 timestamps used by Core sessionwire/v1. */
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** One shared validator instance for the Core Factory schema subset. */
const ajv = new Ajv2020({
  schemas: Object.values(factorySchemas),
  strict: true,
  // Core's gate-response oneOf uses `not: { required: [...] }` to express
  // exclusive alternatives. Ajv's strictRequired lint rejects that valid
  // schema shape; disabling the lint does not weaken runtime validation.
  strictRequired: false,
});

ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => validDateTime(value),
});

ajv.addFormat("uri", {
  type: "string",
  validate: (value: string) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
});

interface FactorySchemaTypeMap {
  create_request: FactoryCreateRequest;
  input_request: FactoryInputRequest;
  interrupt_request: FactoryInterruptRequest;
  restore_request: FactoryRestoreRequest;
  gate_response_request: FactoryGateResponseRequest;
  principal: FactoryPrincipal;
  agent_capability_summary: AgentCapabilitySummary;
  department_capability_summary: DepartmentCapabilitySummary;
  recent_session_page: RecentSessionPage;
  session_status: FactorySessionStatus;
  public_journal_page: PublicJournalPage;
  public_gate_page: PublicGatePage;
  object_metadata: ObjectMetadata;
  enduring_publication: EnduringPublication;
  ephemeral_publication: EphemeralPublication;
  journal_tip: JournalTip;
  session_reset: SessionReset;
  version_negotiation_request: VersionNegotiationRequest;
  version_negotiation_response: VersionNegotiationResponse;
  command_status: CommandStatus;
  error_envelope: CoreErrorEnvelope;
}

export type FactorySchemaName = keyof FactorySchemaTypeMap;

const factorySchemaNames = Object.keys(factorySchemas) as FactorySchemaName[];
const factoryValidators = Object.fromEntries(
  factorySchemaNames.map((name) => [name, ajv.compile(factorySchemas[name])]),
) as { [K in FactorySchemaName]: ValidateFunction };

/** Thrown by validateFactory() when data fails schema conformance. Carries ajv's raw ErrorObjects for programmatic inspection alongside a human-readable message. */
export class ContractValidationError extends Error {
  readonly schemaName: FactorySchemaName;
  readonly errors: ErrorObject[];

  constructor(schemaName: FactorySchemaName, errors: ErrorObject[] | null | undefined) {
    const list = errors ?? [];
    super(
      `contract validation failed for schema "${schemaName}": ${ajv.errorsText(list, { dataVar: "value" })}`,
    );
    this.name = "ContractValidationError";
    this.schemaName = schemaName;
    this.errors = list;
  }
}

export function validateFactory<K extends FactorySchemaName>(schemaName: K, data: unknown): FactorySchemaTypeMap[K] {
  const isValid = factoryValidators[schemaName];
  if (!isValid(data)) {
    throw new ContractValidationError(schemaName, isValid.errors);
  }
  validateFactorySemantics(schemaName, data as FactorySchemaTypeMap[K]);
  return data as FactorySchemaTypeMap[K];
}

function semanticFailure(schemaName: FactorySchemaName): never {
  throw new ContractValidationError(schemaName, []);
}

const idEncoder = new TextEncoder();

function idsWithinCoreLimit(...values: Array<string | undefined>): boolean {
  return values.every((value) => value === undefined || idEncoder.encode(value).byteLength <= 256);
}

function safeJournalCoordinate(value: number, minimum = 0): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validDateTime(value: string | undefined): boolean {
  if (value === undefined) return true;
  const match = DATE_TIME_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? undefined : Number(match[7]);
  const offsetMinute = match[8] === undefined ? undefined : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= (daysInMonth ?? 0)
    && hour <= 23
    && minute <= 59
    && second <= 59
    && (offsetHour === undefined || offsetHour <= 23)
    && (offsetMinute === undefined || offsetMinute <= 59)
    && Number.isFinite(Date.parse(value));
}

function validGateOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host !== ""
      && parsed.username === ""
      && parsed.password === ""
      && (parsed.pathname === "" || parsed.pathname === "/")
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

/**
 * Enforces consumed value-level Core decoder invariants that draft-2020 JSON
 * Schema cannot express. Raw JSON spelling rules (duplicate members and the
 * canonical byte spelling of an opaque body) are unrecoverable after
 * `Response.json()` / SDK decoding and remain producer-side wire invariants.
 */
function validateFactorySemantics<K extends FactorySchemaName>(
  schemaName: K,
  data: FactorySchemaTypeMap[K],
): void {
  switch (schemaName) {
    case "agent_capability_summary": {
      const value = data as AgentCapabilitySummary;
      if (!idsWithinCoreLimit(value.agent_id)) semanticFailure(schemaName);
      return;
    }
    case "department_capability_summary": {
      const value = data as DepartmentCapabilitySummary;
      if (value.agents.some((agent) => !idsWithinCoreLimit(agent.agent_id))) semanticFailure(schemaName);
      return;
    }
    case "enduring_publication": {
      const value = data as EnduringPublication;
      if (!idsWithinCoreLimit(value.tenant_id, value.session_id, value.event_id)
        || !safeJournalCoordinate(value.journal_seq, 1)
        || !safeJournalCoordinate(value.covered_through, 1)
        || value.covered_through !== value.journal_seq) semanticFailure(schemaName);
      return;
    }
    case "ephemeral_publication": {
      const value = data as EphemeralPublication & Record<string, unknown>;
      if (!idsWithinCoreLimit(value.tenant_id, value.session_id)
        || "event_id" in value || "journal_seq" in value || "covered_through" in value) semanticFailure(schemaName);
      return;
    }
    case "journal_tip": {
      const value = data as JournalTip;
      if (!idsWithinCoreLimit(value.tenant_id, value.session_id)
        || !safeJournalCoordinate(value.journal_tip)) semanticFailure(schemaName);
      return;
    }
    case "session_reset": {
      const value = data as SessionReset;
      if (!idsWithinCoreLimit(value.tenant_id, value.session_id)
        || !safeJournalCoordinate(value.last_contiguous)
        || !safeJournalCoordinate(value.journal_tip)
        || value.last_contiguous > value.journal_tip) semanticFailure(schemaName);
      return;
    }
    case "command_status": {
      const value = data as CommandStatus;
      if (!idsWithinCoreLimit(value.command_id)
        || (value.status === "rejected") !== (value.error !== undefined)) semanticFailure(schemaName);
      return;
    }
    case "recent_session_page": {
      const value = data as RecentSessionPage;
      for (const session of value.sessions) {
        if (!idsWithinCoreLimit(session.session_id, session.agent_id)
          || !validDateTime(session.created_at)
          || !validDateTime(session.last_active_at)) semanticFailure(schemaName);
      }
      for (let index = 1; index < value.sessions.length; index += 1) {
        const current = Date.parse(value.sessions[index]!.last_active_at);
        const previous = Date.parse(value.sessions[index - 1]!.last_active_at);
        if (!Number.isFinite(current) || !Number.isFinite(previous) || current > previous) {
          semanticFailure(schemaName);
        }
      }
      return;
    }
    case "session_status": {
      const value = data as FactorySessionStatus;
      if (!idsWithinCoreLimit(value.session_id, value.agent_id, value.waiting_gate_id)
        || !safeJournalCoordinate(value.journal_tip)
        || !validDateTime(value.updated_at)) semanticFailure(schemaName);
      return;
    }
    case "public_journal_page": {
      const value = data as PublicJournalPage;
      if (!safeJournalCoordinate(value.journal_tip)
        || !safeJournalCoordinate(value.covered_through)
        || value.covered_through > value.journal_tip) semanticFailure(schemaName);
      let previous = 0;
      for (const event of value.events) {
        if (!idsWithinCoreLimit(event.event_id)
          || !safeJournalCoordinate(event.journal_seq, 1)
          || event.journal_seq <= previous
          || event.journal_seq > value.covered_through) semanticFailure(schemaName);
        previous = event.journal_seq;
      }
      return;
    }
    case "public_gate_page": {
      const value = data as PublicGatePage;
      if (!safeJournalCoordinate(value.journal_tip)
        || value.gates.length > value.open_gate_count) semanticFailure(schemaName);
      let previous = 0;
      for (const gate of value.gates) {
        if (!idsWithinCoreLimit(gate.gate_id, gate.opened_event_id)
          || !validDateTime(gate.deadline)
          || !validGateOrigin(gate.prompt.origin)
          || gate.prompt.controls?.some((control) => control.action.trim() === "" || control.label.trim() === "")
          || !safeJournalCoordinate(gate.opened_journal_seq, 1)
          || gate.opened_journal_seq <= previous
          || gate.opened_journal_seq > value.journal_tip) semanticFailure(schemaName);
        previous = gate.opened_journal_seq;
      }
      return;
    }
    case "object_metadata": {
      const value = data as ObjectMetadata;
      if (!idsWithinCoreLimit(value.reference.object_id) || !validDateTime(value.created_at)) semanticFailure(schemaName);
      return;
    }
  }
}

export const validateAgentCapabilitySummary = (data: unknown): AgentCapabilitySummary =>
  validateFactory("agent_capability_summary", data);
export const validateDepartmentCapabilitySummary = (data: unknown): DepartmentCapabilitySummary =>
  validateFactory("department_capability_summary", data);
export const validateRecentSessionPage = (data: unknown): RecentSessionPage => validateFactory("recent_session_page", data);
export const validateFactorySessionStatus = (data: unknown): FactorySessionStatus => validateFactory("session_status", data);
export const validatePublicJournalPage = (data: unknown): PublicJournalPage => validateFactory("public_journal_page", data);
export const validatePublicGatePage = (data: unknown): PublicGatePage => validateFactory("public_gate_page", data);
export const validateObjectMetadata = (data: unknown): ObjectMetadata => validateFactory("object_metadata", data);
export const validateEnduringPublication = (data: unknown): EnduringPublication => validateFactory("enduring_publication", data);
export const validateEphemeralPublication = (data: unknown): EphemeralPublication => validateFactory("ephemeral_publication", data);
export const validateJournalTip = (data: unknown): JournalTip => validateFactory("journal_tip", data);
export const validateSessionReset = (data: unknown): SessionReset => validateFactory("session_reset", data);
export const validateVersionNegotiationRequest = (data: unknown): VersionNegotiationRequest =>
  validateFactory("version_negotiation_request", data);
export const validateVersionNegotiationResponse = (data: unknown): VersionNegotiationResponse =>
  validateFactory("version_negotiation_response", data);
export const validateCommandStatus = (data: unknown): CommandStatus => validateFactory("command_status", data);
export const validateCoreErrorEnvelope = (data: unknown): CoreErrorEnvelope => validateFactory("error_envelope", data);
