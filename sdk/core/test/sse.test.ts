/**
 * Coverage for the SSE line-parser (src/sse.ts) against the golden SSE
 * fixtures (`contract/fixtures/*.sse`) and against synthetic chunk-boundary
 * splits of those same bytes.
 *
 * The chunk-splitting tests are the point of this file (see sse.ts's module
 * comment: "a naive line parser will corrupt the stream" is a real bug
 * class). They don't just try one arbitrarily-chosen split point — every
 * fixture-derived byte buffer used here is fed to the parser split at EVERY
 * possible single-cut offset, and additionally one byte at a time, and the
 * result is asserted identical to parsing the same bytes as one whole chunk
 * every time.
 *
 * ## A pre-existing contract bug this parser surfaces for the first time
 *
 * Building a REAL ajv validator over `contract/fixtures/ephemeral_token_delta.sse`
 * (rather than the shallow, non-$ref, top-level-only structural check
 * harness's own `pkg/serve/schema_test.go`'s `TestFixturesMatchSchemaShape`
 * does — see that function's own doc comment: "NOT full JSON-Schema
 * validation (no type or $ref checking)") exposes a genuine, pre-existing
 * bug in the vendored contract, not a bug in this parser:
 *
 *   `contract/schema/ephemeral_frame.schema.json`'s `header` property is
 *   `{ "$ref": "event_envelope.schema.json" }`, which `required`s `type`
 *   and `v`. But the actual wire encoder
 *   (`harness/pkg/serve/ephemeral.go`'s `ephemeralFrame.Header` field) is
 *   typed `event.Header` (`harness/pkg/event/event.go`) and marshaled
 *   directly with NO custom `MarshalJSON` — and `event.Header` has NEITHER
 *   a `type` NOR a `v` field, ever. Every real `ephemeral` SSE frame stamps
 *   a non-empty `Header` (`Coordinates.SessionID` is set on every event, so
 *   `header,omitzero` never actually omits it), so THIS BUG REJECTS EVERY
 *   REAL EPHEMERAL FRAME a running server ever sends, not just this one
 *   fixture's `token_delta` kind.
 *
 * This is out of scope for this task to fix: `contract/schema/` is a
 * verbatim copy of `harness/pkg/serve/testdata/schema/` (see this repo's
 * root `Makefile`'s `contract` target) — the actual fix belongs in harness
 * (either a dedicated header schema matching `event.Header`'s real shape,
 * or dropping `required: ["type","v"]` for this reuse), followed by
 * re-vendoring here. The tests below document the bug precisely (so it
 * doesn't regress further or get "fixed" by accident without noticing) and
 * additionally exercise the SAME parser logic against a hand-built,
 * schema-CONFORMANT ephemeral frame so the parser's happy path for
 * `ephemeral` frames is still proven correct independent of this fixture's
 * bug — see `validEphemeralBytes` below.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SseFrameError, SseFrameParser, type SseFrame } from "../src/sse.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixtureBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(fixtureDir + file));
}

const enduringBytes = readFixtureBytes("enduring_frame.sse");
/** The real, currently-vendored golden fixture. See the module comment: this fails ajv validation due to a pre-existing contract bug, unrelated to this parser. */
const ephemeralFixtureBytes = readFixtureBytes("ephemeral_token_delta.sse");

const enduringExpectedData = {
  v: 1,
  event: {
    created_at: "2026-07-08T12:00:00Z",
    event_id: "00000000-0000-0000-0000-000000000000",
    loop_id: "00000000-0000-0000-0000-000000000000",
    session_id: "00000000-0000-0000-0000-000000000000",
    turn_id: "00000000-0000-0000-0000-000000000000",
    turn_index: 1,
    type: "TurnDone",
    v: 1,
  },
};

/**
 * A hand-built, schema-CONFORMANT `ephemeral` frame, used everywhere this
 * suite needs "a real, valid ephemeral frame" for framing/chunk-boundary
 * robustness (as opposed to specifically exercising the header bug
 * documented above). `kind: "input_queued"` legitimately omits both
 * `header` and `delta` per `ephemeral_frame.schema.json` ("delta is absent
 * for input_queued"; `header` is optional in the schema even though a real
 * server always sends one) — so this is valid wire content, not a
 * fabricated shape the real server could never produce.
 */
const validEphemeralBytes = new TextEncoder().encode('event: ephemeral\ndata: {"v":1,"kind":"input_queued"}\n\n');
const validEphemeralExpectedData = { v: 1, kind: "input_queued" };

