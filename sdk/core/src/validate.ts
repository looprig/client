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
import { allSchemas, bffErrorResponseSchema } from "./schema.js";
import type {
  BFFErrorResponse,
  Capabilities,
  CreateRequest,
  CreateResponse,
  EnduringFrame,
  EphemeralFrame,
  ErrorResponse,
  EventEnvelope,
  EventHeader,
  EventJournalPage,
  GateAcceptedResponse,
  GateResponseRequest,
  InputResponse,
  InterruptResponse,
  RestoreResponse,
  SessionList,
  SessionStatus,
  SessionSummary,
  StatusEvent,
  UUID,
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
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * One ajv instance, compiled once against every vendored schema. Schemas are
 * registered together (rather than compiled one at a time) so `$ref`s between
 * them — e.g. `create_response.schema.json` referring to `uuid.schema.json` —
 * resolve against each other's `$id` instead of failing to resolve.
 */
const ajv = new Ajv2020({
  schemas: Object.values(allSchemas),
  strict: true,
});

ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => DATE_TIME_PATTERN.test(value),
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

/** Every schema name in SchemaTypeMap, used to fail fast if the two maps ever diverge. */
const schemaNames = Object.keys(allSchemas) as SchemaName[];

const validators = Object.fromEntries(
  schemaNames.map((name) => [name, ajv.compile(allSchemas[name])]),
) as { [K in SchemaName]: ValidateFunction };

/**
 * Compiled separately from the `validators` map above: bffErrorResponseSchema
 * is deliberately NOT part of `allSchemas` (see its own doc in schema.ts —
 * it has no vendored counterpart under `contract/schema/` for the drift
 * guard to compare against), so it isn't looped over by `schemaNames`. It's
 * still compiled against the SAME `ajv` instance (its `$id` doesn't collide
 * with anything in `allSchemas`), so BFFTransport's error decoding shares
 * the same ajv configuration (draft-2020, the same date-time format) as
 * every other validator in this module.
 */
const bffErrorResponseValidator = ajv.compile(bffErrorResponseSchema);

/** Thrown by validate() when data fails schema conformance. Carries ajv's raw ErrorObjects for programmatic inspection alongside a human-readable message. */
export class ContractValidationError extends Error {
  readonly schemaName: SchemaName;
  readonly errors: ErrorObject[];

  constructor(schemaName: SchemaName, errors: ErrorObject[] | null | undefined) {
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
 * every code the vendored schema already lists. Used by BFFTransport's
 * request plumbing (transport.ts) in place of validateErrorResponse, since
 * BFFTransport — unlike ServeTransport — can genuinely observe either kind
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
