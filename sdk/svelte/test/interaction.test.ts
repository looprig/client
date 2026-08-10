/**
 * Reactivity-lifecycle tests for interaction.svelte.ts's stores
 * (`SessionComposerStore`, `GateStore`). Scope deliberately excludes
 * protocol/transport behavior (request shaping, response validation, error
 * decoding) — that's sdk/core's test responsibility (transport.test.ts) —
 * except for the ONE thing this test suite specifically must prove: that
 * each store hands the transport the EXACT request shape/values this task's
 * design depends on (the `textBlock` wire shape for `submit`, and the three
 * exact `GATE_APPROVAL_ACTIONS` strings plus an untouched, opaque gate id for
 * `respondGate`). Everything else here is store `$state` transition
 * behavior against a hand-rolled fake `LooprigTransport`, no network
 * involved — same approach as session.test.ts/live-session.test.ts.
 */
import { GATE_APPROVAL_ACTIONS, NetworkError } from "@looprig/client";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateStore, SessionComposerStore } from "../src/interaction.svelte.js";

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
 * Minimal `LooprigTransport` fake covering every method (the full Task 28
 * control-plane surface), recording every `submit`/`respondGate` call's
 * exact arguments so a test can assert on the real request shape, not just
 * that "some call happened."
 */
class FakeTransport implements LooprigTransport {
  readStatusResult: Promise<SessionStatus> = new Promise(() => {});
  submitResult: Promise<InputResponse> = new Promise(() => {});
  respondGateResult: Promise<GateAcceptedResponse> = new Promise(() => {});

  readStatusCalls: string[] = [];
  submitCalls: Array<{ sessionId: string; request: CreateRequest }> = [];
  respondGateCalls: Array<{ sessionId: string; gateId: string; request: GateResponseRequest }> = [];

  listSessions(_options?: ListSessionsOptions): Promise<SessionList> {
    throw new Error("not used by these tests");
  }
  readStatus(sessionId: string, _options?: RequestOptions): Promise<SessionStatus> {
    this.readStatusCalls.push(sessionId);
    return this.readStatusResult;
  }
  readHistory(_sessionId: string, _options?: ReadHistoryOptions): Promise<EventJournalPage> {
    throw new Error("not used by these tests");
  }
  createSession(_request?: CreateRequest, _options?: CreateSessionOptions): Promise<CreateResponse> {
    throw new Error("not used by these tests");
  }
  restoreSession(_sessionId: string, _options?: RequestOptions): Promise<RestoreResponse> {
    throw new Error("not used by these tests");
  }
  submit(sessionId: string, request: CreateRequest, _options?: RequestOptions): Promise<InputResponse> {
    this.submitCalls.push({ sessionId, request });
    return this.submitResult;
  }
  respondGate(
    sessionId: string,
    gateId: string,
    request: GateResponseRequest,
    _options?: RequestOptions,
  ): Promise<GateAcceptedResponse> {
    this.respondGateCalls.push({ sessionId, gateId, request });
    return this.respondGateResult;
  }
  interrupt(_sessionId: string, _options?: RequestOptions): Promise<InterruptResponse> {
    throw new Error("not used by these tests");
  }
}

const sessionId = "11111111-1111-1111-1111-111111111111";