/** Runs a full byte buffer through a fresh parser, split into the given chunk sizes (which must sum to buffer.length), and returns every frame produced (feed() results plus finish()'s). */
function parseChunks(bytes: Uint8Array, chunkBoundaries: number[]): SseFrame[] {
  const parser = new SseFrameParser();
  const frames: SseFrame[] = [];
  let start = 0;
  for (const end of chunkBoundaries) {
    frames.push(...parser.feed(bytes.slice(start, end)));
    start = end;
  }
  frames.push(...parser.finish());
  return frames;
}

/** Parses `bytes` as one single chunk. */
function parseWhole(bytes: Uint8Array): SseFrame[] {
  return parseChunks(bytes, [bytes.length]);
}

/** Deep-comparable projection of a frame: SseFrameError instances aren't structurally comparable via toEqual out of the box (Error subclasses + `cause`), so error frames are reduced to their message/raw/cause-message. */
function normalize(frames: SseFrame[]): unknown[] {
  return frames.map((f) => {
    if (f.type === "error") {
      const cause = f.error.cause;
      return {
        type: "error",
        message: f.error.message,
        raw: f.error.raw,
        causeMessage: cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause),
      };
    }
    return f;
  });
}

// --- 1. Golden fixtures, fed as one chunk -----------------------------------

describe("golden fixtures parsed as a single chunk", () => {
  it("parses enduring_frame.sse: correct journal_seq and ajv-validated payload", () => {
    const frames = parseWhole(enduringBytes);
    expect(frames).toEqual([{ type: "enduring", journalSeq: 42, data: enduringExpectedData }]);
  });

  it("KNOWN CONTRACT BUG: ephemeral_token_delta.sse is recognized as an ephemeral frame (no seq) but its payload fails ajv validation, because the fixture's header does not (and per event.Header's real shape, cannot) satisfy event_envelope.schema.json's required type+v — see this file's module comment", () => {
    const frames = parseWhole(ephemeralFixtureBytes);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.type).toBe("error"); // NOT "ephemeral" — this is the bug, not a parser defect
    const err = (frame as Extract<SseFrame, { type: "error" }>).error;
    expect(err).toBeInstanceOf(SseFrameError);
    expect(err.message).toMatch(/schema validation/);
    expect(err.cause).toMatchObject({
      name: "ContractValidationError",
      schemaName: "ephemeral_frame",
    });
    // The raw block is still preserved verbatim for diagnostics, proving the
    // frame was recognized as `event: ephemeral` (and NOT confused with a
    // different event: type) despite the validation failure.
    expect(err.raw).toContain("event: ephemeral");
    expect(err.raw).not.toContain("id:"); // ephemeral frames never carry a journal seq
  });

  it("a schema-conformant ephemeral frame IS recognized as ephemeral, with no seq, and an ajv-validated payload", () => {
    const frames = parseWhole(validEphemeralBytes);
    expect(frames).toEqual([{ type: "ephemeral", data: validEphemeralExpectedData }]);
    expect(frames[0]).not.toHaveProperty("journalSeq");
  });
});

// --- 2. Chunk-boundary handling ----------------------------------------------
//
// Build one combined buffer containing, in order: the enduring fixture, a
// heartbeat comment, a frame with invalid JSON, a frame that fails ajv
// validation, a frame with an unrecognized event: value, and a valid
// ephemeral frame. This exercises every frame kind (including error kinds)
// inside a single stream, so the chunk-split tests below prove chunking
// never corrupts ANY of them.

const heartbeatBytes = new TextEncoder().encode(": ping\n\n");
const invalidJsonBytes = new TextEncoder().encode('event: enduring\nid: 7\ndata: {not json}\n\n');
const invalidSchemaBytes = new TextEncoder().encode(
  'event: enduring\nid: 8\ndata: {"v":1,"event":{"type":"Foo"}}\n\n', // event_envelope requires "v"
);
const unrecognizedEventBytes = new TextEncoder().encode('event: bogus\ndata: {}\n\n');

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const combined = concatBytes(
  enduringBytes,
  heartbeatBytes,
  invalidJsonBytes,
  invalidSchemaBytes,
  unrecognizedEventBytes,
  validEphemeralBytes,
);

const referenceFrames = parseWhole(combined);

