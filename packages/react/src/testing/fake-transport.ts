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

/** A fixed, valid v4 UUID; harness parses `{sid}` strictly, and so do the schemas. */
export const SID = "6f1d9f4e-6c2a-4c3a-9f2e-1a2b3c4d5e6f";
export const OTHER_SID = "7a2e0a5f-7d3b-4d4b-a03f-2b3c4d5e6f70";

export type TransportMethod =
  | "listSessions"
  | "readStatus"
  | "readHistory"
  | "createSession"
  | "restoreSession"
  | "submit"
  | "respondGate"
  | "interrupt";

export interface RecordedCall {
  method: TransportMethod;
  args: unknown[];
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A hand-written `LooprigTransport` double. It resolves immediately from its
 * public response fields unless a call has been armed with `defer()` (hold it
 * open, resolve it by hand — the only way to observe a loading state or an
 * out-of-order resolution deterministically) or `fail()` (reject once).
 *
 * Deliberately not a `vi.fn()` mesh: every later task asserts on ORDER and
 * COUNT across several methods at once, and one `calls` array reads far better
 * than eight separate mock inspections.
 *
 * Every default below is a body the vendored schemas would actually accept —
 * `restoreResponse` carries `restored` (required since harness v0.30.0 made
 * restore attach-or-restore), and `sessionList.limit` is inside the schema's
 * [1, 1000] range. The fake does not validate, so a body that could never come
 * off the wire would silently become the shape every hook in this package is
 * developed against.
 */
export class FakeTransport implements LooprigTransport {
  readonly calls: RecordedCall[] = [];

  sessionList: SessionList = { sessions: [], skip: 0, limit: 100, next_skip: 0, done: true };
  status: SessionStatus = { session_id: SID, last_journal_seq: 0 };
  /** Consumed one page per `readHistory` call; the last page is reused once exhausted. */
  journalPages: EventJournalPage[] = [{ events: [], next_journal_seq: 0, done: true }];
  createResponse: CreateResponse = { session_id: SID };
  restoreResponse: RestoreResponse = { session_id: SID, restored: false };
  inputResponse: InputResponse = { command_id: "0f0e0d0c-0b0a-4908-8706-050403020100" };
  gateResponse: GateAcceptedResponse = {};
  interruptResponse: InterruptResponse = { interrupted: true };

  readonly #deferrals = new Map<TransportMethod, Deferred<unknown>[]>();
  readonly #failures = new Map<TransportMethod, unknown[]>();
  #journalCursor = 0;

  /** Arms the next call of `method` to hang until the returned deferred settles. */
  defer<T>(method: TransportMethod): Deferred<T> {
    const d = deferred<T>();
    const queue = this.#deferrals.get(method) ?? [];
    queue.push(d as Deferred<unknown>);
    this.#deferrals.set(method, queue);
    return d;
  }

  /** Arms the next call of `method` to reject with `error`. One-shot. */
  fail(method: TransportMethod, error: unknown): void {
    const queue = this.#failures.get(method) ?? [];
    queue.push(error);
    this.#failures.set(method, queue);
  }

  countOf(method: TransportMethod): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  async #call<T>(method: TransportMethod, args: unknown[], value: () => T): Promise<T> {
    this.calls.push({ method, args });

    const failure = this.#failures.get(method);
    if (failure !== undefined && failure.length > 0) throw failure.shift();

    const deferrals = this.#deferrals.get(method);
    if (deferrals !== undefined && deferrals.length > 0) {
      const d = deferrals.shift() as Deferred<T>;
      return await d.promise;
    }
    return value();
  }

  listSessions(options?: ListSessionsOptions): Promise<SessionList> {
    return this.#call("listSessions", [options], () => this.sessionList);
  }

  readStatus(sessionId: string, options?: RequestOptions): Promise<SessionStatus> {
    return this.#call("readStatus", [sessionId, options], () => this.status);
  }

  readHistory(sessionId: string, options?: ReadHistoryOptions): Promise<EventJournalPage> {
    return this.#call("readHistory", [sessionId, options], () => {
      const index = Math.min(this.#journalCursor, this.journalPages.length - 1);
      this.#journalCursor += 1;
      const page = this.journalPages[index];
      if (page === undefined) throw new Error("FakeTransport: journalPages must not be empty");
      return page;
    });
  }

  createSession(request?: CreateRequest, options?: CreateSessionOptions): Promise<CreateResponse> {
    return this.#call("createSession", [request, options], () => this.createResponse);
  }

  restoreSession(sessionId: string, options?: RequestOptions): Promise<RestoreResponse> {
    return this.#call("restoreSession", [sessionId, options], () => this.restoreResponse);
  }

  submit(sessionId: string, request: CreateRequest, options?: RequestOptions): Promise<InputResponse> {
    return this.#call("submit", [sessionId, request, options], () => this.inputResponse);
  }

  respondGate(
    sessionId: string,
    gateId: string,
    request: GateResponseRequest,
    options?: RequestOptions,
  ): Promise<GateAcceptedResponse> {
    return this.#call("respondGate", [sessionId, gateId, request, options], () => this.gateResponse);
  }

  interrupt(sessionId: string, options?: RequestOptions): Promise<InterruptResponse> {
    return this.#call("interrupt", [sessionId, options], () => this.interruptResponse);
  }
}
