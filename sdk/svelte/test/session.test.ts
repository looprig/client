/**
 * Reactivity-lifecycle tests for session.svelte.ts's stores. Scope
 * deliberately excludes protocol/transport behavior (request shaping,
 * response validation, error decoding) — that's sdk/core's test
 * responsibility (sdk/core/test/transport.test.ts) and is exercised there
 * against a real HTTP round trip. Here, `LooprigTransport` is a hand-rolled
 * fake with no network involved: the only thing under test is whether each
 * store's `$state` fields transition in the right order and shape around a
 * transport call.
 */
import { NetworkError } from "@looprig/client";
import type {
  EventJournalPage,
  ListSessionsOptions,
  LooprigTransport,
  ReadHistoryOptions,
  RequestOptions,
  SessionList,
  SessionStatus,
} from "@looprig/client";
import { describe, expect, it } from "vitest";
import { SessionHistoryStore, SessionListStore, SessionStatusStore } from "../src/session.svelte.js";

/** A promise plus its resolve/reject, so a test can control exactly when a fake transport call settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Minimal `LooprigTransport` fake: each method returns whatever promise the
 * test wired up via the corresponding `*Result` field, defaulting to a
 * promise that never settles (so a test that doesn't care about a given
 * method never accidentally exercises it).
 */
class FakeTransport implements LooprigTransport {
  listSessionsResult: Promise<SessionList> = new Promise(() => {});
  readStatusResult: Promise<SessionStatus> = new Promise(() => {});
  readHistoryResult: Promise<EventJournalPage> = new Promise(() => {});

  listSessions(_options?: ListSessionsOptions): Promise<SessionList> {
    return this.listSessionsResult;
  }
  readStatus(_sessionId: string, _options?: RequestOptions): Promise<SessionStatus> {
    return this.readStatusResult;
  }
  readHistory(_sessionId: string, _options?: ReadHistoryOptions): Promise<EventJournalPage> {
    return this.readHistoryResult;
  }
}

const sessionListPage: SessionList = {
  sessions: [{ session_id: "11111111-1111-1111-1111-111111111111", title: "first" }],
  skip: 0,
  limit: 100,
  next_skip: 1,
  done: true,
};

const sessionStatus: SessionStatus = {
  session_id: "11111111-1111-1111-1111-111111111111",
  last_journal_seq: 5,
  state: "idle",
};

const historyPage: EventJournalPage = {
  events: [{ journal_seq: 0, event: { type: "turn_started", v: 1 } }],
  next_journal_seq: 1,
  done: false,
};

describe("SessionListStore", () => {
  it("flips loading true synchronously, before the transport call settles", () => {
    const transport = new FakeTransport();
    const { promise } = deferred<SessionList>();
    transport.listSessionsResult = promise;
    const store = new SessionListStore(transport);

    expect(store.loading).toBe(false);
    void store.refresh();
    expect(store.loading).toBe(true);
    expect(store.sessions).toEqual([]);
  });

  it("populates sessions and paging fields and clears loading/error on success", async () => {
    const transport = new FakeTransport();
    transport.listSessionsResult = Promise.resolve(sessionListPage);
    const store = new SessionListStore(transport);

    await store.refresh();

    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.sessions).toEqual(sessionListPage.sessions);
    expect(store.skip).toBe(0);
    expect(store.limit).toBe(100);
    expect(store.nextSkip).toBe(1);
    expect(store.done).toBe(true);
  });

  it("sets error and clears loading on failure, without discarding previously loaded sessions", async () => {
    const transport = new FakeTransport();
    transport.listSessionsResult = Promise.resolve(sessionListPage);
    const store = new SessionListStore(transport);
    await store.refresh();

    const failure = new NetworkError("/sessions");
    const { promise, reject } = deferred<SessionList>();
    transport.listSessionsResult = promise;
    const refreshing = store.refresh();
    reject(failure);
    await refreshing;

    expect(store.loading).toBe(false);
    expect(store.error).toBe(failure);
    // The previous page's sessions are still there — a failed refresh
    // reports the error but doesn't blank out what was already on screen.
    expect(store.sessions).toEqual(sessionListPage.sessions);
  });

  it("clears a previous error at the start of the next refresh", () => {
    const transport = new FakeTransport();
    transport.listSessionsResult = Promise.reject(new NetworkError("/sessions"));
    const store = new SessionListStore(transport);

    return store.refresh().then(() => {
      expect(store.error).not.toBeNull();
      const { promise } = deferred<SessionList>();
      transport.listSessionsResult = promise;
      void store.refresh();
      expect(store.error).toBeNull();
    });
  });
});