describe("combined buffer parsed as a single chunk (reference for chunk-split tests)", () => {
  it("produces exactly one frame per block, each of the expected type", () => {
    expect(referenceFrames.map((f) => f.type)).toEqual([
      "enduring",
      "heartbeat",
      "error",
      "error",
      "error",
      "ephemeral",
    ]);
  });

  it("the enduring frame and ephemeral frame carry the same validated payloads as the standalone fixtures", () => {
    expect(referenceFrames[0]).toEqual({ type: "enduring", journalSeq: 42, data: enduringExpectedData });
    expect(referenceFrames[5]).toEqual({ type: "ephemeral", data: validEphemeralExpectedData });
  });

  it("each error frame carries a distinguishing message and the raw block text", () => {
    const errors = referenceFrames.filter((f): f is Extract<SseFrame, { type: "error" }> => f.type === "error");
    expect(errors).toHaveLength(3);
    expect(errors[0]!.error).toBeInstanceOf(SseFrameError);
    expect(errors[0]!.error.message).toMatch(/not valid JSON/);
    expect(errors[0]!.error.raw).toContain("id: 7");
    expect(errors[1]!.error.message).toMatch(/schema validation/);
    expect(errors[1]!.error.raw).toContain("id: 8");
    expect(errors[2]!.error.message).toMatch(/unrecognized "event:" value/);
    expect(errors[2]!.error.raw).toContain("event: bogus");
  });
});

describe("chunk-boundary handling: identical result regardless of how input bytes are split", () => {
  it("every possible single two-way split offset (0..length) produces the identical parse", () => {
    for (let cut = 0; cut <= combined.length; cut++) {
      const frames = parseChunks(combined, cut === 0 ? [0, combined.length] : [cut, combined.length]);
      expect(normalize(frames), `split at offset ${cut}`).toEqual(normalize(referenceFrames));
    }
  });

  it("split into three chunks at every pair of offsets across a representative stride", () => {
    // Full O(n^2) three-way coverage would be slow; a stride sample across
    // the buffer still exercises splits landing inside every field, the
    // blank-line separators, and frame bodies from multiple starting points.
    const stride = 7;
    for (let a = 0; a < combined.length; a += stride) {
      for (let b = a; b < combined.length; b += stride) {
        const frames = parseChunks(combined, [a, b, combined.length]);
        expect(normalize(frames), `split at [${a}, ${b}]`).toEqual(normalize(referenceFrames));
      }
    }
  });

  it("fed one byte at a time (the most adversarial possible chunking) produces the identical parse", () => {
    const boundaries = Array.from({ length: combined.length }, (_, i) => i + 1);
    const frames = parseChunks(combined, boundaries);
    expect(normalize(frames)).toEqual(normalize(referenceFrames));
  });

  it("splits exactly on the blank-line frame separator produce the identical parse", () => {
    // Locate every "\n\n" in the combined buffer and split exactly between
    // the two newlines, and exactly before/after the pair.
    const text = new TextDecoder().decode(combined);
    const separatorOffsets: number[] = [];
    let idx = text.indexOf("\n\n");
    while (idx !== -1) {
      separatorOffsets.push(idx, idx + 1, idx + 2);
      idx = text.indexOf("\n\n", idx + 2);
    }
    for (const cut of separatorOffsets) {
      const frames = parseChunks(combined, [cut, combined.length]);
      expect(normalize(frames), `split at separator-relative offset ${cut}`).toEqual(normalize(referenceFrames));
    }
  });

  it("splits mid-`id:` line, mid-`data:` prefix, and mid-JSON-value all produce the identical parse", () => {
    const text = new TextDecoder().decode(combined);
    const targets = [
      text.indexOf("id: 42") + 2, // mid "id:" line, inside the digits
      text.indexOf("data: {") + 3, // mid "data:" prefix, before the space
      text.indexOf('"event":{"created_at"') + 5, // mid JSON value, inside a key name
      text.indexOf("input_queued") + 4, // mid JSON string value content
    ];
    for (const cut of targets) {
      expect(cut).toBeGreaterThan(0); // sanity: the target string was actually found
      const frames = parseChunks(combined, [cut, combined.length]);
      expect(normalize(frames), `split at offset ${cut}`).toEqual(normalize(referenceFrames));
    }
  });

  it("the buggy real ephemeral fixture also produces an IDENTICAL (error) result regardless of chunking", () => {
    const reference = normalize(parseWhole(ephemeralFixtureBytes));
    for (let cut = 0; cut <= ephemeralFixtureBytes.length; cut++) {
      const frames = parseChunks(ephemeralFixtureBytes, cut === 0 ? [0, ephemeralFixtureBytes.length] : [cut, ephemeralFixtureBytes.length]);
      expect(normalize(frames), `split at offset ${cut}`).toEqual(reference);
    }
  });
});

// --- 3. Heartbeat handling ----------------------------------------------------

