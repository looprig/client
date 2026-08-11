/**
 * Type-level DTOs for harness's `pkg/serve` wire contract, derived from the
 * schema literals in schema.ts via `json-schema-to-ts`'s `FromSchema`. See the
 * module comment at the top of schema.ts for why these are derived from `as
 * const` mirrors rather than directly from a JSON import.
 *
 * `references` lists every schema that could be reached through a `$ref`
 * anywhere in the source schema's (transitive) shape — `FromSchema` resolves
 * `$ref`s against this flat list keyed by `$id`, not by walking the reference
 * graph itself, so a schema whose refs are refs (e.g. SessionStatus ->
 * StatusEvent -> EventEnvelope -> UUID) must list every hop, not just its
 * direct ref.
 */
import type { FromSchema } from "json-schema-to-ts";
import {
  bffErrorResponseSchema,
  capabilitiesSchema,
  createRequestSchema,
  createResponseSchema,
  enduringFrameSchema,
  ephemeralFrameSchema,
  errorResponseSchema,
  eventEnvelopeSchema,
  eventHeaderSchema,
  eventJournalPageSchema,
  gateAcceptedResponseSchema,
  gateResponseRequestSchema,
  inputResponseSchema,
  interruptResponseSchema,
  restoreResponseSchema,
  sessionListSchema,
  sessionStatusSchema,
  sessionSummarySchema,
  statusEventSchema,
  uuidSchema,
} from "./schema.js";

/** `contract/schema/uuid.schema.json` — no refs. */
export type UUID = FromSchema<typeof uuidSchema>;

/** `contract/schema/event_envelope.schema.json` — refs UUID. */
export type EventEnvelope = FromSchema<
  typeof eventEnvelopeSchema,
  { references: [typeof uuidSchema] }
>;

/** `contract/schema/event_header.schema.json` — refs UUID. */
export type EventHeader = FromSchema<
  typeof eventHeaderSchema,
  { references: [typeof uuidSchema] }
>;

/** `contract/schema/status_event.schema.json` — refs EventEnvelope (-> UUID). */
export type StatusEvent = FromSchema<
  typeof statusEventSchema,
  { references: [typeof eventEnvelopeSchema, typeof uuidSchema] }
>;

/** `contract/schema/session_summary.schema.json` — refs UUID. */
export type SessionSummary = FromSchema<
  typeof sessionSummarySchema,
  { references: [typeof uuidSchema] }
>;

/** `contract/schema/capabilities.schema.json` — no refs. */
export type Capabilities = FromSchema<typeof capabilitiesSchema>;

/** `contract/schema/create_request.schema.json` — no refs. */
export type CreateRequest = FromSchema<typeof createRequestSchema>;

/** `contract/schema/create_response.schema.json` — refs UUID. */
export type CreateResponse = FromSchema<
  typeof createResponseSchema,
  { references: [typeof uuidSchema] }
>;

/** `contract/schema/enduring_frame.schema.json` — refs EventEnvelope (-> UUID). */
export type EnduringFrame = FromSchema<
  typeof enduringFrameSchema,
  { references: [typeof eventEnvelopeSchema, typeof uuidSchema] }
>;

/** `contract/schema/ephemeral_frame.schema.json` — refs EventHeader (-> UUID). */
export type EphemeralFrame = FromSchema<
  typeof ephemeralFrameSchema,
  { references: [typeof eventHeaderSchema, typeof uuidSchema] }
>;

/** `contract/schema/error_response.schema.json` — no refs. */
export type ErrorResponse = FromSchema<typeof errorResponseSchema>;

/**
 * looprig/client's own bffErrorResponseSchema (schema.ts) — NOT vendored, no
 * refs. Structurally a superset of ErrorResponse (same shape, wider `code`
 * union), so any ErrorResponse value is assignable to BFFErrorResponse. See
 * schema.ts's module comment on bffErrorResponseSchema for the full
 * rationale.
 */
export type BFFErrorResponse = FromSchema<typeof bffErrorResponseSchema>;

/** `contract/schema/event_journal_page.schema.json` — refs StatusEvent (-> EventEnvelope -> UUID). */
export type EventJournalPage = FromSchema<
  typeof eventJournalPageSchema,
  { references: [typeof statusEventSchema, typeof eventEnvelopeSchema, typeof uuidSchema] }
>;

/** `contract/schema/gate_accepted_response.schema.json` — no refs (empty object). */
export type GateAcceptedResponse = FromSchema<typeof gateAcceptedResponseSchema>;

/** `contract/schema/gate_response_request.schema.json` — no refs. */
export type GateResponseRequest = FromSchema<typeof gateResponseRequestSchema>;

/** `contract/schema/input_response.schema.json` — refs UUID. */
export type InputResponse = FromSchema<
  typeof inputResponseSchema,
  { references: [typeof uuidSchema] }
>;

/** `contract/schema/interrupt_response.schema.json` — no refs. */
export type InterruptResponse = FromSchema<typeof interruptResponseSchema>;

/** `contract/schema/restore_response.schema.json` — refs UUID. */
export type RestoreResponse = FromSchema<
  typeof restoreResponseSchema,
  { references: [typeof uuidSchema] }
>;

/** `contract/schema/session_list.schema.json` — refs SessionSummary (-> UUID). */
export type SessionList = FromSchema<
  typeof sessionListSchema,
  { references: [typeof sessionSummarySchema, typeof uuidSchema] }
>;

/** `contract/schema/session_status.schema.json` — refs UUID and StatusEvent (-> EventEnvelope -> UUID). */
export type SessionStatus = FromSchema<
  typeof sessionStatusSchema,
  { references: [typeof uuidSchema, typeof statusEventSchema, typeof eventEnvelopeSchema] }
>;
