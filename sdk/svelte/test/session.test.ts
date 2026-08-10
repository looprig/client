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
  CreateRequest,
  CreateResponse,
  CreateSessionOptions,
  EventJournalPage,
  GateAcceptedResponse,
  GateResponseRequest,
  InputResponse,
  InterruptResponse,
  ListSessionsOptions,
  LooprigTransport,
  ReadHistoryOptions,
  RequestOptions,
  RestoreResponse,
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
  createSession(_request?: CreateRequest, _options?: CreateSessionOptions): Promise<CreateResponse> {
    throw new Error("not used by these tests");
  }
  restoreSession(_sessionId: string, _options?: RequestOptions): Promise<RestoreResponse> {
    throw new Error("not used by these tests");
  }
  submit(_sessionId: string, _request: CreateRequest, _options?: RequestOptions): Promise<InputResponse> {
    throw new Error("not used by these tests");
  }
  respondGate(
    _sessionId: string,
    _gateId: string,
    _request: GateResponseRequest,
    _options?: RequestOptions,
  ): Promise<GateAcceptedResponse> {
    throw new Error("not used by these tests");
  }
  interrupt(_sessionId: string, _options?: RequestOptions): Promise<InterruptResponse> {
    throw new Error("not used by these tests");
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

  it("keeps the later-started refresh()'s result when responses resolve out of order", async () => {
    const transport = new FakeTransport();
    const store = new SessionListStore(transport);

    const firstPage: SessionList = { ...sessionListPage, skip: 0 };
    const secondPage: SessionList = {
      ...sessionListPage,
      skip: 10,
      sessions: [{ session_id: "22222222-2222-2222-2222-222222222222", title: "second" }],
    };

    // Start the first call...
    const first = deferred<SessionList>();
    transport.listSessionsResult = first.promise;
    const firstRefresh = store.refresh({ skip: 0 });

    // ...then start a second, overlapping call before the first settles.
    const second = deferred<SessionList>();
    transport.listSessionsResult = second.promise;
    const secondRefresh = store.refresh({ skip: 10 });

    expect(store.loading).toBe(true);

    // The SECOND (later-started) call's response arrives FIRST.
    second.resolve(secondPage);
    await secondRefresh;

    expect(store.loading).toBe(false);
    expect(store.sessions).toEqual(secondPage.sessions);
    expect(store.skip).toBe(10);

    // The FIRST call's response arrives AFTER — it is now stale and must be
    // discarded rather than overwriting the fresher result already committed.
    first.resolve(firstPage);
    await firstRefresh;

    expect(store.sessions).toEqual(secondPage.sessions);
    expect(store.skip).toBe(10);
    expect(store.loading).toBe(false);
  });

  it("keeps loading true when a stale (superseded) call settles before the latest call is still in flight", async () => {
    const transport = new FakeTransport();
    const store = new SessionListStore(transport);

    const first = deferred<SessionList>();
    transport.listSessionsResult = first.promise;
    const firstRefresh = store.refresh();

    const second = deferred<SessionList>();
    transport.listSessionsResult = second.promise;
    const secondRefresh = store.refresh();

    // The stale (first) call settles while the latest (second) call is still
    // outstanding.
    first.resolve(sessionListPage);
    await firstRefresh;

    // Its result must not be committed, and loading must remain true — the
    // truly latest call hasn't settled yet.
    expect(store.sessions).toEqual([]);
    expect(store.loading).toBe(true);

    second.resolve(sessionListPage);
    await secondRefresh;

    expect(store.loading).toBe(false);
    expect(store.sessions).toEqual(sessionListPage.sessions);
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

  it("keeps the later-started refresh()'s result when responses resolve out of order", async () => {
    const transport = new FakeTransport();
    const store = new SessionStatusStore(transport, sessionId);

    const firstStatus: SessionStatus = { ...sessionStatus, last_journal_seq: 5, state: "idle" };
    const secondStatus: SessionStatus = { ...sessionStatus, last_journal_seq: 9, state: "running" };

    const first = deferred<SessionStatus>();
    transport.readStatusResult = first.promise;
    const firstRefresh = store.refresh();

    const second = deferred<SessionStatus>();
    transport.readStatusResult = second.promise;
    const secondRefresh = store.refresh();

    expect(store.loading).toBe(true);

    // The SECOND (later-started) call's response arrives FIRST.
    second.resolve(secondStatus);
    await secondRefresh;

    expect(store.loading).toBe(false);
    expect(store.status).toEqual(secondStatus);

    // The FIRST call's response arrives AFTER — stale, must be discarded.
    first.resolve(firstStatus);
    await firstRefresh;

    expect(store.status).toEqual(secondStatus);
    expect(store.loading).toBe(false);
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

  it("keeps the later-started refresh()'s result when responses resolve out of order", async () => {
    const transport = new FakeTransport();
    const store = new SessionHistoryStore(transport, sessionId);

    const secondPage: EventJournalPage = {
      events: [{ journal_seq: 5, event: { type: "step_completed", v: 1 } }],
      next_journal_seq: 6,
      done: true,
    };

    const first = deferred<EventJournalPage>();
    transport.readHistoryResult = first.promise;
    const firstRefresh = store.refresh();

    const second = deferred<EventJournalPage>();
    transport.readHistoryResult = second.promise;
    const secondRefresh = store.refresh({ fromJournalSeq: 5 });

    expect(store.loading).toBe(true);

    // The SECOND (later-started) call's response arrives FIRST.
    second.resolve(secondPage);
    await secondRefresh;

    expect(store.loading).toBe(false);
    expect(store.events).toEqual(secondPage.events);
    expect(store.nextJournalSeq).toBe(6);

    // The FIRST call's response arrives AFTER — stale, must be discarded.
    first.resolve(historyPage);
    await firstRefresh;

    expect(store.events).toEqual(secondPage.events);
    expect(store.nextJournalSeq).toBe(6);
    expect(store.loading).toBe(false);
  });
});
