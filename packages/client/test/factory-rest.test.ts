import { describe, expect, it, vi } from "vitest";
import { FactoryRestReads, isRejectedJournalCursor } from "../src/factory-rest.js";
import {
  CoreProtocolError,
  MalformedResponseError,
  NetworkError,
  RequestAbortedError,
} from "../src/errors.js";

describe("FactoryRestReads bounded object ranges", () => {
  it("issues an authenticated inclusive range request and accepts only a 206 response", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([2, 3, 4]), {
        status: 206,
        headers: {
          "Content-Range": "bytes 2-4/9",
          "Content-Length": "3",
          "Content-Type": "application/octet-stream",
        },
      });
    });
    const reads = new FactoryRestReads({
      baseUrl: "https://factory.example/",
      fetch,
      credentials: { restHeaders: () => ({ Authorization: "Bearer object-token" }) },
    });

    await expect(reads.readObjectRange("session /1", "object/a", {
      start: 2, end: 4,
    })).resolves.toEqual({
      bytes: new Uint8Array([2, 3, 4]),
      contentRange: "bytes 2-4/9",
      mediaType: "application/octet-stream",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls[0]?.url).toBe("https://factory.example/v1/sessions/session%20%2F1/objects/object%2Fa");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer object-token");
    expect(new Headers(calls[0]?.init?.headers).get("Range")).toBe("bytes=2-4");
  });

  it("rejects one atomically delivered oversized default-reader chunk without another pull", async () => {
    let emittedBytes = 0;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        const chunkBytes = pulls === 1 ? 8 : 4;
        emittedBytes += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const fetch = vi.fn(async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }));
    const reads = new FactoryRestReads({ fetch });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0,
      end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(cancelled).toBe(true);
    expect(emittedBytes).toBe(8);
    expect(pulls).toBe(1);
    expect(body.locked).toBe(false);
  });

  it("returns and cancels at exact fill without pulling one surplus byte", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([pulls]));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(pulls).toBe(4);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("caps a byte stream's BYOB delivery view to the exact remaining range", async () => {
    let pulls = 0;
    let cancelled = false;
    const deliveredViewSizes: number[] = [];
    const byteSource: UnderlyingByteSource = {
      type: "bytes",
      pull(controller) {
        pulls += 1;
        const request = controller.byobRequest;
        if (request?.view === null || request === null) throw new Error("expected a BYOB request");
        deliveredViewSizes.push(request.view.byteLength);
        new Uint8Array(request.view.buffer, request.view.byteOffset, request.view.byteLength)[0] = pulls;
        request.respond(1);
      },
      cancel() { cancelled = true; },
    };
    const body = new ReadableStream(byteSource);
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(deliveredViewSizes).toStrictEqual([4, 3, 2, 1]);
    expect(pulls).toBe(4);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("rejects a legal HTTP 200 Range response before consuming its unproven body", async () => {
    let emittedBytes = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emittedBytes += 4;
        controller.enqueue(new Uint8Array(4));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 200,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(cancelled).toBe(true);
    expect(emittedBytes).toBe(0);
  });

  it("rejects a declared response length above the bound before consuming the body", async () => {
    let emittedBytes = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emittedBytes += 8;
        controller.enqueue(new Uint8Array(8));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4", "Content-Length": "8" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(cancelled).toBe(true);
    expect(emittedBytes).toBe(0);
  });

  it("rejects a declared response length below the exact range before consuming the body", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(2));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4", "Content-Length": "2" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("rejects Content-Range bounds that differ from the request before consuming the body", async () => {
    let emittedBytes = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emittedBytes += 4;
        controller.enqueue(new Uint8Array(4));
        controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 4-7/8" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(cancelled).toBe(true);
    expect(emittedBytes).toBe(0);
  });

  it("rejects a missing 206 body", async () => {
    const reads = new FactoryRestReads({ fetch: async () => new Response(null, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it("rejects a body that closes before the exact requested range is filled", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toBeInstanceOf(MalformedResponseError);
    expect(body.locked).toBe(false);
  });

  it("classifies aborts before and during body reads and cancels the reader", async () => {
    for (const timing of ["before", "during"] as const) {
      const abort = new AbortController();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (timing === "during") abort.abort();
          controller.enqueue(new Uint8Array(4));
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
        status: 206,
        headers: { "Content-Range": "bytes 0-3/4" },
      }) });
      if (timing === "before") abort.abort();

      await expect(reads.readObjectRange("session-1", "object-1", {
        start: 0, end: 3, signal: abort.signal,
      })).rejects.toBeInstanceOf(RequestAbortedError);
      expect(cancelled, timing).toBe(true);
    }
  });

  it("awaits asynchronous stream cancellation before releasing an aborted reader", async () => {
    const abort = new AbortController();
    let releaseCancellation!: () => void;
    const cancellationFinished = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    let cancellationStarted = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { queueMicrotask(() => abort.abort()); },
      cancel() {
        cancellationStarted = true;
        return cancellationFinished;
      },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    const result = reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3, signal: abort.signal,
    });
    let settled = false;
    void result.finally(() => { settled = true; }).catch(() => undefined);
    await vi.waitFor(() => expect(cancellationStarted).toBe(true));
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseCancellation();
    await expect(result).rejects.toBeInstanceOf(RequestAbortedError);
    expect(body.locked).toBe(false);
  });

  it("classifies a body reader failure as a network error and cancels/releases it", async () => {
    let cancelled = false;
    const cause = new Error("reader failed");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(cause); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const reads = new FactoryRestReads({ fetch: async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/4" },
    }) });

    await expect(reads.readObjectRange("session-1", "object-1", {
      start: 0, end: 3,
    })).rejects.toMatchObject({ constructor: NetworkError, cause });
    expect(cancelled).toBe(false); // errored streams are already terminal; cancel remains harmless.
    expect(body.locked).toBe(false);
  });

  // The response bound is DERIVED from the inclusive range, so the only way to
  // ask for an illegal number of bytes is to describe an illegal range. Every
  // row below is rejected before any request is issued, and the set is chosen
  // so that no single guard can be deleted and leave them all still rejected.
  // `readObjectRange` has five conjuncts and each one has a row below that is
  // the SOLE reason that row is rejected:
  //
  //  - the START safe-integer guard: `{ start: 1e-17, end: 5 }`. 1e-17 rounds
  //    away in `end - start + 1`, so the derived length is 6 and safe.
  //    `{ start: 1.5, end: 3 }` cannot isolate it, since its length is 2.5 and
  //    the length guard rejects it too; it is kept as the ordinary fractional
  //    case, not as an isolator.
  //  - the END safe-integer guard: `{ start: MAX_SAFE_INTEGER, end:
  //    MAX_SAFE_INTEGER + 1 }`. `MAX_SAFE_INTEGER + 1` is 2**53 and is NOT a
  //    safe integer. Its derived length is 2, so this row says nothing at all
  //    about the length guard.
  //  - `start < 0`: `{ start: -1, end: 3 }`. -1 is a safe integer, the range is
  //    in order, and the derived length, 5, is safe.
  //  - the ordering guard: `{ start: 3, end: 2 }`, whose derived length is 0.
  //  - the LENGTH guard: `{ start: 0, end: MAX_SAFE_INTEGER }`. Both endpoints
  //    are safe integers, non-negative and in order, and only `end - start + 1`
  //    — 2**53 bytes — leaves the safe domain.
  it.each([
    { start: 1e-17, end: 5 },
    { start: 1.5, end: 3 },
    { start: -1, end: 3 },
    { start: 3, end: 2 },
    { start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER + 1 },
    { start: 0, end: Number.MAX_SAFE_INTEGER },
  ])("rejects an invalid byte range before fetch: %o", async (options) => {
    const fetch = vi.fn();
    const reads = new FactoryRestReads({ fetch });
    await expect(reads.readObjectRange("session-1", "object-1", options)).rejects.toBeInstanceOf(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies missing and denied objects identically from Factory's non-disclosing response", async () => {
    const envelope = { error: { code: "not_found", message: "not found", retryable: false } };
    const requests: Array<{ token: string; url: string }> = [];
    const attempt = async (token: string): Promise<CoreProtocolError> => {
      const reads = new FactoryRestReads({
        baseUrl: "https://factory.example",
        credentials: { restHeaders: () => ({ Authorization: token }) },
        fetch: async (url, init) => {
          requests.push({ token: new Headers(init?.headers).get("Authorization") ?? "", url });
          return new Response(JSON.stringify(envelope), { status: 404 });
        },
      });
      try {
        await reads.readObjectMetadata("session-1", "object-1");
        throw new Error("expected read to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(CoreProtocolError);
        return error as CoreProtocolError;
      }
    };

    const missing = await attempt("Bearer may-read-missing");
    const denied = await attempt("Bearer denied");
    expect({ code: denied.code, message: denied.message, retryable: denied.retryable, body: denied.body })
      .toStrictEqual({ code: missing.code, message: missing.message, retryable: missing.retryable, body: missing.body });
    expect(requests).toStrictEqual([
      { token: "Bearer may-read-missing", url: "https://factory.example/v1/sessions/session-1/objects/object-1/metadata" },
      { token: "Bearer denied", url: "https://factory.example/v1/sessions/session-1/objects/object-1/metadata" },
    ]);
  });
});

