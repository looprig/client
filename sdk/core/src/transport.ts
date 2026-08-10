/**
 * `LooprigTransport` is the abstraction every concrete way of talking to
 * harness's session HTTP surface implements. It covers the FULL cold-path
 * surface (SPEC §6): the three read-plane methods (Task 16 —
 * `listSessions`/`readStatus`/`readHistory`) plus the five control-plane
 * methods (Task 28 — `createSession`/`restoreSession`/`submit`/`respondGate`/
 * `interrupt`). Live (SSE) is a separate seam (`live.ts`), not part of this
 * interface.
 *
 * Two implementations exist, both built over the same shared HTTP plumbing
 * (`HttpTransport` below), differing only in base URL and how (if at all)
 * they authenticate:
 *
 *  - `BFFTransport` — for same-origin browser apps: calls relative
 *    `/api/v1/...` paths on looprig/client's own BFF (`internal/bff/mux.go`),
 *    which strips "/api" and forwards to harness's `pkg/serve`. A browser
 *    never holds a token itself; the BFF (already authenticated, cookie/
 *    session-scoped) injects the real server-side bearer token
 *    (`internal/bff/tokencustody.go`) on the outbound leg. BFFTransport
 *    itself therefore carries no credential.
 *  - `ServeTransport` — for trusted/server-side/custom callers (a non-browser
 *    Node/CLI consumer, a backend job, a test harness) that talk DIRECTLY to
 *    `pkg/serve`'s own unprefixed `/v1/...` routes, bypassing the BFF
 *    entirely. Such a caller DOES hold a credential, so ServeTransport
 *    accepts an optional bearer token and sends `Authorization: Bearer
 *    <token>` on every request — the same convention the BFF's own control
 *    proxy uses when IT talks to serve as a trusted caller
 *    (`internal/bff/tokencustody.go`'s `setOutboundAuthorization`). serve's
 *    own auth is a pluggable `func(*http.Request) error`
 *    (`pkg/serve/options.go`'s `WithAuth`), so a deployment is free to demand
 *    something else entirely; a caller in that position can inject a custom
 *    `fetch` that attaches its own headers instead of using the `token`
 *    option.
 *
 * Every response body is parsed through the ajv validators from validate.ts
 * before being returned — never cast with `as` — and every non-2xx response
 * is decoded as a (validated) ErrorResponse and turned into the matching
 * typed error from errors.ts. Both implementations share this discipline by
 * construction: they share the same private request plumbing, not just the
 * same intent independently reimplemented.
 */
import {
  errorFromResponse,
  MalformedResponseError,
  NetworkError,
  RequestAbortedError,
} from "./errors.js";
import type {
  CreateRequest,
  CreateResponse,
  ErrorResponse,
  EventJournalPage,
  GateAcceptedResponse,
  GateResponseRequest,
  InputResponse,
  InterruptResponse,
  RestoreResponse,
  SessionList,
  SessionStatus,
} from "./types.js";
import {
  validateCreateResponse,
  validateErrorResponse,
  validateEventJournalPage,
  validateGateAcceptedResponse,
  validateInputResponse,
  validateInterruptResponse,
  validateRestoreResponse,
  validateSessionList,
  validateSessionStatus,
} from "./validate.js";

/** Common options every transport method accepts. */
export interface RequestOptions {
  /**
   * Cancels the in-flight request. When aborted, the returned promise rejects
   * with a RequestAbortedError — before or during the underlying fetch,
   * whichever the abort happens to race with — rather than a NetworkError,
   * so callers can tell "I cancelled this" apart from "the network failed."
   */
  signal?: AbortSignal;
}

/** Options for `listSessions`: mirrors `GET /v1/sessions`'s `skip`/`limit` query params (parse.go). */
export interface ListSessionsOptions extends RequestOptions {
  /** Paging offset. Server default: 0. Server rejects negative values. */
  skip?: number;
  /** Page size. Server default: 100. Server-enforced range: [1, 1000]. */
  limit?: number;
}

