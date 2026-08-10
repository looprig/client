/**
 * The exact history-to-live join: turns a cold `LooprigTransport.readHistory`
 * journal walk and a live `SseFrame` stream (sse.ts's parser output, or any
 * equivalent async source) into ONE ongoing stream of `fold()`ed
 * `SessionView` updates, with no gap and no duplicate for `enduring`
 * (sequenced) content across the history/live boundary. This module
 * orchestrates transport.ts (cold reads), sse.ts (live frame shape), and
 * fold.ts (the actual folding) — it reimplements none of them.
 *
 * ## Why "exact" is hard: there is no server-side resume
 *
 * A fresh SSE connection to `GET /v1/sessions/{sid}/events` starts
 * delivering from whenever the connection opens; `pkg/serve.handleEvents`
 * does not read `Last-Event-ID` or accept any "give me everything since seq
 * N" parameter. So a naive join ("read cold history, THEN open the live
 * connection") has a race window: an event durably written after the cold
 * read finishes but before the live connection opens is never seen by
 * either side — silently lost. And the reverse naive join ("open live
 * first, THEN read cold history, THEN start applying live frames") risks
 * duplicating whatever landed in both the cold page and the live stream.
 *
 * The algorithm here avoids both failure modes by controlling ORDER, not by
 * any server cooperation:
 *
 *   1. Subscribe to the live source FIRST. Every frame it produces from this
 *      instant on is buffered (not yet applied) — see `AsyncQueue` below.
 *   2. Page the cold journal (`readHistory`, `from_journal_seq`-driven,
 *      possibly many pages) forward until a page reports `done: true`. That
 *      page's `next_journal_seq` is the join's definition of "the tip" `T`
 *      (see below) — the boundary the cold read has now durably covered.
 *   3. Drain everything the live source buffered during step 2, and from
 *      here on (step 4) keep consuming the same, still-open live source
 *      indefinitely. In BOTH cases, an `enduring` frame with
 *      `journalSeq < T` is dropped (already delivered by the cold read —
 *      applying it again would duplicate); everything else (an `enduring`
 *      frame with `journalSeq >= T`, or an `ephemeral`/`heartbeat`/`error`
 *      frame, none of which the tip check ever touches) is applied.
 *
 * Because step 1 happens before step 2 starts, no event durably written
 * during the cold walk can be missed: it either lands IN a cold page (read
 * directly) or arrives on the live buffer (caught in step 3/4). The
 * `journalSeq < T` filter is deliberately NOT a one-shot check applied only
 * to the step-3 drain — it's applied for the rest of the connection's
 * lifetime (step 4 too). Relaying a frame from the raw live source into the
 * internal buffer is itself asynchronous (a real pump keeps pace with, but
 * is not instantaneously synchronized with, the underlying network read),
 * so there is no instant by which "everything that physically arrived
 * during buffering" is guaranteed to already be sitting in the drainable
 * buffer — a frame that arrived during the window could still surface
 * through the step-4 follow loop rather than the step-3 drain, purely as an
 * artifact of scheduling. Filtering by `T` everywhere, not just at the
 * drain boundary, means the exact-once property never depends on that
 * timing. This is always safe: `journal_seq` is monotonic, so once live
 * frames genuinely catch up to real time every subsequent one has
 * `journalSeq >= T` by construction and the filter becomes a permanent
 * no-op. This is the exact property the module exists to guarantee — see
 * join.test.ts's "lands inside the join window" case for the test that
 * proves it under adversarial timing, not just by inspection.
 *
 * ## What "the tip" T precisely means
 *
 * `EventJournalPage.next_journal_seq` is documented (event_journal_page
 * .schema.json) as "the sequence to pass as `from_journal_seq` for the next
 * page" — i.e. it is the server's own resume cursor, not merely
 * `1 + max(journal_seq actually returned)`. This module defines the tip `T`
 * as that cursor value from the final (`done: true`) page, and drops a
 * buffered `enduring` live frame when `frame.journalSeq < T`.
 *
 * In the ordinary contiguous case (no journal gaps) `T` and
 * `1 + max(journal_seq seen)` are the same number, so this choice makes no
 * observable difference in the common case. It's deliberately the cursor,
 * not the max-seen value, because the cursor is the server's own checkpoint
 * of what has been durably resolved — including any journal_seq range the
 * server may have advanced past without literally returning an event for it
 * (e.g. a future pruning/compaction scheme). Using max-seen instead would
 * under-report the tip in that scenario and risk re-applying live content
 * the server already considers resolved. `T` also degrades correctly for a
 * brand-new, empty session: the first (and only) page has `events: []` and
 * `next_journal_seq` equal to whatever cursor was requested (typically 0),
 * so `T` is that same starting cursor and nothing gets dropped — every live
 * frame passes straight through once the (trivial) catch-up completes.
 *
 * ## Ephemeral frames during the buffering window
 *
 * `ephemeral` frames carry no `journal_seq` — they're unsequenced and
 * best-effort by design (see sse.ts/fold.ts). This module's choice: an
 * ephemeral (or `heartbeat`/`error`) frame is NEVER filtered by the tip
 * check (only `type: "enduring"` frames are), and it is applied exactly
 * once, in the order the live source delivered it — either via the step-3
 * drain (if it arrived during buffering) or via the step-4 follow loop (if
 * it arrived after). It is never dropped and never duplicated: `AsyncQueue`
 * delivers each pushed item to exactly one of `drain()` or a later `next()`
 * call, never both. The only externally visible effect of a frame having
 * arrived during the buffering window is where in the output sequence it
 * lands (immediately after the cold-history items, rather than interleaved
 * in real time with them) — which is consistent with "ephemeral content has
 * no ordering key to reconcile against the journal at all" and only ever
 * affects ordering among already-unordered content, never loss or
 * duplication.
 *
 * ## Reconnect
 *
 * `options.autoReconnect` (default `false`) controls what happens when this
 * connection attempt's live segment ENDS, for EITHER of two reasons:
 *
 *  1. Cleanly: the live source's async iterable completes (its `next()`
 *     resolves `{ done: true }`) — e.g. the server closed the connection.
 *  2. With an error: `readHistory()` rejects during the cold catch-up, OR
 *     the live connection's iterator throws (propagating through
 *     `queue.next()` rejecting) — e.g. a network failure. This is, in
 *     practice, the more common real-world disconnect mode, and is covered
 *     the SAME way as a clean end, not a separate code path.
 *
 * What `autoReconnect` does with either case:
 *
 *  - `false` (default): the join ends. A clean end returns the generator
 *    normally (see join.test.ts's "session ends" case: no hang, no
 *    unhandled rejection, just a clean end of the output stream); an error
 *    propagates as a rejection out of the `.next()` call in flight when it
 *    happened (see join.test.ts's "readHistory() rejecting" / "the live
 *    connection failing" cases) — a caller that wants to handle
 *    reconnection/backoff itself still can, exactly as before this covered
 *    errors too.
 *  - `true`: EITHER case opens a fresh connection (`liveSource()` again) and
 *    repeats the full subscribe-buffer-catch-up cycle from step 1, resuming
 *    the cold walk from the highest `journal_seq` this join has applied so
 *    far (not from 0) — so a reconnect only re-reads the gap the dropped
 *    connection may have missed, and the exact no-gap/no-duplicate property
 *    holds across the reconnect boundary exactly as it does for the first
 *    connection. See join.test.ts's "reconnect mid-stream" case (clean end)
 *    and its "reconnect on error" cases (readHistory()/live-connection
 *    failure). An ERROR-triggered reconnect waits `options.reconnectDelayMs`
 *    (default 250ms) before retrying — see that option's doc comment: this
 *    is a minimal fixed delay to avoid hot-looping against a persistently
 *    down server, NOT a real backoff/jitter policy (the delay does not grow
 *    across repeated failures); a full backoff policy is a known, deliberately
 *    out-of-scope follow-up. A clean end reconnects immediately, with no
 *    delay, exactly as before.
 */