describe("SessionStatusStore", () => {
  const sessionId = "11111111-1111-1111-1111-111111111111";

  it("flips loading true synchronously, before the transport call settles", () => {
    const transport = new FakeTransport();
    transport.readStatusResult = deferred<SessionStatus>().promise;
    const store = new SessionStatusStore(transport, sessionId);

    expect(store.loading).toBe(false);
    void store.refresh();
    expect(store.loading).toBe(true);
    expect(store.status).toBeNull();
  });

  it("populates status and clears loading/error on success", async () => {
    const transport = new FakeTransport();
    transport.readStatusResult = Promise.resolve(sessionStatus);
    const store = new SessionStatusStore(transport, sessionId);

    await store.refresh();

    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.status).toEqual(sessionStatus);
  });

  it("sets error and clears loading on failure, without discarding the previous status", async () => {
    const transport = new FakeTransport();
    transport.readStatusResult = Promise.resolve(sessionStatus);
    const store = new SessionStatusStore(transport, sessionId);
    await store.refresh();

    const failure = new NetworkError(`/sessions/${sessionId}/status`);
    transport.readStatusResult = Promise.reject(failure);
    await store.refresh();

    expect(store.loading).toBe(false);
    expect(store.error).toBe(failure);
    expect(store.status).toEqual(sessionStatus);
  });
});

describe("SessionHistoryStore", () => {
  const sessionId = "11111111-1111-1111-1111-111111111111";

  it("flips loading true synchronously, before the transport call settles", () => {
    const transport = new FakeTransport();
    transport.readHistoryResult = deferred<EventJournalPage>().promise;
    const store = new SessionHistoryStore(transport, sessionId);

    expect(store.loading).toBe(false);
    void store.refresh();
    expect(store.loading).toBe(true);
    expect(store.events).toEqual([]);
  });

  it("populates events and the paging cursor and clears loading/error on success", async () => {
    const transport = new FakeTransport();
    transport.readHistoryResult = Promise.resolve(historyPage);
    const store = new SessionHistoryStore(transport, sessionId);

    await store.refresh();

    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.events).toEqual(historyPage.events);
    expect(store.nextJournalSeq).toBe(1);
    expect(store.done).toBe(false);
  });

  it("sets error and clears loading on failure, without discarding the previous page", async () => {
    const transport = new FakeTransport();
    transport.readHistoryResult = Promise.resolve(historyPage);
    const store = new SessionHistoryStore(transport, sessionId);
    await store.refresh();

    const failure = new NetworkError(`/sessions/${sessionId}/journal`);
    transport.readHistoryResult = Promise.reject(failure);
    await store.refresh();

    expect(store.loading).toBe(false);
    expect(store.error).toBe(failure);
    expect(store.events).toEqual(historyPage.events);
  });

  it("replaces the page on the next refresh rather than accumulating across calls", async () => {
    const transport = new FakeTransport();
    transport.readHistoryResult = Promise.resolve(historyPage);
    const store = new SessionHistoryStore(transport, sessionId);
    await store.refresh();
    expect(store.events).toHaveLength(1);

    const secondPage: EventJournalPage = {
      events: [
        { journal_seq: 1, event: { type: "step_completed", v: 1 } },
        { journal_seq: 2, event: { type: "step_completed", v: 1 } },
      ],
      next_journal_seq: 3,
      done: true,
    };
    transport.readHistoryResult = Promise.resolve(secondPage);
    await store.refresh({ fromJournalSeq: 1 });

    // Not `toHaveLength(3)` — refresh() replaces, it doesn't join pages
    // together. Accumulating/ordering pages into one feed is the "history
    // join" this package is explicitly not allowed to own.
    expect(store.events).toEqual(secondPage.events);
    expect(store.nextJournalSeq).toBe(3);
    expect(store.done).toBe(true);
  });
});
