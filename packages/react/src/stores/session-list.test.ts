import { expect, test } from "vitest";
import type { SessionList } from "@looprig/client";
import { FakeTransport, OTHER_SID, SID } from "../testing/fake-transport.js";
import { SessionListStore } from "./session-list.js";

function page(overrides: Partial<SessionList> = {}): SessionList {
  return { sessions: [{ session_id: SID }], skip: 0, limit: 50, next_skip: 1, done: true, ...overrides };
}

test("publishes a fresh snapshot object with the page", async () => {
  const transport = new FakeTransport();
  transport.sessionList = page();
  const store = new SessionListStore(transport);
  const before = store.snapshot();

  await store.refresh({ limit: 50 });

  expect(store.snapshot()).not.toBe(before);
  expect(store.snapshot().sessions).toStrictEqual([{ session_id: SID }]);
  expect(store.snapshot().loading).toBe(false);
  expect(store.snapshot().nextSkip).toBe(1);
  expect(store.snapshot().error).toBeNull();
});

test("loading flips true for the duration of a refresh", async () => {
  const transport = new FakeTransport();
  const pending = transport.defer<SessionList>("listSessions");
  const store = new SessionListStore(transport);

  const inFlight = store.refresh();
  expect(store.snapshot().loading).toBe(true);

  pending.resolve(page());
  await inFlight;
  expect(store.snapshot().loading).toBe(false);
});

test("only the last-started refresh commits when responses resolve out of order", async () => {
  const transport = new FakeTransport();
  const first = transport.defer<SessionList>("listSessions");
  const second = transport.defer<SessionList>("listSessions");
  const store = new SessionListStore(transport);

  const a = store.refresh();
  const b = store.refresh();

  // The SUPERSEDED call resolves last, with different data.
  second.resolve(page({ sessions: [{ session_id: OTHER_SID }] }));
  await b;
  first.resolve(page({ sessions: [{ session_id: SID }] }));
  await a;

  expect(store.snapshot().sessions).toStrictEqual([{ session_id: OTHER_SID }]);
  expect(store.snapshot().loading).toBe(false);
});

test("a superseded refresh resolving FIRST neither commits nor clears loading", async () => {
  const transport = new FakeTransport();
  const first = transport.defer<SessionList>("listSessions");
  const second = transport.defer<SessionList>("listSessions");
  const store = new SessionListStore(transport);

  const a = store.refresh();
  const b = store.refresh();

  first.resolve(page({ sessions: [{ session_id: SID }] }));
  await a;

  // The documented contract: `loading` stays true until the LATEST call
  // settles, rather than flipping false when a superseded one finishes. The
  // out-of-order test above cannot see this — there the superseded call is the
  // last to settle, so a store with no guard at all still ends up `loading:
  // false` with the right rows.
  expect(store.snapshot().loading).toBe(true);
  expect(store.snapshot().sessions).toStrictEqual([]);

  second.resolve(page({ sessions: [{ session_id: OTHER_SID }] }));
  await b;

  expect(store.snapshot().loading).toBe(false);
  expect(store.snapshot().sessions).toStrictEqual([{ session_id: OTHER_SID }]);
});

test("a failed refresh sets error and keeps the previously loaded page", async () => {
  const transport = new FakeTransport();
  transport.sessionList = page();
  const store = new SessionListStore(transport);
  await store.refresh();

  transport.fail("listSessions", new Error("network down"));
  await store.refresh();

  expect(store.snapshot().error?.message).toBe("network down");
  expect(store.snapshot().sessions).toStrictEqual([{ session_id: SID }]);
  expect(store.snapshot().loading).toBe(false);
});

test("a superseded refresh's failure never reaches error", async () => {
  const transport = new FakeTransport();
  const first = transport.defer<SessionList>("listSessions");
  const second = transport.defer<SessionList>("listSessions");
  const store = new SessionListStore(transport);

  const a = store.refresh();
  const b = store.refresh();

  second.resolve(page());
  await b;
  // This is the StrictMode shape: the first mount's request is aborted, and its
  // rejection lands AFTER the second mount's request has already succeeded.
  first.reject(new Error("aborted"));
  await a;

  expect(store.snapshot().error).toBeNull();
});

test("a subsequent refresh clears a previous error", async () => {
  const transport = new FakeTransport();
  const store = new SessionListStore(transport);
  transport.fail("listSessions", new Error("network down"));
  await store.refresh();
  expect(store.snapshot().error).not.toBeNull();

  transport.sessionList = page();
  await store.refresh();

  expect(store.snapshot().error).toBeNull();
});

test("notifies subscribers on each publish", async () => {
  const transport = new FakeTransport();
  transport.sessionList = page();
  const store = new SessionListStore(transport);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  await store.refresh();

  // One for `loading: true`, one for the committed page.
  expect(notifications).toBe(2);
});
