/**
 * Message-LEVEL fields are snake_case: core/content/message.go declares
 * tagged wire structs (messageJSON, aiMessageJSON, toolResultMessageJSON).
 * The nested blocks stay Go-cased. AgenticMessages itself has no codec in
 * core/content — the slice dispatch lives in harness/pkg/event/marshal.go's
 * marshalMessages/unmarshalMessages, which tags each element by "role".
 *
 * ## Provenance of the wire strings below
 *
 * The vendored fixtures reach messages exactly once: `status_running.json`'s
 * `last_step.event.messages` is `[{"role":"assistant"}]`. That one really is
 * decoded here, from the file — it is the committed proof that `role` is
 * snake_case and that `blocks` is omitempty-absent on a real StepDone. It
 * carries no blocks, so it cannot pin anything below it.
 *
 * The POSITIVE cases below are therefore the VERBATIM output of `json.Marshal`
 * over a `content.AgenticMessages` in `github.com/looprig/core@v0.6.0` — the
 * version `github.com/looprig/harness@v0.30.0` (this module's pin) requires —
 * which is byte-for-byte what harness's marshalMessages emits, since
 * marshalMessages is `json.Marshal` per element into a `[]json.RawMessage`.
 *
 * The NEGATIVE cases (Go-cased message keys, a non-boolean is_error, a
 * non-object message) are deliberately NOT real wire: they are the shapes a
 * wrong assumption would produce, and they exist so a decoder reading the wrong
 * key could not pass this file. Each is labelled where it appears.
 *
 * Every string is parsed with JSON.parse, so the test consumes bytes rather
 * than a JS literal that could quietly encode the author's belief.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeMessage, decodeMessages } from "../src/blocks.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixtureJson(file: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + file, "utf8")) as unknown;
}

/** Parses one real marshalled message, so the test decodes bytes rather than a JS literal. */
function wire(json: string): unknown {
  return JSON.parse(json) as unknown;
}

describe("decodeMessage", () => {
  it("decodes a user message: snake_case role/blocks, Go-cased block fields", () => {
    expect(decodeMessage(wire('{"role":"user","blocks":[{"Text":"go","type":"text"}]}'))).toEqual({
      role: "user",
      blocks: [{ type: "text", text: "go" }],
      toolUseId: "",
      isError: false,
    });
  });

  it("does NOT read Go-cased message-level fields", () => {
    // The mirror of blocks.test.ts's lowercase-text case. content.Message
    // declares `json:"role"` / `json:"blocks,omitempty"`, so a decoder that
    // applied the BLOCK rule one level up reads nothing and renders an empty
    // transcript with no error.
    expect(decodeMessage(wire('{"Role":"user","Blocks":[{"Text":"go","type":"text"}]}'))).toEqual({
      role: "",
      blocks: [],
      toolUseId: "",
      isError: false,
    });
  });

  it("decodes an assistant message's blocks in order, with their Go-cased contents", () => {
    const msg = decodeMessage(
      wire(
        '{"role":"assistant","blocks":[{"Signature":"s","Thinking":"hm","type":"thinking"},{"Text":"answer","type":"text"},{"ID":"toolu_1","Input":{},"Name":"Read","type":"tool_use"}],"usage":{"InputTokens":10,"OutputTokens":4}}',
      ),
    );
    // Asserted whole, not by `.map(b => b.type)`: the tags are snake_case on
    // the wire either way, so a type-only assertion would pass against a
    // decoder that read every payload field with the wrong casing.
    expect(msg).toEqual({
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "hm", signature: "s", redacted: false },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
      ],
      toolUseId: "",
      isError: false,
    });
  });

  it("does not decode an AIMessage's own usage key", () => {
    // aiMessageJSON carries `usage,omitempty` (Go-cased inner names, since
    // usageJSON tags are `json:",omitempty"`). It is deliberately absent from
    // ConversationMessage: the transcript reads turn accounting from
    // event.TurnDone's own top-level `usage` field, not from the message. This
    // pins the omission as a decision — adding it here means deciding whether
    // per-message and per-turn usage may both be shown without double-counting.
    // Asserted as a whole object rather than `not.toHaveProperty("usage")`,
    // which a gutted decoder returning a stub would also satisfy.
    expect(
      decodeMessage(
        wire(
          '{"role":"assistant","blocks":[{"Signature":"s","Thinking":"hm","type":"thinking"},{"Text":"answer","type":"text"},{"ID":"toolu_1","Input":{},"Name":"Read","type":"tool_use"}],"usage":{"InputTokens":10,"OutputTokens":4}}',
        ),
      ),
    ).toEqual({
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "hm", signature: "s", redacted: false },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
      ],
      toolUseId: "",
      isError: false,
    });
  });

  it("decodes a tool result message's tool_use_id and is_error", () => {
    expect(
      decodeMessage(wire('{"role":"tool","blocks":[{"Text":"output","type":"text"}],"tool_use_id":"toolu_1","is_error":true}')),
    ).toEqual({
      role: "tool",
      blocks: [{ type: "text", text: "output" }],
      toolUseId: "toolu_1",
      isError: true,
    });
  });

  it("does NOT read Go-cased ToolUseID/IsError on a tool result message", () => {
    expect(decodeMessage(wire('{"role":"tool","ToolUseID":"toolu_1","IsError":true}'))).toEqual({
      role: "tool",
      blocks: [],
      toolUseId: "",
      isError: false,
    });
  });

  it("defaults an omitted is_error to false and an omitted blocks to []", () => {
    // Real wire: marshalling ToolResultMessage{ToolUseID: "t"} — `blocks` and
    // `is_error` are both omitempty and both absent, and tool_use_id is not.
    expect(decodeMessage(wire('{"role":"tool","tool_use_id":"t"}'))).toEqual({
      role: "tool",
      blocks: [],
      toolUseId: "t",
      isError: false,
    });
  });

  it("treats a non-true is_error as false rather than truthy", () => {
    // Not real wire: content.ToolResultMessage's IsError is a bool. These are
    // the shapes a lenient producer or a corrupted record could present, and a
    // truthy check would turn a stray string into a red error row.
    expect(decodeMessage(wire('{"role":"tool","is_error":"true"}')).isError).toBe(false);
    expect(decodeMessage(wire('{"role":"tool","is_error":1}')).isError).toBe(false);
  });

  it("keeps an unknown role rather than failing closed on the display path", () => {
    // harness's unmarshalMessage returns UnknownMessageRoleError here, at the
    // DURABLE boundary. This is a display path: dropping a message the journal
    // already accepted would be worse than rendering it.
    expect(decodeMessage(wire('{"role":"wat"}')).role).toBe("wat");
  });

  it("decodes a system message, which harness accepts and the union includes", () => {
    expect(decodeMessage(wire('{"role":"system","blocks":[{"Text":"sys","type":"text"}]}'))).toEqual({
      role: "system",
      blocks: [{ type: "text", text: "sys" }],
      toolUseId: "",
      isError: false,
    });
  });

  it("tolerates a non-object message rather than throwing", () => {
    expect(decodeMessage(null)).toEqual({ role: "", blocks: [], toolUseId: "", isError: false });
    expect(decodeMessage(wire("[]"))).toEqual({ role: "", blocks: [], toolUseId: "", isError: false });
  });
});

