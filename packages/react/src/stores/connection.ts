import { FoldError, type SessionViewStore } from "@looprig/client";
import type { ClientLink, ClientSubscription, FactoryPublication, SessionReset, SubscribeOptions } from "@looprig/client";
import { asError, cancelOnce, Publisher, RefreshGuard } from "./publisher.js";

export type ConnectionState = "idle" | "live" | "closed" | "failed";

export interface ConnectionStatus {
  /**
   * `"idle"` before the join starts, `"live"` while it is running, `"closed"`
   * once it ended without a failure, `"failed"` once a failure ended it.
   *
   * `"idle"` and `"closed"` are both "not connected, nothing went wrong": a
   * hook that attaches to an already-stopped store reports `"idle"`, because
   * the store carries no history of why it is not running.
   */
  readonly state: ConnectionState;
  readonly connected: boolean;
  /** The error that ENDED the join. Non-null only in `"failed"`. */
  readonly failure: Error | null;
  /**
   * The most recent NON-FATAL error: an input the fold skipped, or live frames
   * the queue dropped under backpressure. The join kept going past it.
   */
  readonly lastWarning: Error | null;
  /** How many non-fatal errors have been reported since this store attached. */
  readonly warningCount: number;
}

const IDLE: ConnectionStatus = {
  state: "idle",
  connected: false,
  failure: null,
  lastWarning: null,
  warningCount: 0,
};

/**
 * Classifies a `SessionViewStore`'s two out-of-band channels into one reactive
 * connection status.
 *
 * ## Why the classification needs both channels
 *
 * `subscribeErrors` carries three different things and does not label them:
 *
 *  - a `FoldError`, which fold.ts's contract says is NON-FATAL — the join skips
 *    one bad input and keeps going;
 *  - a live-frame-queue overflow, also non-fatal — frames were dropped;
 *  - the failure that terminated the join, which is followed by the store going
 *    inactive.
 *
 * Collapsing all three into one `error` field would tell a renderer to tear the
 * transcript down for a single malformed delta. So a `FoldError` is recorded as
 * a warning immediately, by contract, and anything else is held as a CANDIDATE:
 * the store emits a terminal failure and goes inactive in the same synchronous
 * turn (pinned by `protocol/test/store-lifecycle.test.ts`), so if the
 * liveness transition arrives before the candidate's own microtask, that error
 * ended the join; if the microtask wins, nothing ended and it was a warning.
 *
 * The residual ambiguity is exactly one case: a non-`FoldError` warning
 * followed by an explicit `stop()` inside the same microtask turn would be
 * reported as the failure. `stop()` comes from a React cleanup and an overflow
 * from the pump, so they are never in the same turn in practice, and the
 * mislabel would be a stopped connection shown with a real error attached.
 *
 * ## Why liveness cannot come from the notify channel
 *
 * `commit()` is a no-op when nothing is dirty, so a stream that ends cleanly
 * with no pending update notifies nobody. That is what
 * `SessionViewStore.subscribeLifecycle` exists for.
 *
 * Nothing in this file imports React.
 */
export class SessionConnectionStore extends Publisher<ConnectionStatus> {
  readonly #view: SessionViewStore;
  /** A non-`FoldError` awaiting classification; see the class comment. */
  #candidate: Error | undefined;

  constructor(view: SessionViewStore) {
    super(IDLE);
    this.#view = view;
  }

  /**
   * Subscribes to both channels and returns an unsubscribe. Construction is
   * side-effect-free, so a StrictMode double-invoke that discards one store
   * costs nothing; all subscription happens here, from an effect.
   */
  attach(): () => void {
    if (this.#view.isActive()) this.publish({ state: "live", connected: true, failure: null });

    const offErrors = this.#view.subscribeErrors((error) => {
      if (error instanceof FoldError) {
        this.#warn(error);
        return;
      }
      this.#candidate = error;
      queueMicrotask(() => {
        const candidate = this.#candidate;
        if (candidate === undefined) return;
        this.#candidate = undefined;
        this.#warn(candidate);
      });
    });

