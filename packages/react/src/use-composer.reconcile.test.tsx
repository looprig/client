import { SessionViewStore } from "@looprig/client";
import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { ControlledLiveSource, turnRejected, turnStarted } from "./testing/live.js";
import { useComposer } from "./use-composer.js";

const CMD = "aabbccdd-1122-4334-8556-778899aabbcc";
const OTHER_CMD = "11223344-5566-4778-899a-abbccddeeff0";

interface Submitted {
  live: ControlledLiveSource;
  view: SessionViewStore;
  result: { current: ReturnType<typeof useComposer> };
}

async function submitOne(): Promise<Submitted> {
  const transport = new FakeTransport();
  transport.inputResponse = { command_id: CMD };
  const live = new ControlledLiveSource();
  const view = new SessionViewStore({ journal: transport, sessionId: SID, liveSource: live.source });
  view.start();
  const { result } = await renderHook(() => useComposer(transport, SID, view));
  await result.current.submit("ship it");
  await expect.poll(() => result.current.pending).toHaveLength(1);
  return { live, view, result };
}

test("TurnStarted for the pending command retires the optimistic row", async () => {
  const { live, view, result } = await submitOne();

  live.emit(turnStarted(1, { commandId: CMD, text: "ship it" }));

  await expect.poll(() => result.current.pending).toStrictEqual([]);
  // The fold now owns the authoritative user row, so the transcript did not
  // blink: the optimistic row is retired only once its replacement exists.
  expect(view.snapshot().view.rows.map((row) => row.kind)).toStrictEqual(["user"]);
  view.stop();
});

test("TurnRejected also retires it — a rejected submit must not hang as pending forever", async () => {
  const { live, view, result } = await submitOne();

  live.emit(turnRejected(1, CMD));

  // The composer drops its optimistic row; the user-visible explanation is the
  // fold's own NOTICE row, which is exactly why scanning `rows` for a user row
  // carrying this command id could never observe the resolution.
  await expect.poll(() => result.current.pending).toStrictEqual([]);
  const rejection = view.snapshot().view.rows.find((row) => row.kind === "notice");
  expect(rejection?.kind).toBe("notice");
  expect(view.snapshot().view.commandOutcomes.get(CMD)).toBe("rejected");
  view.stop();
});

test("an unrelated command id leaves the pending row alone", async () => {
  const { live, view, result } = await submitOne();

  live.emit(turnStarted(1, { commandId: OTHER_CMD }));
  await expect.poll(() => view.snapshot().view.commandOutcomes.has(OTHER_CMD)).toBe(true);

  expect(result.current.pending).toHaveLength(1);
  view.stop();
});
