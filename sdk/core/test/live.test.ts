/**
 * `createFetchLiveFrameSource` coverage against REAL HTTP round trips: a tiny
 * `node:http` server stands in for the BFF's SSE proxy
 * (`internal/bff/events.go`'s `NewSSEProxy`, itself a byte-level relay of
 * harness's `pkg/serve` events endpoint), mirroring transport.test.ts's own
 * "no fetch mock, a real server" approach.
 *
 * The flagship test here ("abort unblocks a pending read...") is the one
 * live.ts's own module comment calls out as the point of this whole module:
 * proving that calling `.return()` on the returned iterator genuinely
 * unblocks a `reader.read()` call that is ACTUALLY PENDING against a real
 * socket with nothing more coming — not just that this module's own
 * bookkeeping stops, and not just that `.return()`'s promise eventually
 * resolves (which alone wouldn't prove the underlying connection was ever
 * torn down). It additionally asserts the SERVER side observes the
 * connection closing, which is the only way to be sure the fix is real: a
 * client that merely stops reading while the TCP connection lingers open
 * would still make the client-side promise "resolve eventually" once the
 * server times out on its own, but the server in this test explicitly never
 * writes or ends the response again — so a server-observed close can only
 * come from the client's abort actually tearing down the connection.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createFetchLiveFrameSource } from "../src/live.js";
import { LiveConnectionError, NetworkError } from "../src/errors.js";
import type { SseFrame } from "../src/sse.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Starts a throwaway HTTP server on an ephemeral port running `handler`, returning its base URL and a teardown. */
async function startServer(handler: Handler): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/api/v1`, server };
}

/** A promise plus its resolve/reject, so a test can synchronize on a server-side event without polling. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Races `promise` against a timeout, so a hang shows up as a clear assertion failure instead of the whole suite stalling. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), ms)),
  ]);
}

function sseFrame(seq: number): string {
  const eventId = `10000000-0000-0000-0000-${String(seq).padStart(12, "0")}`;
  const data = JSON.stringify({ v: 1, event: { type: "TurnDone", v: 1, event_id: eventId } });
  return `event: enduring\nid: ${seq}\ndata: ${data}\n\n`;
}

const sessionId = "11111111-1111-1111-1111-111111111111";

let activeServer: Server | undefined;

afterEach(async () => {
  if (activeServer !== undefined) {
    // Some of these tests deliberately leave a connection open until the
    // client aborts it; closeAllConnections() (rather than plain close(),
    // which waits for every connection to end on its own) keeps teardown
    // from hanging if a test's own abort assertions already ran but the
    // socket needs an extra nudge.
    activeServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => activeServer!.close((err) => (err ? reject(err) : resolve())));
    activeServer = undefined;
  }
});

describe("createFetchLiveFrameSource: real SSE round trip", () => {
  it("streams parsed SseFrames from a real server, in order, until the server ends the response", async () => {
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe(`/api/v1/sessions/${sessionId}/events`);
      expect(req.headers.accept).toBe("text/event-stream");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sseFrame(1));
      res.write(sseFrame(2));
      res.end();
    });
    activeServer = server;

    const source = createFetchLiveFrameSource(sessionId, { baseUrl });
    const frames: SseFrame[] = [];
    for await (const frame of source()) frames.push(frame);

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: "enduring", journalSeq: 1 });
    expect(frames[1]).toMatchObject({ type: "enduring", journalSeq: 2 });
  });

  it("opens a genuinely fresh connection on each call to the returned LiveFrameSource", async () => {
    let requestCount = 0;
    const { baseUrl, server } = await startServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sseFrame(requestCount));
      res.end();
    });
    activeServer = server;

    const source = createFetchLiveFrameSource(sessionId, { baseUrl });

    const first: SseFrame[] = [];
    for await (const frame of source()) first.push(frame);
    const second: SseFrame[] = [];
    for await (const frame of source()) second.push(frame);

    expect(requestCount).toBe(2);
    expect(first).toMatchObject([{ journalSeq: 1 }]);
    expect(second).toMatchObject([{ journalSeq: 2 }]);
  });

  it("rejects with LiveConnectionError (carrying the real status) when the server responds non-2xx", async () => {
    const { baseUrl, server } = await startServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("service unavailable");
    });
    activeServer = server;

    const source = createFetchLiveFrameSource(sessionId, { baseUrl });
    const iterator = source()[Symbol.asyncIterator]();

    const rejection = iterator.next();
    await expect(rejection).rejects.toBeInstanceOf(LiveConnectionError);
    await rejection.catch((err: LiveConnectionError) => {
      expect(err.status).toBe(503);
    });
  });

  it("rejects with NetworkError (not LiveConnectionError) when the server is unreachable", async () => {
    // Nothing listens on this port: connection refused before any response.
    const source = createFetchLiveFrameSource(sessionId, { baseUrl: "http://127.0.0.1:1/api/v1" });
    const iterator = source()[Symbol.asyncIterator]();

    const rejection = iterator.next();
    await expect(rejection).rejects.toBeInstanceOf(NetworkError);
    await expect(rejection).rejects.not.toBeInstanceOf(LiveConnectionError);
  });
});

describe("createFetchLiveFrameSource: abort/cancellation correctness", () => {
  it("abort unblocks a pending read against a real server that sends nothing further, and the server observes the connection actually close", async () => {
    const serverClosed = deferred<void>();
    let serverSawClose = false;

    const { baseUrl, server } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sseFrame(1));
      // Deliberately never write or end again: this is what makes the
      // second `next()` below a GENUINELY pending read, with nothing but a
      // client-side abort able to ever settle it.
      req.on("close", () => {
        serverSawClose = true;
        serverClosed.resolve();
      });
    });
    activeServer = server;

    const source = createFetchLiveFrameSource(sessionId, { baseUrl });
    const iterator = source()[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first).toMatchObject({ done: false, value: { type: "enduring", journalSeq: 1 } });

    // The pending read `.return()` must unblock. Not yet awaited: this is
    // the in-flight operation the rest of the test verifies actually
    // settles, rather than hanging until some outer test timeout.
    const pendingNext = iterator.next();

    const startedReturn = Date.now();
    await withTimeout(Promise.resolve(iterator.return?.()), 1_000, "iterator.return() to settle");
    expect(Date.now() - startedReturn).toBeLessThan(1_000);

    // The read that was ALREADY pending before .return() was called must
    // also settle promptly — this is the actual "unblocks a pending read"
    // claim, distinct from .return() itself merely resolving.
    const settledPendingNext = await withTimeout(pendingNext, 1_000, "the already-pending next() to settle");
    expect(settledPendingNext.done).toBe(true);

    // And the server — which never closed or ended the response itself —
    // must have observed the connection actually go away. This is what
    // rules out "the client gave up locally while the socket leaked."
    await withTimeout(serverClosed.promise, 2_000, "the server to observe the connection closing");
    expect(serverSawClose).toBe(true);
  });

  it("abort during the initial connect (before any response arrives) ends cleanly and promptly, without leaking a hung request", async () => {
    const requestReceived = deferred<void>();
    let serverSawClose = false;
    const serverClosed = deferred<void>();

    const { baseUrl, server } = await startServer((req, res) => {
      requestReceived.resolve();
      req.on("close", () => {
        serverSawClose = true;
        serverClosed.resolve();
      });
      // Never respond at all within the test's lifetime — simulates a slow
      // upstream that hasn't even sent headers yet when the client gives up.
      res.flushHeaders?.();
    });
    activeServer = server;

    const source = createFetchLiveFrameSource(sessionId, { baseUrl });
    const iterator = source()[Symbol.asyncIterator]();

    const pendingFirst = iterator.next();
    await withTimeout(requestReceived.promise, 1_000, "the server to receive the request");

    const started = Date.now();
    await withTimeout(Promise.resolve(iterator.return?.()), 1_000, "iterator.return() to settle");
    expect(Date.now() - started).toBeLessThan(1_000);

    const settled = await withTimeout(pendingFirst, 1_000, "the already-pending next() to settle");
    expect(settled.done).toBe(true);

    await withTimeout(serverClosed.promise, 2_000, "the server to observe the connection closing");
    expect(serverSawClose).toBe(true);
  });
});