    const offLifecycle = this.#view.subscribeLifecycle((active) => {
      if (active) {
        this.publish({ state: "live", connected: true, failure: null });
        return;
      }
      const failure = this.#candidate;
      this.#candidate = undefined;
      this.publish(
        failure === undefined
          ? { state: "closed", connected: false }
          : { state: "failed", connected: false, failure },
      );
    });

    return () => {
      offErrors();
      offLifecycle();
      this.#candidate = undefined;
    };
  }

  #warn(error: Error): void {
    this.publish({ lastWarning: error, warningCount: this.snapshot().warningCount + 1 });
  }
}

/** The application-scoped link's own state, independent of any one session. */
export type FactoryLinkState = "idle" | "connecting" | "connected" | "failed";

export interface FactoryLinkStatus {
  readonly state: FactoryLinkState;
  readonly connected: boolean;
  /** The error that ended the last connect attempt. Non-null only in `"failed"`. */
  readonly failure: Error | null;
  /** How many session bindings are currently open on this link. */
  readonly bindingCount: number;
}

const LINK_IDLE: FactoryLinkStatus = {
  state: "idle",
  connected: false,
  failure: null,
  bindingCount: 0,
};

export interface SessionBindingOptions {
  tenantId: string;
  sessionId: string;
  /** Greatest journal sequence the view has already durably applied. */
  cursor?: number;
  onPublication(publication: FactoryPublication): void;
  onReset(reset: SessionReset): void;
  /**
   * Called once, when this binding's FIRST subscription is authorized, with the
   * cursor at that moment. `onRejoin` covers every later one, so between them
   * every authorization has exactly one callback and no callback covers two
   * cases.
   *
   * This exists because a cold-read + join state machine has to sequence
   * subscribe -> read the durable plane -> reconcile, and the first subscribe
   * is precisely the one `onRejoin` does not report. A view that timed the read
   * instead would either read before it was subscribed (and lose whatever
   * committed in between) or wait for no reason.
   */
  onJoin?(cursor: number): void;
  /**
   * Called once each time this binding is re-authorized on a NEW connection,
   * with the cursor at that moment. This is the view's signal to repair the
   * span it may have missed through `FactoryReads` — the link cannot replay it.
   */
  onRejoin?(cursor: number): void;
  /**
   * Every error this binding sees, including the one that ended its
   * subscription. A binding whose subscription ends while the CONNECTION
   * survives is left down deliberately — see `#onBindingError` — and is
   * rejoined by the next connection, not by a retry against this one.
   */
  onError?(error: Error): void;
}

/** One session view's whole share of the connection plane. */
export interface SessionBinding {
  readonly sessionId: string;
  readonly cursor: number;
  /** Records durable coverage. Monotonic: a lower sequence is ignored. */
  advance(sequence: number): void;
  /** Idempotent. See `cancelOnce` in `publisher.ts` for why that matters. */
  cancel(): void;
}

interface BindingRecord {
  readonly options: SessionBindingOptions;
  cursor: number;
  cancelled: boolean;
  /** Releases the CURRENT subscription, at most once for that subscription. */
  release: (() => void) | undefined;
  /** The link generation this binding has already attempted to subscribe on. */
  attemptedGeneration: number;
  /** True once this binding has subscribed at least once; a later one rejoins. */
  joined: boolean;
  subscription: ClientSubscription | undefined;
  authorize(): void;
  reject(error: Error): void;
  cancel(): void;
}

/**
 * Owns one `ClientLink` for the whole application and hands each session view a
 * binding over it.
 *
 * ## Why the link cannot belong to the session view
 *
 * A `ClientLink` is one WebSocket. A route-scoped link means one socket per open
 * session, a fresh version negotiation and a fresh authorization per route
 * change, and — under React StrictMode, whose whole purpose is to run a mount,
 * an unmount and a second mount — a real chance of two live sockets where the
 * code reads as if there is one. So the link is constructed above the route and
 * this store is what a view is given: `bind()` in, publications out.
 *
 * ## The three properties this class exists to hold
 *
 *  - **One connect per loss, not one per binding.** Every binding observes the
 *    same disconnection and every one of them asks to recover; `#ensureConnected`
 *    coalesces those into a single in-flight `link.connect()`.
 *  - **Each binding rejoins on its own.** A session the server declines to
 *    re-authorize fails alone: its peers stay subscribed and keep delivering.
 *  - **Every binding is cancelled exactly once.** Teardown and the view's own
 *    cleanup both cancel, in an order React does not fix, so the guard is in the
 *    binding rather than in either caller.
 *
 * Nothing in this file imports React.
 */
