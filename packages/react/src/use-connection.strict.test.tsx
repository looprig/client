import { SessionViewStore } from "@looprig/client";
import { expect, test } from "vitest";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { ControlledLiveSource, badTokenDelta } from "./testing/live.js";
import { renderHookStrict } from "./testing/strict.js";
import { useConnection } from "./use-connection.js";

test("a StrictMode double-mount does not double-count warnings", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const store = new SessionViewStore({
    journal: transport,
    sessionId: SID,
    liveSource: live.source,
    join: { autoReconnect: false },
  });
  const { result } = await renderHookStrict(() => useConnection(store));
  store.start();
  await expect.poll(() => result.current.state).toBe("live");

  live.emit(badTokenDelta());

  // Mount, unmount, mount leaves exactly one live subscription: attach() is
  // driven by the effect and its cleanup really unsubscribes, so a leaked
  // first subscription would count this error twice.
  await expect.poll(() => result.current.warningCount).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(result.current.warningCount).toBe(1);
  store.stop();
});

test("unmounting stops tracking the store", async () => {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const store = new SessionViewStore({
    journal: transport,
    sessionId: SID,
    liveSource: live.source,
    join: { autoReconnect: false },
  });
  const { result, unmount } = await renderHookStrict(() => useConnection(store));
  store.start();
  await expect.poll(() => result.current.state).toBe("live");

  await unmount();
  live.emit(badTokenDelta());
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(result.current.warningCount).toBe(0);
  store.stop();
});