/** Options for `readHistory`: mirrors `GET /v1/sessions/{sid}/journal`'s `from_journal_seq`/`limit` query params. */
export interface ReadHistoryOptions extends RequestOptions {
  /** Resume cursor. Server default: 0 (from the beginning). */
  fromJournalSeq?: number;
  /** Page size. Server default: 100. Server-enforced range: [1, 1000]. */
  limit?: number;
}

/** The request header carrying `createSession`'s idempotency key (harness's `pkg/serve/handlers_lifecycle.go` `headerIdempotencyKey`). */
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * Options for `createSession`. `idempotencyKey`, if supplied, opts the create
 * into idempotent replay (SPEC §6): a retry of `createSession` using the SAME
 * key and a byte-identical request body replays the original response
 * instead of minting a second session; a retry with the same key and a
 * DIFFERENT body is a 409 (`IdempotencyConflictError`). Omit for a normal,
 * non-idempotent create.
 *
 * To use this for real retry-safety, generate the key ONCE, before the first
 * attempt, and reuse the SAME value across retries — `generateIdempotencyKey()`
 * below is a convenience for minting that value; a fresh call to
 * `createSession` with no `idempotencyKey` remembered from a prior attempt
 * gets a fresh key each time and is not actually idempotent across retries.
 *
 * This is deliberately create-only: `RequestOptions` (used by every other
 * control method) has no equivalent field. Confirmed against both sides of
 * the real wire: harness's `pkg/serve/handlers_lifecycle.go` `handleCreate`
 * is the only handler that ever reads the `Idempotency-Key` header (every
 * other handler — restore, input, gate response, interrupt — never
 * references it), and looprig/client's own BFF proxy
 * (`internal/bff/control.go`) forwards the header on `POST /v1/sessions`
 * alone, unconditionally stripping it on the other four control routes. An
 * earlier draft of the plan this task implements assumed restore also needed
 * idempotency-key plumbing; that was a documented correction, not this
 * implementation's own guess.
 */
export interface CreateSessionOptions extends RequestOptions {
  idempotencyKey?: string;
}

/**
 * Mints a fresh idempotency key suitable for `CreateSessionOptions.idempotencyKey`,
 * via `crypto.randomUUID()`. A caller wanting retry-safe creates should call
 * this ONCE, hold onto the result, and pass the SAME value to every attempt
 * (including retries) of what is logically one create — see
 * `CreateSessionOptions`'s doc for why a fresh key per call defeats the
 * purpose.
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * The full cold-path subset of harness's session HTTP surface (SPEC §6): the
 * three read-plane methods (a page of session summaries, one session's
 * projected status, a page of a session's durable Enduring event journal) plus
 * the five control-plane methods (create, restore, submit input, respond to a
 * gate, interrupt). Every method validates its response through the Task 15
 * ajv validators before resolving — no implementation may hand back
 * unvalidated network data. Live (SSE) is intentionally NOT part of this
 * interface; see live.ts.
 */
export interface LooprigTransport {
  /** `GET /v1/sessions?skip&limit` — a page of session summaries. */
  listSessions(options?: ListSessionsOptions): Promise<SessionList>;
  /** `GET /v1/sessions/{sid}/status` — one session's projected status. */
  readStatus(sessionId: string, options?: RequestOptions): Promise<SessionStatus>;
  /** `GET /v1/sessions/{sid}/journal?from_journal_seq&limit` — a page of Enduring events. */
  readHistory(sessionId: string, options?: ReadHistoryOptions): Promise<EventJournalPage>;

