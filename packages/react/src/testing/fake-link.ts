/**
 * A controllable `ClientLink` for this package's tests.
 *
 * `@looprig/client` builds its real link over Centrifuge and exposes only
 * `createClientLink` from its barrel — `createClientLinkWithTransport`, the
 * seam its own `clientlink.test.ts` drives, is not public — so a React test
 * cannot reach the real adapter with a fake socket underneath it. This stands
 * in for it.
 *
 * The semantics mirrored from `protocol/src/clientlink.ts`, each because a test
 * here depends on it:
 *
 *  - `connect()` returns the SAME promise while one is in flight and an
 *    already-resolved one once connected, which is what makes a coalescing
 *    claim about `FactoryLinkStore` a claim about the store rather than about
 *    the link;
 *  - `disconnect()` rejects a pending connect;
 *  - `subscribe()` returns synchronously with `ready` still pending, so a
 *    binding exists before it is authorized;
 *  - `unsubscribe()` is accepted any number of times, so "exactly once" is a
 *    property of the caller, never of this fake;
 *  - **one live subscription per session.** Centrifuge keeps a per-channel
 *    registry and `newSubscription` THROWS on a second entry; `unsubscribe()`
 *    on the real link releases it. `ClientLink over real Centrifuge` in
 *    `protocol/test/clientlink.test.ts` reads three things off the library: the
 *    second-subscribe throw, the guard against a stale handle detaching its
 *    successor, and the resubscribe-after-unsubscribe the rejoin path needs.
 *    This fake ALSO declines to release a failed subscription, and that fourth
 *    property is INFERRED rather than measured — driving a real subscription
 *    into an errored state takes a server, so no subtest there reaches it. The
 *    inference: centrifuge 5.7.2 empties `_subs` only through
 *    `_removeSubscription`, which has exactly one call site, the public
 *    `removeSubscription` that `CentrifugeSubscriptionAdapter.release` calls.
 *    No error path can hand a channel back, so a rejoin after an error must
 *    release before it subscribes, exactly as it must after a silent transport
 *    loss. A fake that accepted overlapping subscriptions would turn that throw
 *    into a passing test, which is what it did until this was added.
 *
 * Deliberately NOT mirrored, because nothing here reads them: schema validation
 * of publications (the real link validates and routes `session.reset` by its
 * `type` member; this one is handed already-typed values) and the token/data
 * option plumbing.
 *
 * Three differences remain after auditing this against `clientlink.ts` in both
 * directions, and none of them is inert:
 *
 *  - **Centrifuge's own automatic reconnect and resubscribe.** The real link
 *    revives an existing subscription across a transport reconnect by itself, so
 *    publications can keep arriving on a subscription `FactoryLinkStore`
 *    believes it must rejoin; here they stop until the store resubscribes. The
 *    cost is that this fake cannot show a failed rejoin being MASKED by live
 *    publications — which is precisely why a failed rejoin goes unnoticed in a
 *    browser — only whether the rejoin happened. `onRejoin` is therefore the
 *    signal these tests assert on.
 *  - **`ready` after an unsubscribe.** The real link REJECTS a `ready` that has
 *    not settled when the subscription is torn down; `unsubscribe()` here leaves
 *    it pending forever. `FactoryLinkStore` observes that rejection and ignores
 *    it, so the two agree on what the store does — but a future consumer that
 *    reads `ready` for a teardown signal would be tested against the weaker one.
 *  - **`deliver()` on an unsubscribed subscription.** The real link stops
 *    routing publications once the subscription is gone. `deliver()` is a test
 *    ACTION rather than something this fake produces on its own, and one test
 *    uses it deliberately to model a frame the socket had already handed up
 *    before the unsubscribe; nothing calls it by accident. `link.open` is the
 *    accessor to reach for when the question is what a live subscription
 *    delivers.
 */
import { RealtimeTransportError } from "@looprig/client";
import type {
  ClientLink,
  ClientLinkState,
  ClientSubscription,
  ClientSubscriptionState,
  FactoryPublication,
  SessionReset,
  SubscribeOptions,
  CommandStatus,
  VersionNegotiationResponse,
} from "@looprig/client";

const NEGOTIATED: VersionNegotiationResponse = { version: 1 };

