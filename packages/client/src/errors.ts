/** Factory protocol and client-side request errors. */
import type { CoreErrorEnvelope } from "./types.js";

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
 * Base class for every failure of an explicit retained-tool-result read.
 *
 * It extends `Error` rather than `CoreProtocolError` because none of these carry a
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