describe("SessionComposerStore", () => {
  it("is a no-op on empty or whitespace-only text: does not call submit, submitting stays false", async () => {
    const transport = new FakeTransport();
    const store = new SessionComposerStore(transport, sessionId);

    expect(await store.submit("")).toBe(false);
    expect(await store.submit("   \n\t")).toBe(false);

    expect(transport.submitCalls).toHaveLength(0);
    expect(store.submitting).toBe(false);
  });

  it("flips submitting true synchronously, before the transport call settles", () => {
    const transport = new FakeTransport();
    transport.submitResult = deferred<InputResponse>().promise;
    const store = new SessionComposerStore(transport, sessionId);

    expect(store.submitting).toBe(false);
    void store.submit("hello");
    expect(store.submitting).toBe(true);
  });

  it("calls transport.submit with the trimmed text as a single wire-shape text block", async () => {
    const transport = new FakeTransport();
    transport.submitResult = Promise.resolve({ command_id: "22222222-2222-2222-2222-222222222222" });
    const store = new SessionComposerStore(transport, sessionId);

    const ok = await store.submit("  hello world  ");

    expect(ok).toBe(true);
    expect(transport.submitCalls).toHaveLength(1);
    expect(transport.submitCalls[0]).toEqual({
      sessionId,
      request: { blocks: [{ type: "text", Text: "hello world" }] },
    });
  });

  it("clears error and flips submitting false on success", async () => {
    const transport = new FakeTransport();
    transport.submitResult = Promise.resolve({ command_id: "22222222-2222-2222-2222-222222222222" });
    const store = new SessionComposerStore(transport, sessionId);

    await store.submit("hi");

    expect(store.submitting).toBe(false);
    expect(store.error).toBeNull();
  });

  it("sets the real typed error and flips submitting false on failure, and returns false", async () => {
    const transport = new FakeTransport();
    const failure = new NetworkError(`/sessions/${sessionId}/input`);
    transport.submitResult = Promise.reject(failure);
    const store = new SessionComposerStore(transport, sessionId);

    const ok = await store.submit("hi");

    expect(ok).toBe(false);
    expect(store.submitting).toBe(false);
    expect(store.error).toBe(failure);
  });

  it("a second submit() call while one is already in flight is a no-op", async () => {
    const transport = new FakeTransport();
    const first = deferred<InputResponse>();
    transport.submitResult = first.promise;
    const store = new SessionComposerStore(transport, sessionId);

    const firstCall = store.submit("first");
    expect(store.submitting).toBe(true);

    const secondResult = await store.submit("second");
    expect(secondResult).toBe(false);
    expect(transport.submitCalls).toHaveLength(1);

    first.resolve({ command_id: "22222222-2222-2222-2222-222222222222" });
    await firstCall;
  });
});