/**
 * One command this link was asked to send, plus the settlement the test owns.
 *
 * `settle` merges over `{ command_id: <echoed>, status: "accepted" }`, so a
 * test that wants a rejection writes only what differs and never has to
 * re-state the echo the identity check depends on.
 */
export interface FakeRpcCall {
  readonly method: string;
  readonly request: unknown;
  /** The `command_id` this call carried, and the one its reply will echo. */
  readonly commandId: string;
  settled: boolean;
  settle(patch?: Partial<CommandStatus>): void;
  fail(error: Error): void;
}

/**
 * The real link's channel grammar is reversible, so one channel per
 * `(tenantId, sessionId)` and no collisions between distinct pairs; this
 * reproduces that identity rather than the exact spelling, which no caller here
 * can observe.
 */
function channelOf(tenantId: string, sessionId: string): string {
  return `session:${encodeURIComponent(tenantId)}:${encodeURIComponent(sessionId)}`;
}

export class FakeSubscription implements ClientSubscription {
  /** How many times `unsubscribe()` reached this subscription. */
  unsubscribeCount = 0;
  state: ClientSubscriptionState = "subscribing";
  version: number | undefined;

  readonly ready: Promise<void>;
  readonly #resolve: () => void;
  readonly #reject: (reason: unknown) => void;
  #settled = false;

  constructor(
    readonly options: SubscribeOptions,
    /** The link connection generation this subscription was opened on. */
    readonly generation: number,
    /** Hands the channel back to the link's registry. See `FakeClientLink`. */
    private readonly release: (subscription: FakeSubscription) => void = () => {},
  ) {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    this.ready = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#resolve = resolve;
    this.#reject = reject;
    // An unobserved rejection in a browser test surfaces as an unrelated
    // failure; every caller here observes `ready` only when it means to.
    this.ready.catch(() => {});
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  authorize(version: number = NEGOTIATED.version): void {
    this.state = "subscribed";
    this.version = version;
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve();
  }

  fail(error: Error): void {
    this.state = "unsubscribed";
    this.version = undefined;
    if (!this.#settled) {
      this.#settled = true;
      this.#reject(error);
    }
    this.options.onError?.(error);
  }

  deliver(publication: FactoryPublication): void {
    this.options.onPublication(publication);
  }

  reset(reset: SessionReset): void {
    this.options.onReset(reset);
  }

  unsubscribe(): void {
    this.unsubscribeCount += 1;
    this.state = "unsubscribed";
    this.release(this);
  }
}

export class FakeClientLink implements ClientLink {
  /** Every subscription ever opened, in order, including superseded ones. */
  readonly subscriptions: FakeSubscription[] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  /** 1 while connected, 0 otherwise. `maxLiveConnections` is its high-water mark. */
  liveConnections = 0;
  maxLiveConnections = 0;
  /** While true, `connect()` stays pending until `settleConnect()` is called. */
  holdConnect = false;
  /** Leave subscriptions pending until a test explicitly authorizes them. */
  holdAuthorization = false;
  /** Sessions whose next authorization attempt fails instead. */
  readonly denied = new Set<string>();

  #state: ClientLinkState = "disconnected";
  #pending:
    | { promise: Promise<VersionNegotiationResponse>; resolve: () => void; reject: (reason: unknown) => void }
    | undefined;
  #generation = 0;
  /** The channels currently holding a subscription, mirroring Centrifuge's `_subs`. */
  readonly #registry = new Map<string, FakeSubscription>();

