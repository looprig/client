import {
  CoreInvalidRequestError,
  errorFromCoreEnvelope,
  MalformedResponseError,
  NetworkError,
  RequestAbortedError,
} from "./errors.js";
import type {
  DepartmentCapabilitySummary,
  FactorySessionStatus,
  ObjectMetadata,
  PublicGatePage,
  PublicJournalPage,
  RecentSessionPage,
} from "./types.js";
import {
  validateDepartmentCapabilitySummary,
  validateCoreErrorEnvelope,
  validateFactorySessionStatus,
  validateObjectMetadata,
  validatePublicGatePage,
  validatePublicJournalPage,
  validateRecentSessionPage,
} from "./validate.js";
import type { FetchLike, RequestOptions } from "./transport.js";

export interface FactoryRestCredentials {
  restHeaders?(): Promise<Record<string, string>> | Record<string, string>;
}

/** Factory-owned identity document for the authenticated browser caller. */
export interface FactoryBootstrap {
  readonly tenant_id: string;
}

export interface FactoryPageOptions extends RequestOptions {
  cursor?: string;
  limit?: number;
}

export interface FactoryJournalOptions extends FactoryPageOptions {
  /** A bounded tail-first read. Mutually exclusive with cursor and fromSeq. */
  tail?: number;
  /**
   * A bounded FORWARD read starting at this journal sequence (Factory's
   * `from_seq`). The page captures the tip at read time, and its `next_cursor`
   * continues that one capture. Mutually exclusive with cursor and tail.
   *
   * This is how a view RESUMES from the sequence it last committed, so a
   * reconnect shows every public event since that checkpoint rather than only
   * the newest tail window.
   */
  fromSeq?: number;
}

/**
 * Whether a journal read that carried a continuation `cursor` was refused
 * because Factory does not honour that cursor for this session.
 *
 * Journal cursors are opaque, and Factory is free to change their encoding: a
 * Host session's cursor is a `j1.` wrapper bound to the public session and its
 * binding, so a cursor minted before a Factory upgrade (or before the session
 * was re-bound) is answered `400 invalid_request` — "the cursor is not one this
 * session issued; restart the walk". The only correct response is the one the
 * message names: drop the cursor and start the walk again from a position the
 * caller still knows (the tail, the beginning, or a committed sequence).
 *
 * Only meaningful for a read that sent a cursor. Every other parameter this
 * package sends is validated before it leaves, so on such a read
 * `invalid_request` names the cursor.
 */
export function isRejectedJournalCursor(cause: unknown): boolean {
  return cause instanceof CoreInvalidRequestError;
}

export interface ObjectRangeOptions extends RequestOptions {
  start: number;
  end: number;
}

export interface ObjectRange {
  bytes: Uint8Array;
  contentRange: string;
  mediaType: string | undefined;
}

export interface FactoryReads {
  readBootstrap(options?: RequestOptions): Promise<FactoryBootstrap>;
  listAgents(options?: FactoryPageOptions): Promise<DepartmentCapabilitySummary>;
  listRecentSessions(options?: FactoryPageOptions): Promise<RecentSessionPage>;
  readStatus(sessionId: string, options?: RequestOptions): Promise<FactorySessionStatus>;
  readJournal(sessionId: string, options?: FactoryJournalOptions): Promise<PublicJournalPage>;
  listGates(sessionId: string, options?: FactoryPageOptions): Promise<PublicGatePage>;
  readObjectMetadata(sessionId: string, objectId: string, options?: RequestOptions): Promise<ObjectMetadata>;
  readObjectRange(sessionId: string, objectId: string, options: ObjectRangeOptions): Promise<ObjectRange>;
}

export interface FactoryRestOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  credentials?: FactoryRestCredentials;
}

function query(options: FactoryPageOptions & { tail?: number; fromSeq?: number }): string {
  const params = new URLSearchParams();
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  if (options.fromSeq !== undefined) params.set("from_seq", String(options.fromSeq));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.tail !== undefined) params.set("tail", String(options.tail));
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function normalizedBase(baseUrl: string | undefined): string {
  return baseUrl === undefined ? "" : baseUrl.replace(/\/+$/, "");
}

