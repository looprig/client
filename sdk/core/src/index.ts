// Public barrel export for @looprig/client (sdk/core).
//
// This package is the framework-neutral TypeScript boundary over harness's
// `pkg/serve` wire contract: type-level DTOs (types.ts) derived from the
// vendored JSON Schema documents (schema.ts), ajv-backed runtime validation
// (validate.ts) compiled from those same schemas, a typed error hierarchy
// over the error envelope (errors.ts), a transport abstraction plus its
// same-origin browser implementation (transport.ts), and the thin client
// composition over a transport (client.ts).

export * from "./types.js";
export * from "./validate.js";
export * from "./errors.js";
export * from "./transport.js";
export * from "./client.js";
export {
  allSchemas,
  capabilitiesSchema,
  createRequestSchema,
  createResponseSchema,
  enduringFrameSchema,
  ephemeralFrameSchema,
  errorResponseSchema,
  eventEnvelopeSchema,
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
