/**
 * A framework-neutral subscribe/notify store over `joinSessionView`.
 *
 * ## Why the store owns coalescing, and `join` does not
 *
 * Batching inside `join` would hide per-input granularity from non-UI
 * consumers and would swallow fold errors; batching inside components cannot
 * avoid tearing. So coalescing lives HERE, in notify — and ONLY in notify:
 * `fold` runs inside `joinSessionView`'s generator body, so a store that
 * throttled its PUMP rather than its NOTIFY would stop folding altogether and
 * freeze the transcript. `pump()` below therefore consumes the generator as
 * fast as it yields, and only the publication is scheduled.
 *
 * It coalesces STATE, not a queue: every notify publishes the CURRENT
 * snapshot, so a dropped intermediate frame is impossible — provided the last
 * one is always committed, which is what `finalize()` guarantees on stream
 * end, on error and on `stop()`.
 *
 * ## The snapshot reference is version-stamped, deliberately
 *
 * React's `useSyncExternalStore` throws "The result of getSnapshot should be
 * cached to avoid an infinite loop" if `snapshot()` returns a fresh object per
 * call. `published` is therefore replaced in exactly one place — `commit()` —
 * so the reference changes only at notify time and `version` is the cheap
 * equality key a consumer can memoise on.
 *
 * ## Teardown (carried from client/sdk/svelte's LiveSessionViewStore)
 *
 * join.ts documents that "a `.return()` call QUEUES BEHIND an already-in-flight
 * `.next()`", and `joinSessionView`'s steady state is parked at
 * `await queue.next()`. Calling `.return()` on the JOIN generator there never
 * unblocks it while the connection is idle — possibly for the rest of the
 * session. So `stop()`:
 *
 *  1. Aborts this store's own `AbortController` SYNCHRONOUSLY, before anything
 *     else, so `autoReconnect` never reopens once the cascade below completes.
 *  2. Calls `.return()` on the LIVE iterator directly, bypassing the join
 *     generator's request queue, which is what actually tears the fetch down.
 *
 * Neither piece alone suffices: the signal is never checked while parked
 * mid-await, and the direct cancellation alone looks to `join` like a plain
 * end-of-connection and triggers a reconnect.
 *
 * A generation counter, bumped by every `start()`/`stop()`, guards every state
 * commit, so a superseded pump loop can never clobber a newer cycle's state.
 */
import { emptySessionView, type FoldInput, type SessionView } from "./fold.js";
import {
  joinFactorySessionView,
  joinSessionView,
  type BindingState,
  type FactoryJoinEvent,
  type FactoryJoinLink,
  type FactoryJoinOptions,
  type FactoryJoinReads,
  type JoinEvent,
  type JoinOptions,
  type JournalReader,
  type LiveFrameSource,
} from "./join.js";
import type { ReadHistoryOptions } from "./transport.js";
import type { EphemeralPublication, FactorySessionStatus, PublicJournalPage } from "./types.js";

export interface FactorySessionViewSnapshot {
  readonly version: number;
  readonly generation: number;
  readonly coveredThrough: number;
  readonly status?: FactorySessionStatus;
  readonly event?: PublicJournalPage["events"][number];
  readonly ephemeral?: EphemeralPublication;
}

export interface FactorySessionViewStoreOptions {
  reads: FactoryJoinReads;
  link: FactoryJoinLink;
  tenantId: string;
  sessionId: string;
  initialCoveredThrough?: number;
  join?: Omit<FactoryJoinOptions, "initialCoveredThrough" | "signal">;
  /** Persist this value atomically; it may cover withheld private records. */
  persistCoveredThrough?: (coveredThrough: number) => void;
}

/** Application lifecycle owner for the Factory join and its durable cursor. */
export class FactorySessionViewStore {
  private readonly listeners = new Set<() => void>();
  private readonly errors = new Set<(error: Error) => void>();
  private controller: AbortController | undefined;
  private generation = 0;
  private lifecycleToken = 0;
  private coveredThrough: number;
  private published: FactorySessionViewSnapshot;

