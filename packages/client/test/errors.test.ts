import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";
import { CoreProtocolError, CoreSessionNotFoundError, errorFromCoreEnvelope,
  ToolCaptureError, ToolCaptureIntegrityError, ToolCaptureTooLargeError, ToolCaptureUnavailableError } from "../src/errors.js";
import { validateCoreErrorEnvelope } from "../src/validate.js";

describe("Core error envelopes", () => {
  it("maps the published Core fixture without changing its body", () => {
    const body = validateCoreErrorEnvelope(JSON.parse(readFileSync(new URL("../../../contract/fixtures/error_envelope.json", import.meta.url), "utf8")));
    const error = errorFromCoreEnvelope(body);
    expect(error).toBeInstanceOf(CoreProtocolError);
    expect(error.body).toBe(body);
    expect(error.code).toBe(body.error.code);
    expect(error.message).toBe(body.error.message);
    expect(error.retryable).toBe(body.error.retryable);
  });
  it("maps known codes and preserves forward-compatible codes", () => {
    const known = errorFromCoreEnvelope(validateCoreErrorEnvelope({error: {code: "session_not_found", message: "missing", retryable: false}}));
    expect(known).toBeInstanceOf(CoreSessionNotFoundError);
    const unknown = errorFromCoreEnvelope(validateCoreErrorEnvelope({error: {code: "future_code", message: "future", retryable: true}}));
    expect(unknown.constructor).toBe(CoreProtocolError);
    expect(unknown.code).toBe("future_code");
    expect(unknown.retryable).toBe(true);
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

  it.each(family)("%s is catchable as ToolCaptureError and as Error, but is not a CoreProtocolError", (_name, ctor) => {
    const err = new ctor();
    expect(err).toBeInstanceOf(ToolCaptureError);
    expect(err).toBeInstanceOf(Error);
    // These are decided client-side and carry no server error envelope, so
    // `CoreProtocolError`'s `code`/`retryable`/`status`/`body` would all be lies.
    expect(err).not.toBeInstanceOf(CoreProtocolError);
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
