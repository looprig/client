/**
 * Svelte 5 reactivity wrapper driving sdk/core's `joinSessionView` (join.ts):
 * republishes each yielded `SessionView` as `$state`, so a component can
 * reactively render a session's continuously-updating live transcript. This
 * is architecturally different from session.svelte.ts's cold stores — those
 * wrap a single request/response (`refresh()`, called again for a fresh
 * page); a live join is an ONGOING SUBSCRIPTION with no natural "done" until
 * something asks it to stop, so this store exposes `start()`/`stop()`
 * lifecycle methods instead of a one-shot `refresh()`. `active`/`view`/
 * `error`/`lastFoldError` are still plain `$state` fields republished the
 * same way session.svelte.ts's stores republish their transport results —
 * only the thing driving those updates (a long-lived generator loop instead
 * of a single awaited call) differs.
 *
 * ## Why `stop()` needs more than "call `.return()` on the join generator"
 *
 * join.ts's own module comment already flags this: "a `.return()` call
 * QUEUES BEHIND an already-in-flight `.next()` rather than preempting it."
 * This was verified empirically for this task (not just taken on faith): an
 * async generator parked mid-`await` on a promise that never settles on its
 * own NEVER processes a `.return()` call made from outside — the call just
 * sits in the generator's internal request queue forever, because nothing
 * ever causes the generator to leave its "executing" state. Concretely, for
 * `joinSessionView`, its steady state for almost all of a live session's
 * lifetime is parked at `await queue.next()` in its "step 4" follow loop,
 * waiting for the next live frame — calling `.return()` on the join
 * generator while it's sitting there does NOT unblock it; nothing does,
 * until the live connection itself produces activity (a frame, a heartbeat,
 * or an end/error).
 *
 * So a caller that only calls `joinGenerator.return()` to stop early would,
 * in the common "waiting for the next event" case, leave the join (and its
 * open network connection) running in the background for as long as the
 * live connection stays idle — possibly the rest of the session, since
 * nothing then ever prompts the next check. This is exactly the kind of
 * silent resource leak the task set out to close, one layer up from
 * `live.ts`'s own fix for the SAME class of problem inside
 * `FetchLiveConnection`.
 *
 * The fix mirrors `live.ts`'s: this store wraps the `LiveFrameSource` it's
 * given so that EVERY connection `joinSessionView` opens (the first one, and
 * any `autoReconnect` reopens) has its returned iterator's reference
 * captured as it's created. `stop()` calls `.return()` on that iterator
 * DIRECTLY — bypassing `joinSessionView`'s own generator entirely, so it is
 * NOT subject to that generator's request queue. Calling `.return()` on the
 * live iterator this way reaches `FetchLiveConnection`'s own `.return()`
 * (live.ts), whose `controller.abort()` runs synchronously and is what
 * ACTUALLY unblocks the pending read — from there the effect cascades
 * naturally: the live connection ends, `joinSessionView`'s internal pump
 * closes its queue, the parked `await queue.next()` resolves, and the join
 * generator itself finally reaches code that can observe the stop.
 *
 * That cascade alone would make `autoReconnect: true` (this store's default
 * — see `start()`) immediately reopen a fresh connection, since from
 * `joinSessionView`'s perspective the live connection merely ended. This
 * store also owns an `AbortController` passed as `options.signal`, aborted
 * SYNCHRONOUSLY at the start of `stop()` — before the cascade above even
 * begins — so that by the time `joinSessionView`'s loop gets back around to
 * its `if (signal?.aborted) return;` check (which only happens once the
 * cascade unblocks it), the signal is unquestionably already aborted and no
 * reconnect is attempted. Neither piece alone is sufficient: the abort
 * signal alone never gets checked while parked mid-await; the direct
 * iterator cancellation alone doesn't stop `autoReconnect` from reopening.
 * See live-session.test.ts's "stop() during an idle live wait" case, which
 * reproduces the exact parked-mid-await scenario and asserts both that the
 * live connection's `.return()` was actually called AND that no new
 * connection is opened afterward.
 *
 * The same reasoning applies to an in-flight cold-history page read: this
 * store also threads its own `signal` into every `readHistory()` call (via
 * a small `JournalReader` wrapper), since `joinSessionView` does not do so
 * itself (verified by reading join.ts's step 2 — it calls
 * `journal.readHistory(sessionId, { fromJournalSeq, limit })` with no
 * `signal`). Without this, `stop()` during the (typically brief) initial
 * cold-history catch-up would not cancel that HTTP request either.
 */
import {
  emptySessionView,
  joinSessionView,
  type FoldError,
  type JoinEvent,
  type JoinOptions,
  type JournalReader,
  type LiveFrameSource,
  type ReadHistoryOptions,
  type SessionView,
} from "@looprig/client";

/**
 * Wraps `inner` so every connection it opens has its iterator's reference
 * captured in a variable `cancelActive` can reach directly — see this
 * module's doc comment for why that's necessary (bypassing
 * `joinSessionView`'s own generator queue) and safe (each `LiveFrameSource`
 * call, including every `autoReconnect` reopen, produces a fresh
 * `AsyncIterable` per join.ts's own documented contract, so overwriting
 * `activeIterator` on each call always tracks the CURRENTLY open
 * connection).
 */
