/**
 * The public surface of `@looprig/client`.
 *
 * This package is the framework-neutral TypeScript boundary over Core's
 * `sessionwire/v1` contract and the legacy live transport. It is the ONE
 * package a non-React consumer installs — `packages/react` is only the
 * reference adapter, so a Vue or Solid author must be able to reach every
 * capability from this barrel and never need a deep import into `src/`. It has
 * no framework dependencies, which is the package's whole reason to exist
 * (design §1). `test/surface.test.ts` pins the supported names below and walks
 * the public module graph for forbidden framework imports.
 *
 * The layers, bottom up:
 *
 *  - `types` / `schema` / `validate` — DTOs derived from the vendored JSON
 *    Schema documents, the documents themselves, and the ajv-compiled runtime
 *    validators.
 *  - `errors` / `transport` / `client` — the typed error hierarchy over the
 *    error envelope, the transport abstraction plus its browser and
 *    same-origin implementations, and the thin client composition over one.
 *  - `sse` / `live` — the streaming frame parser for the live event plane and
 *    the `fetch`-backed source that feeds it.
 *  - `blocks` / `gate` / `enduring` — decoders for the payloads
 *    `event_envelope.schema.json` leaves open: content blocks and messages,
 *    the gate envelope, and the per-type enduring payloads.
 *  - `rows` / `toolsummary` / `fold` / `join` — the transcript row projection,
 *    the redacted tool-call summariser a cold-replayed card derives its detail
 *    line from, the session state-machine fold both segments accumulate into,
 *    and the exact history-to-live join that drives it.
 *  - `store` — the framework-neutral subscribe/notify store over that join.
 *  - `content` / `gate-actions` — small composition helpers for the UI layer.
 *  - `tool-capture` — the explicit, user-initiated, bounded and
 *    digest-verified read of a retained tool-result object from Factory.
 *
 * `blocks.ts`'s `isRecord` and `str` are deliberately NOT re-exported: they are
 * cross-module decode helpers for `enduring.ts`, `gate.ts` and `fold.ts`, not
 * public API on a package root.
 */
export * from "./types.js";
export * from "./validate.js";
export * from "./errors.js";
export * from "./transport.js";
export * from "./client.js";
export * from "./commands.js";
export * from "./factory-rest.js";
export {
  createClientLink,
  type ClientLink,
  type ClientLinkConstructor,
  type ClientLinkCredentials,
  type ClientLinkOptions,
  type ClientLinkState,
  type ClientSubscription,
  type ClientSubscriptionState,
  type SubscribeOptions,
} from "./clientlink.js";
export * from "./sse.js";
export {
  decodeBlock,
  decodeBlocks,
  decodeMessage,
  decodeMessages,
  type ContentBlock,
  type ConversationMessage,
  type OpaqueBlockValue,
  type RefusalBlockValue,
  type TextBlockValue,
  type ThinkingBlockValue,
  type ToolResultBlockValue,
  type ToolUseBlockValue,
} from "./blocks.js";
export * from "./gate.js";
export * from "./enduring.js";
export * from "./rows.js";
export * from "./toolsummary.js";
export * from "./fold.js";
export * from "./join.js";
export * from "./factory-live-text.js";
export * from "./pending-store.js";
export * from "./live.js";
export * from "./store.js";
export * from "./content.js";
export * from "./tool-capture.js";
export * from "./gate-actions.js";
export {
  allSchemas,
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
  factoryAgentCapabilitySummarySchema,
  factoryCommandStatusSchema,
  factoryCreateRequestSchema,
  factoryDepartmentCapabilitySummarySchema,
  factoryEnduringPublicationSchema,
  factoryEphemeralPublicationSchema,
  factoryErrorEnvelopeSchema,
  factoryGateResponseRequestSchema,
  factoryInputRequestSchema,
  factoryInterruptRequestSchema,
  factoryJournalTipSchema,
  factoryObjectMetadataSchema,
  factoryPublicGatePageSchema,
  factoryPublicJournalPageSchema,
  factoryPrincipalSchema,
  factoryRecentSessionPageSchema,
  factoryRestoreRequestSchema,
  factorySchemas,
  factorySessionResetSchema,
  factorySessionStatusSchema,
  factoryVersionNegotiationRequestSchema,
  factoryVersionNegotiationResponseSchema,
} from "./schema.js";

export { uuidV4 } from "./uuid.js";
export * from "./factory-auth.js";
export * from "./link-recovery.js";
export * from "./factory-view.js";