describe("FactoryRestReads browser identity bootstrap", () => {
  it("reads the authenticated caller tenant from the exact bootstrap route", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const reads = new FactoryRestReads({
      baseUrl: "https://factory.example/",
      credentials: { restHeaders: () => ({ Authorization: "Bearer browser-token" }) },
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ tenant_id: "tenant-1" }));
      },
    });

    await expect(reads.readBootstrap()).resolves.toStrictEqual({ tenant_id: "tenant-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://factory.example/v1/bootstrap");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer browser-token");
  });

  it.each([
    null,
    {},
    { tenant_id: "" },
    { tenant_id: 7 },
    { tenant_id: "t".repeat(257) },
    { tenant_id: "é".repeat(200) },
    { tenant_id: "tenant-1", subject: "must-not-cross-the-boundary" },
  ])("rejects a bootstrap body outside the exact bounded DTO: %o", async (body) => {
    const reads = new FactoryRestReads({ fetch: async () => new Response(JSON.stringify(body)) });
    await expect(reads.readBootstrap()).rejects.toBeInstanceOf(MalformedResponseError);
  });
});

describe("FactoryRestReads journal positions", () => {
  const page = { journal_tip: 9, covered_through: 9, events: [] };

  it("sends a forward read as Factory's from_seq, never combined with a cursor or tail", async () => {
    const urls: string[] = [];
    const reads = new FactoryRestReads({
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(page));
      },
    });
    await reads.readJournal("session-1", { fromSeq: 7, limit: 16 });
    expect(urls).toStrictEqual(["/v1/sessions/session-1/journal?from_seq=7&limit=16"]);
    await expect(reads.readJournal("session-1", { fromSeq: 7, cursor: "j1.x" })).rejects.toBeInstanceOf(RangeError);
    await expect(reads.readJournal("session-1", { fromSeq: 7, tail: 4 })).rejects.toBeInstanceOf(RangeError);
    await expect(reads.readJournal("session-1", { fromSeq: -1 })).rejects.toBeInstanceOf(RangeError);
    expect(urls).toHaveLength(1);
  });

  it("classifies Factory's refusal of a cursor it did not issue as a restartable walk", async () => {
    const reads = new FactoryRestReads({
      fetch: async () => new Response(JSON.stringify({
        version: 1,
        error: {
          code: "invalid_request",
          message: "the cursor is not one this session issued; restart the walk",
          retryable: false,
        },
      }), { status: 400, headers: { "Content-Type": "application/json" } }),
    });
    const refusal = await reads.readJournal("session-1", { cursor: "c2.pre-upgrade" }).catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(CoreProtocolError);
    expect(isRejectedJournalCursor(refusal)).toBe(true);
    expect(isRejectedJournalCursor(new NetworkError("offline"))).toBe(false);
    expect(isRejectedJournalCursor(new CoreProtocolError({
      version: 1, error: { code: "session_not_found", retryable: false },
    }))).toBe(false);
  });
});

describe("the default fetch", () => {
  it("is called with the global receiver, as a browser's Window.fetch requires", async () => {
    // A browser's fetch throws "Illegal invocation" when called with any other
    // receiver; Node's does not, so this stub restores the browser's check.
    const original = globalThis.fetch;
    const receivers: unknown[] = [];
    globalThis.fetch = function strictFetch(this: unknown): Promise<Response> {
      receivers.push(this);
      if (this !== globalThis && this !== undefined) {
        return Promise.reject(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"));
      }
      return Promise.resolve(new Response(JSON.stringify({ tenant_id: "tenant-1" })));
    } as typeof fetch;
    try {
      await expect(new FactoryRestReads().readBootstrap()).resolves.toStrictEqual({ tenant_id: "tenant-1" });
      expect(receivers).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