function cancelableLiveSource(inner: LiveFrameSource): { source: LiveFrameSource; cancelActive: () => void } {
  let activeIterator: AsyncIterator<unknown, void, void> | undefined;

  const source: LiveFrameSource = () => {
    const innerIterable = inner();
    return {
      [Symbol.asyncIterator]() {
        const iterator = innerIterable[Symbol.asyncIterator]();
        activeIterator = iterator;
        return iterator;
      },
    };
  };

  const cancelActive = (): void => {
    activeIterator?.return?.()?.catch?.(() => {});
    activeIterator = undefined;
  };

  return { source, cancelActive };
}

/** Wraps `inner` so every `readHistory()` call also carries `signal` — see this module's doc comment for why `joinSessionView` doesn't do this on its own. */
function abortableJournal(inner: JournalReader, signal: AbortSignal): JournalReader {
  return {
    readHistory: (sessionId: string, options?: ReadHistoryOptions) =>
      inner.readHistory(sessionId, { ...options, signal }),
  };
}

/**
 * Drives `joinSessionView(...)` and republishes each yielded `SessionView` as
 * `$state`. `journal` and `liveSource` are accepted as separate, narrow
 * dependencies (mirroring join.ts's own `JournalReader`/`LiveFrameSource`
 * split) rather than this store constructing them itself — a `LooprigTransport`
 * already structurally satisfies `JournalReader`, so a caller typically
 * passes the same transport it uses elsewhere; `liveSource` is expected to be
 * `createFetchLiveFrameSource(sessionId)` (live.ts) in real usage, or a fake
 * in tests. This keeps sdk/svelte's stated scope (the reactive-wrapper layer
 * only, no protocol/fetch-construction logic of its own) intact.
 */
export class LiveSessionViewStore {
  view = $state<SessionView>(emptySessionView());
  /** True from `start()` until the join ends (or `stop()` is called). */
  active = $state(false);
  /** Set when the join itself terminates abnormally (e.g. a non-reconnecting failure, or `autoReconnect: false` and the connection errored). Cleared at the start of the next `start()`. */
  error = $state<Error | null>(null);
  /** The most recent per-input fold failure (fold.ts's `FoldError`), if any — surfaced for diagnostics; does not stop the join (see fold.ts: a fold error is non-fatal, the loop keeps going). Not auto-cleared on a later successful event. */
  lastFoldError = $state<FoldError | null>(null);

  /** Bumped by every `start()`/`stop()` call; a running `pump()` loop checks this before committing state, so an old loop from a superseded start()/stop() cycle can never clobber a newer one's state — the same "discard the stale one" idea as session.svelte.ts's `RefreshGuard`, adapted for a long-running subscription instead of a single awaited call. */
  private generation = 0;
  private abortController: AbortController | undefined;
  private cancelActive: (() => void) | undefined;

  constructor(
    private readonly journal: JournalReader,
    private readonly sessionId: string,
    private readonly liveSource: LiveFrameSource,
    private readonly options: Omit<JoinOptions, "signal"> = {},
  ) {}

  /**
   * Starts consuming `joinSessionView(...)` and republishing each yielded
   * view. Idempotent: a no-op while already `active` (does not start a
   * second overlapping loop). Defaults `autoReconnect` to `true` (resilience
   * against a transient network drop is the point of a "live" store — a
   * caller that wants the old default can pass `autoReconnect: false`
   * explicitly); `signal` is always this store's own (see `stop()` and the
   * module doc comment) and cannot be overridden via `options`.
   */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.error = null;
    this.lastFoldError = null;
    // A fresh join starts from a fresh view (or the caller's own
    // `options.initialView`, mirroring `joinSessionView`'s own default) —
    // without this, `view` would keep showing whatever a PREVIOUS start()/
    // stop() cycle last folded until the new join happens to produce its own
    // first update to overwrite it.
    this.view = this.options.initialView ?? emptySessionView();
    const generation = ++this.generation;

    const abortController = new AbortController();
    this.abortController = abortController;

    const { source, cancelActive } = cancelableLiveSource(this.liveSource);
    this.cancelActive = cancelActive;

    const journal = abortableJournal(this.journal, abortController.signal);

    const generator = joinSessionView(journal, this.sessionId, source, {
      ...this.options,
      autoReconnect: this.options.autoReconnect ?? true,
      signal: abortController.signal,
    });

    void this.pump(generator, generation);
  }

  private async pump(generator: AsyncGenerator<JoinEvent, void, void>, generation: number): Promise<void> {
    try {
      for await (const event of generator) {
        if (generation !== this.generation) return; // superseded by a later stop()/start() cycle
        this.view = event.view;
        if (!event.ok) this.lastFoldError = event.error;
      }
    } catch (err) {
      if (generation !== this.generation) return;
      this.error = asError(err);
    } finally {
      if (generation === this.generation) this.active = false;
    }
  }

  /**
   * Stops the running join loop. Safe to call when not active (a no-op
   * beyond bumping the generation guard). See the module doc comment for
   * why this does more than call `.return()` on the join generator: it
   * synchronously aborts this store's own `AbortController` (preventing an
   * `autoReconnect` reopen once the cascade below completes) AND directly
   * cancels whichever live connection is currently open (via
   * `cancelActive()`, bypassing `joinSessionView`'s own generator so the
   * cancellation isn't stuck behind its request queue) — which is what
   * actually unblocks a pending read and tears down the underlying `fetch()`
   * promptly, not just detaches this store's own subscription to it.
   */
  stop(): void {
    this.generation += 1;
    this.active = false;
    this.abortController?.abort();
    this.cancelActive?.();
    this.abortController = undefined;
    this.cancelActive = undefined;
  }
}

/** Same rationale as session.svelte.ts's `asError`: every rejection this store can observe is already a real `Error`, but `strict`'s `unknown` catch type still needs narrowing without an `as`. */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}