describe("heartbeat comment lines", () => {
  it("a heartbeat between two real frames doesn't corrupt either and is itself yielded as a heartbeat frame", () => {
    const buf = concatBytes(enduringBytes, heartbeatBytes, validEphemeralBytes);
    const frames = parseWhole(buf);
    expect(frames).toEqual([
      { type: "enduring", journalSeq: 42, data: enduringExpectedData },
      { type: "heartbeat" },
      { type: "ephemeral", data: validEphemeralExpectedData },
    ]);
  });

  it("consecutive blank lines with no comment produce no frame at all (not a heartbeat, not an error)", () => {
    const parser = new SseFrameParser();
    const frames = parser.feed(new TextEncoder().encode("\n\n\n"));
    expect(frames).toEqual([]);
  });
});

// --- 4. Malformed frames --------------------------------------------------

describe("malformed frames", () => {
  it("invalid JSON in data: yields a typed error frame, not a thrown exception", () => {
    const parser = new SseFrameParser();
    const frames = parser.feed(invalidJsonBytes);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("error");
    const err = (frames[0] as Extract<SseFrame, { type: "error" }>).error;
    expect(err).toBeInstanceOf(SseFrameError);
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  it("JSON that fails ajv schema validation yields a typed error frame carrying the ContractValidationError as cause", () => {
    const parser = new SseFrameParser();
    const frames = parser.feed(invalidSchemaBytes);
    expect(frames).toHaveLength(1);
    const err = (frames[0] as Extract<SseFrame, { type: "error" }>).error;
    expect(err.message).toMatch(/schema validation/);
    expect(err.cause).toMatchObject({ name: "ContractValidationError" });
  });

  it("an enduring frame missing its id: line yields a typed error frame", () => {
    const parser = new SseFrameParser();
    const frames = parser.feed(new TextEncoder().encode('event: enduring\ndata: {"v":1,"event":{"type":"X","v":1}}\n\n'));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("error");
    expect((frames[0] as Extract<SseFrame, { type: "error" }>).error.message).toMatch(/missing its required "id:"/);
  });

  it("a bad frame does not corrupt the parser's internal buffering state: the next good frame after it still parses correctly", () => {
    const parser = new SseFrameParser();
    const badThenGood = concatBytes(invalidJsonBytes, validEphemeralBytes);
    const frames = parser.feed(badThenGood);
    expect(frames).toEqual([
      expect.objectContaining({ type: "error" }),
      { type: "ephemeral", data: validEphemeralExpectedData },
    ]);
  });

  it("a bad frame straddling a chunk boundary still resolves to exactly one error frame, and parsing resumes correctly", () => {
    const badThenGood = concatBytes(invalidJsonBytes, validEphemeralBytes);
    for (let cut = 1; cut < invalidJsonBytes.length; cut++) {
      const frames = parseChunks(badThenGood, [cut, badThenGood.length]);
      expect(normalize(frames), `split at offset ${cut}`).toEqual([
        {
          type: "error",
          message: expect.stringMatching(/not valid JSON/),
          raw: expect.any(String),
          causeMessage: expect.any(String),
        },
        { type: "ephemeral", data: validEphemeralExpectedData },
      ]);
    }
  });
});

// --- 5. finish() / stream-end semantics --------------------------------------

describe("finish()", () => {
  it("an unterminated trailing partial line (stream closed mid-line) is discarded, not force-processed", () => {
    const parser = new SseFrameParser();
    const frames = [
      ...parser.feed(enduringBytes),
      ...parser.feed(new TextEncoder().encode("event: ephemeral\ndata: {\"v\":1")), // no terminator, stream ends here
      ...parser.finish(),
    ];
    expect(frames).toEqual([{ type: "enduring", journalSeq: 42, data: enduringExpectedData }]);
  });

  it("a frame whose only missing piece was the final blank line still completes if finish() sees it split across feed/finish", () => {
    // Everything up to (not including) the final "\n" of the trailing blank
    // line is fed; the very last byte is delivered to a second feed() call
    // before finish() — proves finish() isn't the only place a trailing
    // frame can complete, and that a 1-byte-short buffer correctly withholds
    // dispatch until the terminator actually arrives.
    const parser = new SseFrameParser();
    const withheld = validEphemeralBytes.slice(0, validEphemeralBytes.length - 1);
    const lastByte = validEphemeralBytes.slice(validEphemeralBytes.length - 1);
    const partial = parser.feed(withheld);
    expect(partial).toEqual([]); // final blank line not yet complete
    const completed = [...parser.feed(lastByte), ...parser.finish()];
    expect(completed).toEqual([{ type: "ephemeral", data: validEphemeralExpectedData }]);
  });
});
