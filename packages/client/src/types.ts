/** Core sessionwire/v1 DTOs and shared public event-body projection types. */
import type { FromSchema } from "json-schema-to-ts";
import {
  factoryAgentCapabilitySummarySchema,
  factoryDepartmentCapabilitySummarySchema,
  factoryRecentSessionPageSchema,
  factorySessionStatusSchema,
  factoryPublicJournalPageSchema,
  factoryPublicGatePageSchema,
  factoryObjectMetadataSchema,
  factoryEnduringPublicationSchema,
  factoryEphemeralPublicationSchema,
  factoryJournalTipSchema,
  factorySessionResetSchema,
  factoryVersionNegotiationRequestSchema,
  factoryVersionNegotiationResponseSchema,
  factoryCommandStatusSchema,
  factoryErrorEnvelopeSchema,
  factoryCreateRequestSchema,
  factoryInputRequestSchema,
  factoryInterruptRequestSchema,
  factoryRestoreRequestSchema,
  factoryGateResponseRequestSchema,
  factoryPrincipalSchema,
} from "./schema.js";

/** Opaque enduring body carried by Core's public journal/publication envelope.
 * Payload fields are decoded by enduring.ts; these are not serve wire DTOs.
 */
export interface EventEnvelope {
  type: string;
  /** Producer-specific version, absent on Core's example public bodies. */
  v?: number;
  session_id?: string;
  loop_id?: string;
  turn_id?: string;
  step_id?: string;
  event_id?: string;
  created_at?: string;
  [key: string]: unknown;
}
/** A durable event and its Core journal position, used by the shared fold. */
export interface StatusEvent { journal_seq: number; event?: EventEnvelope }

export type FactoryCreateRequest = FromSchema<typeof factoryCreateRequestSchema>;
export type FactoryInputRequest = FromSchema<typeof factoryInputRequestSchema>;
export type FactoryInterruptRequest = FromSchema<typeof factoryInterruptRequestSchema>;
export type FactoryRestoreRequest = FromSchema<typeof factoryRestoreRequestSchema>;
export type FactoryGateResponseRequest = FromSchema<typeof factoryGateResponseRequestSchema>;
export type FactoryPrincipal = FromSchema<typeof factoryPrincipalSchema>;
export type AgentCapabilitySummary = FromSchema<typeof factoryAgentCapabilitySummarySchema>;
export type DepartmentCapabilitySummary = FromSchema<typeof factoryDepartmentCapabilitySummarySchema>;
export type RecentSessionPage = FromSchema<typeof factoryRecentSessionPageSchema>;
export type FactorySessionStatus = FromSchema<typeof factorySessionStatusSchema>;
export type PublicJournalPage = FromSchema<typeof factoryPublicJournalPageSchema>;
export type PublicGatePage = FromSchema<typeof factoryPublicGatePageSchema>;
export type ObjectMetadata = FromSchema<typeof factoryObjectMetadataSchema>;
export type EnduringPublication = FromSchema<typeof factoryEnduringPublicationSchema>;
export type EphemeralPublication = FromSchema<typeof factoryEphemeralPublicationSchema>;
export type JournalTip = FromSchema<typeof factoryJournalTipSchema>;
export type SessionReset = FromSchema<typeof factorySessionResetSchema>;
export type VersionNegotiationRequest = FromSchema<typeof factoryVersionNegotiationRequestSchema>;
export type VersionNegotiationResponse = FromSchema<typeof factoryVersionNegotiationResponseSchema>;
export type CommandStatus = FromSchema<typeof factoryCommandStatusSchema>;
export type CoreErrorEnvelope = FromSchema<typeof factoryErrorEnvelopeSchema>;

export type FactoryPublication = EnduringPublication | EphemeralPublication | JournalTip;
