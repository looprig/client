/**
 * Pins the wire casing split described in core/content: bare structs with no
 * json tags (TextBlock, ThinkingBlock, ToolUseBlock, RefusalBlock) encode
 * Go-cased field names, while ToolResultBlock defines its own tagged codec
 * (block_json.go's toolResultJSON) and is snake_case. Getting either half
 * backwards yields empty strings and NO error, which is why this is pinned
 * rather than inspected.
 *
 * ## Provenance of the wire strings below
 *
 * `wui/contract/fixtures/` covers NO content block: its only message is
 * `status_running.json`'s `{"role":"assistant"}`, which carries no `blocks`
 * key at all (see messages.test.ts, which decodes it). So there is no vendored
 * fixture to decode here.
 *
 * Rather than hand-author objects — which would only encode this author's
 * belief about the casing, and pass happily if that belief were wrong — every
 * string below is the VERBATIM output of `content.MarshalBlock` /
 * `content.MarshalBlocks` in `github.com/looprig/core@v0.6.0`, the version
 * `github.com/looprig/harness@v0.30.0` (this module's pin, and the version
 * `contract/VERSION` records) requires. They are parsed with JSON.parse so the
 * test consumes bytes, not a JS literal. Regenerate by marshalling the same
 * values against that core version; two of them also appear verbatim in
 * core's own corpus — `{"type":"text","Text":"hello"}` and
 * `{"type":"tool_result","tool_use_id":"tu","content":[{"type":"text","Text":"x"}]}`
 * are seeds in content/block_json_fuzz_test.go (key order is not significant;
 * MarshalBlock round-trips through a map).
 *
 * The NEGATIVE cases are deliberately NOT real wire: the lowercase-`text`
 * block, the Go-cased `tool_result` block, the wrongly-typed fields and the
 * non-object inputs are the shapes a wrong assumption or a corrupted record
 * would produce, and they exist so a decoder that read the wrong key could not
 * pass this file. Each is labelled where it appears.
 */
import { describe, expect, it } from "vitest";
import { decodeBlock, decodeBlocks } from "../src/blocks.js";

/** Parses one real marshalled block, so the test decodes bytes rather than a JS literal. */
function wire(json: string): unknown {
  return JSON.parse(json) as unknown;
}

