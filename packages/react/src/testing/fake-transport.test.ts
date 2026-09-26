import { expect, test } from "vitest";
import { FakeTransport, SID } from "./fake-transport.js";

/** Yields the macrotask queue, which drains every pending microtask chain with it. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("records calls and returns the configured page", async () => {
  const transport = new FakeTransport();
  transport.sessionList = {
    sessions: [{ session_id: SID, title: "goal" }],
    skip: 0,
    limit: 50,
    next_skip: 1,
    done: true,
  };

  const page = await transport.listSessions({ limit: 50 });

  expect(page.sessions).toHaveLength(1);
  expect(transport.calls).toStrictEqual([{ method: "listSessions", args: [{ limit: 50 }] }]);
  expect(transport.countOf("listSessions")).toBe(1);
  expect(transport.countOf("submit")).toBe(0);
});

test("defer() holds a call open until it is resolved", async () => {
  const transport = new FakeTransport();
  const pending = transport.defer("restoreSession");
  let settled = false;

  const inFlight = transport.restoreSession(SID).then((r) => {
    settled = true;
    return r;
  });

  // Deliberately AFTER a full macrotask turn, not synchronously: an undeferred
  // FakeTransport also leaves `settled` false on the line right after the call,
  // because the `.then` callback cannot have run yet either way. Only settling
  // the queue first makes this assertion able to fail.
  await tick();
  expect(settled).toBe(false);

  pending.resolve({ session_id: SID, restored: true });
  await expect(inFlight).resolves.toStrictEqual({ session_id: SID, restored: true });
});

test("fail() makes the next call of a method reject", async () => {
  const transport = new FakeTransport();
  transport.fail("submit", new Error("boom"));

  await expect(transport.submit(SID, { blocks: [] })).rejects.toThrow("boom");
  // One-shot: the failure is consumed, the next call succeeds.
  await expect(transport.submit(SID, { blocks: [] })).resolves.toHaveProperty("command_id");
});

test("readHistory walks the configured pages and then repeats the last one", async () => {
  const transport = new FakeTransport();
  transport.journalPages = [
    { events: [{ journal_seq: 0 }], next_journal_seq: 1, done: false },
    { events: [{ journal_seq: 1 }], next_journal_seq: 2, done: true },
  ];

  const first = await transport.readHistory(SID);
  const second = await transport.readHistory(SID);
  const third = await transport.readHistory(SID);

  expect(first.next_journal_seq).toBe(1);
  expect(second.next_journal_seq).toBe(2);
  expect(third).toStrictEqual(second);
});
