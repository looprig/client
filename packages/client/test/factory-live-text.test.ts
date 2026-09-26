import { expect, test } from "vitest";
import { decodeFactoryLiveText } from "../src/index.js";

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

test("accepts an escape-heavy 16 KiB text chunk", () => {
  const text = '"'.repeat(16_384);
  expect(decodeFactoryLiveText(body(text), SESSION)).toStrictEqual({ loopId: LOOP, turnId: TURN, text });
});

test("identifies an oversized delta for this session so its key can be suppressed", () => {
  expect(decodeFactoryLiveText(body("x".repeat(16_385)), SESSION)).toStrictEqual({
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
