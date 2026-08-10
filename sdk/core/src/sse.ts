/**
 * SSE (Server-Sent Events) line-framing parser for harness's live event
 * stream (`pkg/serve/ephemeral.go`, `pkg/serve/handlers_events.go`).
 *
 * This is a real line-parser over raw bytes, NOT the browser's built-in
 * `EventSource` — `EventSource` can only be pointed at a URL (it owns the
 * whole connection and offers no way to feed it synthetic chunks), which
 * makes it untestable with the chunk-boundary scenarios this module exists
 * to get right. Instead:
 *
 *  - `SseFrameParser` is the synchronous core: `feed(chunk: Uint8Array)`
 *    consumes one arbitrarily-sized chunk of bytes and returns every frame
 *    that chunk completed. This is what the unit tests below drive directly
 *    with hand-split byte arrays.
 *  - `parseSseStream(stream: ReadableStream<Uint8Array>)` is a thin async
 *    generator wrapper for real usage against `fetch()`'s streaming
 *    `response.body`.
 *
 * ## Wire format (confirmed against `contract/schema/enduring_frame.schema.json`,
 * `ephemeral_frame.schema.json`, and their fixtures — see those files'
 * `description`s, which are the authoritative source for this framing):
 *
 *   `event: enduring\nid: <journal_seq>\ndata: <json>\n\n`   -- id: ALWAYS present
 *   `event: ephemeral\ndata: <json>\n\n`                     -- id: NEVER present
 *   `: ping\n\n`                                             -- heartbeat comment
 *
 * Frames are separated by a blank line, per the SSE spec
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation).
 * This parser implements that general line-processing algorithm (comment
 * lines, `field: value` lines with the single-leading-space-stripped rule,
 * multi-line `data:` accumulation joined by `\n`) rather than a narrower
 * ad hoc format, since it costs little extra and the wire format is a
 * subset of full SSE, not a divergent one.
 *
 * ## Design decision: heartbeats are a distinct yielded frame, not silently
 * dropped.
 *
 * Strict SSE dispatch semantics (a comment-only block sets no `data`, so a
 * generic client's "message" listener never fires) would already make a
 * heartbeat invisible to a naive caller for free. This module yields it
 * explicitly instead (`{ type: "heartbeat" }`) because the information the
 * wire actually sent — "the connection is alive, nothing new happened" — is
 * useful at the call site (e.g. resetting a stale-connection timeout) and
 * cheap to ignore (`if (frame.type === "heartbeat") continue;`) for callers
 * that don't care. Silently eating it would throw that signal away with no
 * way to recover it later.
 *
 * ## Design decision: a malformed frame yields a typed error frame; it does
 * NOT throw and does NOT halt the stream.
 *
 * `{ type: "error", error: SseFrameError }` is yielded in place of the
 * frame that failed to parse/validate (bad JSON, ajv rejection, missing
 * `id:` on an `enduring` frame, an unrecognized `event:` value). Parsing
 * resumes normally on the next frame. This is a deliberate departure from
 * this package's usual "parse, don't cast; throw on violation" discipline
 * (`validate.ts`'s `ContractValidationError`, `transport.ts`'s typed HTTP
 * errors) — those guard a single request/response, where surfacing the
 * failure as a rejected promise is the whole story. A live SSE connection is
 * a long-lived multiplexed sequence of independent, self-delimited frames:
 * one server bug or transient encoding glitch on a single event (frequently
 * an `ephemeral` progress tick, not journal-critical) should not force the
 * caller to tear down and reconnect the entire stream, losing every
 * following frame along with it. Concretely:
 *  - `feed()`/`parseSseStream()` throwing would mean ONE bad `ephemeral`
 *    frame kills delivery of every subsequent `enduring` frame too, which is
 *    strictly worse for a caller that only cared about the durable events.
 *  - The internal buffering state is never corrupted by a bad frame either
 *    way (each frame is parsed from its own bounded block, reset at every
 *    blank-line dispatch) — that invariant holds regardless of this choice,
 *    it's tested separately (see sse.test.ts's "internal buffer state" case
 *    following a malformed frame).
 *  - The caller still gets a fully typed, non-silent signal
 *    (`SseFrameError`, with the raw block text and, where available, the
 *    underlying `cause`) and can choose its own policy: log and continue,
 *    count/alert past a threshold, or itself decide to tear down the
 *    connection. Silently dropping the bad frame (no error frame at all)
 *    was rejected for the same reason `validate.ts` never returns `null` on
 *    failure — a caller should never have to wonder whether "fewer frames
 *    than expected arrived" means "nothing happened" or "something was
 *    silently thrown away."
 *
 * ## Chunk-boundary / UTF-8 safety
 *
 * Bytes are decoded incrementally with `TextDecoder`'s `{ stream: true }`
 * mode, which is specifically designed to hold back a not-yet-complete
 * multi-byte UTF-8 sequence at the end of a chunk until the remaining bytes
 * arrive in a later chunk, rather than emitting a corrupt/replacement
 * character. Line-splitting then operates on the decoded string buffer, not
 * raw bytes, so a chunk boundary landing anywhere at all — mid multi-byte
 * character, mid line, mid `data:` JSON value, exactly on the blank-line
 * separator — cannot corrupt or drop a frame: incomplete trailing text
 * simply stays in the buffer until the next `feed()` call supplies the rest.
 * (None of the current fixtures contain non-ASCII bytes, so this specific
 * property isn't exercised by golden-fixture bytes today; it follows from
 * `TextDecoder`'s documented streaming contract rather than from anything
 * fixture-specific, and is reasoned about explicitly since it can't be
 * pinned down with real multi-byte fixture content yet.)
 */
