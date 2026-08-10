/**
 * Minimal wire-level helper for constructing `CreateRequest.blocks` entries
 * (the request body `submit`/`createSession` accept — see transport.ts).
 * `blocks` is loosely typed at the schema level (each item is just
 * `{"type":"object"}` — see create_request.schema.json's own description,
 * "Block semantics are validated by the content block codec, not this
 * schema") because the actual codec lives in harness's `core/content`
 * package (Go), not this SDK.
 *
 * `textBlock` mirrors that codec's EXACT wire shape for a plain-text content
 * block: `{"type":"text","Text":"..."}` — the capitalized `Text` field is not
 * a stylistic guess, it's what `content.TextBlock` (a bare
 * `struct{ Text string }` with no `json` struct tag, see harness's
 * `core/content/block.go`) actually encodes to. Confirmed against harness's
 * own `pkg/serve/handlers_lifecycle_test.go`, whose `validBlocksBody` fixture
 * is literally `{"blocks":[{"type":"text","Text":"hello"}]}`. Sending a
 * lowerCamelCase `text` field instead would silently decode to an EMPTY
 * TextBlock server-side (Go's default JSON unmarshaling is case-insensitive
 * for matching but there is no `text` field to match at all here — the real
 * field is `Text`), not fail loudly, so getting this exact casing right
 * matters.
 */

/**
 * The wire shape of a single text content block, as `content.TextBlock` (Go)
 * encodes it. Carries an index signature purely so a `TextContentBlock`
 * value structurally satisfies `CreateRequest["blocks"]`'s item type (schema-
 * derived as an open `{[x: string]: unknown}`, per create_request.schema.json's
 * `{"type":"object"}` with no declared properties) — TypeScript's implicit-
 * index-signature compatibility only applies to a genuinely fresh object
 * literal at the assignment site, not to a value flowing through a named
 * return type like this one.
 */
export interface TextContentBlock {
  type: "text";
  Text: string;
  [key: string]: unknown;
}

/** Builds a `CreateRequest.blocks` entry carrying plain text — the shape a chat composer submits. */
export function textBlock(text: string): TextContentBlock {
  return { type: "text", Text: text };
}
