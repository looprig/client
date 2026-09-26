import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import { CoreProtocolError } from "@looprig/client";
import type { FactoryPageOptions, RecentSessionPage } from "@looprig/client";
import { useFactorySessionList } from "./use-factory-session-list.js";

type Call = { options: FactoryPageOptions | undefined };

function reader(...pages: Array<RecentSessionPage | Promise<RecentSessionPage>>): {
  calls: Call[];
  listRecentSessions(options?: FactoryPageOptions): Promise<RecentSessionPage>;
} {
  const calls: Call[] = [];
  return {
    calls,
    listRecentSessions(options) {
      calls.push({ options });
      const page = pages.shift();
      if (page === undefined) return new Promise(() => {});
      return Promise.resolve(page);
    },
  };
}

function rejectedPage(cause: Error): Promise<RecentSessionPage> {
  const page = Promise.reject<RecentSessionPage>(cause);
  // The promise is queued before the hook issues its second read. Mark it as
  // observed now; the store still awaits and receives the same rejection.
  void page.catch(() => undefined);
  return page;
}

const first: RecentSessionPage = {
  sessions: [{
    session_id: "session-1", agent_id: "agent-1", state: "idle",
    last_active_at: "2026-09-05T12:00:00Z",
  }],
  next_cursor: "next-1",
};

test("loads one bounded recent session page on mount", async () => {
  const reads = reader(first);
  const { result } = await renderHook(() => useFactorySessionList(reads));

  await expect.poll(() => result.current.sessions).toStrictEqual(first.sessions);
  expect(reads.calls).toHaveLength(1);
  expect(reads.calls[0]?.options?.limit).toBe(100);
  expect(reads.calls[0]?.options?.cursor).toBeUndefined();
  expect(result.current.nextCursor).toBe("next-1");
});

test("moves through opaque next and previous cursors only on explicit actions", async () => {
  const second: RecentSessionPage = {
    sessions: [{
      session_id: "session-2", agent_id: "agent-1", state: "failed",
      last_active_at: "2026-09-04T12:00:00Z",
    }],
    previous_cursor: "previous-2",
  };
  const reads = reader(first, second, first);
  const { result } = await renderHook(() => useFactorySessionList(reads));
  await expect.poll(() => result.current.nextCursor).toBe("next-1");

  await result.current.loadNext();
  expect(reads.calls[1]?.options).toMatchObject({ cursor: "next-1", limit: 100 });
  expect(result.current.sessions).toStrictEqual(second.sessions);

  await result.current.loadPrevious();
  expect(reads.calls[2]?.options).toMatchObject({ cursor: "previous-2", limit: 100 });
  expect(result.current.sessions).toStrictEqual(first.sessions);
});

test("aborts the mounted page read when the list leaves the identity scope", async () => {
  const reads = reader();
  const { unmount } = await renderHook(() => useFactorySessionList(reads));
  await expect.poll(() => reads.calls).toHaveLength(1);

  await unmount();
  expect(reads.calls[0]?.options?.signal?.aborted).toBe(true);
});

test.each([
  ["refresh", (result: ReturnType<typeof useFactorySessionList>) => result.refresh()],
  ["next", (result: ReturnType<typeof useFactorySessionList>) => result.loadNext()],
  ["previous", (result: ReturnType<typeof useFactorySessionList>) => result.loadPrevious()],
] as const)("aborts a pending explicit %s read when the list leaves the identity scope", async (_name, act) => {
  const cursored = { ...first, previous_cursor: "previous-1" };
  const reads = reader(cursored);
  const { result, unmount } = await renderHook(() => useFactorySessionList(reads));
  await expect.poll(() => result.current.loaded).toBe(true);

  void act(result.current);
  await expect.poll(() => reads.calls).toHaveLength(2);
  expect(reads.calls[1]?.options?.signal).toBeInstanceOf(AbortSignal);

  await unmount();
  expect(reads.calls[1]?.options?.signal?.aborted).toBe(true);
});

test.each(["unauthenticated", "not_authorized"])(
  "a current authoritative %s denial clears the scoped page",
  async (code) => {
    const denial = new CoreProtocolError({ error: { code, retryable: false } });
    const reads = reader(first, rejectedPage(denial));
    const { result } = await renderHook(() => useFactorySessionList(reads));
    await expect.poll(() => result.current.loaded).toBe(true);

    await result.current.refresh();

    expect(result.current.sessions).toEqual([]);
    expect(result.current.nextCursor).toBeUndefined();
    expect(result.current.previousCursor).toBeUndefined();
    expect(result.current.loaded).toBe(false);
    expect(result.current.error).toBe(denial);
  },
);

test("a transient list failure retains the last authorized page", async () => {
  const outage = new CoreProtocolError({ error: { code: "unavailable", retryable: true } });
  const reads = reader(first, rejectedPage(outage));
  const { result } = await renderHook(() => useFactorySessionList(reads));
  await expect.poll(() => result.current.loaded).toBe(true);

  await result.current.refresh();

  expect(result.current.sessions).toStrictEqual(first.sessions);
  expect(result.current.nextCursor).toBe("next-1");
  expect(result.current.loaded).toBe(true);
  expect(result.current.error).toBe(outage);
});

test("a superseded denial cannot clear a newer successful page", async () => {
  let rejectDenied!: (cause: Error) => void;
  const denied = new Promise<RecentSessionPage>((_resolve, reject) => { rejectDenied = reject; });
  const newest: RecentSessionPage = {
    sessions: [{
      session_id: "session-2", agent_id: "agent-2", state: "idle",
      last_active_at: "2026-09-05T13:00:00Z",
    }],
  };
  const reads = reader(first, denied, newest);
  const { result } = await renderHook(() => useFactorySessionList(reads));
  await expect.poll(() => result.current.loaded).toBe(true);

  void result.current.refresh();
  await expect.poll(() => reads.calls).toHaveLength(2);
  await result.current.refresh();
  expect(reads.calls[1]?.options?.signal?.aborted).toBe(true);
  rejectDenied(new CoreProtocolError({ error: { code: "not_authorized", retryable: false } }));

  await expect.poll(() => result.current.sessions).toStrictEqual(newest.sessions);
  expect(result.current.error).toBeNull();
});
