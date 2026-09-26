/**
 * Runtime validation against harness's `pkg/serve` wire contract, compiled once
 * from the same schema literals schema.ts derives types.ts's DTOs from — so the
 * static type and the runtime check are guaranteed to describe the same shape.
 *
 * The vendored schemas declare `"$schema": "https://json-schema.org/draft/2020-12/schema"`
 * (checked directly in every file under contract/schema/), so this compiles
 * them with ajv's `Ajv2020` class rather than the package's draft-07 default
 * export.
 *
 * `validate()` PARSES: given `unknown` (e.g. the result of a `fetch()`
 * response's `.json()`), it runs the real ajv-compiled schema against the data
 * and only returns a typed value once ajv has actually accepted it. It never
 * casts untyped data with `as`.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { allSchemas, bffErrorResponseSchema, factorySchemas } from "./schema.js";
import type {
  AgentCapabilitySummary,
  BFFErrorResponse,
  CommandStatus,
  CoreErrorEnvelope,
  DepartmentCapabilitySummary,
  Capabilities,
  CreateRequest,
  CreateResponse,
  EnduringFrame,
  EphemeralFrame,
  ErrorResponse,
  EventEnvelope,
  EventHeader,
  EventJournalPage,
  FactorySessionStatus,
  FactoryCreateRequest,
  FactoryInputRequest,
  FactoryInterruptRequest,
  FactoryRestoreRequest,
  FactoryGateResponseRequest,
  FactoryPrincipal,
  EnduringPublication,
  EphemeralPublication,
  GateAcceptedResponse,
  GateResponseRequest,
  InputResponse,
  InterruptResponse,
  JournalTip,
  ObjectMetadata,
  PublicGatePage,
  PublicJournalPage,
  RecentSessionPage,
  RestoreResponse,
  SessionList,
  SessionReset,
  SessionStatus,
  SessionSummary,
  StatusEvent,
  UUID,
  VersionNegotiationRequest,
  VersionNegotiationResponse,
} from "./types.js";

/**
 * RFC3339 date-time, matched against the same shape harness's fixture
 * normalizer (`pkg/serve/fixtures_test.go`'s `tsRE`) treats as a timestamp:
 * whole-second or fractional-second, `Z` or a numeric offset. The vendored
 * schemas declare `"format": "date-time"` on several fields; ajv's core
 * package ships NO format implementations at all (confirmed empirically —
 * `ajv.compile` throws "unknown format \"date-time\"" without one registered),
 * and only the separate `ajv-formats` package supplies them. That package is
 * not in this repo's approved npm dependency list (CLAUDE.md), so rather than
 * requesting a new dependency approval for a single format keyword, this
 * defines it directly — small, stdlib-only, and it's the exact format the
 * fixtures already commit to.
 */
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * One ajv instance, compiled once against every vendored schema. Schemas are
 * registered together (rather than compiled one at a time) so `$ref`s between
 * them — e.g. `create_response.schema.json` referring to `uuid.schema.json` —
 * resolve against each other's `$id` instead of failing to resolve.
 */
