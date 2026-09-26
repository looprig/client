/**
 * Decoders for harness's content-block wire shapes.
 *
 * There is no vendored JSON Schema for a block payload (event_envelope
 * .schema.json leaves the per-type payload open — see the module comment in
 * fold.ts), so these are hand-authored runtime guards, exactly like fold.ts's
 * own parseTokenDeltaChunk.
 *
 * ## The casing rule
 *
 * core/content/block.go declares TextBlock, ThinkingBlock, ToolUseBlock and
 * RefusalBlock as bare structs whose VISIBLE fields carry no json tags, so
 * encoding/json emits the exported field name verbatim:
 * {"type":"text","Text":"hello"}. The "type" key is merged in by MarshalBlock
 * as a sibling, not declared on the struct.
 *
 * ToolResultBlock is the ONE exception: it nests []Block, so it defines its
 * own MarshalJSON over a tagged wire struct (block_json.go's toolResultJSON),
 * and its fields are snake_case: tool_use_id / content / is_error.
 *
 * The rule: a block type with a hand-written codec is snake_case; a bare
 * struct is Go-cased. Never "normalize" one to the other. Both halves are
 * pinned in test/blocks.test.ts against bytes core's own codec produced,
 * because reading the wrong key yields empty strings and NO error.
 *
 * ## The tagged fields that do not break the rule
 *
 * ThinkingBlock and ToolUseBlock are not literally tag-free: SignatureFormat,
 * ProviderState and ProviderStateFormat carry `json:"...,omitempty"` tags. The
 * tags restate the Go field name, so the casing conclusion is unchanged, but
 * the fields are real wire. They are dropped here on purpose. They are
 * provider-private continuation state whose only use is replaying a turn back
 * to the dialect that minted it — replaying one provider's state to another is
 * a guaranteed rejection, which is why core labels each one with its issuer.
 * wui renders; it never replays. Forwarding opaque provider bytes into a
 * browser has no reader and is a leak.
 *
 * One bit survives that drop: `ThinkingBlockValue.redacted`. Dropping the
 * bytes also destroyed the only evidence that a block HELD any, and a redacted
 * thinking block is otherwise identical in its visible fields to a block with
 * no reasoning in it — so the row projection could not tell "the model thought
 * and you may not see it" from "the model did not think", and committed no row
 * for a step whose only content was redacted reasoning. The derived boolean
 * restores exactly that distinction and forwards no provider bytes: the
 * decision that provider-private replay state never reaches the browser
 * stands.
 *
 * Unrecognized blocks (image/audio/document, and anything added later) are
 * preserved as an opaque `other` variant rather than dropped, so a renderer
 * can show a placeholder instead of silently losing turn content.
 */