import type { EnduringFrame, EphemeralFrame } from "./types.js";
import { validateEnduringFrame, validateEphemeralFrame } from "./validate.js";

export interface EnduringSseFrame {
  type: "enduring";
  /** Parsed from the frame's `id:` line — the durable journal sequence. */
  journalSeq: number;
  data: EnduringFrame;
}

export interface EphemeralSseFrame {
  type: "ephemeral";
  data: EphemeralFrame;
}

/** A `: ping\n\n`-style comment-only block. See the module comment for why this is surfaced rather than dropped. */
export interface HeartbeatSseFrame {
  type: "heartbeat";
}

/** A frame that failed to parse or failed schema validation. See the module comment for why this is yielded in-band rather than thrown. */
export interface ErrorSseFrame {
  type: "error";
  error: SseFrameError;
}

export type SseFrame = EnduringSseFrame | EphemeralSseFrame | HeartbeatSseFrame | ErrorSseFrame;

/**
 * Thrown (well, carried — see the module comment on why this is yielded as
 * `ErrorSseFrame` rather than thrown) for one SSE block that failed to
 * decode into a valid `enduring`/`ephemeral` frame. `raw` is the block's
 * original, unmodified lines (joined with `\n`) for diagnostics/logging;
 * `cause` (via the standard `Error` option, when present) is the underlying
 * `JSON.parse` `SyntaxError` or `ContractValidationError`.
 */
export class SseFrameError extends Error {
  readonly raw: string;

  constructor(message: string, raw: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SseFrameError";
    this.raw = raw;
  }
}

const JOURNAL_SEQ_PATTERN = /^\d+$/;

/**
 * Result of locating the next line terminator in a string starting at
 * `from`. `length` is 1 for a bare `\n` or `\r`, 2 for `\r\n`.
 *
 * A lone trailing `\r` at the very end of the currently-buffered text is
 * genuinely ambiguous mid-stream (it might be the first half of a `\r\n`
 * pair whose `\n` hasn't arrived in a chunk yet) and is NOT reported as a
 * terminator unless `atEnd` is set (end of stream reached, no more bytes
 * are coming, so it must be a bare CR terminator).
 */
function nextLineBreak(s: string, from: number, atEnd: boolean): { index: number; length: number } | null {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") return { index: i, length: 1 };
    if (c === "\r") {
      if (s[i + 1] === "\n") return { index: i, length: 2 };
      if (i + 1 < s.length) return { index: i, length: 1 };
      // Lone CR at the current end of the buffer.
      return atEnd ? { index: i, length: 1 } : null;
    }
  }
  return null;
}

/**
 * Streaming SSE line-parser. Feed it raw bytes as they arrive (in whatever
 * chunk sizes the transport happens to deliver — nothing about `feed()`
 * assumes a chunk respects line or frame boundaries) and it yields every
 * frame the newly-fed bytes completed.
 *
 * Every `data:` payload is parsed with `JSON.parse` and then passed through
 * the matching ajv validator (`validateEnduringFrame` / `validateEphemeralFrame`
 * from validate.ts) before ever being handed back as typed data — the same
 * parse-don't-cast discipline as the rest of this package. There is no path
 * that returns an `enduring`/`ephemeral` frame's `data` without it having
 * gone through ajv.
 */
