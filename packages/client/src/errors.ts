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
import type { BFFErrorResponse, CoreErrorEnvelope, ErrorResponse } from "./types.js";

export class CoreProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly body: CoreErrorEnvelope;

  constructor(body: CoreErrorEnvelope) {
    super(body.error.message ?? body.error.code);
    this.name = new.target.name;
    this.code = body.error.code;
    this.retryable = body.error.retryable;
    this.body = body;
  }
}

export class CoreInvalidRequestError extends CoreProtocolError {}
export class CoreUnsupportedVersionError extends CoreProtocolError {}
export class CoreSessionNotFoundError extends CoreProtocolError {}
export class CoreCommandRejectedError extends CoreProtocolError {}
export class CoreGateResolvedError extends CoreProtocolError {}
export class CoreGateNotResumableError extends CoreProtocolError {}
export class CoreGateExpiredError extends CoreProtocolError {}
export class CoreGateResponseInvalidError extends CoreProtocolError {}
export class CoreRuntimeUnavailableError extends CoreProtocolError {}

export function errorFromCoreEnvelope(body: CoreErrorEnvelope): CoreProtocolError {
  switch (body.error.code) {
    case "invalid_request": return new CoreInvalidRequestError(body);
    case "unsupported_version": return new CoreUnsupportedVersionError(body);
    case "session_not_found": return new CoreSessionNotFoundError(body);
    case "command_rejected": return new CoreCommandRejectedError(body);
    case "gate_resolved": return new CoreGateResolvedError(body);
    case "gate_not_resumable": return new CoreGateNotResumableError(body);
    case "gate_expired": return new CoreGateExpiredError(body);
    case "gate_response_invalid": return new CoreGateResponseInvalidError(body);
    case "runtime_unavailable": return new CoreRuntimeUnavailableError(body);
    default: return new CoreProtocolError(body);
  }
}

/** A Centrifuge failure translated into an SDK-independent public error. */
export class RealtimeTransportError extends Error {
  readonly transportCode: number | undefined;

  constructor(message: string, transportCode?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RealtimeTransportError";
    this.transportCode = transportCode;
  }
}

/**
 * The `error.code` field's type. Widened beyond `ErrorResponse["error"]["code"]`
 * (the vendored serve schema's enum) to also cover the two BFF-local codes
 * `internal/bff/guard.go` and `internal/bff/csrf.go` mint before a request
 * ever reaches serve — see `schema.ts`'s `bffErrorResponseSchema` doc.
 * ServeTransport (which talks directly to serve, bypassing the BFF) can
 * never actually observe either of these two; only HostTransport can.
 */
export type ErrorCode = ErrorResponse["error"]["code"] | "csrf_invalid" | "origin_not_allowed";

/**
 * Base class for every typed error derived from a server-sent error envelope.
 * Carries the fields a caller needs to react programmatically: `code` (switch
 * on this, not `message`), `retryable` (whether the identical request may be
 * retried as-is), `status` (the HTTP status actually observed), and `body`
 * (the full validated envelope, for callers that want more). `body` is typed
 * `BFFErrorResponse` (the wider, client-owned shape) rather than the
 * narrower vendored `ErrorResponse`, since any subclass here — including the
 * two BFF-local ones below — may need to carry one; `ErrorResponse` is
 * structurally assignable to `BFFErrorResponse`, so every existing call site
 * passing a validated `ErrorResponse` still type-checks unchanged.
 */
export abstract class LooprigError extends Error {
  abstract readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly body: BFFErrorResponse;

