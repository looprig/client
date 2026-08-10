/**
 * Typed error hierarchy mirroring harness's stable HTTP error envelope
 * (`contract/schema/error_response.schema.json`): `{ "error": { code, message,
 * retryable } }`. `code` is the stable, machine-readable field the schema
 * documents callers should switch on ("Stable machine-readable code a client
 * can switch on.") — never parse `message` text, it is generic/client-safe
 * prose, not a contract.
 *
 * Every error mirrored here comes from a fixture: `contract/fixtures/
 * error_400.json` (invalid_body), `error_404.json` (session_not_found),
 * `error_409.json` (idempotency_conflict), `error_500.json` (internal), and
 * `error_503.json` (gate_capacity) are the ONLY five codes the fixtures give
 * evidence for, so those are the only ones with a dedicated subclass below.
 * The schema's `code` enum lists five more (invalid_parameter, gate_not_found,
 * gate_action_invalid, gate_kind_mismatch, gate_not_ready) with no fixture —
 * deliberately not invented a taxonomy for those; they (and any future code a
 * newer server adds that this client doesn't know about yet) fall back to
 * UnknownLooprigError, which still carries the real `code` string untyped so a
 * caller can still branch on it, just without a dedicated class.
 */
import type { ErrorResponse } from "./types.js";

/** The `error.code` field's type, derived from the same schema every other DTO is. */
export type ErrorCode = ErrorResponse["error"]["code"];

/**
 * Base class for every typed error derived from a server-sent error envelope.
 * Carries the fields a caller needs to react programmatically: `code` (switch
 * on this, not `message`), `retryable` (whether the identical request may be
 * retried as-is), `status` (the HTTP status actually observed), and `body`
 * (the full validated envelope, for callers that want more).
 */
export abstract class LooprigError extends Error {
  abstract readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly body: ErrorResponse;

  protected constructor(status: number, body: ErrorResponse) {
    super(body.error.message);
    this.status = status;
    this.retryable = body.error.retryable;
    this.body = body;
    // Every concrete subclass below sets `name` to its own class name via
    // `new.target`, so `err.name` and `err.constructor.name` agree even after
    // minification renames the class identifier used in source.
    this.name = new.target.name;
  }
}

/** 400: the request body failed server-side validation. */
export class InvalidBodyError extends LooprigError {
  readonly code = "invalid_body" as const;
  constructor(status: number, body: ErrorResponse) {
    super(status, body);
  }
}

/** 404: no session exists for the requested id. */
export class SessionNotFoundError extends LooprigError {
  readonly code = "session_not_found" as const;
  constructor(status: number, body: ErrorResponse) {
    super(status, body);
  }
}

/** 409: an idempotency key was reused with a different request body. */
export class IdempotencyConflictError extends LooprigError {
  readonly code = "idempotency_conflict" as const;
  constructor(status: number, body: ErrorResponse) {
    super(status, body);
  }
}

/** 500: an unclassified server-side failure. */
export class InternalServerError extends LooprigError {
  readonly code = "internal" as const;
  constructor(status: number, body: ErrorResponse) {
    super(status, body);
  }
}

/** 503: the gate subsystem is at capacity; retryable per the envelope. */
export class GateCapacityError extends LooprigError {
  readonly code = "gate_capacity" as const;
  constructor(status: number, body: ErrorResponse) {
    super(status, body);
  }
}

/**
 * Fallback for any `code` without a dedicated subclass above — either one of
 * the five schema-enum codes no fixture exercises yet, or (forward
 * compatibility) a code a future server version introduces that this client
 * build doesn't recognize. Never throws on an unrecognized code; always
 * produces a typed, inspectable value instead.
 */
export class UnknownLooprigError extends LooprigError {
  readonly code: ErrorCode;
  constructor(status: number, body: ErrorResponse) {
    super(status, body);
    this.code = body.error.code;
  }
}

/**
 * Parses a decoded, schema-validated `ErrorResponse` (see
 * `validateErrorResponse` in validate.ts — callers MUST validate the raw body
 * before calling this; it does not re-validate) plus the HTTP status it
 * arrived with into the matching typed error. Exhaustive over the five
 * fixture-backed codes; every other code (known-but-unmodeled or genuinely
 * unknown) maps to UnknownLooprigError rather than throwing.
 */
export function errorFromResponse(status: number, body: ErrorResponse): LooprigError {
  switch (body.error.code) {
    case "invalid_body":
      return new InvalidBodyError(status, body);
    case "session_not_found":
      return new SessionNotFoundError(status, body);
    case "idempotency_conflict":
      return new IdempotencyConflictError(status, body);
    case "internal":
      return new InternalServerError(status, body);
    case "gate_capacity":
      return new GateCapacityError(status, body);
    default:
      return new UnknownLooprigError(status, body);
  }
}

/**
 * Thrown when a transport request is cancelled via its `AbortSignal` — either
 * because the signal was already aborted before the request started, or it
 * fired mid-flight. Distinguishable from NetworkError (below) so a caller
 * doesn't have to guess whether "the promise rejected" means "I cancelled
 * this" versus "the network really failed."
 */
export class RequestAbortedError extends Error {
  readonly path: string;

  constructor(path: string, options?: { cause?: unknown }) {
    super(`request aborted: ${path}`, options);
    this.name = "RequestAbortedError";
    this.path = path;
  }
}

/**
 * Thrown when `fetch()` itself rejects for a reason other than abort (DNS
 * failure, connection refused, CORS rejection, etc.) — i.e. no HTTP response
 * was ever received to decode an ErrorResponse envelope from.
 */
export class NetworkError extends Error {
  readonly path: string;

  constructor(path: string, options?: { cause?: unknown }) {
    super(`network error: ${path}`, options);
    this.name = "NetworkError";
    this.path = path;
  }
}

/**
 * Thrown when an HTTP response was received but its body is not valid JSON at
 * all (a lower-level failure than ContractValidationError in validate.ts,
 * which handles JSON that parses but doesn't match the expected schema).
 */
export class MalformedResponseError extends Error {
  readonly path: string;
  readonly status: number;

  constructor(path: string, status: number, options?: { cause?: unknown }) {
    super(`malformed response body (status ${status}): ${path}`, options);
    this.name = "MalformedResponseError";
    this.path = path;
    this.status = status;
  }
}

/**
 * Thrown by a live SSE connection (live.ts's `FetchLiveFrameSource`) when the
 * initial HTTP response itself is unusable as an event stream — a non-2xx
 * status, or a 2xx response with no readable body. This is distinct from a
 * mid-stream framing failure (sse.ts's `SseFrameError`, yielded in-band as an
 * `ErrorSseFrame` rather than thrown, since the connection is still alive and
 * subsequent frames may still be fine) and from `NetworkError` (fetch()
 * itself never got a response at all, e.g. DNS/connection failure) — this
 * error means a response WAS received, it's just not a stream this client can
 * consume.
 */
export class LiveConnectionError extends Error {
  readonly status: number | undefined;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LiveConnectionError";
    this.status = options?.status;
  }
}
