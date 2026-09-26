import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import type { ListSessionsOptions } from "@looprig/client";
import { FakeTransport, OTHER_SID, SID } from "./testing/fake-transport.js";
import { renderHookStrict } from "./testing/strict.js";
import { useSessionList } from "./use-session-list.js";

function optionsOf(transport: FakeTransport, index: number): ListSessionsOptions | undefined {
  return transport.calls[index]?.args[0] as ListSessionsOptions | undefined;
}

test("refreshes on mount and exposes the page", async () => {
  const transport = new FakeTransport();
  transport.sessionList = { sessions: [{ session_id: SID }], skip: 0, limit: 50, next_skip: 1, done: true };

  const { result } = await renderHook(() => useSessionList(transport, { limit: 50 }));

  await expect.poll(() => result.current.sessions).toStrictEqual([{ session_id: SID }]);
  expect(result.current.loading).toBe(false);
  expect(result.current.nextSkip).toBe(1);
  expect(transport.countOf("listSessions")).toBe(1);
  expect(optionsOf(transport, 0)?.limit).toBe(50);
});

test("a fresh-but-equal inline query object does not refetch", async () => {
  const transport = new FakeTransport();
  // The footgun this guards: `useSessionList(t, { limit: 50 })` builds a NEW
  // object every render, so an effect keyed on object identity would refetch
  // forever. The hook keys on the query's VALUE instead.
  const { rerender, result } = await renderHook(() => useSessionList(transport, { limit: 50 }));
  await expect.poll(() => result.current.loading).toBe(false);

  await rerender();
  await rerender();

  expect(transport.countOf("listSessions")).toBe(1);
});

test("a changed query refetches with the new values", async () => {
  const transport = new FakeTransport();
  let limit = 50;
  const { rerender, result } = await renderHook(() => useSessionList(transport, { limit }));
  await expect.poll(() => result.current.loading).toBe(false);

  limit = 10;
  await rerender();

  await expect.poll(() => transport.countOf("listSessions")).toBe(2);
  expect(optionsOf(transport, 1)?.limit).toBe(10);
});

test("refresh() re-fetches on demand and can override the query", async () => {
  const transport = new FakeTransport();
  transport.sessionList = { sessions: [{ session_id: SID }], skip: 0, limit: 50, next_skip: 1, done: true };
  const { result } = await renderHook(() => useSessionList(transport, { limit: 50 }));
  await expect.poll(() => result.current.loading).toBe(false);

  transport.sessionList = { sessions: [{ session_id: OTHER_SID }], skip: 1, limit: 50, next_skip: 2, done: true };
  await result.current.refresh({ skip: 1, limit: 50 });

  await expect.poll(() => result.current.sessions).toStrictEqual([{ session_id: OTHER_SID }]);
  expect(optionsOf(transport, 1)?.skip).toBe(1);
});

test("unmounting aborts the in-flight request", async () => {
  const transport = new FakeTransport();
  transport.defer("listSessions");
  const { unmount } = await renderHook(() => useSessionList(transport));
  await expect.poll(() => transport.countOf("listSessions")).toBe(1);

  await unmount();

  expect(optionsOf(transport, 0)?.signal?.aborted).toBe(true);
});

test("a StrictMode remount's aborted first request never lands in error", async () => {
  const transport = new FakeTransport();
  const first = transport.defer<never>("listSessions");
  transport.sessionList = { sessions: [{ session_id: SID }], skip: 0, limit: 100, next_skip: 0, done: true };

  const { result } = await renderHookStrict(() => useSessionList(transport));

  // mount -> unmount -> mount: two requests, the first of them aborted.
  await expect.poll(() => transport.countOf("listSessions")).toBe(2);
  expect(optionsOf(transport, 0)?.signal?.aborted).toBe(true);
  await expect.poll(() => result.current.sessions).toStrictEqual([{ session_id: SID }]);

  first.reject(new Error("request aborted: /v1/sessions"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Both mechanisms are needed and this is the one that needs a remount to be
  // observable at all: the abort frees the socket, and the RefreshGuard keeps
  // the superseded rejection out of `error`. Asserted on settled state after
  // the rejection has had a full macrotask to land, never inside a callback.
  expect(result.current.error).toBeNull();
  expect(result.current.sessions).toStrictEqual([{ session_id: SID }]);
});
