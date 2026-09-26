/**
 * `ControlledLiveSource` and the frame builders in `./live.js`.
 *
 * The builders are asserted by FOLDING them, not by inspecting the literals
 * they return. A fixture is only correct relative to the decoder that reads it,
 * and 04-react.md's originals were wrong in five separate places against the
 * real `@looprig/client` fold — `chunkType` for `chunk_type`, a nested
 * `header` key inside an enduring envelope (MarshalEvent promotes those fields
 * to siblings), a string `reject_reason` where the wire carries a numeric
 * `reason`, and a `turn_index`-less TurnStarted. Every one of those produces a
 * literal that LOOKS plausible and folds to nothing, which no shape assertion
 * on the builder's output would have caught.
 */
import { expect, test } from "vitest";
import { emptySessionView, fold, type SessionView } from "@looprig/client";
import {
  ControlledLiveSource,
  GATE_ID,
  LOOP_ID,
  gateOpened,
  gateResolved,
  textDelta,
  toolCallCompleted,
  toolCallStarted,
  turnRejected,
  turnStarted,
} from "./live.js";
import type { SseFrame } from "@looprig/client";
import { SID } from "./fake-transport.js";

/** Folds live frames in order, asserting none of them produced a fold error. */
function foldLive(frames: SseFrame[]): SessionView {
  let view = emptySessionView();
  for (const frame of frames) {
    const result = fold(view, { segment: "live", frame });
    if (!result.ok) throw new Error(`fold rejected a fixture: ${result.error.message}`);
    view = result.view;
  }
  return view;
}

test("delivers emitted frames to the consumer in order", async () => {
  const live = new ControlledLiveSource();
  const seen: string[] = [];

  const consume = (async () => {
    for await (const frame of live.source()) {
      if (frame.type === "ephemeral") seen.push(frame.data.kind);
    }
  })();

  live.emit(toolCallStarted("t1", "Read"));
  live.emit(textDelta("hi"));
  live.end();
  await consume;

  expect(seen).toStrictEqual(["tool_call_started", "token_delta"]);
});

test("counts opens and closes, and return() closes the open connection", async () => {
  const live = new ControlledLiveSource();
  const iterator = live.source()[Symbol.asyncIterator]();
  const first = iterator.next();

  expect(live.openCount).toBe(1);
  expect(live.isOpen).toBe(true);

  await iterator.return?.();
  await first;

  expect(live.closedCount).toBe(1);
  expect(live.isOpen).toBe(false);
});

test("a late return() on a closed connection does not close the next one", async () => {
  const live = new ControlledLiveSource();
  const first = live.source()[Symbol.asyncIterator]();
  await first.return?.();

  const second = live.source()[Symbol.asyncIterator]();
  const parked = second.next();

  // joinSessionView's `finally` calls `liveIterator.return()` best-effort long
  // after a store already cancelled, so this really happens on every session
  // switch. With per-instance state the late close lands on the connection
  // the NEXT store just opened, which autoReconnect then reopens.
  await first.return?.();

  expect([live.openCount, live.closedCount]).toStrictEqual([2, 1]);
  expect(live.isOpen).toBe(true);
  live.emit(toolCallStarted("t1", "Read"));
  await expect(parked).resolves.toHaveProperty("done", false);
});

test("error() makes the consumer's next() reject", async () => {
  const live = new ControlledLiveSource();
  const iterator = live.source()[Symbol.asyncIterator]();

  live.error(new Error("connection dropped"));

  await expect(iterator.next()).rejects.toThrow("connection dropped");
});

test("a tool-call pair folds to one completed tool row", () => {
  const view = foldLive([
    toolCallStarted("t1", "Read"),
    toolCallCompleted("t1", { resultPreview: "3 lines" }),
  ]);

  const rows = view.rows.filter((row) => row.loopId === LOOP_ID);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row?.kind !== "tool") throw new Error(`expected a tool row, got ${String(row?.kind)}`);
  expect(row.toolName).toBe("Read");
  expect(row.status).toBe("ok");
  expect(row.result).toBe("3 lines");
});

test("a text delta folds into a live assistant row", () => {
  const view = foldLive([textDelta("hello ")]);

  const row = view.rows.at(-1);
  if (row?.kind !== "assistant") throw new Error(`expected an assistant row, got ${String(row?.kind)}`);
  expect(row.text).toBe("hello ");
  expect(row.live).toBe(true);
});

test("turnStarted records the command id as started", () => {
  const commandId = "aaaaaaaa-1111-4111-8111-111111111111";

  const view = foldLive([turnStarted(1, { commandId, text: "do the thing" })]);

  expect(view.commandOutcomes.get(commandId)).toBe("started");
});

test("turnRejected records the command id as rejected and commits a notice", () => {
  const commandId = "bbbbbbbb-1111-4111-8111-111111111111";

  const view = foldLive([turnRejected(1, commandId, 1)]);

  expect(view.commandOutcomes.get(commandId)).toBe("rejected");
  const row = view.rows.at(-1);
  if (row?.kind !== "notice") throw new Error(`expected a notice row, got ${String(row?.kind)}`);
  // The wire reason is a uint8 RejectReason, so this text is the fold's own
  // lookup — proof the builder passed a number, not the string 04-react.md had.
  expect(row.text).toBe("input rejected: the loop's queue is full");
});

test("gateOpened opens a gate keyed by gate id, and gateResolved removes it", () => {
  const opened = foldLive([gateOpened(1, { id: GATE_ID, title: "Allow Write?" })]);

  expect([...opened.gates.keys()]).toStrictEqual([GATE_ID]);
  expect(opened.gates.get(GATE_ID)?.kind).toBe("harness.permission");
  expect(opened.gates.get(GATE_ID)?.prompt.title).toBe("Allow Write?");

  const resolved = foldLive([gateOpened(1, { id: GATE_ID }), gateResolved(2, GATE_ID)]);
  expect(resolved.gates.size).toBe(0);
});

test("every builder carries the session id the fixtures share", () => {
  const frame = turnStarted(1, {});
  if (frame.type !== "enduring") throw new Error("expected an enduring frame");
  expect(frame.data.event.session_id).toBe(SID);
});
