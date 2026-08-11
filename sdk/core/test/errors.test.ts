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
  // validator BFFTransport's request plumbing actually uses), rather than
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