export interface TextBlockValue {
  type: "text";
  text: string;
}
export interface RefusalBlockValue {
  type: "refusal";
  text: string;
}
export interface ThinkingBlockValue {
  type: "thinking";
  thinking: string;
  signature: string;
  /**
   * True when the block carried provider-private continuation state — the
   * model reasoned and the provider withheld the text.
   *
   * A DERIVED boolean, and the one thing this decoder keeps from
   * `ProviderState`. The fact of redaction is display information: a redacted
   * block and a block with no reasoning at all are `{"Signature":"",
   * "Thinking":""}` in every VISIBLE field, so without this the transcript
   * cannot tell "the model thought and you may not see it" from "the model did
   * not think", and a step whose only content is redacted reasoning renders as
   * nothing at all. The bytes themselves stay on the server: they are
   * dialect-scoped replay state with no reader in a browser (see the module
   * comment), and forwarding them would be a leak with no purpose.
   *
   * Derived from PRESENCE of a non-null `ProviderState`, not from an empty
   * `Thinking`. `omitempty` drops only a zero-length RawMessage, so a
   * `RawMessage("null")` really does reach the wire as `"ProviderState":null` —
   * and a key whose value is JSON null withheld nothing. It is also
   * independent of `thinking`: core marshals a block carrying both, so this
   * means "some of this reasoning was withheld", not "all of it".
   */
  redacted: boolean;
}
export interface ToolUseBlockValue {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlockValue {
  type: "tool_result";
  toolUseId: string;
  content: ContentBlock[];
  isError: boolean;
}
export interface OpaqueBlockValue {
  type: "other";
  wireType: string;
  raw: Record<string, unknown>;
}

export type ContentBlock =
  | TextBlockValue
  | RefusalBlockValue
  | ThinkingBlockValue
  | ToolUseBlockValue
  | ToolResultBlockValue
  | OpaqueBlockValue;

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

/** Decodes one tagged content block. Never throws; never drops. */
export function decodeBlock(raw: unknown): ContentBlock {
  if (!isRecord(raw)) return { type: "other", wireType: "", raw: {} };
  switch (raw["type"]) {
    case "text":
      return { type: "text", text: str(raw["Text"]) };
    case "refusal":
      // Byte-identical to a text block's payload; the tag is the only thing
      // that keeps a refusal from rendering as ordinary assistant prose.
      return { type: "refusal", text: str(raw["Text"]) };
    case "thinking":
      return {
        type: "thinking",
        thinking: str(raw["Thinking"]),
        signature: str(raw["Signature"]),
        // The ONLY thing kept from ProviderState: that there was one.
        redacted: raw["ProviderState"] !== undefined && raw["ProviderState"] !== null,
      };
    case "tool_use":
      return { type: "tool_use", id: str(raw["ID"]), name: str(raw["Name"]), input: raw["Input"] };
    case "tool_result":
      // Snake_case: ToolResultBlock has its own tagged codec. See the module
      // comment — this is deliberately NOT Go-cased.
      return {
        type: "tool_result",
        toolUseId: str(raw["tool_use_id"]),
        content: decodeBlocks(raw["content"]),
        isError: raw["is_error"] === true,
      };
    default:
      return { type: "other", wireType: str(raw["type"]), raw };
  }
}

/** Decodes a `blocks`/`content` array. A missing or malformed value yields []. */
export function decodeBlocks(raw: unknown): ContentBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(decodeBlock);
}

/**
 * One decoded conversation message. `toolUseId`/`isError` are meaningful only
 * for role "tool" (content.ToolResultMessage) and are "" / false otherwise —
 * a flat shape rather than a discriminated union, because every consumer here
 * switches on `role` anyway and the union buys nothing but casts.
 *
 * `role` is kept as a plain string. harness's unmarshalMessage fails closed on
 * an unknown role at the DURABLE boundary; this is a display path, where
 * dropping a message the journal accepted would be worse than rendering it.
 *
 * An AIMessage's own `usage` key (aiMessageJSON) is deliberately not decoded:
 * turn accounting is read from event.TurnDone's top-level `usage` field, so
 * decoding it here would offer a second, easily double-counted source.
 */
export interface ConversationMessage {
  role: string;
  blocks: ContentBlock[];
  toolUseId: string;
  isError: boolean;
}

export function decodeMessage(raw: unknown): ConversationMessage {
  if (!isRecord(raw)) return { role: "", blocks: [], toolUseId: "", isError: false };
  // Snake_case, unlike the Go-cased blocks nested inside: message.go declares
  // tagged wire structs (messageJSON, aiMessageJSON, toolResultMessageJSON).
  return {
    role: str(raw["role"]),
    blocks: decodeBlocks(raw["blocks"]),
    toolUseId: str(raw["tool_use_id"]),
    isError: raw["is_error"] === true,
  };
}

/**
 * Decodes a content.AgenticMessages array. Note that AgenticMessages has NO
 * codec in core/content at all: the discriminated-union slice dispatch lives
 * in harness/pkg/event/marshal.go (marshalMessages/unmarshalMessages), which
 * emits a plain JSON array of role-tagged messages and can legitimately emit
 * a null element. A null is skipped rather than yielding an empty row.
 */
export function decodeMessages(raw: unknown): ConversationMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map(decodeMessage);
}