describe("decodeBlock", () => {
  it("reads a text block's Go-cased Text field", () => {
    expect(decodeBlock(wire('{"Text":"hello","type":"text"}'))).toEqual({ type: "text", text: "hello" });
  });

  it("does NOT read a lowercase text field", () => {
    // Not real wire: content.TextBlock has no `text` field to emit. This is the
    // shape a snake_case assumption would invent, and reading it would mean the
    // decoder silently returns "" for every REAL block.
    expect(decodeBlock(wire('{"text":"hello","type":"text"}'))).toEqual({ type: "text", text: "" });
  });

  it("reads a refusal block's Go-cased Text field", () => {
    expect(decodeBlock(wire('{"Text":"I won\'t","type":"refusal"}'))).toEqual({
      type: "refusal",
      text: "I won't",
    });
  });

  it("reads a thinking block's Go-cased Thinking and Signature", () => {
    expect(decodeBlock(wire('{"Signature":"sig","Thinking":"hm","type":"thinking"}'))).toEqual({
      type: "thinking",
      thinking: "hm",
      signature: "sig",
      redacted: false,
    });
  });

  it("drops a thinking block's three provider-private replay fields", () => {
    // ThinkingBlock is NOT tag-free after all: SignatureFormat, ProviderState
    // and ProviderStateFormat carry `json:"...,omitempty"` tags. The tags are
    // Go-cased, so the casing conclusion holds, but the fields are real wire
    // and a decoder has to decide about them. They are dropped on purpose:
    // they are provider-private continuation state whose ONLY use is replaying
    // a turn back to the issuing provider (see the ThinkingBlock doc comment —
    // replaying one dialect's state to another is a guaranteed rejection).
    // wui renders; it never replays. Surfacing opaque provider bytes in a
    // browser DOM would be a leak with no reader.
    expect(decodeBlock(wire('{"Signature":"sig","SignatureFormat":"anthropic","Thinking":"hm","type":"thinking"}'))).toEqual({
      type: "thinking",
      thinking: "hm",
      signature: "sig",
      redacted: false,
    });
  });

  it("decodes a redacted thinking block to empty visible text, not undefined", () => {
    // NewThinkingBlock("", "", providerState, "gemini") — the redacted shape.
    // Thinking and Signature carry no omitempty, so both are present and empty;
    // the payload rides in ProviderState.
    expect(
      decodeBlock(
        wire('{"ProviderState":{"d":"op"},"ProviderStateFormat":"gemini","Signature":"","Thinking":"","type":"thinking"}'),
      ),
    ).toEqual({ type: "thinking", thinking: "", signature: "", redacted: true });
  });

  it("marks a redacted block WITHOUT forwarding one provider byte", () => {
    // The whole point of the derived boolean. `redacted` says THAT reasoning
    // was withheld; the opaque continuation state that says what it was stays
    // on the server, where the only thing that can read it lives. Serialising
    // the decoded block must not contain the payload or its dialect label.
    const decoded = decodeBlock(
      wire('{"ProviderState":{"d":"OPAQUE-PAYLOAD"},"ProviderStateFormat":"gemini","Signature":"","Thinking":"","type":"thinking"}'),
    );
    const serialized = JSON.stringify(decoded);
    expect(serialized).not.toContain("OPAQUE-PAYLOAD");
    expect(serialized).not.toContain("ProviderState");
    expect(serialized).not.toContain("gemini");
    expect(Object.keys(decoded).sort()).toStrictEqual(["redacted", "signature", "thinking", "type"]);
  });

  it("does NOT mark a plain empty thinking block, which is the whole distinction", () => {
    // Both are `{"Signature":"","Thinking":""}` in their VISIBLE fields — the
    // only thing separating "the model redacted its reasoning" from "there was
    // no reasoning" is the presence of ProviderState. Verbatim from core@v0.6.0:
    // NewThinkingBlock("", "", nil, "") marshals to {"Thinking":"","Signature":""}.
    expect(decodeBlock(wire('{"Signature":"","Thinking":"","type":"thinking"}'))).toEqual({
      type: "thinking",
      thinking: "",
      signature: "",
      redacted: false,
    });
  });

  it("marks a block that carries BOTH visible reasoning and provider state", () => {
    // core's doc says the two "are never both populated by the same wire
    // block", but that describes providers, not a validated invariant: a bare
    // struct literal can pair them, and core@v0.6.0 marshals the pair happily.
    // `redacted` is therefore independent of `thinking`, meaning "some of this
    // step's reasoning was withheld", not "all of it".
    expect(
      decodeBlock(
        wire('{"ProviderState":"op","ProviderStateFormat":"gemini","Signature":"","Thinking":"visible","type":"thinking"}'),
      ),
    ).toEqual({ type: "thinking", thinking: "visible", signature: "", redacted: true });
  });

  it("does NOT mark a literal null ProviderState, which carries no state at all", () => {
    // Reachable, not hypothetical: `omitempty` on a json.RawMessage drops only
    // a ZERO-LENGTH value, and the four bytes "null" are not zero-length, so
    // core@v0.6.0 emits {"ProviderState":null,"ProviderStateFormat":"anthropic"}
    // for a RawMessage("null"). A key whose value is JSON null withheld nothing.
    expect(
      decodeBlock(wire('{"ProviderState":null,"ProviderStateFormat":"anthropic","Signature":"","Thinking":"","type":"thinking"}')),
    ).toEqual({ type: "thinking", thinking: "", signature: "", redacted: false });
  });

  it("marks any non-null provider state, whatever JSON shape it takes", () => {
    // ProviderState is a json.RawMessage: an object for Gemini, a base64 string
    // for Anthropic's redacted_thinking.data. Neither is read, both count.
    for (const state of ['"opaque-bytes"', '{"d":"op"}', '[1,2]', "0", "false", '""']) {
      const raw = `{"ProviderState":${state},"ProviderStateFormat":"anthropic","Signature":"","Thinking":"","type":"thinking"}`;
      expect(decodeBlock(wire(raw)), raw).toMatchObject({ redacted: true });
    }
  });

  it("reads a tool_use block's Go-cased ID, Name and Input", () => {
    expect(decodeBlock(wire('{"ID":"toolu_1","Input":{"path":"/tmp/x"},"Name":"Read","type":"tool_use"}'))).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "Read",
      input: { path: "/tmp/x" },
    });
  });

  it("drops a tool_use block's provider-private replay fields too", () => {
    expect(
      decodeBlock(
        wire('{"ID":"toolu_2","Input":{},"Name":"Bash","ProviderState":"st","ProviderStateFormat":"openai-responses","type":"tool_use"}'),
      ),
    ).toEqual({ type: "tool_use", id: "toolu_2", name: "Bash", input: {} });
  });

  it("reads a tool_result block's SNAKE_CASE fields (it has its own tagged codec)", () => {
    expect(
      decodeBlock(wire('{"content":[{"Text":"ok","type":"text"}],"is_error":true,"tool_use_id":"toolu_1","type":"tool_result"}')),
    ).toEqual({
      type: "tool_result",
      toolUseId: "toolu_1",
      content: [{ type: "text", text: "ok" }],
      isError: true,
    });
  });

  it("does NOT read Go-cased fields on a tool_result block", () => {
    // The mirror of the lowercase-text case: ToolResultBlock is the ONE block
    // whose fields are snake_case, so a decoder that "normalized" every block
    // to Go casing would read nothing here and lose the tool output silently.
    expect(decodeBlock(wire('{"Content":[{"Text":"ok","type":"text"}],"IsError":true,"ToolUseID":"toolu_1","type":"tool_result"}'))).toEqual(
      { type: "tool_result", toolUseId: "", content: [], isError: false },
    );
  });

  it("defaults is_error to false when omitempty dropped it", () => {
    // Real wire: MarshalBlock of &ToolResultBlock{ToolUseID: "t"} — `content`
    // and `is_error` are both omitempty and both absent.
    const decoded = decodeBlock(wire('{"tool_use_id":"t","type":"tool_result"}'));
    expect(decoded).toEqual({ type: "tool_result", toolUseId: "t", content: [], isError: false });
  });

  it("nests a tool_result's Go-cased children under its own snake_case keys", () => {
    // Both halves of the split in ONE value: the outer keys are snake_case and
    // the nested blocks stay Go-cased, which is what UnmarshalBlocks recursing
    // through the shared slice codec produces.
    const decoded = decodeBlock(
      wire('{"content":[{"Text":"a","type":"text"},{"Signature":"s","Thinking":"why","type":"thinking"}],"tool_use_id":"tu","type":"tool_result"}'),
    );
    expect(decoded).toEqual({
      type: "tool_result",
      toolUseId: "tu",
      content: [
        { type: "text", text: "a" },
        { type: "thinking", thinking: "why", signature: "s", redacted: false },
      ],
      isError: false,
    });
  });

  it("keeps an unrecognized block as an opaque passthrough, never dropping it", () => {
    // ImageBlock is a real core variant wui does not render; MarshalBlock emits
    // it Go-cased like every other bare struct.
    const raw = '{"MediaType":"image/png","Source":{"URL":"https://x/y.png","Data":null},"type":"image"}';
    expect(decodeBlock(wire(raw))).toEqual({
      type: "other",
      wireType: "image",
      raw: JSON.parse(raw) as Record<string, unknown>,
    });
  });

  it("tolerates a non-object block rather than throwing", () => {
    expect(decodeBlock(null)).toEqual({ type: "other", wireType: "", raw: {} });
    expect(decodeBlock(wire("[]"))).toEqual({ type: "other", wireType: "", raw: {} });
    expect(decodeBlock(wire('"a string"'))).toEqual({ type: "other", wireType: "", raw: {} });
  });

  it("tolerates a non-string type tag and a missing one", () => {
    expect(decodeBlock(wire("{}"))).toEqual({ type: "other", wireType: "", raw: {} });
    expect(decodeBlock(wire('{"type":7}'))).toEqual({ type: "other", wireType: "", raw: { type: 7 } });
  });

  it("substitutes an empty string for a wrongly-typed Go-cased field", () => {
    expect(decodeBlock(wire('{"Text":7,"type":"text"}'))).toEqual({ type: "text", text: "" });
    expect(decodeBlock(wire('{"tool_use_id":7,"content":"nope","type":"tool_result"}'))).toEqual({
      type: "tool_result",
      toolUseId: "",
      content: [],
      isError: false,
    });
  });
});

describe("decodeBlocks", () => {
  it("decodes an array in order and yields [] for a missing/omitempty field", () => {
    // Real wire: content.MarshalBlocks of two TextBlocks.
    expect(decodeBlocks(wire('[{"Text":"a","type":"text"},{"Text":"b","type":"text"}]'))).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    expect(decodeBlocks(undefined)).toEqual([]);
    expect(decodeBlocks("not an array")).toEqual([]);
  });

  it("preserves order rather than grouping by type", () => {
    const decoded = decodeBlocks(
      wire('[{"Signature":"s","Thinking":"t","type":"thinking"},{"Text":"n","type":"text"},{"ID":"i","Input":{},"Name":"Read","type":"tool_use"}]'),
    );
    expect(decoded.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
  });

  it("keeps a malformed element in place instead of shortening the array", () => {
    expect(decodeBlocks(wire('[{"Text":"a","type":"text"},null]'))).toEqual([
      { type: "text", text: "a" },
      { type: "other", wireType: "", raw: {} },
    ]);
  });
});