/**
 * The route for one retained session object's bytes; `/metadata` is appended
 * for its descriptor. This module owns the spelling, and exports it because
 * `tool-capture.ts` names the same route in the `RequestAbortedError` it raises
 * around these calls — a second literal there would keep naming the old path
 * for as long as nobody noticed the route had moved.
 */
export function sessionObjectPath(sessionId: string, objectId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/objects/${encodeURIComponent(objectId)}`;
}

export class FactoryRestReads implements FactoryReads {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly credentials: FactoryRestCredentials;

  constructor(options: FactoryRestOptions = {}) {
    // BOUND. A browser's `fetch` is a Window method: stored bare and called
    // as `this.fetchImpl(...)` it runs with this object as its receiver and
    // throws "Illegal invocation" before any request leaves — which the catch
    // below reports as a NetworkError. Node's fetch does not check its
    // receiver, so only a real browser against a real Factory ever saw it.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = normalizedBase(options.baseUrl);
    this.credentials = options.credentials ?? {};
  }

  async readBootstrap(options: RequestOptions = {}): Promise<FactoryBootstrap> {
    const path = "/v1/bootstrap";
    const response = await this.request(path, { method: "GET", cache: "no-store", signal: options.signal });
    if (!response.ok) await this.throwResponseError(path, response);
    const data = await this.parseJSON(path, response);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new MalformedResponseError(path, response.status);
    }
    const keys = Object.keys(data);
    const tenantId = (data as Record<string, unknown>).tenant_id;
    if (keys.length !== 1 || keys[0] !== "tenant_id" || typeof tenantId !== "string"
      || tenantId.length === 0 || new TextEncoder().encode(tenantId).byteLength > 256) {
      throw new MalformedResponseError(path, response.status);
    }
    return { tenant_id: tenantId };
  }

  async listAgents(options: FactoryPageOptions = {}): Promise<DepartmentCapabilitySummary> {
    return validateDepartmentCapabilitySummary(
      await this.getJSON(`/v1/agents${query(options)}`, options.signal),
    );
  }

  async listRecentSessions(options: FactoryPageOptions = {}): Promise<RecentSessionPage> {
    return validateRecentSessionPage(await this.getJSON(`/v1/sessions${query(options)}`, options.signal));
  }

  async readStatus(sessionId: string, options: RequestOptions = {}): Promise<FactorySessionStatus> {
    return validateFactorySessionStatus(
      await this.getJSON(`/v1/sessions/${encodeURIComponent(sessionId)}/status`, options.signal),
    );
  }

  async readJournal(sessionId: string, options: FactoryJournalOptions = {}): Promise<PublicJournalPage> {
    if (options.cursor !== undefined && options.tail !== undefined) {
      throw new RangeError("journal cursor and tail are mutually exclusive");
    }
    if (options.fromSeq !== undefined) {
      if (options.cursor !== undefined || options.tail !== undefined) {
        throw new RangeError("journal fromSeq is mutually exclusive with cursor and tail");
      }
      if (!Number.isSafeInteger(options.fromSeq) || options.fromSeq < 0) {
        throw new RangeError("journal fromSeq must be a non-negative safe integer");
      }
    }
    return validatePublicJournalPage(
      await this.getJSON(`/v1/sessions/${encodeURIComponent(sessionId)}/journal${query(options)}`, options.signal),
    );
  }

  async listGates(sessionId: string, options: FactoryPageOptions = {}): Promise<PublicGatePage> {
    return validatePublicGatePage(
      await this.getJSON(`/v1/sessions/${encodeURIComponent(sessionId)}/gates${query(options)}`, options.signal),
    );
  }

  async readObjectMetadata(
    sessionId: string,
    objectId: string,
    options: RequestOptions = {},
  ): Promise<ObjectMetadata> {
    const path = `${sessionObjectPath(sessionId, objectId)}/metadata`;
    return validateObjectMetadata(await this.getJSON(path, options.signal));
  }

  async readObjectRange(sessionId: string, objectId: string, options: ObjectRangeOptions): Promise<ObjectRange> {
    // The inclusive range IS the response bound: there is exactly one legal
    // byte count for a `start`/`end` pair, so it is derived here rather than
    // accepted from the caller, who could only restate what it just passed.
    const maximumBytes = options.end - options.start + 1;
    if (!Number.isSafeInteger(options.start) || !Number.isSafeInteger(options.end)
      || options.start < 0 || options.end < options.start
      || !Number.isSafeInteger(maximumBytes)) {
      throw new RangeError("object range must be an inclusive positive safe-integer byte range");
    }
    const path = sessionObjectPath(sessionId, objectId);
    const response = await this.request(path, {
      method: "GET",
      signal: options.signal,
      headers: { Range: `bytes=${options.start}-${options.end}` },
    });
    if (!response.ok) await this.throwResponseError(path, response);
    const contentRange = response.headers.get("Content-Range");
    if (response.status !== 206 || contentRange === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new MalformedResponseError(path, response.status);
    }
    const expectedContentRangePrefix = `bytes ${options.start}-${options.end}/`;
    const completeLength = contentRange.slice(expectedContentRangePrefix.length);
    if (!contentRange.startsWith(expectedContentRangePrefix) || !/^(?:\d+|\*)$/.test(completeLength)) {
      await response.body?.cancel().catch(() => undefined);
      throw new MalformedResponseError(path, response.status);
    }
    const contentLength = response.headers.get("Content-Length");
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== maximumBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new MalformedResponseError(path, response.status);
    }
    return {
      bytes: await this.readBoundedBody(path, response, maximumBytes, options.signal),
      contentRange,
      mediaType: response.headers.get("Content-Type") ?? undefined,
    };
  }

  private async readBoundedBody(
    path: string,
    response: Response,
    maximumBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    if (response.body === null) throw new MalformedResponseError(path, response.status);
    let byobReader: ReadableStreamBYOBReader | undefined;
    let defaultReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Fetch byte streams in the supported Node and Chromium targets expose a
    // BYOB reader, so the transport requests no more than the exact remaining
    // capacity. A custom/polyfilled default stream may deliver one chunk
    // atomically before its size is observable; that fallback rejects before
    // copying any oversized chunk and cancels without making another read.
    try {
      byobReader = response.body.getReader({ mode: "byob" });
    } catch (cause) {
      if (!(cause instanceof TypeError)) throw cause;
      defaultReader = response.body.getReader();
    }
    const reader = byobReader ?? defaultReader!;
    let bytes = new Uint8Array(maximumBytes);
    let total = 0;
    let cancellation: Promise<void> | undefined;
    const cancel = (): Promise<void> => {
      cancellation ??= reader.cancel().catch(() => {
        // Preserve the primary protocol/cancellation/read error.
      });
      return cancellation;
    };
    const abort = (): void => { void cancel(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new RequestAbortedError(path);
      while (true) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try {
          if (byobReader === undefined) {
            part = await defaultReader!.read();
          } else {
            const byobPart = await byobReader.read(bytes.subarray(total));
            if (byobPart.done) {
              part = { done: true, value: undefined };
            } else {
              const value = new Uint8Array(
                byobPart.value.buffer,
                byobPart.value.byteOffset,
                byobPart.value.byteLength,
              );
              bytes = new Uint8Array(byobPart.value.buffer);
              part = { done: false, value };
            }
          }
        } catch (cause) {
          if (signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
            throw new RequestAbortedError(path, { cause });
          }
          throw new NetworkError(path, { cause });
        }
        if (signal?.aborted) throw new RequestAbortedError(path);
        if (part.done) throw new MalformedResponseError(path, response.status);
        if (part.value.byteLength > maximumBytes - total) {
          throw new MalformedResponseError(path, response.status);
        }
        if (byobReader === undefined) bytes.set(part.value, total);
        total += part.value.byteLength;
        if (total === maximumBytes) return bytes;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      await cancel();
      reader.releaseLock();
    }
  }

  private async getJSON(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(path, { method: "GET", signal });
    if (!response.ok) await this.throwResponseError(path, response);
    return this.parseJSON(path, response);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(await this.credentials.restHeaders?.() ?? {})) {
      headers.set(name, value);
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      if (init.signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw new RequestAbortedError(path, { cause });
      }
      throw new NetworkError(path, { cause });
    }
  }

  private async parseJSON(path: string, response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new MalformedResponseError(path, response.status, { cause });
    }
  }

  private async throwResponseError(path: string, response: Response): Promise<never> {
    const data = await this.parseJSON(path, response);
    throw errorFromCoreEnvelope(validateCoreErrorEnvelope(data));
  }
}
