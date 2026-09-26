import { expect, test } from "vitest";
import { decodeFactoryLiveDelta, decodeFactoryLiveText } from "../src/index.js";

const SESSION = "public-session";
const LOOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TURN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function body(text: unknown = "hello"): Record<string, unknown> {
  return {
    v: 1, type: "TokenDelta", session_id: SESSION, loop_id: LOOP, turn_id: TURN,
    chunk: { chunk_type: "text", text },
  };
}

test("decodes only a correlated public text delta", () => {
  expect(decodeFactoryLiveText(body(), SESSION)).toStrictEqual({ loopId: LOOP, turnId: TURN, text: "hello" });
});

test("decodes text and thinking as distinct preview kinds without changing the text API", () => {
  expect(decodeFactoryLiveDelta(body(), SESSION)).toStrictEqual({ kind: "text", loopId: LOOP, turnId: TURN, text: "hello" });
  const thinking = { ...body(), chunk: { chunk_type: "thinking", thinking: "because" } };
  expect(decodeFactoryLiveDelta(thinking, SESSION)).toStrictEqual({ kind: "reasoning", loopId: LOOP, turnId: TURN, text: "because" });
  expect(decodeFactoryLiveText(thinking, SESSION)).toBeNull();
});

test.each([
  ["nonstring", 42], ["empty", ""], ["oversized", "x".repeat(16_385)],
])("rejects %s thinking for its reasoning key", (_name, thinking) => {
  expect(decodeFactoryLiveDelta({ ...body(), chunk: { chunk_type: "thinking", thinking } }, SESSION))
    .toStrictEqual({ kind: "reasoning", rejected: true, loopId: LOOP, turnId: TURN });
});

test("applies the envelope limit to thinking and ignores unrelated chunks", () => {
  expect(decodeFactoryLiveDelta({ ...body(), chunk: { chunk_type: "thinking", thinking: "ok" }, padding: "x".repeat(102_401) }, SESSION))
    .toStrictEqual({ kind: "reasoning", rejected: true, loopId: LOOP, turnId: TURN });
  expect(decodeFactoryLiveDelta({ ...body(), chunk: { chunk_type: "tool_use", name: "Read" } }, SESSION)).toBeNull();
  expect(decodeFactoryLiveDelta({ ...body(), session_id: "private", chunk: { chunk_type: "thinking", thinking: "secret" } }, SESSION)).toBeNull();
});

test("accepts an escape-heavy 16 KiB text chunk", () => {
  const text = '"'.repeat(16_384);
  expect(decodeFactoryLiveText(body(text), SESSION)).toStrictEqual({ loopId: LOOP, turnId: TURN, text });
});

test("identifies an oversized delta for this session so its key can be suppressed", () => {
  expect(decodeFactoryLiveText(body("x".repeat(16_385)), SESSION)).toStrictEqual({
    rejected: true, loopId: LOOP, turnId: TURN,
  });
});

test("a non-object chunk suppresses the text key as in 0.1.0", () => {
  const malformed = { ...body(), chunk: 42 };
  expect(decodeFactoryLiveDelta(malformed, SESSION)).toStrictEqual({
    kind: "text", rejected: true, loopId: LOOP, turnId: TURN,
  });
  expect(decodeFactoryLiveText(malformed, SESSION)).toStrictEqual({
    rejected: true, loopId: LOOP, turnId: TURN,
  });
});

test.each([
  ["nonstring text", body(42)],
  ["oversized envelope", { ...body(), padding: "x".repeat(102_401) }],
])("identifies %s as a rejected delta", (_name, value) => {
  expect(decodeFactoryLiveText(value, SESSION)).toStrictEqual({ rejected: true, loopId: LOOP, turnId: TURN });
});

test.each([
  ["wrong version", { ...body(), v: 2 }],
  ["wrong kind", { ...body(), type: "ToolCallStarted" }],
  ["wrong public session", { ...body(), session_id: "private-session" }],
  ["missing session", { ...body(), session_id: undefined }],
  ["missing loop", { ...body(), loop_id: undefined }],
  ["malformed loop", { ...body(), loop_id: "bad" }],
  ["missing turn", { ...body(), turn_id: undefined }],
  ["malformed turn", { ...body(), turn_id: "bad" }],
  ["thinking chunk", { ...body(), chunk: { chunk_type: "thinking", thinking: "secret" } }],
  ["nontext chunk", { ...body(), chunk: { chunk_type: "tool_use", text: "secret" } }],
  ["array body", []],
  ["null body", null],
])("refuses %s", (_name, value) => {
  expect(decodeFactoryLiveText(value, SESSION)).toBeNull();
});