import type { SessionView, FoldInput, FoldResult, FoldError } from "./fold.js";
import { emptySessionView, fold } from "./fold.js";
import type { SseFrame } from "./sse.js";
import type { EventJournalPage } from "./types.js";
import type { ReadHistoryOptions } from "./transport.js";

// --- Public surface -----------------------------------------------------------

/**
 * The subset of `LooprigTransport` the join needs — cold journal paging
 * only. Kept narrow (interface segregation): a caller wiring this up from a
 * real `LooprigTransport`/`BFFTransport` needs no adapter (both already
 * structurally satisfy this), and a test double only has to implement one
 * method.
 */
export interface JournalReader {
  readHistory(sessionId: string, options?: ReadHistoryOptions): Promise<EventJournalPage>;
}

/**
 * Opens one live connection and returns an async iterable of its `SseFrame`s.
 * Called once per connection attempt: the first call at join start, and
 * again on every reconnect when `options.autoReconnect` is set. Each call
 * must represent a genuinely fresh subscription whose iterable starts
 * yielding from the moment the call returns — the exact-join property
 * depends on the join buffering everything from that instant, per this
 * module's algorithm.
 */
export type LiveFrameSource = () => AsyncIterable<SseFrame>;

export interface JoinOptions {
  /** Cursor the cold journal walk starts from. Default 0 (full history). */
  fromJournalSeq?: number;
  /** Starting view to fold into. Default `emptySessionView()`. */
  initialView?: SessionView;
  /** Page size forwarded to `readHistory`. Default: transport's own default. */
  pageLimit?: number;
  /**
   * Reopen a fresh live connection and repeat the join cycle when one ends —
   * cleanly OR with an error (`readHistory()` rejecting, or the live
   * connection's iterator throwing) — instead of terminating the output
   * stream. Default `false`. See the module comment's "Reconnect" section.
   */
  autoReconnect?: boolean;
  /**
   * Delay before a reconnect attempt triggered by an ERROR (not applied to a
   * clean end-of-stream reconnect, which retries immediately as before).
   * Only consulted when `autoReconnect` is `true`. Default `250`
   * (milliseconds). This is a minimal fixed delay so a persistently-down
   * server doesn't get hammered by a tight zero-delay retry loop — it is
   * NOT a backoff/jitter policy (the delay does not grow across repeated
   * failures); that's a known, deliberately out-of-scope follow-up. Set to
   * `0` to retry immediately (e.g. in a test that doesn't want to wait).
   */
  reconnectDelayMs?: number;
  /** Aborts the join. Checked between steps; does not preempt an in-flight `readHistory`/live `next()` call already awaited (those should honor their own cancellation, e.g. via `RequestOptions.signal` on the transport call a caller wires up). Also cuts short an in-progress error-triggered reconnect delay. */
  signal?: AbortSignal;
}