describe("decodeMessages", () => {
  it("decodes the real status_running.json fixture's StepDone messages", () => {
    const status = readFixtureJson("status_running.json") as {
      last_step: { event: { messages: unknown } };
    };
    // Guard the path itself: if the fixture stops carrying messages this test
    // must fail loudly, not quietly assert [] against nothing.
    expect(Array.isArray(status.last_step.event.messages)).toBe(true);
    expect(status.last_step.event.messages).toHaveLength(1);
    expect(decodeMessages(status.last_step.event.messages)).toEqual([
      { role: "assistant", blocks: [], toolUseId: "", isError: false },
    ]);
  });

  it("decodes a whole marshalled AgenticMessages array in order", () => {
    // Verbatim json.Marshal of a six-element content.AgenticMessages: user,
    // assistant (with usage), system, tool result, an omitempty-bare tool
    // result, and a nil element.
    const out = decodeMessages(
      wire(
        '[{"role":"user","blocks":[{"Text":"go","type":"text"}]},' +
          '{"role":"assistant","blocks":[{"Signature":"s","Thinking":"hm","type":"thinking"},{"Text":"answer","type":"text"},{"ID":"toolu_1","Input":{},"Name":"Read","type":"tool_use"}],"usage":{"InputTokens":10,"OutputTokens":4}},' +
          '{"role":"system","blocks":[{"Text":"sys","type":"text"}]},' +
          '{"role":"tool","blocks":[{"Text":"output","type":"text"}],"tool_use_id":"toolu_1","is_error":true},' +
          '{"role":"tool","tool_use_id":"t"},null]',
      ),
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "system", "tool", "tool"]);
    expect(out[3]).toEqual({
      role: "tool",
      blocks: [{ type: "text", text: "output" }],
      toolUseId: "toolu_1",
      isError: true,
    });
  });

  it("skips a null element (marshalMessages can emit one) and yields [] for a non-array", () => {
    // unmarshalMessages appends a literal nil for a `null` element, so `null`
    // is a value the durable codec produces, not a corruption.
    expect(decodeMessages(wire('[null,{"role":"user"}]'))).toEqual([
      { role: "user", blocks: [], toolUseId: "", isError: false },
    ]);
    expect(decodeMessages(undefined)).toEqual([]);
    expect(decodeMessages("not an array")).toEqual([]);
  });
});