export class FactoryLinkStore extends Publisher<FactoryLinkStatus> {
  readonly #link: ClientLink;
  readonly #bindings = new Set<BindingRecord>();
  /**
   * Increments once per established connection. A binding subscribes at most
   * once per generation, which is what bounds recovery: a session the server
   * will not authorize retries when — and only when — a NEW connection exists.
   *
   * Zero is therefore not just "no connection yet", it is a value no binding may
   * ever see: `BindingRecord.attemptedGeneration` starts at 0, so a `#join` that
   * ran at generation 0 would compare `0 === 0` and return without subscribing.
   * That is why `#ensureConnected`'s already-connected fast path also requires
   * `#generation > 0` — see there.
   */
  #generation = 0;
  /**
   * Which connect attempt the store is still willing to hear from. Read on BOTH
   * settlement paths of an interrupted connect. `ClientLink.disconnect` REJECTS
   * a pending connect, so the attempt a close interrupts settles just after it
   * and the store would end up `"failed"` after a clean close. The success path
   * is not the same case: a connect cannot resolve after a close, but its
   * already-queued reaction can still RUN after one, which would leave the store
   * `"connected"` over a disconnected link.
   *
   * This is `RefreshGuard`'s exact shape — a last-starter wins over an earlier
   * call's late result — so it is `RefreshGuard`, not a second hand-rolled
   * counter. It cannot be merged with `#generation`: that one counts
   * ESTABLISHED connections and is read out by `#join` and stored per binding,
   * neither of which `RefreshGuard` offers, and a single counter bumped by
   * `close()` as well would advance the "one subscribe per connection" bound
   * without a new connection existing behind it.
   */
  readonly #epoch = new RefreshGuard();
  #connecting: Promise<boolean> | undefined;

  constructor(link: ClientLink) {
    super(LINK_IDLE);
    this.#link = link;
  }

  /**
   * Connects eagerly. Idempotent because `#ensureConnected` is, and NOT a
   * precondition of `bind()`: React runs a child's effect before its parent's,
   * so the first binding routinely arrives before the provider that owns this
   * store has opened it.
   */
  open(): void {
    void this.#ensureConnected();
  }