  protected constructor(status: number, body: BFFErrorResponse) {
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
  constructor(status: number, body: BFFErrorResponse) {
    super(status, body);
  }
}

/** 404: no session exists for the requested id. */
export class SessionNotFoundError extends LooprigError {
  readonly code = "session_not_found" as const;
  constructor(status: number, body: BFFErrorResponse) {
    super(status, body);
  }
}

/** 409: an idempotency key was reused with a different request body. */
export class IdempotencyConflictError extends LooprigError {
  readonly code = "idempotency_conflict" as const;
  constructor(status: number, body: BFFErrorResponse) {
    super(status, body);
  }
}

/** 500: an unclassified server-side failure. */
export class InternalServerError extends LooprigError {
  readonly code = "internal" as const;
  constructor(status: number, body: BFFErrorResponse) {
    super(status, body);
  }
}

/** 503: the gate subsystem is at capacity; retryable per the envelope. */
export class GateCapacityError extends LooprigError {
  readonly code = "gate_capacity" as const;
  constructor(status: number, body: BFFErrorResponse) {
    super(status, body);
  }
}

/**
 * 403, BFF-local: `internal/bff/csrf.go`'s `CSRFGuard.Wrap` rejected a
 * control-plane request for a missing, unknown, or expired CSRF token —
 * `retryable: true` on the wire (see csrf.go's Wrap doc), meaning the
 * recovery path (clear the cached token, mint a fresh one, retry the
 * identical request once) is expected and safe. `HostTransport`'s request
 * plumbing (transport.ts) does exactly that automatically; a caller using
 * this class directly should follow the same one-retry-then-give-up
 * discipline rather than looping.
 */
export class CSRFRejectedError extends LooprigError {
  readonly code = "csrf_invalid" as const;
  constructor(status: number, body: BFFErrorResponse) {
    super(status, body);
  }
}

/**
 * 403, BFF-local: `internal/bff/guard.go`'s `HostOriginGuard.Wrap` rejected a
 * request because its Host and/or Origin header didn't name an allowed
 * host, or didn't exactly match this request's own Host (see guard.go's
 * `originAllowed` doc for the port-exactness fix this maps to).
 * `retryable: false` on the wire — deliberately distinct from
 * `CSRFRejectedError`'s `true`: retrying an identical request against the
 * identical (rejected) origin can never succeed, so a caller (and
 * `HostTransport`'s automatic retry logic) must NOT retry on this code.
 */
export class OriginNotAllowedError extends LooprigError {
  readonly code = "origin_not_allowed" as const;
  constructor(status: number, body: BFFErrorResponse) {
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
  constructor(status: number, body: BFFErrorResponse) {
    super(status, body);
    this.code = body.error.code;
  }
}

/**
 * Parses a decoded, schema-validated `BFFErrorResponse` (see
 * `validateBFFErrorResponse` in validate.ts for `HostTransport`'s callers, or
 * `validateErrorResponse` — a structurally-compatible narrower validator —
 * for `ServeTransport`'s; callers MUST validate the raw body before calling
 * this, it does not re-validate) plus the HTTP status it arrived with into
 * the matching typed error. Exhaustive over the five fixture-backed serve
 * codes plus the two BFF-local codes; every other code (known-but-unmodeled
 * or genuinely unknown) maps to UnknownLooprigError rather than throwing.
 */
export function errorFromResponse(status: number, body: BFFErrorResponse): LooprigError {
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
    case "csrf_invalid":
      return new CSRFRejectedError(status, body);
    case "origin_not_allowed":
      return new OriginNotAllowedError(status, body);
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

/**
 * Base class for every failure of an explicit retained-tool-result read.
 *
 * It extends `Error` rather than `LooprigError` because none of these carry a
 * server error envelope — like `RequestAbortedError`, `NetworkError` and
 * `MalformedResponseError`, they are decided client-side. It exists so a UI
 * can catch "the capture read failed" as a family; without it a handler must
 * name all three subclasses and a fourth added later would silently escape
 * every such handler. The subclasses stay separately catchable: this is an
 * ADDITIONAL discrimination, not a replacement for `instanceof` on them.
 */
export abstract class ToolCaptureError extends Error {}

/**
 * Thrown when a retained tool result is LARGER than the ceiling the caller
 * declared for this read. An explicit refusal before any object I/O, not a
 * failure of the object.
 */
export class ToolCaptureTooLargeError extends ToolCaptureError {
  constructor() {
    super("retained tool result exceeds the requested read ceiling");
    this.name = "ToolCaptureTooLargeError";
  }
}

/**
 * Thrown when a retained tool result's metadata or bytes do not verify: a
 * descriptor bound to a different object, a size disagreeing with the capture,
 * an unusable digest, a `Content-Range` that does not bind the requested page,
 * a short page, or a whole-object digest mismatch.
 *
 * It means the bytes could not be TRUSTED, which is distinct from there being
 * no object to read — see `ToolCaptureUnavailableError`, which was split out
 * of this class precisely because one shared class made a missing-object guard
 * indistinguishable from the check that would have caught its absence one
 * request later.
 */
export class ToolCaptureIntegrityError extends ToolCaptureError {
  constructor() {
    super("retained tool result failed integrity verification");
    this.name = "ToolCaptureIntegrityError";
  }
}

/**
 * Thrown when a tool-result capture retained no object at all, so there is
 * nothing to read. The fold genuinely produces such captures (a `StepDone`
 * capture entry carrying no `reference`). This is an ABSENCE precondition,
 * checked before any request is issued, and deliberately not an integrity
 * failure.
 */
export class ToolCaptureUnavailableError extends ToolCaptureError {
  constructor() {
    super("tool result has no retained object");
    this.name = "ToolCaptureUnavailableError";
  }
}
