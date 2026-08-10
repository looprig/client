/**
 * `LooprigTransport` is the abstraction every concrete way of talking to
 * harness's session HTTP surface implements. This task (Phase 1a — cold reads
 * only) builds exactly one implementation, `BFFTransport`, which calls
 * same-origin `/api/v1/...` paths on looprig/client's own BFF
 * (`internal/bff/mux.go`): a browser app never holds a token itself, it just
 * calls its own origin and the BFF (already authenticated, token stays
 * server-side) forwards to harness's `pkg/serve`.
 *
 * A second implementation, `ServeTransport` — for talking directly to
 * `pkg/serve` (e.g. a non-browser Node/CLI consumer that DOES hold a token) —
 * is deliberately deferred to Task 28. Nothing here should assume BFFTransport
 * is the only implementation that will ever exist: the interface is written
 * against what `pkg/serve`'s read plane actually accepts/returns (SPEC §6,
 * `pkg/serve/mux.go`, `pkg/serve/parse.go`), not against BFFTransport's own
 * shape, so a future ServeTransport can satisfy it without a redesign.
 *
 * `LooprigTransport` covers only the read plane (list/status/journal) per
 * this task; live (SSE) and control (create/input/interrupt/gate/restore)
 * methods are added in Tasks 21+/26+.
 */
import {
  errorFromResponse,
  MalformedResponseError,
  NetworkError,
  RequestAbortedError,
} from "./errors.js";
import type { ErrorResponse, EventJournalPage, SessionList, SessionStatus } from "./types.js";
import { validateErrorResponse, validateEventJournalPage, validateSessionList, validateSessionStatus } from "./validate.js";

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

/**
 * The read-plane subset of harness's session HTTP surface (SPEC §6): a page
 * of session summaries, one session's projected status, and a page of a
 * session's durable (Enduring) event journal. Every method validates its
 * response through the Task 15 ajv validators before resolving — no
 * implementation may hand back unvalidated network data.
 */
export interface LooprigTransport {
  /** `GET /v1/sessions?skip&limit` — a page of session summaries. */
  listSessions(options?: ListSessionsOptions): Promise<SessionList>;
  /** `GET /v1/sessions/{sid}/status` — one session's projected status. */
  readStatus(sessionId: string, options?: RequestOptions): Promise<SessionStatus>;
  /** `GET /v1/sessions/{sid}/journal?from_journal_seq&limit` — a page of Enduring events. */
  readHistory(sessionId: string, options?: ReadHistoryOptions): Promise<EventJournalPage>;
}

/** The subset of the `fetch()` signature BFFTransport depends on, so tests can inject a fake without touching globals. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
 *
 * Every response body is parsed through the ajv validators from validate.ts
 * before being returned — never cast with `as` — and every non-2xx response
 * is decoded as a (validated) ErrorResponse and turned into the matching
 * typed error from errors.ts.
 */
export class BFFTransport implements LooprigTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: BFFTransportOptions = {}) {
    this.baseUrl = options.baseUrl ?? "/api/v1";
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
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

  /**
   * Issues a GET, decodes the JSON body, and either returns the raw
   * (not-yet-schema-validated — each public method above validates against
   * its OWN expected schema) parsed value for a 2xx response, or throws the
   * typed error matching a non-2xx response. This is the one place fetch()
   * itself is called; every public method funnels through it so abort/network
   * handling is implemented exactly once.
   */
  private async getJSON(path: string, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "GET", signal });
    } catch (cause) {
      if (signal?.aborted) {
        throw new RequestAbortedError(path, { cause });
      }
      throw new NetworkError(path, { cause });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      if (signal?.aborted) {
        throw new RequestAbortedError(path, { cause });
      }
      throw new MalformedResponseError(path, response.status, { cause });
    }

    if (!response.ok) {
      let errorBody: ErrorResponse;
      try {
        errorBody = validateErrorResponse(body);
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

    return body;
  }
}

function queryString(params: URLSearchParams): string {
  const qs = params.toString();
  return qs === "" ? "" : `?${qs}`;
}