  /**
   * Cancels every binding exactly once, then drops the connection.
   *
   * The set is emptied BEFORE the cancels rather than after, and the order is
   * load-bearing: `record.cancel` re-enters this store through
   * `#redriveChannelPeers`, so with the set still populated the first cancel
   * sent a surviving peer at `#join` -> `#ensureConnected`, which found
   * `#connecting` already cleared and the link not yet disconnected and started
   * a SECOND `link.connect()` on a fresh epoch. The `disconnect()` below then
   * rejected it, and because that epoch was current the store published
   * `"failed"` after publishing `"idle"` — the exact outcome `#epoch` exists to
   * prevent, reached from inside rather than from a stale caller. Emptying
   * first leaves the re-drive scan nothing to find.
   */
  close(): void {
    this.#epoch.start();
    this.#connecting = undefined;
    const bindings = [...this.#bindings];
    this.#bindings.clear();
    for (const record of bindings) record.cancel();
    this.#link.disconnect();
    this.publish({ state: "idle", connected: false, failure: null, bindingCount: 0 });
  }

  /** Protocol owns repair generations; this store owns the shared connection. */
  bindSubscription(options: SubscribeOptions): ClientSubscription {
    return this.bind({
      ...options,
      onRejoin: () => options.onError?.(new Error("factory subscription reauthorized; durable repair required")),
    });
  }

  bind(options: SessionBindingOptions): SessionBinding & ClientSubscription {
    let authorize!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, fail) => { authorize = resolve; reject = fail; });
    // Legacy bindings do not consume readiness; their callbacks still report errors.
    void ready.catch(() => {});
    const record: BindingRecord = {
      options,
      cursor: options.cursor ?? 0,
      cancelled: false,
      release: undefined,
      attemptedGeneration: 0,
      joined: false,
      subscription: undefined,
      authorize,
      reject,
      cancel: () => {},
    };
    record.cancel = cancelOnce(() => {
      record.cancelled = true;
      record.reject(new Error("factory binding cancelled"));
      this.#bindings.delete(record);
      // Only a record that actually HELD the channel frees one, so only that
      // record may drive a peer at it. A cancelling loser frees nothing, and
      // sending its fellow loser at a channel the winner still holds throws and
      // reports a second error for a subscription that never changed hands.
      if (this.#release(record)) this.#redriveChannelPeers(record);
      this.publish({ bindingCount: this.#bindings.size });
    });
    this.#bindings.add(record);
    this.publish({ bindingCount: this.#bindings.size });
    void this.#join(record);
    return {
      ready,
      get state() { return record.cancelled ? "unsubscribed" : record.subscription?.state ?? "subscribing"; },
      get version() { return record.subscription?.version; },
      unsubscribe: record.cancel,
      get sessionId(): string {
        return options.sessionId;
      },
      get cursor(): number {
        return record.cursor;
      },
      advance: (sequence: number): void => {
        if (sequence > record.cursor) record.cursor = sequence;
      },
      cancel: record.cancel,
    };
  }

  /**
   * Take-and-clear: the release is read out of the record and the slot emptied
   * BEFORE it is invoked, so no two callers can unsubscribe the same
   * subscription twice, in either order.
   *
   * Counting the CALLERS of this method is not enough, and enumerating them was
   * how a live subscription came to be stranded. The slot has three writers:
   * `bind` initialises it to `undefined`, this method empties it, and `#join`
   * FILLS it after every subscribe — and `#join` runs again for a binding on
   * every new connection, not only for one whose subscription has ended. A
   * `#join` that assigned over a slot still holding a live release would leave
   * that subscription open with no way to reach it, so `#join` calls this first
   * and the three writers stay disjoint.
   *
   * The callers, for the record, are a cancellation, a subscription error that
   * triggers a rejoin, and that rejoin itself.
   *
   * Returns whether this call is the one that freed the channel — which it does
   * even if the underlying `unsubscribe` throws, because the slot is emptied
   * before the call and no second caller can reach that subscription again.
   * Both release paths that END a binding's hold — a cancellation and a subscription error —
   * use it to decide whether a peer may now be driven at that channel; a caller
   * that released nothing has made nothing available.
   */
  #release(record: BindingRecord): boolean {
    const release = record.release;
    record.release = undefined;
    if (release === undefined) return false;
    try {
      release();
    } catch {
      // A throwing `unsubscribe` used to escape `record.cancel`, and from there
      // the cancel loop in `close()`: `#link.disconnect()` never ran, the
      // remaining bindings were never cancelled, and the `"idle"` publish never
      // happened — leaving the store reporting a connection over a link nobody
      // would ever close. The slot is already emptied above, so the channel is
      // released as far as this store is concerned either way; what a failed
      // `unsubscribe` costs is the link's own registry entry, which is the
      // link's to report, not this store's to abort a teardown over.
    }
    return true;
  }

  /**
   * Re-drives any binding on `released`'s channel that lost the race for it.
   *
   * `bind()` is not keyed by session, so two mounted views of one session are
   * two records competing for a channel the link permits ONE subscription on.
   * The loser's `#join` threw, reported through `onError` and left
   * `attemptedGeneration` set — deliberately, because retrying against a
   * channel the winner still holds would only throw again. The consequence is
   * that the loser recovers only across a NEW CONNECTION, so a winner that
   * simply unmounts (a route change, a StrictMode remount) frees the channel
   * and nothing re-drives the loser: it stays silent, uncancelled, and counted
   * in `bindingCount`, for as long as the link stays up.
   *
   * The release is what makes the channel available, so every path that ends a
   * binding's hold calls this: a cancellation and `#onBindingError`. Both, not
   * one — a winner whose subscription merely FAILS hands the channel back
   * without anybody unmounting, and for as long as only the cancel path
   * re-drove, that case left the loser silent exactly as before.
   * `attemptedGeneration` is reset to 0 rather than
   * decremented: 0 is the value no live generation ever takes (see
   * `#generation`), so `#join` cannot mistake it for an attempt already made.
   *
   * Only a record that has NEVER subscribed is eligible. `joined` is set the
   * moment `subscribe` returns, so a binding whose subscription was authorized
   * and later failed is not a loser and must keep the one-attempt-per-
   * connection bound that stops a declining Factory being retried in a loop.
   */
  #redriveChannelPeers(released: BindingRecord): void {
    for (const record of [...this.#bindings]) {
      // A record is never its own peer. The cancel path has already removed it
      // from the set; `#onBindingError` has not, and a record that re-drove
      // itself from its own error handler would subscribe, be declined,
      // release and re-drive again on one connection, forever.
      //
      // Redundant today, and said so rather than implied: `release` is written
      // only where `joined` is, so a released record always satisfies the
      // `joined` skip below and this line changes no outcome — removing it
      // alone fails nothing. It is kept because the scan then states its own
      // precondition instead of inheriting it from two fields happening to be
      // written together, and because that coincidence is what turned dropping
      // the `joined` skip into a hang rather than a failure.
      if (record === released) continue;
      if (record.cancelled || record.joined) continue;
      if (record.options.tenantId !== released.options.tenantId) continue;
      if (record.options.sessionId !== released.options.sessionId) continue;
      record.attemptedGeneration = 0;
      void this.#join(record);
    }
  }

  /**
   * Resolves true once a connection exists. Concurrent callers share one
   * attempt: `#connecting` is assigned in the same synchronous turn as the
   * `link.connect()` that produced it, so a burst of bindings reacting to one
   * disconnection cannot each start their own.
   */
  #ensureConnected(): Promise<boolean> {
    if (this.#connecting !== undefined) return this.#connecting;
    // `#generation > 0` is load-bearing, not defensive. A store constructed over
    // a link something else already connected would otherwise take this fast
    // path with `#generation` still 0, and every `#join` would then find
    // `record.attemptedGeneration === 0 === generation` and return without
    // subscribing — no binding on that store would ever open. Pinned by
    // "a link that is already connected still gets a generation before any
    // binding" in `connection.test.ts`.
    if (this.#link.state === "connected" && this.#generation > 0) return Promise.resolve(true);
    // Bumping here rather than only in `close()` changes nothing observable:
    // reaching this line means `#connecting` is undefined, so the previous
    // attempt has either already settled and run its handlers, or been
    // abandoned by a `close()` that bumped anyway.
    const epoch = this.#epoch.start();
    this.publish({ state: "connecting", connected: false });
    const attempt = this.#link.connect().then(
      () => {
        // Guarded for a different reason than the rejection path below. A
        // connect genuinely cannot RESOLVE after a close — `ClientLink.disconnect`
        // rejects a pending connect — but this handler is not the resolution, it
        // is a REACTION the runtime queues as a microtask once the link's promise
        // has resolved. A `close()` in that window runs first, and without this
        // the store would publish `"connected"` over a link it has already
        // disconnected, with nothing left to correct it.
        if (!this.#epoch.isCurrent(epoch)) return false;
        this.#connecting = undefined;
        this.#generation += 1;
        this.publish({ state: "connected", connected: true, failure: null });
        // Every binding gets its own chance on the new connection, including one
        // that has been down since before it: a binding with no live
        // subscription has no error channel left to notice a reconnect on.
        for (const record of [...this.#bindings]) void this.#join(record);
        return true;
      },
      (reason: unknown) => {
        if (!this.#epoch.isCurrent(epoch)) return false;
        this.#connecting = undefined;
        this.publish({ state: "failed", connected: false, failure: asError(reason) });
        return false;
      },
    );
    this.#connecting = attempt;
    return attempt;
  }

  async #join(record: BindingRecord): Promise<void> {
    const connected = await this.#ensureConnected();
    if (record.cancelled) return;
    if (!connected) {
      const error = this.snapshot().failure ?? new Error("factory link unavailable");
      record.reject(error);
      record.options.onError?.(error);
      return;
    }
    const generation = this.#generation;
    // One attempt per connection. Without this a session the server keeps
    // declining would resubscribe from its own error handler forever.
    if (record.attemptedGeneration === generation) return;
    record.attemptedGeneration = generation;
    // Decided here rather than passed in: whichever of `bind`, a reconnect and
    // an error path reaches a given subscribe first, the FIRST one is the join
    // and every later one is a rejoin.
    const rejoin = record.joined;
    // The previous subscription, if any, goes before the next one is opened —
    // not because unsubscribing is tidy, but because the link permits ONE
    // subscription per session at a time and `subscribe` throws on a second.
    // The error path has already released by the time it gets here; the
    // connect-success loop has not, because a transport can lose the connection
    // without any subscription reporting an error, and that loop rejoins every
    // binding including the ones still holding a live subscription wired to
    // this same record.
    this.#release(record);
    let subscription: ClientSubscription;
    try {
      subscription = this.#link.subscribe({
        tenantId: record.options.tenantId,
        sessionId: record.options.sessionId,
        onPublication: (publication) => {
          if (!record.cancelled && record.attemptedGeneration === generation) record.options.onPublication(publication);
        },
        onReset: (reset) => {
          if (!record.cancelled && record.attemptedGeneration === generation) record.options.onReset(reset);
        },
        onError: (error) => {
          this.#onBindingError(record, generation, error);
        },
      });
    } catch (reason) {
      // The link permits one subscription per session and this one is already
      // held. `bind()` is not keyed by session, so two views of the same
      // session are two records competing for one channel — a supported call
      // pattern, since `useSessionBinding` is exported. Without this the throw
      // escaped an `async` method reached only as `void this.#join(record)`:
      // the second binding was dead with no `onError` and `bindingCount` still
      // counting it, which is the "looks healthy, is down" signature.
      //
      // `joined` is deliberately NOT set above: this binding has never
      // subscribed, so its first SUCCESSFUL subscribe must still be reported as
      // a join and not as a rejoin. `attemptedGeneration` IS left set, because
      // retrying on this same connection would find the channel still held and
      // throw again; the next connection is what gives this record its chance.
      record.reject(asError(reason));
      record.options.onError?.(asError(reason));
      return;
    }
    // Set only once a subscription actually exists, so the throw above cannot
    // make this record's first real join look like a rejoin.
    record.joined = true;
    record.subscription = subscription;
    // No second CANCELLATION check between `subscribe` and here: `subscribe`
    // returns without yielding, so the only thing that could reach `cancel` in
    // this window is a callback `subscribe` itself invoked. The check that
    // matters is the one after the await above. The narrower claim that nothing
    // at all can run in this window would not hold: the `onError` above is
    // installed before `subscribe` returns, so a link that delivered an error
    // synchronously would reach `#onBindingError` and `#release` while
    // `record.release` is still undefined — and a consumer `onError` could
    // re-enter `cancel` from there. Centrifuge never does — every subscription
    // error arrives from a socket event or a queued task — and both claims rest
    // on that, not on the window being empty.
    record.release = () => {
      subscription.unsubscribe();
    };
    void subscription.ready.then(
      () => {
        if (record.cancelled || record.attemptedGeneration !== generation) return;
        record.authorize();
        if (rejoin) record.options.onRejoin?.(record.cursor);
        else record.options.onJoin?.(record.cursor);
      },
      // The rejection is already delivered through `onError`; observing it here
      // only keeps it from surfacing as an unhandled rejection.
      (error: unknown) => record.reject(asError(error)),
    );
  }

  #onBindingError(record: BindingRecord, generation: number, error: Error): void {
    if (record.cancelled) return;
    // A superseded subscription's late error is not this binding's state.
    if (record.attemptedGeneration !== generation) return;
    record.reject(error);
    record.options.onError?.(error);
    if (this.#release(record)) this.#redriveChannelPeers(record);
    // Recovers only across a NEW connection: `#join` finds the same generation
    // and stops if the link is still up. A subscription this Factory has stopped
    // authorizing must not be reopened in a loop against the same socket.
    void this.#join(record);
  }
}
