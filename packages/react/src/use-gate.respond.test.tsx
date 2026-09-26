import { GATE_APPROVAL_ACTIONS, GATE_KIND_PERMISSION, SessionViewStore } from "@looprig/client";
import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { ControlledLiveSource, gateOpened } from "./testing/live.js";
import { useGate } from "./use-gate.js";

const GATE_A = "3f4a5b6c-7d8e-4f90-a1b2-c3d4e5f60718";

interface Opened {
  transport: FakeTransport;
  live: ControlledLiveSource;
  view: SessionViewStore;
  result: { current: ReturnType<typeof useGate> };
}

async function openGate(): Promise<Opened> {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const view = new SessionViewStore({ journal: transport, sessionId: SID, liveSource: live.source });
  view.start();
  const { result } = await renderHook(() => useGate(transport, SID, view));
  live.emit(gateOpened(1, { id: GATE_A, kind: GATE_KIND_PERMISSION }));
  await expect.poll(() => result.current.gates).toHaveLength(1);
  return { transport, live, view, result };
}

test("sends one of the three exact action strings and masks the gate", async () => {
  const { transport, view, result } = await openGate();

  await expect(
    result.current.respond(GATE_A, GATE_APPROVAL_ACTIONS.approveAlwaysWorkspace),
  ).resolves.toBe(true);

  expect(transport.calls.at(-1)).toStrictEqual({
    method: "respondGate",
    args: [SID, GATE_A, { action: "Approve always for this workspace" }, undefined],
  });
  // Masked the instant respondGate resolves, ahead of GateResolved, so a fast
  // double-click cannot fire a second response for a gate already answered.
  await expect.poll(() => result.current.gates).toHaveLength(0);
  view.stop();
});

test("a second respond for an answered gate never reaches the transport", async () => {
  const { transport, view, result } = await openGate();
  await result.current.respond(GATE_A, GATE_APPROVAL_ACTIONS.approve);

  await expect(result.current.respond(GATE_A, GATE_APPROVAL_ACTIONS.deny)).resolves.toBe(false);

  expect(transport.countOf("respondGate")).toBe(1);
  view.stop();
});

test("gate_action_invalid is reported as already-answered, not as an error", async () => {
  const { transport, view, result } = await openGate();
  // Two tabs may both answer; the loser gets this code. It maps to protocol's
  // catch-all UnknownLooprigError, so the check must be structural on `code`.
  transport.fail(
    "respondGate",
    Object.assign(new Error("gate already resolved"), { code: "gate_action_invalid" }),
  );

  await expect(result.current.respond(GATE_A, GATE_APPROVAL_ACTIONS.deny)).resolves.toBe(false);

  await expect.poll(() => result.current.gates[0]?.alreadyAnswered).toBe(true);
  expect(result.current.gates[0]?.error).toBeUndefined();
  expect(result.current.gates[0]?.responding).toBe(false);
  view.stop();
});

test("any other failure keeps the gate answerable and records the error", async () => {
  const { transport, view, result } = await openGate();
  transport.fail("respondGate", new Error("network down"));

  await expect(result.current.respond(GATE_A, GATE_APPROVAL_ACTIONS.approve)).resolves.toBe(false);

  await expect.poll(() => result.current.gates[0]?.error?.message).toBe("network down");
  expect(result.current.gates[0]?.responding).toBe(false);
  expect(result.current.gates[0]?.answerable).toBe(true);
  expect(result.current.gates[0]?.alreadyAnswered).toBe(false);
  view.stop();
});

test("a retry after a failure clears the recorded error and succeeds", async () => {
  const { transport, view, result } = await openGate();
  transport.fail("respondGate", new Error("network down"));
  await result.current.respond(GATE_A, GATE_APPROVAL_ACTIONS.approve);
  await expect.poll(() => result.current.gates[0]?.error?.message).toBe("network down");

  await expect(result.current.respond(GATE_A, GATE_APPROVAL_ACTIONS.approve)).resolves.toBe(true);

  await expect.poll(() => result.current.gates).toHaveLength(0);
  expect(transport.countOf("respondGate")).toBe(2);
  view.stop();
});

test("a retry clears the stale error while it is in flight", async () => {
  const { transport, view, result } = await openGate();
  transport.fail("respondGate", new Error("network down"));
  await result.current.respond(GATE_A, GATE_APPROVAL_ACTIONS.approve);
  await expect.poll(() => result.current.gates[0]?.error?.message).toBe("network down");
  const held = transport.defer<Record<string, never>>("respondGate");

  const retry = result.current.respond(GATE_A, GATE_APPROVAL_ACTIONS.approve);
  await expect.poll(() => result.current.gates[0]?.responding).toBe(true);

  // The card must not read "network down" underneath its own spinner.
  expect(result.current.gates[0]?.error).toBeUndefined();
  held.resolve({});
  await expect(retry).resolves.toBe(true);
  view.stop();
});