  /**
   * `POST /v1/sessions` — bring up a fresh session, optionally submitting
   * initial input (`request.blocks`). `request` may be omitted entirely for
   * an idle create (mirrors the server accepting no body or `{}`
   * identically). See `CreateSessionOptions` for `idempotencyKey`.
   */
  createSession(request?: CreateRequest, options?: CreateSessionOptions): Promise<CreateResponse>;
  /** `POST /v1/sessions/{sid}/restore` — rebuild a prior session from durable history and reattach it to the live registry. */
  restoreSession(sessionId: string, options?: RequestOptions): Promise<RestoreResponse>;
  /** `POST /v1/sessions/{sid}/input` — submit human-authored input to a session that is live in the target process. */
  submit(sessionId: string, request: CreateRequest, options?: RequestOptions): Promise<InputResponse>;
  /**
   * `POST /v1/sessions/{sid}/gates/{gid}` — deliver a human's answer to an
   * open gate. `gateId` is OPAQUE: callers get it from wherever a gate
   * identifier surfaces in this SDK (e.g. `SessionStatus.waiting_gate_id`)
   * and must never parse, split, or otherwise assume anything about its
   * format — every implementation treats it as an opaque string, interpolated
   * verbatim (percent-encoded for URL-safety only, exactly like `sessionId`)
   * into the request path.
   */
  respondGate(sessionId: string, gateId: string, request: GateResponseRequest, options?: RequestOptions): Promise<GateAcceptedResponse>;
  /** `POST /v1/sessions/{sid}/interrupt` — cancel every in-flight turn on a session that is live in the target process. */
  interrupt(sessionId: string, options?: RequestOptions): Promise<InterruptResponse>;
}

/** The subset of the `fetch()` signature the shared transport plumbing depends on, so tests can inject a fake without touching globals. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Shared HTTP plumbing for every `LooprigTransport` implementation in this
 * module. Both `BFFTransport` and `ServeTransport` extend this rather than
 * each hand-rolling their own fetch/parse/error-mapping logic, so the two
 * concrete classes cannot silently diverge in how they parse responses, map
 * errors, or handle abort/network failures — the ONLY things a subclass
 * supplies are its base URL and (optionally) per-request auth headers
 * (`extraHeaders`); every method above is implemented exactly once, here.
 *
 * Every response body is parsed through the ajv validators from validate.ts
 * before being returned — never cast with `as` — and every non-2xx response
 * is decoded as a (validated) ErrorResponse and turned into the matching
 * typed error from errors.ts.
 */
abstract class HttpTransport implements LooprigTransport {
  protected abstract readonly baseUrl: string;
  protected abstract readonly fetchImpl: FetchLike;

  /**
   * Extra headers attached to every outbound request (e.g. an Authorization
   * bearer token for ServeTransport). Called fresh on every request rather
   * than cached once, so a subclass could rotate a credential between calls.
   * The base implementation sends none — matching BFFTransport, which is
   * same-origin and carries no credential of its own.
   */
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionList> {
    const params = new URLSearchParams();
    if (options.skip !== undefined) params.set("skip", String(options.skip));
    if (options.limit !== undefined) params.set("limit", String(options.limit));

    const data = await this.getJSON(`/sessions${queryString(params)}`, options.signal);
    return validateSessionList(data);
  }

  async readStatus(sessionId: string, options: RequestOptions = {}): Promise<SessionStatus> {
    const data = await this.getJSON(`/sessions/${encodeURIComponent(sessionId)}/status`, options.signal);
    return validateSessionStatus(data);
  }

  async readHistory(sessionId: string, options: ReadHistoryOptions = {}): Promise<EventJournalPage> {
    const params = new URLSearchParams();
    if (options.fromJournalSeq !== undefined) params.set("from_journal_seq", String(options.fromJournalSeq));
    if (options.limit !== undefined) params.set("limit", String(options.limit));

    const data = await this.getJSON(
      `/sessions/${encodeURIComponent(sessionId)}/journal${queryString(params)}`,
      options.signal,
    );
    return validateEventJournalPage(data);
  }

