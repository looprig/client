/**
 * Unit coverage for the typed-error taxonomy in src/errors.ts.
 *
 * Each of the five error fixtures (contract/fixtures/error_{400,404,409,500,503}.json)
 * is run through `errorFromResponse` and asserted to produce the matching
 * dedicated subclass with `code`/`message`/`retryable`/`status` all preserved.
 * A forward-compatibility case proves an unrecognized `code` (one of the five
 * schema-enum codes with no fixture, plus a genuinely novel string a future
 * server might send) falls back to UnknownLooprigError instead of throwing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";
import {
  CSRFRejectedError,
  errorFromResponse,
  GateCapacityError,
  IdempotencyConflictError,
  InternalServerError,
  InvalidBodyError,
  LooprigError,
  OriginNotAllowedError,
  SessionNotFoundError,
  ToolCaptureError,
  ToolCaptureIntegrityError,
  ToolCaptureTooLargeError,
  ToolCaptureUnavailableError,
  UnknownLooprigError,
} from "../src/errors.js";
import { validateBFFErrorResponse, validateErrorResponse } from "../src/validate.js";
import type { BFFErrorResponse, ErrorResponse } from "../src/types.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixture(file: string): ErrorResponse {
  const raw = JSON.parse(readFileSync(fixtureDir + file, "utf8"));
  return validateErrorResponse(raw);
}

describe("errorFromResponse maps fixture-backed codes to dedicated subclasses", () => {
  const cases: Array<{
    file: string;
    status: number;
    code: string;
    retryable: boolean;
    ctor: new (status: number, body: ErrorResponse) => LooprigError;
  }> = [
    { file: "error_400.json", status: 400, code: "invalid_body", retryable: false, ctor: InvalidBodyError },
    { file: "error_404.json", status: 404, code: "session_not_found", retryable: false, ctor: SessionNotFoundError },
    {
      file: "error_409.json",
      status: 409,
      code: "idempotency_conflict",
      retryable: false,
      ctor: IdempotencyConflictError,
    },
    { file: "error_500.json", status: 500, code: "internal", retryable: false, ctor: InternalServerError },
    { file: "error_503.json", status: 503, code: "gate_capacity", retryable: true, ctor: GateCapacityError },
  ];

  for (const { file, status, code, retryable, ctor } of cases) {
    it(`${file} (HTTP ${status}) produces a ${ctor.name} with code "${code}"`, () => {
      const body = readFixture(file);
      const err = errorFromResponse(status, body);

      expect(err).toBeInstanceOf(ctor);
      expect(err).toBeInstanceOf(LooprigError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
      expect(err.status).toBe(status);
      expect(err.message).toBe(body.error.message);
      expect(err.body).toEqual(body);
      expect(err.name).toBe(ctor.name);
    });
  }
});

describe("errorFromResponse maps the two BFF-local codes to dedicated, mutually-distinguishable subclasses", () => {
  // These two codes have no contract/fixtures/ counterpart (they're
  // internal/bff-local — see schema.ts's bffErrorResponseSchema doc — never
  // emitted by serve), so this constructs BFFErrorResponse values by hand
  // and validates them through validateBFFErrorResponse (the wider
  // validator HostTransport's request plumbing actually uses), rather than
  // reading a fixture file the way the fixture-backed cases above do.
  it("csrf_invalid produces a CSRFRejectedError with retryable: true", () => {
    const raw = { error: { code: "csrf_invalid", message: "missing or invalid CSRF token", retryable: true } };
    const body: BFFErrorResponse = validateBFFErrorResponse(raw);

    const err = errorFromResponse(403, body);

    expect(err).toBeInstanceOf(CSRFRejectedError);
    expect(err).toBeInstanceOf(LooprigError);
    expect(err).not.toBeInstanceOf(OriginNotAllowedError);
    expect(err.code).toBe("csrf_invalid");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(403);
  });

  it("origin_not_allowed produces an OriginNotAllowedError with retryable: false", () => {
    const raw = { error: { code: "origin_not_allowed", message: "origin not allowed", retryable: false } };
    const body: BFFErrorResponse = validateBFFErrorResponse(raw);

    const err = errorFromResponse(403, body);

    expect(err).toBeInstanceOf(OriginNotAllowedError);
    expect(err).toBeInstanceOf(LooprigError);
    expect(err).not.toBeInstanceOf(CSRFRejectedError);
    expect(err.code).toBe("origin_not_allowed");
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(403);
  });

  it("validateBFFErrorResponse rejects a code neither serve nor the BFF's own middleware ever emits", () => {
    expect(() =>
      validateBFFErrorResponse({ error: { code: "not_a_real_code", message: "x", retryable: false } }),
    ).toThrow();
  });
});

describe("errorFromResponse forward compatibility", () => {
  it("falls back to UnknownLooprigError for a schema-enum code with no dedicated subclass", () => {
    // invalid_parameter is a real code in error_response.schema.json's enum,
    // but no fixture exercises it, so errors.ts deliberately has no dedicated
    // subclass for it (see the module comment).
    const body: ErrorResponse = {
      error: { code: "invalid_parameter", message: "bad query parameter", retryable: false },
    };

    const err = errorFromResponse(400, body);

    expect(err).toBeInstanceOf(UnknownLooprigError);
    expect(err).toBeInstanceOf(LooprigError);
    expect(err.code).toBe("invalid_parameter");
    expect(err.message).toBe("bad query parameter");
  });

  it("does not throw for a code string this client build has never seen", () => {
    // Simulates a future server version introducing a new error code. The
    // real ajv-validated path (validate.ts) would reject this at the schema
    // boundary before it got here — this test exercises errorFromResponse in
    // isolation to prove it, specifically, degrades gracefully rather than
    // crashing if ever handed a code outside the current enum.
    const body = {
      error: { code: "some_future_code", message: "a code this client predates", retryable: true },
    } as unknown as ErrorResponse;

    expect(() => errorFromResponse(400, body)).not.toThrow();
    const err = errorFromResponse(400, body);
    expect(err).toBeInstanceOf(UnknownLooprigError);
    expect(err).toBeInstanceOf(LooprigError);
    expect(err.code).toBe("some_future_code");
    expect(err.retryable).toBe(true);
  });
});

describe("the retained-tool-capture read errors are one catchable family without losing their identities", () => {
  // The membership list is DERIVED from the barrel, not typed out here: a
  // guard that names its own subjects cannot fail for a subject that did not
  // exist when it was written, and the whole point of the base class is the
  // FOURTH capture error someone adds later. The base is excluded by the
  // pattern alone — `.+` requires at least one character between `ToolCapture`
  // and `Error`, so `ToolCaptureError` does not match — and that is the sole
  // excluder; an identity comparison beside it would never decide anything.
  const family = Object.entries(protocol).filter(
    ([name, value]) => /^ToolCapture.+Error$/.test(name) && typeof value === "function",
  ) as Array<[string, new () => Error]>;

  it("covers every exported capture error, and is not vacuous", () => {
    expect(family.map(([name]) => name).sort()).toStrictEqual([
      "ToolCaptureIntegrityError",
      "ToolCaptureTooLargeError",
      "ToolCaptureUnavailableError",
    ]);
  });

  it.each(family)("%s is catchable as ToolCaptureError and as Error, but is not a LooprigError", (_name, ctor) => {
    const err = new ctor();
    expect(err).toBeInstanceOf(ToolCaptureError);
    expect(err).toBeInstanceOf(Error);
    // These are decided client-side and carry no server error envelope, so
    // `LooprigError`'s `code`/`retryable`/`status`/`body` would all be lies.
    expect(err).not.toBeInstanceOf(LooprigError);
    expect(err.message).not.toBe("");
  });

  it("keeps the three mutually distinguishable, which is what the shared base must not cost", () => {
    // `ToolCaptureUnavailableError` was split out of `ToolCaptureIntegrityError`
    // precisely so a missing object is not read as untrusted bytes; a base class
    // that collapsed that discrimination would undo the split.
    expect(new ToolCaptureUnavailableError()).not.toBeInstanceOf(ToolCaptureIntegrityError);
    expect(new ToolCaptureIntegrityError()).not.toBeInstanceOf(ToolCaptureUnavailableError);
    expect(new ToolCaptureTooLargeError()).not.toBeInstanceOf(ToolCaptureIntegrityError);
    expect(new ToolCaptureIntegrityError()).not.toBeInstanceOf(ToolCaptureTooLargeError);
    expect(new ToolCaptureUnavailableError()).not.toBeInstanceOf(ToolCaptureTooLargeError);
    expect(new ToolCaptureTooLargeError()).not.toBeInstanceOf(ToolCaptureUnavailableError);
  });
});
