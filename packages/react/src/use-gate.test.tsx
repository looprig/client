import { GATE_KIND_ASK_USER, GATE_KIND_PERMISSION, SessionViewStore } from "@looprig/client";
import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { ControlledLiveSource, gateOpened, gateResolved } from "./testing/live.js";
import { useGate } from "./use-gate.js";

const GATE_A = "3f4a5b6c-7d8e-4f90-a1b2-c3d4e5f60718";
const GATE_B = "4a5b6c7d-8e9f-4012-b3c4-d5e6f7081920";

function setup(): { transport: FakeTransport; live: ControlledLiveSource; view: SessionViewStore } {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const view = new SessionViewStore({ journal: transport, sessionId: SID, liveSource: live.source });
  view.start();
  return { transport, live, view };
}

test("a GateOpened frame surfaces an answerable permission gate", async () => {
  const { transport, live, view } = setup();
  const { result } = await renderHook(() => useGate(transport, SID, view));

  live.emit(gateOpened(1, { id: GATE_A, kind: GATE_KIND_PERMISSION, title: "Run rm -rf?" }));

  await expect.poll(() => result.current.gates.map((gate) => gate.id)).toStrictEqual([GATE_A]);
  expect(result.current.gates[0]?.answerable).toBe(true);
  expect(result.current.gates[0]?.prompt.title).toBe("Run rm -rf?");
  expect(result.current.gates[0]?.responding).toBe(false);
  expect(result.current.gates[0]?.error).toBeUndefined();
  view.stop();
});

test("GateResolved removes it, and two concurrent gates both stay visible", async () => {
  const { transport, live, view } = setup();
  const { result } = await renderHook(() => useGate(transport, SID, view));

  // The exact case GET /status's single last-writer-wins waiting_gate_id slot
  // loses: two parallel subagent gates, one of which it would erase.
  live.emit(gateOpened(1, { id: GATE_A, kind: GATE_KIND_PERMISSION }));
  live.emit(gateOpened(2, { id: GATE_B, kind: GATE_KIND_PERMISSION }));
  await expect.poll(() => result.current.gates.map((gate) => gate.id)).toStrictEqual([GATE_A, GATE_B]);

  live.emit(gateResolved(3, GATE_A));

  await expect.poll(() => result.current.gates.map((gate) => gate.id)).toStrictEqual([GATE_B]);
  view.stop();
});

test("a non-permission kind is surfaced as unanswerable rather than hidden", async () => {
  const { transport, live, view } = setup();
  const { result } = await renderHook(() => useGate(transport, SID, view));

  live.emit(gateOpened(1, { id: GATE_A, kind: GATE_KIND_ASK_USER, title: "What next?" }));

  // wui answers permission gates only. The other three kinds still BLOCK the
  // loop, so they render an explicit "answer this in the TUI" card rather than
  // hanging or vanishing.
  await expect.poll(() => result.current.gates).toHaveLength(1);
  expect(result.current.gates[0]?.answerable).toBe(false);
  view.stop();
});

test("an unrecognised future gate kind is unanswerable, not assumed to be a permission gate", async () => {
  const { transport, live, view } = setup();
  const { result } = await renderHook(() => useGate(transport, SID, view));

  live.emit(gateOpened(1, { id: GATE_A, kind: "harness.something_new" }));

  // Fail secure: offering Approve/Deny for a gate whose resolver never declared
  // those actions submits an action harness rejects, and tells the user they
  // resolved something they did not.
  await expect.poll(() => result.current.gates).toHaveLength(1);
  expect(result.current.gates[0]?.answerable).toBe(false);
  view.stop();
});

test("the responder is stable across re-renders", async () => {
  const { transport, view } = setup();
  const { result, rerender } = await renderHook(() => useGate(transport, SID, view));
  const first = result.current.respond;

  await rerender();
  await rerender();

  expect(result.current.respond).toBe(first);
  view.stop();
});