  async createSession(request?: CreateRequest, options: CreateSessionOptions = {}): Promise<CreateResponse> {
    const requestHeaders: Record<string, string> = {};
    if (options.idempotencyKey !== undefined) {
      requestHeaders[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
    }
    // request ?? {} mirrors the server accepting no body or an empty object
    // identically for an idle create (createRequestSchema's "blocks" is
    // optional) — always sending SOME JSON body keeps this method's wire
    // behavior uniform regardless of whether the caller passed anything.
    const data = await this.postJSON("/sessions", request ?? {}, options.signal, requestHeaders);
    return validateCreateResponse(data);
  }

  async restoreSession(sessionId: string, options: RequestOptions = {}): Promise<RestoreResponse> {
    // No body: handleRestore never reads one.
    const data = await this.postJSON(`/sessions/${encodeURIComponent(sessionId)}/restore`, undefined, options.signal);
    return validateRestoreResponse(data);
  }

  async submit(sessionId: string, request: CreateRequest, options: RequestOptions = {}): Promise<InputResponse> {
    const data = await this.postJSON(`/sessions/${encodeURIComponent(sessionId)}/input`, request, options.signal);
    return validateInputResponse(data);
  }

  async respondGate(
    sessionId: string,
    gateId: string,
    request: GateResponseRequest,
    options: RequestOptions = {},
  ): Promise<GateAcceptedResponse> {
    // gateId is OPAQUE (see the interface doc above): encodeURIComponent here
    // is URL-escaping, not parsing — the exact same treatment sessionId gets
    // on every method in this class. No .split(), no format assumption, no
    // inspection of gateId's contents beyond passing it whole to the encoder.
    const path = `/sessions/${encodeURIComponent(sessionId)}/gates/${encodeURIComponent(gateId)}`;
    const data = await this.postJSON(path, request, options.signal);
    return validateGateAcceptedResponse(data);
  }

  async interrupt(sessionId: string, options: RequestOptions = {}): Promise<InterruptResponse> {
    // No body: handleInterrupt never reads one.
    const data = await this.postJSON(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, undefined, options.signal);
    return validateInterruptResponse(data);
  }

  /** GET variant of the shared request plumbing — see `sendRequest`. */
  private async getJSON(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.sendRequest(path, { method: "GET", signal, headers: this.extraHeaders() });
  }

  /**
   * POST variant of the shared request plumbing. `body`, if provided, is
   * JSON-serialized and sent with `Content-Type: application/json`; `body`
   * omitted (`undefined`) sends no request body at all (used by
   * `restoreSession`/`interrupt`, whose handlers never read one).
   * `requestHeaders` are merged on top of `extraHeaders()` (e.g.
   * `createSession`'s `Idempotency-Key`).
   */
  private async postJSON(
    path: string,
    body: unknown | undefined,
    signal?: AbortSignal,
    requestHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { ...this.extraHeaders(), ...requestHeaders };
    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      serializedBody = JSON.stringify(body);
    }
    return this.sendRequest(path, { method: "POST", body: serializedBody, signal, headers });
  }

  /**
   * Issues a request, decodes the JSON body, and either returns the raw
   * (not-yet-schema-validated — each public method above validates against
   * its OWN expected schema) parsed value for a 2xx response, or throws the
   * typed error matching a non-2xx response. This is the one place fetch()
   * itself is called; every public method funnels through it (via getJSON/
   * postJSON) so abort/network handling is implemented exactly once, shared
   * by every LooprigTransport implementation in this module.
   */
  private async sendRequest(
    path: string,
    init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<unknown> {
    const headers = init.headers !== undefined && Object.keys(init.headers).length > 0 ? init.headers : undefined;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        body: init.body,
        signal: init.signal,
        headers,
      });
    } catch (cause) {
      if (init.signal?.aborted) {
        throw new RequestAbortedError(path, { cause });
      }
      throw new NetworkError(path, { cause });
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch (cause) {
      if (init.signal?.aborted) {
        throw new RequestAbortedError(path, { cause });
      }
      throw new MalformedResponseError(path, response.status, { cause });
    }

    if (!response.ok) {
      let errorBody: ErrorResponse;
      try {
        errorBody = validateErrorResponse(responseBody);
      } catch (cause) {
        // The response was valid JSON but didn't conform to the BFF's
        // error_response envelope — e.g. an infrastructure proxy/load
        // balancer returning its own `{"message": "Bad Gateway"}` shape for
        // a 502 instead of the BFF ever handling the request. Degrade the
        // same way a fully non-JSON body already does (MalformedResponseError),
        // rather than letting ContractValidationError — an implementation
        // detail of validate.ts, not part of this module's documented
        // exception surface — leak to callers. The original validation
        // failure is preserved as `cause` for debugging.
        throw new MalformedResponseError(path, response.status, { cause });
      }
      throw errorFromResponse(response.status, errorBody);
    }

    return responseBody;
  }
}