  constructor(private readonly options: FactorySessionViewStoreOptions) {
    this.coveredThrough = options.initialCoveredThrough ?? 0;
    this.published = { version: 0, generation: 0, coveredThrough: this.coveredThrough };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeErrors(listener: (error: Error) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  snapshot(): FactorySessionViewSnapshot { return this.published; }
  isActive(): boolean { return this.controller !== undefined; }

  start(): void {
    if (this.controller !== undefined) return;
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const token = ++this.lifecycleToken;
    const iterator = joinFactorySessionView(
      this.options.reads,
      this.options.link,
      this.options.tenantId,
      this.options.sessionId,
      {
        ...this.options.join,
        initialCoveredThrough: this.coveredThrough,
        signal: controller.signal,
      },
    );
    void this.pump(iterator, generation, token);
  }

  stop(): void {
    if (this.controller === undefined) return;
    this.lifecycleToken += 1;
    this.controller.abort();
    this.controller = undefined;
  }

  private async pump(iterator: AsyncGenerator<FactoryJoinEvent>, generation: number, token: number): Promise<void> {
    try {
      for await (const update of iterator) {
        if (token !== this.lifecycleToken) return;
        const base: FactorySessionViewSnapshot = {
          version: this.published.version + 1,
          generation,
          coveredThrough: update.coveredThrough,
          status: update.status,
        };
        this.published = update.kind === "public"
          ? { ...base, event: update.event }
          : update.kind === "ephemeral"
            ? { ...base, ephemeral: update.publication }
            : base;
        if (update.coveredThrough > this.coveredThrough) {
          this.coveredThrough = update.coveredThrough;
          this.options.persistCoveredThrough?.(update.coveredThrough);
        }
        for (const listener of [...this.listeners]) listener();
      }
    } catch (cause) {
      if (token === this.lifecycleToken) {
        const error = asError(cause);
        for (const listener of [...this.errors]) listener(error);
      }
    } finally {
      if (token === this.lifecycleToken) this.controller = undefined;
    }
  }
}

/**
 * Injectable frame scheduling, so a test never needs a real
 * `requestAnimationFrame` or a DOM, and a non-browser consumer can supply its
 * own cadence. `browserFrameScheduler()` is the default implementation.
 */
export interface FrameScheduler {
  /** Schedules `callback` for the next frame and returns a cancellable handle. */
  schedule(callback: () => void): number;
  cancel(handle: number): void;
  /** True while the host document is hidden and frames are not being served. */
  isHidden(): boolean;
  /** Subscribes to visibility changes; returns an unsubscribe. */
  onVisibilityChange(callback: () => void): () => void;
}

/**
 * One publication. `version` is monotonic and increments once per notify, so a
 * consumer can compare versions instead of the view; `view` is the current
 * accumulated `SessionView`.
 *
 * Retaining a snapshot across notifications is NOT supported: fold.ts's
 * immutability contract was deliberately narrowed so the append-only outer
 * arrays are appended IN PLACE (see fold.ts and design §3c). Individual ROWS
 * are copy-on-write and may be retained; the `SessionView` may not.
 */
export interface SessionViewSnapshot {
  readonly version: number;
  readonly view: SessionView;
}

export interface SessionViewStoreOptions {
  journal: JournalReader;
  sessionId: string;
  liveSource: LiveFrameSource;
  /**
   * Forwarded to `joinSessionView`. `signal` is always this store's own (see
   * `stop()`), and the queue bound is owned by `maxQueuedFrames` below so its
   * overflow lands on this store's error channel — all three are excluded from
   * the caller's reach rather than silently overridden.
   */
  join?: Omit<JoinOptions, "signal" | "maxQueuedFrames" | "onQueueOverflow" | "onBindingState">;
  /**
   * Upper bound on live frames buffered ahead of the fold. Defaults to
   * `DEFAULT_MAX_QUEUED_FRAMES`.
   *
   * Evicting an EPHEMERAL frame is reported on `subscribeErrors`, on a doubling
   * schedule; see `selectFrameToDrop` for which frames that policy may touch.
   * A backlog of DURABLE frames is not evicted at all — the binding transitions
   * to `repair_required` (see `subscribeBindingState`) and re-reads from its
   * last committed journal sequence.
   */
  maxQueuedFrames?: number;
  scheduler?: FrameScheduler;
}

export class SessionViewStore {
  private readonly options: SessionViewStoreOptions;
  private readonly scheduler: FrameScheduler;
  private readonly listeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly lifecycleListeners = new Set<(active: boolean) => void>();
  private readonly bindingListeners = new Set<(state: BindingState) => void>();

  private current: SessionView = emptySessionView();
  private published: SessionViewSnapshot;
  private dirty = false;
  private frame: number | undefined;

  private generation = 0;
  private active = false;
  private abortController: AbortController | undefined;
  private cancelActive: (() => void) | undefined;
  private offVisibility: (() => void) | undefined;
  /**
   * The next cumulative drop count worth reporting. Overflow is reported on a
   * DOUBLING schedule — the 1st, 2nd, 4th, 8th ... dropped frame — rather than
   * once per drop: a sustained overload drops thousands of frames, and
   * notifying a subscriber thousands of times on an already-overloaded main
   * thread makes the very condition being reported worse. The count is
   * cumulative, so each report supersedes the last and nothing is understated,
   * and the number of reports stays logarithmic in the size of the gap.
   */
  private nextOverflowReport = 1;
  /** True while an urgent microtask flush is already queued. */
  private urgentFlush = false;
  /** True once a publication reflects a completed run, so `start()` knows to reset it. */
  private stalePublication = false;
  /**
   * This binding's live-plane state. `repair_required` from the moment the live
   * buffer refused to drop durable content until the repairing connection's
   * cold read has come back from the last committed sequence.
   */
  private binding: BindingState = "live";
  /**
   * Repair episodes so far, and the next one worth echoing on the error
   * channel. Reported on the SAME doubling schedule `nextOverflowReport` uses —
   * the 1st, 2nd, 4th, 8th episode — and for the same reason.
   *
   * The transitions themselves are NOT damped: a flapping binding really is
   * flapping, and a state channel that lied about it would be worse than
   * noisy. What is damped is the error-channel echo, because a binding whose
   * backlog cannot be repaired away re-enters the episode once per reconnect,
   * and an unthrottled echo of that is a notification storm on an already
   * overloaded main thread. Measured before this: 8 `LiveQueueOverflowError`s
   * in two seconds at the default reconnect cadence.
   */
  private repairEpisodes = 0;
  private nextRepairReport = 1;

  constructor(options: SessionViewStoreOptions) {
    this.options = options;
    this.scheduler = options.scheduler ?? browserFrameScheduler();
    this.published = { version: 0, view: this.current };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribes to fold and join errors. Returns an unsubscribe.
   *
   * Fold errors are EVENTS, not state. Coalescing state would hide them exactly
   * as batching inside `join` would: two errors inside one frame would collapse
   * to one observable value, and an error immediately followed by a success
   * would vanish entirely — the view published at the end of the frame carries
   * no trace of it. So this channel is deliberately NOT coalesced: every error
   * is delivered synchronously, in order, at the moment it is folded.
   *
   * A `FoldError` is non-fatal — fold.ts's contract is that the loop keeps
   * going past one bad input — so the store stays active. A FATAL join failure
   * (a rejected `readHistory`, or a live iterator that threw with
   * `autoReconnect` off) arrives on this same channel as a plain `Error` and IS
   * followed by the store going inactive; `isActive()` is how a consumer tells
   * the two apart, and `instanceof FoldError` is how it classifies them.
   */
  subscribeErrors(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /**
   * Subscribes to LIVENESS transitions: `true` when a join starts, `false` when
   * it ends — by `stop()`, by the live stream ending with `autoReconnect` off,
   * or by a terminal join failure. Returns an unsubscribe.
   *
   * `isActive()` alone is not enough, and neither is `subscribe`. `commit()` is
   * a no-op when nothing is dirty, so a stream that ends cleanly with no
   * pending update leaves the store inactive having notified nobody; a
   * connection indicator built on the notify channel would read "live"
   * indefinitely. Measured before this channel existed: a clean end produced
   * zero notifies and zero errors.
   *
   * Fires only on a REAL transition — an idempotent `start()` and a `stop()`
   * while already inactive say nothing — and, like `subscribeErrors`, is not
   * coalesced: a transition is an event.
   *
   * ORDERING, which is what a consumer classifies on: a terminal join failure
   * is delivered on `subscribeErrors` FIRST, while `isActive()` is still true,
   * and the `false` transition follows. So reading `isActive()` from inside an
   * error listener reports "non-fatal" even for a fatal failure — the two
   * channels have to be combined, not either used alone.
   */
  subscribeLifecycle(listener: (active: boolean) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  /**
   * Subscribes to this binding's live-plane state. Returns an unsubscribe.
   *
   * This is a THIRD channel, and it is neither of the other two on purpose. It
   * is not view state: a view carries no trace of a frame that was never
   * applied, so a repair coalesced into the snapshot would be invisible by
   * construction. It is not a fold error either: nothing was malformed, and the
   * join keeps running. What it reports is that this binding's live buffer
   * refused to drop durable content, discarded its buffer UNAPPLIED, and is
   * re-reading from the last committed journal sequence.
   *
   * Per BINDING, never global: a store holding one session's join announces
   * only its own state, so a consumer with several never has to infer which one
   * degraded. Fires only on a REAL transition and, like `subscribeErrors`, is
   * not coalesced.
   *
   * `repair_required` is ALSO announced on `subscribeErrors` as a
   * `LiveQueueOverflowError`, because a repair a user cannot see is
   * indistinguishable from a session that quietly stopped catching up.
   *
   * THIS CHANNEL FLAPS, and a consumer must expect it to. A binding whose
   * backlog cannot be repaired away re-enters the episode once per reconnect,
   * and nothing here suppresses that: the state channel's job is to be true,
   * not quiet.
   *
   * What bounds the RATE is one thing, and it is worth naming precisely because
   * two earlier versions of this paragraph named bounds that did not bind. The
   * first said the channel "cannot storm" because the join announces at most
   * once per episode — true, and irrelevant, since episodes recur. The second
   * said `maxRepairAttempts` and a doubling backoff bounded it — both clauses
   * true, neither binding, because the streak counter reset on journal cursor
   * movement and a session busy enough to overflow is a session whose journal
   * is advancing. Measured on that path: 783 episodes per second.
   *
   * The bound that binds is the floor: EVERY refusal reconnect waits at least
   * `JoinOptions.reconnectDelayMs`, doubling while refusals repeat with no
   * recovery in between, and `JoinOptions.maxRepairAttempts` counts those same
   * refusals and gives up. Re-measured on the busy path: 3 episodes per second.
   *
   * The error ECHO is damped further, on the same doubling schedule
   * `onQueueOverflow` uses, so notification cost stays logarithmic in the
   * number of episodes even while this channel reports every one of them.
   */
  subscribeBindingState(listener: (state: BindingState) => void): () => void {
    this.bindingListeners.add(listener);
    return () => {
      this.bindingListeners.delete(listener);
    };
  }

  /** This binding's live-plane state. See `subscribeBindingState`. */
  bindingState(): BindingState {
    return this.binding;
  }

  /** The current published snapshot. Its reference changes only at notify. */
  snapshot(): SessionViewSnapshot {
    return this.published;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Starts consuming `joinSessionView` and publishing each accumulated view.
   * Idempotent: a no-op while already active, so it never starts a second
   * overlapping pump. `autoReconnect` defaults to `true` — riding out a
   * transient network drop is the point of a live store.
   */
  start(): void {
    if (this.active) return;
    this.setActive(true);
    this.current = this.options.join?.initialView ?? emptySessionView();
    if (this.stalePublication) {
      // Publish the reset, do not merely stage it: snapshot() is what a
      // useSyncExternalStore consumer renders, and leaving the PREVIOUS
      // cycle's rows visible until the new join happens to produce its own
      // first update is a stale transcript for an unbounded time. Skipped
      // when nothing has ever been published, so a first start() neither
      // notifies nor invalidates the initial snapshot reference.
      this.dirty = true;
      this.finalize();
      this.stalePublication = false;
    }
    this.nextOverflowReport = 1;
    this.repairEpisodes = 0;
    this.nextRepairReport = 1;
    const generation = ++this.generation;
    // Read ONCE. Both the join's option and the error-echo guard below depend
    // on this value, and deriving it twice means a change to the default
    // silently stops the echo instead of failing anything.
    const autoReconnect = this.options.join?.autoReconnect ?? true;

    const abortController = new AbortController();
    this.abortController = abortController;

    const { source, cancelActive } = cancelableLiveSource(this.options.liveSource);
    this.cancelActive = cancelActive;

    // A frame scheduled just before the tab hides NEVER fires and never falls
    // through, which would freeze the transcript and any open permission gate
    // indefinitely. Cancel the pending handle and re-schedule on whichever
    // timer the NEW visibility state selects. Switching schedulers without
    // cancelling is not enough: the dead handle would still be this store's
    // `frame`, so publish() would treat a frame as already scheduled and never
    // ask for another.
    this.offVisibility = this.scheduler.onVisibilityChange(() => {
      if (this.frame === undefined) return;
      this.scheduler.cancel(this.frame);
      this.frame = undefined;
      if (this.dirty) this.publish();
    });

    const generator = joinSessionView(
      abortableJournal(this.options.journal, abortController.signal),
      this.options.sessionId,
      source,
      {
        ...this.options.join,
        autoReconnect,
        signal: abortController.signal,
        ...(this.options.maxQueuedFrames === undefined
          ? {}
          : { maxQueuedFrames: this.options.maxQueuedFrames }),
        onQueueOverflow: (droppedTotal) => {
          if (generation !== this.generation || droppedTotal < this.nextOverflowReport) return;
          this.nextOverflowReport = droppedTotal * 2;
          this.emitError(
            new Error(`live frame queue overflow: ${droppedTotal} live frame(s) dropped`),
          );
        },
        onBindingState: (state, cause) => {
          // Generation-guarded exactly like every other callback here: a
          // superseded join must not be able to flip a state a newer cycle owns.
          if (generation !== this.generation) return;
          // The error echo is gated on the TRANSITION, never on a repeat of a
          // state already held, so it cannot storm on a binding that is already
          // repairing.
          if (!this.setBindingState(state) || cause === undefined) return;
          // Echoed only when the join will SWALLOW the refusal. With
          // `autoReconnect` off it does not: the same error object propagates
          // out of the generator and the pump's own catch surfaces it, so
          // echoing here too would deliver one failure twice.
          if (!autoReconnect) return;
          this.repairEpisodes += 1;
          if (this.repairEpisodes < this.nextRepairReport) return;
          this.nextRepairReport = this.repairEpisodes * 2;
          this.emitError(cause);
        },
      },
    );
    void this.pump(generator, generation);
  }

  /**
   * Stops the running join. Safe when not active (a no-op beyond bumping the
   * generation guard). See the module comment for why this does far more than
   * `.return()` the join generator.
   */
  stop(): void {
    this.generation += 1;
    this.setActive(false);
    this.abortController?.abort();
    this.cancelActive?.();
    this.abortController = undefined;
    this.cancelActive = undefined;
    this.offVisibility?.();
    this.offVisibility = undefined;
    this.finalize();
  }

  private async pump(generator: AsyncGenerator<JoinEvent, void, void>, generation: number): Promise<void> {
    try {
      // Deliberately unthrottled: fold() runs inside the generator body, so
      // pausing here would stop the fold, not just the render.
      for await (const event of generator) {
        if (generation !== this.generation) return; // superseded by a newer cycle
        this.current = event.view;
        if (!event.ok) this.emitError(event.error);
        this.publish();
        if (isLatencyCritical(event.input)) this.flushSoon();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.emitError(asError(error));
    } finally {
      if (generation === this.generation) {
        this.setActive(false);
        this.offVisibility?.();
        this.offVisibility = undefined;
        this.finalize();
      }
    }
  }

  /**
   * The ONE place `binding` is written, so every transition is announced
   * exactly once and a no-op assignment announces nothing. Returns whether the
   * state actually moved, which is what gates the error-channel echo at the
   * call site.
   */
  private setBindingState(state: BindingState): boolean {
    if (this.binding === state) return false;
    this.binding = state;
    for (const listener of [...this.bindingListeners]) listener(state);
    return true;
  }

  private emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }

  /**
   * The ONE place `active` is written, so every transition is announced exactly
   * once and a no-op assignment announces nothing. Copies the listener set
   * before iterating, for the same reason `commit()` does: a listener that
   * subscribes from inside a notify would otherwise be invoked re-entrantly for
   * a transition that happened before it subscribed.
   */
  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    // The binding state follows liveness, because a state that outlives the
    // join it describes is stale by construction: before this, a store that
    // stopped while repairing reported `repair_required` forever, and a badge
    // wired to `subscribeBindingState` alone had no way to know nothing was
    // still repairing. `isActive()` disambiguated it, but only for a consumer
    // that knew to combine the two channels.
    this.setBindingState(active ? "live" : "inactive");
    for (const listener of [...this.lifecycleListeners]) listener(active);
  }

  /** Marks state dirty and schedules at most one notify per frame. */
  private publish(): void {
    this.dirty = true;
    if (this.frame !== undefined) return;
    this.frame = this.scheduler.schedule(() => {
      this.frame = undefined;
      this.commit();
    });
  }

  /** Publishes the CURRENT snapshot and notifies. A no-op when nothing changed. */
  private commit(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.stalePublication = true;
    this.published = { version: this.published.version + 1, view: this.current };
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Commits at the end of the current microtask checkpoint rather than on the
   * next frame. Used for latency-critical input only (see `isLatencyCritical`),
   * and coalesced with itself so a burst of them costs one commit.
   */
  private flushSoon(): void {
    if (this.urgentFlush) return;
    this.urgentFlush = true;
    const generation = this.generation;
    queueMicrotask(() => {
      this.urgentFlush = false;
      if (generation !== this.generation) return;
      this.finalize();
    });
  }

  /** Cancels any pending frame and commits immediately. */
  private finalize(): void {
    if (this.frame !== undefined) {
      this.scheduler.cancel(this.frame);
      this.frame = undefined;
    }
    this.commit();
  }
}

/**
 * Captures each connection's iterator so `stop()` can cancel it directly.
 *
 * Every `LiveFrameSource` call — the first, and every `autoReconnect` reopen —
 * produces a fresh iterable per join.ts's contract, so overwriting
 * `activeIterator` always tracks the currently open connection.
 */
function cancelableLiveSource(inner: LiveFrameSource): { source: LiveFrameSource; cancelActive: () => void } {
  let activeIterator: AsyncIterator<unknown, void, void> | undefined;
  const source: LiveFrameSource = () => {
    const iterable = inner();
    return {
      [Symbol.asyncIterator]() {
        const iterator = iterable[Symbol.asyncIterator]();
        activeIterator = iterator;
        return iterator;
      },
    };
  };
  return {
    source,
    cancelActive: () => {
      activeIterator?.return?.()?.catch?.(() => {});
      activeIterator = undefined;
    },
  };
}

/**
 * True for input that must not wait for a frame.
 *
 * A LIVE enduring frame is durable, low-rate and latency-critical: every gate
 * transition is one, and a permission gate the user has to answer must not sit
 * behind a scheduler hop (16 ms visible, 33 ms hidden, and unbounded if the
 * frame is stranded by a visibility change). Ephemeral deltas are the
 * high-frequency ones and stay coalesced, and so does the COLD history replay —
 * that is thousands of enduring events on the open-a-finished-session path, and
 * flushing per event there would defeat coalescing on exactly the path it
 * exists for.
 */
function isLatencyCritical(input: FoldInput): boolean {
  return input.segment === "live" && input.frame.type === "enduring";
}

/** Narrows a `catch`'s `unknown` without an `as`; every rejection here is already an Error. */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

/** `joinSessionView` does not thread a signal into `readHistory`; this does. */
function abortableJournal(inner: JournalReader, signal: AbortSignal): JournalReader {
  return {
    readHistory: (sessionId: string, options?: ReadHistoryOptions) =>
      inner.readHistory(sessionId, { ...options, signal }),
  };
}

/**
 * About 30 Hz — the cadence a hidden tab publishes at. Fast enough that a gate
 * or a completed turn is visible the moment the user comes back, slow enough
 * that a backgrounded session is not burning a core.
 */
const HIDDEN_FRAME_MS = 33;

/**
 * `requestAnimationFrame` while the tab is visible; a ~33 ms timer while it is
 * hidden.
 *
 * A hidden tab's rAF is throttled to a standstill in every browser — a callback
 * scheduled just before the tab hides never fires AT ALL — so a store that only
 * ever used rAF would stop publishing the moment the user switched tabs and
 * would not resume until they came back. `document.hidden` is re-read on every
 * `schedule()`, so one scheduler instance spans a visibility change correctly.
 */
export function browserFrameScheduler(): FrameScheduler {
  const doc = (): Document | undefined => (typeof document === "undefined" ? undefined : document);
  const hidden = (): boolean => doc()?.hidden === true;
  return {
    schedule(callback) {
      if (hidden() || typeof requestAnimationFrame !== "function") {
        return setTimeout(callback, HIDDEN_FRAME_MS) as unknown as number;
      }
      return requestAnimationFrame(callback);
    },
    cancel(handle) {
      // Cancel through BOTH: the handle may have been minted by either path and
      // the two id spaces are independent, so cancelling only one leaves a live
      // callback that publishes after teardown. Handing a foreign handle to
      // either canceller is a silent no-op, so doing both is always safe.
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
      clearTimeout(handle);
    },
    isHidden: hidden,
    onVisibilityChange(callback) {
      const target = doc();
      if (target === undefined) return () => {};
      const handler = (): void => {
        callback();
      };
      target.addEventListener("visibilitychange", handler);
      return () => {
        target.removeEventListener("visibilitychange", handler);
      };
    },
  };
}