/**
 * One folded update from the join, in emission order. Mirrors `FoldResult`'s
 * `ok` discriminant (see fold.ts) but always carries `view` (the current
 * accumulated view — unchanged from before this input when `ok: false`) and
 * `input` (what produced it), so a caller never needs to track prior state
 * separately just to react to an error.
 */
export type JoinEvent =
  | { ok: true; view: SessionView; input: FoldInput }
  | { ok: false; view: SessionView; error: FoldError; input: FoldInput };

/**
 * Runs the exact history-to-live join and yields every folded update, in
 * order, for as long as the join keeps running (see `options.autoReconnect`
 * for when it ends). See the module comment for the full algorithm and its
 * correctness argument.
 */
export async function* joinSessionView(
  journal: JournalReader,
  sessionId: string,
  liveSource: LiveFrameSource,
  options: JoinOptions = {},
): AsyncGenerator<JoinEvent, void, void> {
  let view = options.initialView ?? emptySessionView();
  let cursor = options.fromJournalSeq ?? 0;
  const signal = options.signal;
  const autoReconnect = options.autoReconnect ?? false;
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;

  for (;;) {
    if (signal?.aborted) return;

    // --- Step 1: subscribe live FIRST. Buffering starts the instant liveSource() returns. ---
    const queue = new AsyncQueue<SseFrame>();
    const liveIterator = liveSource()[Symbol.asyncIterator]();
    const pumpDone = pumpLiveConnection(liveIterator, queue);

    // Set inside `catch` below when `autoReconnect` swallows an error rather
    // than rethrowing it, so the code after `finally` knows to (a) actually
    // loop back around instead of returning and (b) apply the reconnect
    // delay — see the module comment's "Reconnect" section for why an error
    // is treated as just another reason this connection attempt ended,
    // exactly like a clean `{ done: true }`, once `autoReconnect` is on.
    let reconnectAfterError = false;

    try {
      // --- Step 2: page the cold journal forward to the tip T. ---
      let tip = cursor;
      for (;;) {
        if (signal?.aborted) return;
        const page = await journal.readHistory(sessionId, { fromJournalSeq: cursor, limit: options.pageLimit });
        for (const event of page.events) {
          const input: FoldInput = { segment: "history", event };
          const result = fold(view, input);
          if (result.ok) view = result.view;
          yield toJoinEvent(result, input, view);
        }
        cursor = page.next_journal_seq;
        tip = page.next_journal_seq;
        if (page.done) break;
      }

      // --- Step 3: drain the live buffer; drop enduring frames the cold read already covered. ---
      //
      // Step 4 (below) applies the SAME `isAlreadyCovered(frame, tip)` check,
      // not just this drain — see the module comment ("the tip filter is not
      // a one-shot boundary") for why a two-phase drain-then-follow split
      // with filtering ONLY here would be a latent duplicate bug: relaying a
      // frame from the raw live iterator into `queue` (the pump loop below)
      // is itself asynchronous, so there is no guaranteed instant by which
      // "everything that arrived during buffering" is necessarily reflected
      // in `queue`'s synchronous buffer yet. Filtering by `tip` for the
      // whole lifetime of this connection (not just this one drain) is what
      // actually makes the exact-once property hold regardless of that
      // timing, and it's always safe to do so: journal_seq is monotonic, so
      // no legitimate NEW live frame can ever carry `journalSeq < tip` — the
      // filter is a permanent no-op the moment real-time catches up.
      for (const frame of queue.drain()) {
        if (signal?.aborted) return;
        if (isAlreadyCovered(frame, tip)) continue;
        const input: FoldInput = { segment: "live", frame };
        const result = fold(view, input);
        if (result.ok) view = result.view;
        if (frame.type === "enduring") cursor = Math.max(cursor, frame.journalSeq + 1);
        yield toJoinEvent(result, input, view);
      }

      // --- Step 4: follow live indefinitely (still tip-filtered — see above). ---
      for (;;) {
        if (signal?.aborted) return;
        const next = await queue.next();
        if (next.done) break; // this connection ended
        const frame = next.value;
        if (isAlreadyCovered(frame, tip)) continue;
        const input: FoldInput = { segment: "live", frame };
        const result = fold(view, input);
        if (result.ok) view = result.view;
        if (frame.type === "enduring") cursor = Math.max(cursor, frame.journalSeq + 1);
        yield toJoinEvent(result, input, view);
      }
    } catch (err) {
      // `readHistory()` rejected (step 2), or the live connection's iterator
      // threw (propagated through `queue.next()` rejecting in step 4) —
      // see the module comment's "Reconnect" section. Only swallow this
      // when `autoReconnect` is on; otherwise preserve the pre-existing
      // behavior of propagating it straight out of this generator.
      if (!autoReconnect) throw err;
      reconnectAfterError = true;
    } finally {
      // Signal the live source to release its resources, and let the pump
      // wind down on its own — but do NOT block this generator's own
      // termination on either of those actually settling. Neither is
      // guaranteed to happen promptly: `pumpDone`'s loop can be genuinely
      // stuck awaiting `iterator.next()` on a connection nobody has closed
      // (real network I/O with nothing more arriving), and per the
      // async-iterator protocol a `.return()` call QUEUES BEHIND an
      // already-in-flight `.next()` rather than preempting it — so it can
      // be stuck waiting on that exact same pending read too. Awaiting
      // either one here would make tearing down this join (an abort, or a
      // caller simply stopping iteration while still connected) hang on
      // cooperation this module cannot itself guarantee. A real
      // `LiveFrameSource` is expected to wire its own cancellation (e.g. an
      // `AbortSignal` into the `fetch()` it opens) so the underlying read
      // actually unblocks; this module's own cleanup is always best-effort
      // and non-blocking, never a source of a hang by itself. (Verified:
      // join.test.ts's "the join window" and reconnect cases call
      // `gen.return()` mid-connection specifically to exercise this path.)
      liveIterator.return?.()?.catch(() => {});
      pumpDone.catch(() => {});
    }

    if (!autoReconnect) return;

    if (reconnectAfterError) {
      // Minimal hot-loop guard for a persistently-failing server — see
      // `reconnectDelayMs`'s doc comment for why this is a fixed delay, not
      // a real backoff policy. A clean end (reconnectAfterError === false)
      // intentionally retries immediately, unchanged from before.
      await delay(reconnectDelayMs, signal);
      if (signal?.aborted) return;
    }
    // Loop again: liveSource() is called afresh at the top, and the cold walk
    // resumes from `cursor` (the highest journal_seq this join has applied so
    // far), so the reconnect cycle only re-reads whatever gap the dropped
    // connection may have missed.
  }
}