describe("GateStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const idleStatus: SessionStatus = { session_id: sessionId, last_journal_seq: 3, state: "idle" };
  const waitingStatus: SessionStatus = {
    session_id: sessionId,
    last_journal_seq: 4,
    state: "waiting_on_gate",
    waiting_gate_id: "33333333-3333-3333-3333-333333333333",
  };

  it("waitingGateId is null before any poll has resolved", () => {
    const transport = new FakeTransport();
    const store = new GateStore(transport, sessionId, 1000);
    expect(store.waitingGateId).toBeNull();
  });

  it("start() polls readStatus immediately and flips polling true", async () => {
    const transport = new FakeTransport();
    transport.readStatusResult = Promise.resolve(idleStatus);
    const store = new GateStore(transport, sessionId, 1000);

    store.start();
    expect(store.polling).toBe(true);
    await vi.waitFor(() => expect(transport.readStatusCalls).toHaveLength(1));

    store.stop();
  });

  it("surfaces waiting_gate_id once a poll observes it, and clears back to null once it's gone", async () => {
    const transport = new FakeTransport();
    transport.readStatusResult = Promise.resolve(waitingStatus);
    const store = new GateStore(transport, sessionId, 1000);

    store.start();
    await vi.waitFor(() => expect(store.waitingGateId).toBe(waitingStatus.waiting_gate_id));

    transport.readStatusResult = Promise.resolve(idleStatus);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.waitingGateId).toBeNull();

    store.stop();
  });

  it("stop() halts further polling", async () => {
    const transport = new FakeTransport();
    transport.readStatusResult = Promise.resolve(idleStatus);
    const store = new GateStore(transport, sessionId, 1000);

    store.start();
    await vi.waitFor(() => expect(transport.readStatusCalls).toHaveLength(1));
    store.stop();
    expect(store.polling).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    // No further polls after stop(), despite five intervals' worth of time passing.
    expect(transport.readStatusCalls).toHaveLength(1);
  });

  it("sets pollError and leaves the previous status untouched on a failed poll", async () => {
    const transport = new FakeTransport();
    transport.readStatusResult = Promise.resolve(waitingStatus);
    const store = new GateStore(transport, sessionId, 1000);
    store.start();
    await vi.waitFor(() => expect(store.waitingGateId).toBe(waitingStatus.waiting_gate_id));

    const failure = new NetworkError(`/sessions/${sessionId}/status`);
    const rejected = Promise.reject(failure);
    // Attach a no-op handler immediately: this promise sits in the field
    // for a tick before the fake-timer-driven poll loop actually awaits it
    // (via `readStatus()`'s return), and Node reports an "unhandled
    // rejection" for a rejected promise with no attached handler at the end
    // of a microtask flush — even one that IS handled later. This doesn't
    // change what the store itself observes: a promise may have more than
    // one handler attached, and `pollOnce()`'s own `await` still sees (and
    // reacts to) the same rejection independently.
    rejected.catch(() => {});
    transport.readStatusResult = rejected;
    await vi.advanceTimersByTimeAsync(1000);

    expect(store.pollError).toBe(failure);
    // The gate is still open as far as this store can tell — a transient
    // poll failure must not silently hide an open gate.
    expect(store.waitingGateId).toBe(waitingStatus.waiting_gate_id);

    store.stop();
  });

  it("respond() is a no-op when no gate is open: does not call respondGate, returns false", async () => {
    const transport = new FakeTransport();
    transport.readStatusResult = Promise.resolve(idleStatus);
    const store = new GateStore(transport, sessionId, 1000);
    store.start();
    await vi.waitFor(() => expect(transport.readStatusCalls).toHaveLength(1));

    const ok = await store.respond(GATE_APPROVAL_ACTIONS.approve);

    expect(ok).toBe(false);
    expect(transport.respondGateCalls).toHaveLength(0);
    store.stop();
  });

  it.each([
    ["approve", GATE_APPROVAL_ACTIONS.approve],
    ["approve always for this workspace", GATE_APPROVAL_ACTIONS.approveAlwaysWorkspace],
    ["deny", GATE_APPROVAL_ACTIONS.deny],
  ] as const)(
    "respond(%s) calls respondGate with the exact opaque gate id and action, and re-polls on success",
    async (_label, action) => {
      const transport = new FakeTransport();
      transport.readStatusResult = Promise.resolve(waitingStatus);
      const store = new GateStore(transport, sessionId, 1000);
      store.start();
      await vi.waitFor(() => expect(store.waitingGateId).toBe(waitingStatus.waiting_gate_id));

      transport.respondGateResult = Promise.resolve({});
      transport.readStatusResult = Promise.resolve(idleStatus);

      const ok = await store.respond(action);

      expect(ok).toBe(true);
      expect(transport.respondGateCalls).toHaveLength(1);
      expect(transport.respondGateCalls[0]).toEqual({
        sessionId,
        gateId: waitingStatus.waiting_gate_id,
        request: { action },
      });
      // respond() triggers an immediate re-poll on success — the gate should
      // clear without waiting for the next scheduled tick.
      expect(store.waitingGateId).toBeNull();
      expect(store.responding).toBe(false);

      store.stop();
    },
  );

  it("flips responding true synchronously, before respondGate settles", async () => {
    const transport = new FakeTransport();
    transport.readStatusResult = Promise.resolve(waitingStatus);
    const store = new GateStore(transport, sessionId, 1000);
    store.start();
    await vi.waitFor(() => expect(store.waitingGateId).toBe(waitingStatus.waiting_gate_id));

    const gateResponse = deferred<GateAcceptedResponse>();
    transport.respondGateResult = gateResponse.promise;

    const respondCall = store.respond(GATE_APPROVAL_ACTIONS.deny);
    expect(store.responding).toBe(true);

    gateResponse.resolve({});
    await respondCall;
    store.stop();
  });

  it("sets respondError and flips responding false on a failed respond(), and returns false", async () => {
    const transport = new FakeTransport();
    transport.readStatusResult = Promise.resolve(waitingStatus);
    const store = new GateStore(transport, sessionId, 1000);
    store.start();
    await vi.waitFor(() => expect(store.waitingGateId).toBe(waitingStatus.waiting_gate_id));

    const failure = new NetworkError(`/sessions/${sessionId}/gates/${waitingStatus.waiting_gate_id}`);
    transport.respondGateResult = Promise.reject(failure);

    const ok = await store.respond(GATE_APPROVAL_ACTIONS.approve);

    expect(ok).toBe(false);
    expect(store.responding).toBe(false);
    expect(store.respondError).toBe(failure);
    // The gate is still open — a failed response must not clear it.
    expect(store.waitingGateId).toBe(waitingStatus.waiting_gate_id);

    store.stop();
  });
});