export interface BFFTransportOptions {
  /**
   * Prefix every request path is appended to. Defaults to "/api/v1" — a
   * same-origin, relative path, matching the BFF framing (`internal/bff/
   * mux.go` strips "/api" and forwards the rest to serve's own "/v1/..."
   * routes). Overridable for tests (an absolute `http://127.0.0.1:PORT/api/v1`
   * against a real local server) or a deployment that mounts the BFF under a
   * different prefix.
   */
  baseUrl?: string;
  /** Injectable fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

/**
 * `LooprigTransport` implementation for same-origin browser apps: calls
 * `/api/v1/...` paths via `fetch()`. The BFF already sits behind
 * authentication and CSRF/Origin guards (`internal/bff/guard.go`,
 * `csrf.go`) — this transport itself carries no token, matching the plan's
 * "token stays server-side" framing.
 */
export class BFFTransport extends HttpTransport {
  protected readonly baseUrl: string;
  protected readonly fetchImpl: FetchLike;

  constructor(options: BFFTransportOptions = {}) {
    super();
    this.baseUrl = options.baseUrl ?? "/api/v1";
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
}

export interface ServeTransportOptions {
  /**
   * Base URL harness's own unprefixed serve routes are resolved against, e.g.
   * "https://serve.internal.example:8443/v1" or (colocated)
   * "http://127.0.0.1:8080/v1". Unlike `BFFTransportOptions.baseUrl`, there is
   * NO sensible default: `pkg/serve` exposes no fixed host/port convention
   * (bind address is entirely the deployer's choice), so a caller must always
   * supply the real endpoint.
   */
  baseUrl: string;
  /**
   * Sent as `Authorization: Bearer <token>` on every request — the same
   * convention looprig/client's own BFF uses when IT talks to serve as a
   * trusted caller (`internal/bff/tokencustody.go`'s
   * `setOutboundAuthorization`). serve's own auth is a pluggable
   * `func(*http.Request) error` (`pkg/serve/options.go`'s `WithAuth`), so a
   * deployment could in principle demand a different scheme entirely; this
   * option covers the one convention this codebase already uses, not every
   * scheme serve could ever be configured to require. A caller whose
   * deployment needs something else can supply a custom `fetch` that attaches
   * its own headers instead. Omit for an unauthenticated deployment, or one
   * where the injected `fetch` already handles auth itself.
   */
  token?: string;
  /** Injectable fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

/**
 * `LooprigTransport` implementation for trusted/server-side/custom callers —
 * a non-browser Node/CLI consumer, a backend job, a test harness — that talk
 * DIRECTLY to harness's `pkg/serve`, bypassing looprig/client's BFF entirely.
 * Such a caller holds its own credential (unlike a browser via BFFTransport),
 * so this transport sends `Authorization: Bearer <token>` when `token` is
 * supplied. Paths are resolved against `options.baseUrl` with NO "/api"
 * prefix, matching `pkg/serve/mux.go`'s own unprefixed route table
 * (`GET /v1/capabilities`, `GET /v1/sessions`, ...) — this is a different URL
 * scheme from BFFTransport's `/api/v1/...`, not merely a different host.
 */
export class ServeTransport extends HttpTransport {
  protected readonly baseUrl: string;
  protected readonly fetchImpl: FetchLike;
  private readonly token: string | undefined;

  constructor(options: ServeTransportOptions) {
    super();
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.token = options.token;
  }

  protected override extraHeaders(): Record<string, string> {
    return this.token !== undefined ? { Authorization: `Bearer ${this.token}` } : {};
  }
}

function queryString(params: URLSearchParams): string {
  const qs = params.toString();
  return qs === "" ? "" : `?${qs}`;
}