// --- Internals ------------------------------------------------------------------

/**
 * Resolves after `ms` milliseconds, or immediately if `ms <= 0` (skips the
 * timer entirely — used by tests that pass `reconnectDelayMs: 0` to exercise
 * the error-triggered reconnect path without actually waiting). If `signal`
 * aborts while waiting, resolves immediately rather than waiting out the
 * full delay — the top-of-loop `if (signal?.aborted) return;` check right
 * after the caller's `await` is what actually ends the join in that case;
 * this function's job is only to not make that check wait needlessly.
 */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isAlreadyCovered(frame: SseFrame, tip: number): boolean {
  return frame.type === "enduring" && frame.journalSeq < tip;
}

function toJoinEvent(result: FoldResult, input: FoldInput, view: SessionView): JoinEvent {
  if (result.ok) return { ok: true, view: result.view, input };
  return { ok: false, view, error: result.error, input };
}

/**
 * A minimal async FIFO: `push()` never blocks (buffers if nobody's waiting),
 * `next()` resolves immediately from the buffer or waits for the next
 * `push()`/`close()`, and `drain()` synchronously removes and returns
 * everything currently buffered without waiting. Every pushed item is
 * delivered to exactly ONE consumer call — either a `drain()` that happened
 * to run after it was buffered, or a later `next()` — never both and never
 * neither, which is what makes the join's step 3 (drain) -> step 4 (follow)
 * handoff itself gap-free and duplicate-free at the delivery level. (Getting
 * an item to exactly one of "the tip filter's step-3 pass" vs. "the tip
 * filter's step-4 pass" is a separate, ADDITIONAL property the join gets by
 * applying the same `isAlreadyCovered` check in both — see the module
 * comment; `AsyncQueue` itself only guarantees each item is handed to the
 * caller exactly once, not which of the two loops that happens to be.)
 */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{ resolve: (r: IteratorResult<T, undefined>) => void; reject: (e: unknown) => void }> = [];
  private closed = false;
  private closeError: unknown;
  private hasCloseError = false;

  push(item: T): void {
    if (this.closed) return; // a well-behaved pump never pushes after close; ignored defensively rather than throwing
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  /** Marks the queue closed. `error`, if provided, is thrown by every subsequent (and any currently-pending) `next()` call once the buffer is exhausted. */
  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.hasCloseError = error !== undefined;
    this.closeError = error;
    for (const waiter of this.waiters.splice(0)) {
      if (this.hasCloseError) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  drain(): T[] {
    return this.items.splice(0);
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift() as T, done: false });
    }
    if (this.closed) {
      return this.hasCloseError ? Promise.reject(this.closeError) : Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

/**
 * Pulls frames from one live connection's iterator into `queue` until the
 * connection ends or errors. Never lets its own returned promise reject —
 * any failure is funneled through `queue.close(err)` instead, so a caller
 * awaiting this promise in a `finally` block (defensively, since this
 * function is designed never to reject) can do so without a `.catch()`.
 */
async function pumpLiveConnection(iterator: AsyncIterator<SseFrame>, queue: AsyncQueue<SseFrame>): Promise<void> {
  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) {
        queue.close();
        return;
      }
      queue.push(value);
    }
  } catch (err) {
    queue.close(err);
  }
}