  get state(): ClientLinkState {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  connect(): Promise<VersionNegotiationResponse> {
    this.connectCalls += 1;
    if (this.#state === "connected") return Promise.resolve(NEGOTIATED);
    if (this.#pending !== undefined) return this.#pending.promise;
    this.#state = "connecting";
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<VersionNegotiationResponse>((res, rej) => {
      resolve = () => res(NEGOTIATED);
      reject = rej;
    });
    this.#pending = { promise, resolve, reject };
    if (!this.holdConnect) queueMicrotask(() => this.settleConnect());
    return promise;
  }

  /** Completes the in-flight connect, successfully or with `error`. */
  settleConnect(error?: Error): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    if (error !== undefined) {
      this.#state = "disconnected";
      pending.reject(error);
      return;
    }
    this.#state = "connected";
    this.#generation += 1;
    this.liveConnections += 1;
    this.maxLiveConnections = Math.max(this.maxLiveConnections, this.liveConnections);
    pending.resolve();
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(new Error("connection closed"));
    if (this.#state === "connected") this.liveConnections -= 1;
    this.#state = "disconnected";
  }

  /**
   * Loses the connection underneath every open subscription AND every command
   * still awaiting a reply.
   *
   * The second half mirrors Centrifuge, which rejects an in-flight RPC when the
   * transport goes down: that is precisely the moment a client learns nothing
   * about whether the command was admitted, so a fake that left those replies
   * pending would make the ambiguous case unreachable.
   */
  drop(reason = "connection lost"): void {
    if (this.#state === "connected") this.liveConnections -= 1;
    this.#state = "disconnected";
    for (const subscription of this.subscriptions) {
      if (subscription.state === "subscribed") subscription.fail(new Error(reason));
    }
    for (const call of this.outstanding) call.fail(new RealtimeTransportError(reason));
  }

  subscribe(options: SubscribeOptions): ClientSubscription {
    const channel = channelOf(options.tenantId, options.sessionId);
    if (this.#registry.has(channel)) {
      throw new Error(`Subscription to the channel ${channel} already exists`);
    }
    const subscription = new FakeSubscription(options, this.#generation, (released) => {
      // Removal is by CHANNEL in Centrifuge, so a stale handle releasing a
      // second time could take a successor's entry out. It does not, here or in
      // the adapter, and this is the half of that pair the store's tests reach.
      if (this.#registry.get(channel) === released) this.#registry.delete(channel);
    });
    this.#registry.set(channel, subscription);
    this.subscriptions.push(subscription);
    queueMicrotask(() => {
      if (subscription.state !== "subscribing") return;
      if (this.holdAuthorization) return;
      if (this.denied.has(options.sessionId)) {
        subscription.fail(new Error(`not authorized for ${options.sessionId}`));
        return;
      }
      subscription.authorize();
    });
    return subscription;
  }

  /**
   * Every command this link was asked to send, in order.
   *
   * This is the reader that makes "opening a session sends no restore or
   * admission command" an assertion about behaviour rather than about types:
   * `PendingCommand.submit()` reaches the transport ONLY here, whatever hook or
   * store called it, so an empty list is a claim over the whole plane rather
   * than over one hook's imports.
   *
   * Each entry also carries its own settlement, so a test can hold a command
   * open, answer it with a durable status, or lose its reply. The real link
   * settles an RPC exactly once; `settle` and `fail` here are therefore no-ops
   * after the first, whichever ran.
   */
  readonly rpcCalls: FakeRpcCall[] = [];
  /** While true, every `rpc` stays pending until the test settles its call. */
  holdRpc = false;

  rpc(method: string, request: unknown): Promise<CommandStatus> {
    // The command id is ECHOED, not invented. `PendingCommand.submit()` throws
    // `CommandIdentityMismatchError` on a reply naming another command, so a
    // canned id would make every send fail — and a positive control that cannot
    // succeed proves nothing about a negative assertion.
    const id = (request as { command_id?: unknown }).command_id;
    const commandId = typeof id === "string" ? id : "fake";
    let settle!: (status: CommandStatus) => void;
    let reject!: (error: Error) => void;
    const reply = new Promise<CommandStatus>((res, rej) => {
      settle = res;
      reject = rej;
    });
    const call: FakeRpcCall = {
      method,
      request,
      commandId,
      settled: false,
      settle: (patch = {}) => {
        if (call.settled) return;
        call.settled = true;
        settle({ command_id: commandId, status: "accepted", ...patch });
      },
      fail: (error: Error) => {
        if (call.settled) return;
        call.settled = true;
        reject(error);
      },
    };
    this.rpcCalls.push(call);
    if (!this.holdRpc) call.settle();
    return reply;
  }

  /** The calls still awaiting a settlement, oldest first. */
  get outstanding(): FakeRpcCall[] {
    return this.rpcCalls.filter((call) => !call.settled);
  }

  /** Every subscription ever opened for `sessionId`, oldest first. */
  forSession(sessionId: string): FakeSubscription[] {
    return this.subscriptions.filter((subscription) => subscription.sessionId === sessionId);
  }

  /** The subscriptions that are currently subscribed. */
  get open(): FakeSubscription[] {
    return this.subscriptions.filter((subscription) => subscription.state === "subscribed");
  }
}