export class SseFrameParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";

  // Accumulated state for the block currently being read (reset on every dispatch).
  private currentEvent: string | undefined;
  private currentId: string | undefined;
  private dataLines: string[] = [];
  private rawLines: string[] = [];
  private sawFieldLine = false;
  private sawCommentLine = false;

  /** Feeds one chunk of bytes and returns every frame it completed. Safe to call with any chunk size, including a chunk that splits a line, a field, a JSON value, or a multi-byte UTF-8 character. */
  feed(chunk: Uint8Array): SseFrame[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /**
   * Call once the underlying byte source is exhausted (e.g. the fetch
   * body's reader reports `done`). Flushes any pending decoder state and
   * processes trailing buffered text. An unterminated trailing partial line
   * (the source closed mid-line, with no final line terminator) is
   * discarded rather than force-processed, matching `EventSource`'s own
   * "ignore an incomplete final line" behavior — the source closing
   * mid-line is indistinguishable from a truncated connection, not a
   * complete-but-unterminated frame.
   */
  finish(): SseFrame[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(atEnd: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    for (;;) {
      const found = nextLineBreak(this.buffer, 0, atEnd);
      if (found === null) break;
      const line = this.buffer.slice(0, found.index);
      this.buffer = this.buffer.slice(found.index + found.length);
      const frame = this.processLine(line);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  private processLine(line: string): SseFrame | null {
    if (line === "") {
      return this.dispatch();
    }
    if (line.startsWith(":")) {
      this.sawCommentLine = true;
      this.rawLines.push(line);
      return null;
    }

    this.sawFieldLine = true;
    this.rawLines.push(line);

    const colonIdx = line.indexOf(":");
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.currentEvent = value;
        break;
      case "id":
        this.currentId = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      default:
        // Unrecognized field (e.g. "retry:") — ignored, per SSE semantics
        // and because this wire format never sends one.
        break;
    }
    return null;
  }

  /** Blank line reached: the current block is complete. Resets all per-block state either way. */
  private dispatch(): SseFrame | null {
    const event = this.currentEvent;
    const id = this.currentId;
    const dataLines = this.dataLines;
    const sawFieldLine = this.sawFieldLine;
    const sawCommentLine = this.sawCommentLine;
    const raw = this.rawLines.join("\n");
    this.resetBlock();

    if (!sawFieldLine) {
      // No event/id/data field lines seen since the last dispatch.
      return sawCommentLine ? { type: "heartbeat" } : null; // pure comment vs. e.g. consecutive blank lines
    }

    if (dataLines.length === 0) {
      return errorFrame(`SSE frame is missing a "data:" line (event: ${JSON.stringify(event ?? null)})`, raw);
    }
    const dataText = dataLines.join("\n");

    if (event === "enduring") return this.parseEnduring(id, dataText, raw);
    if (event === "ephemeral") return this.parseEphemeral(dataText, raw);
    return errorFrame(`SSE frame has an unrecognized "event:" value: ${JSON.stringify(event ?? null)}`, raw);
  }

  private resetBlock(): void {
    this.currentEvent = undefined;
    this.currentId = undefined;
    this.dataLines = [];
    this.rawLines = [];
    this.sawFieldLine = false;
    this.sawCommentLine = false;
  }

  private parseEnduring(id: string | undefined, dataText: string, raw: string): SseFrame {
    if (id === undefined) {
      return errorFrame('"enduring" SSE frame is missing its required "id:" line', raw);
    }
    if (!JOURNAL_SEQ_PATTERN.test(id)) {
      return errorFrame(`"enduring" SSE frame's "id:" line is not a non-negative integer: ${JSON.stringify(id)}`, raw);
    }
    const journalSeq = Number(id);

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch (cause) {
      return errorFrame('"enduring" SSE frame\'s "data:" line is not valid JSON', raw, cause);
    }

    try {
      const data = validateEnduringFrame(parsed);
      return { type: "enduring", journalSeq, data };
    } catch (cause) {
      return errorFrame('"enduring" SSE frame\'s "data:" payload failed schema validation', raw, cause);
    }
  }

  private parseEphemeral(dataText: string, raw: string): SseFrame {
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch (cause) {
      return errorFrame('"ephemeral" SSE frame\'s "data:" line is not valid JSON', raw, cause);
    }

    try {
      const data = validateEphemeralFrame(parsed);
      return { type: "ephemeral", data };
    } catch (cause) {
      return errorFrame('"ephemeral" SSE frame\'s "data:" payload failed schema validation', raw, cause);
    }
  }
}

function errorFrame(message: string, raw: string, cause?: unknown): ErrorSseFrame {
  return { type: "error", error: new SseFrameError(message, raw, cause === undefined ? undefined : { cause }) };
}

/**
 * Wraps a `ReadableStream<Uint8Array>` (e.g. `fetch()`'s `response.body`)
 * as an async iterable of parsed SSE frames. This is the real-usage
 * counterpart to `SseFrameParser` — it owns nothing but the read loop and a
 * fresh `SseFrameParser`, so all the actual framing logic (and every test
 * of it) lives in one place.
 */
export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame, void, void> {
  const parser = new SseFrameParser();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.feed(value)) yield frame;
    }
    for (const frame of parser.finish()) yield frame;
  } finally {
    reader.releaseLock();
  }
}
