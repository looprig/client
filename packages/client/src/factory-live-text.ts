/** The public Harness TokenDelta body is distinct from the legacy Serve SSE frame. */
export interface FactoryLiveText {
  readonly loopId: string;
  readonly turnId: string;
  readonly text: string;
}

/** A correlated text delta whose shape or size is invalid. Stop this key's preview. */
export interface RejectedFactoryLiveText {
  readonly rejected: true;
  readonly loopId: string;
  readonly turnId: string;
}

/** Host sends at most 4 KiB of text per delta; WUI accepts up to 16 KiB. */
export const MAX_FACTORY_LIVE_TEXT_CHUNK_BYTES = 16_384;
// JSON escaping can expand one byte to six, plus a bounded envelope.
export const MAX_FACTORY_LIVE_TEXT_BODY_BYTES = 6 * MAX_FACTORY_LIVE_TEXT_CHUNK_BYTES + 4_096;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

/**
 * Host sends at most 4 KiB of text per delta; WUI accepts text up to 16 KiB.
 * Unrelated publications return null. A correlated text delta with invalid
 * shape or size returns its key so the caller can stop that preview.
 */
export function decodeFactoryLiveText(body: unknown, publicSessionId: string): FactoryLiveText | RejectedFactoryLiveText | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (value["v"] !== 1 || value["type"] !== "TokenDelta"
    || typeof value["session_id"] !== "string" || value["session_id"] !== publicSessionId
    || typeof value["loop_id"] !== "string" || !uuid.test(value["loop_id"])
    || typeof value["turn_id"] !== "string" || !uuid.test(value["turn_id"])) return null;
  const rejected: RejectedFactoryLiveText = {
    rejected: true, loopId: value["loop_id"], turnId: value["turn_id"],
  };
  const chunk = value["chunk"];
  if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) return rejected;
  const fields = chunk as Record<string, unknown>;
  if (fields["chunk_type"] !== "text") return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(body);
  } catch {
    return rejected;
  }
  if (encoder.encode(encoded).byteLength > MAX_FACTORY_LIVE_TEXT_BODY_BYTES) return rejected;
  if (typeof fields["text"] !== "string" || fields["text"] === ""
    || encoder.encode(fields["text"]).byteLength > MAX_FACTORY_LIVE_TEXT_CHUNK_BYTES) return rejected;
  return { loopId: value["loop_id"], turnId: value["turn_id"], text: fields["text"] };
}
