/**
 * Real `LiveFrameSource` implementation (join.ts's `() => AsyncIterable<SseFrame>`
 * contract): streams harness's live SSE event feed over `fetch()`, same-origin,
 * via the BFF's reverse proxy (`GET /api/v1/sessions/{sid}/events` ->
 * `internal/bff/events.go`'s `NewSSEProxy`, which forwards to `pkg/serve`'s
 * `GET /v1/sessions/{sid}/events`). Every request the returned source opens is a
 * fresh subscription starting from "now" — this module carries no cursor/resume
 * logic of its own; `join.ts` owns reconciling that against cold history (see
 * its module comment, "there is no server-side resume").
 *
 * ## Why a hand-rolled `AsyncIterator`, not just `parseSseStream()` returned
 * directly
 *
 * join.ts's own module comment flags exactly the risk this module exists to
 * close: "`LiveFrameSource` implementations must ensure their `.return()`/
 * cancellation actually unblocks a pending read (e.g. via an `AbortController`
 * into `fetch()`) — this module documents that requirement but cannot enforce
 * it." A bare async generator's `.return()` does NOT satisfy that requirement
 * on its own: per the AsyncGenerator spec, every request (`next`/`return`/
 * `throw`) is processed through the generator's internal single-flight queue —
 * calling `.return()` while a `.next()` call is already in flight (suspended
 * mid-execution awaiting a promise, e.g. `reader.read()`, rather than paused at
 * a `yield`) QUEUES the `.return()` request behind that pending operation
 * rather than preempting it. In the ordinary steady state of a live SSE
 * connection — waiting on the next byte from a server that has nothing new to
 * say right now — nothing else would ever settle that pending read, so the
 * queued `.return()` would simply never run and the underlying TCP connection
 * (and the whole fetch) would leak for the rest of the process's life.
 *
 * This module closes that gap by owning an `AbortController` OUTSIDE the
 * generator, on the connection object itself, and having the returned
 * iterator's `.return()` method call `controller.abort()` SYNCHRONOUSLY —
 * `AbortController.abort()` is a plain, immediate DOM/undici operation, not
 * itself subject to the generator's request queue, so it runs the instant
 * `.return()` is called regardless of what the generator is currently doing.
 * Aborting the fetch's signal makes the in-flight `reader.read()` (inside
 * `parseSseStream`, which this module delegates to for actual frame parsing)
 * reject right away — THAT is what actually unblocks the pending read. Only
 * after triggering the abort does this module also forward the `.return()`
 * call into the underlying generator, for API-compliant cleanup (running its
 * `finally` — `reader.releaseLock()` — once the now-rejected read unwinds); by
 * that point it's a formality, not the thing actually doing the unblocking.
 *
 * See live.test.ts's "abort unblocks a pending read" test, which proves this
 * against a REAL `node:http` server that never sends another byte after the
 * first frame (not a fake that resolves promptly regardless of what
 * cancellation does) and additionally asserts the SERVER observes the
 * connection actually closing — proving the fix closes the real TCP socket,
 * not just that this module's own iteration stops while a connection lingers
 * in the background.
 */
import { LiveConnectionError, NetworkError } from "./errors.js";
import type { LiveFrameSource } from "./join.js";
import { parseSseStream, type SseFrame } from "./sse.js";
import type { FetchLike } from "./transport.js";

export interface FetchLiveFrameSourceOptions {
  /**
   * Prefix the session's events path is appended to. Defaults to "/api/v1" —
   * a same-origin, relative path, matching BFFTransport's own default and the
   * BFF's actual route (`internal/bff/mux.go` mounts the SSE proxy at
   * "/api/v1/sessions/{sid}/events"). Overridable for tests (an absolute
   * `http://127.0.0.1:PORT/api/v1` against a real local server).
   */
  baseUrl?: string;
  /** Injectable fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

/**
 * Builds a `LiveFrameSource` for one session: each call to the returned
 * function opens a genuinely fresh `fetch()` subscription to
 * `{baseUrl}/sessions/{sessionId}/events`, per `LiveFrameSource`'s documented
 * contract (join.ts) that every call represents a new connection whose
 * iterable starts yielding from the moment the call returns.
 */
export function createFetchLiveFrameSource(
  sessionId: string,
  options: FetchLiveFrameSourceOptions = {},
): LiveFrameSource {
  const baseUrl = options.baseUrl ?? "/api/v1";
  const fetchImpl = options.fetch ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`;
  return () => new FetchLiveConnection(url, fetchImpl);
}

/**
 * One live connection attempt. `AsyncIterable`, not `AsyncIterator`, because
 * `LiveFrameSource` is called once per connection attempt and join.ts itself
 * calls `[Symbol.asyncIterator]()` on the result exactly once — but modeling
 * it as an iterable (rather than handing back the iterator directly) keeps
 * this class's public surface matching the interface it implements verbatim.
 */
class FetchLiveConnection implements AsyncIterable<SseFrame> {
  private readonly controller = new AbortController();

  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<SseFrame, void, void> {
    const generator = this.run();
    return {
      next: () => generator.next(),
      // Deliberately NOT just `generator.return` — see the module comment.
      // `controller.abort()` runs synchronously, before this method ever
      // touches the (possibly mid-flight) generator, so it isn't subject to
      // the generator's own next()/return() request queue.
      return: (value?: void | PromiseLike<void>) => {
        this.controller.abort();
        return generator.return(value as void);
      },
      throw: (err?: unknown) => generator.throw(err),
    };
  }

  private async *run(): AsyncGenerator<SseFrame, void, void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "GET",
        signal: this.controller.signal,
        headers: { Accept: "text/event-stream" },
      });
    } catch (cause) {
      // A `.return()` call before the fetch settled aborts `controller`,
      // which makes `fetchImpl` reject — that is a caller-requested clean
      // stop, not a real network failure, so it ends the generator quietly
      // rather than propagating an error nobody asked to see.
      if (this.controller.signal.aborted) return;
      throw new NetworkError(this.url, { cause });
    }

    if (!response.ok) {
      throw new LiveConnectionError(`live events request to ${this.url} failed with status ${response.status}`, {
        status: response.status,
      });
    }
    if (response.body === null) {
      throw new LiveConnectionError(`live events response from ${this.url} has no readable body`, {
        status: response.status,
      });
    }

    try {
      yield* parseSseStream(response.body);
    } catch (cause) {
      // Same reasoning as above: an abort mid-read is what makes
      // `parseSseStream`'s `reader.read()` reject. That is this module doing
      // exactly what it's supposed to do, not a failure to report.
      if (this.controller.signal.aborted) return;
      throw cause;
    }
  }
}