const ajv = new Ajv2020({
  schemas: Object.values(allSchemas),
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

/** Maps each schema's filename stem (as used in `allSchemas`) to its derived DTO type. */
interface SchemaTypeMap {
  capabilities: Capabilities;
  create_request: CreateRequest;
  create_response: CreateResponse;
  enduring_frame: EnduringFrame;
  ephemeral_frame: EphemeralFrame;
  error_response: ErrorResponse;
  event_envelope: EventEnvelope;
  event_header: EventHeader;
  event_journal_page: EventJournalPage;
  gate_accepted_response: GateAcceptedResponse;
  gate_response_request: GateResponseRequest;
  input_response: InputResponse;
  interrupt_response: InterruptResponse;
  restore_response: RestoreResponse;
  session_list: SessionList;
  session_status: SessionStatus;
  session_summary: SessionSummary;
  status_event: StatusEvent;
  uuid: UUID;
}

export type SchemaName = keyof SchemaTypeMap;

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

/** Every schema name in SchemaTypeMap, used to fail fast if the two maps ever diverge. */
const schemaNames = Object.keys(allSchemas) as SchemaName[];

const validators = Object.fromEntries(
  schemaNames.map((name) => [name, ajv.compile(allSchemas[name])]),
) as { [K in SchemaName]: ValidateFunction };

const factorySchemaNames = Object.keys(factorySchemas) as FactorySchemaName[];
const factoryValidators = Object.fromEntries(
  factorySchemaNames.map((name) => [name, ajv.compile(factorySchemas[name])]),
) as { [K in FactorySchemaName]: ValidateFunction };

/**
 * Compiled separately from the `validators` map above: bffErrorResponseSchema
 * is deliberately NOT part of `allSchemas` (see its own doc in schema.ts —
 * it has no vendored counterpart under `contract/schema/` for the drift
 * guard to compare against), so it isn't looped over by `schemaNames`. It's
 * still compiled against the SAME `ajv` instance (its `$id` doesn't collide
 * with anything in `allSchemas`), so HostTransport's error decoding shares
 * the same ajv configuration (draft-2020, the same date-time format) as
 * every other validator in this module.
 */
const bffErrorResponseValidator = ajv.compile(bffErrorResponseSchema);

/** Thrown by validate() when data fails schema conformance. Carries ajv's raw ErrorObjects for programmatic inspection alongside a human-readable message. */
export class ContractValidationError extends Error {
  readonly schemaName: SchemaName | FactorySchemaName;
  readonly errors: ErrorObject[];

  constructor(schemaName: SchemaName | FactorySchemaName, errors: ErrorObject[] | null | undefined) {
    const list = errors ?? [];
    super(
      `contract validation failed for schema "${schemaName}": ${ajv.errorsText(list, { dataVar: "value" })}`,
    );
    this.name = "ContractValidationError";
    this.schemaName = schemaName;
    this.errors = list;
  }
}

/**
 * Validates `data` (e.g. the result of `response.json()`) against the named
 * schema and returns it typed as the matching DTO. Throws ContractValidationError
 * if ajv rejects it. This is the one true parse boundary — every other typed
 * accessor in this module is a thin wrapper around this function.
 */
export function validate<K extends SchemaName>(schemaName: K, data: unknown): SchemaTypeMap[K] {
  const isValid = validators[schemaName];
  if (!isValid(data)) {
    throw new ContractValidationError(schemaName, isValid.errors);
  }
  return data as SchemaTypeMap[K];
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

export const validateCapabilities = (data: unknown): Capabilities => validate("capabilities", data);
export const validateCreateRequest = (data: unknown): CreateRequest => validate("create_request", data);
export const validateCreateResponse = (data: unknown): CreateResponse => validate("create_response", data);
export const validateEnduringFrame = (data: unknown): EnduringFrame => validate("enduring_frame", data);
export const validateEphemeralFrame = (data: unknown): EphemeralFrame => validate("ephemeral_frame", data);
export const validateErrorResponse = (data: unknown): ErrorResponse => validate("error_response", data);

/**
 * Validates `data` against bffErrorResponseSchema (schema.ts) — the SAME
 * envelope shape validateErrorResponse checks, but accepting the two
 * additional BFF-local codes (csrf_invalid, origin_not_allowed) alongside
 * every code the vendored schema already lists. Used by HostTransport's
 * request plumbing (transport.ts) in place of validateErrorResponse, since
 * HostTransport — unlike ServeTransport — can genuinely observe either kind
 * of error. Not part of the `validate()`/`SchemaTypeMap` machinery above
 * (bffErrorResponseSchema is deliberately excluded from `allSchemas`; see its
 * schema.ts doc), so this wraps `bffErrorResponseValidator` directly rather
 * than going through `validate("error_response", data)`, which would reject
 * either new code as `additionalProperties`/`enum` violations.
 */
export function validateBFFErrorResponse(data: unknown): BFFErrorResponse {
  if (!bffErrorResponseValidator(data)) {
    throw new ContractValidationError("error_response", bffErrorResponseValidator.errors);
  }
  return data as BFFErrorResponse;
}
export const validateEventEnvelope = (data: unknown): EventEnvelope => validate("event_envelope", data);
export const validateEventHeader = (data: unknown): EventHeader => validate("event_header", data);
export const validateEventJournalPage = (data: unknown): EventJournalPage => validate("event_journal_page", data);
export const validateGateAcceptedResponse = (data: unknown): GateAcceptedResponse => validate("gate_accepted_response", data);
export const validateGateResponseRequest = (data: unknown): GateResponseRequest => validate("gate_response_request", data);
export const validateInputResponse = (data: unknown): InputResponse => validate("input_response", data);
export const validateInterruptResponse = (data: unknown): InterruptResponse => validate("interrupt_response", data);
export const validateRestoreResponse = (data: unknown): RestoreResponse => validate("restore_response", data);
export const validateSessionList = (data: unknown): SessionList => validate("session_list", data);
export const validateSessionStatus = (data: unknown): SessionStatus => validate("session_status", data);
export const validateSessionSummary = (data: unknown): SessionSummary => validate("session_summary", data);
export const validateStatusEvent = (data: unknown): StatusEvent => validate("status_event", data);
export const validateUUID = (data: unknown): UUID => validate("uuid", data);
