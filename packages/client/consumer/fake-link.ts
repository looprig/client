/**
 * A fake Factory ClientLink.
 *
 * Unlike the REST half there is no way to serve real bytes here without a
 * Centrifugo server, so this IS a test double for `ClientLink` -- the shape the
 * brief calls out as most likely to be looser than the dependency it stands in
 * for. It is therefore written against the published `ClientLink` type and
 * against the observable behaviour of `CentrifugeClientLink`, and the
 * behaviours below are the ones the join actually depends on. Each is stated
 * with the reason it is not an invention of this file.
 *
 *  1. `subscription.version` is `undefined` until the LINK has negotiated.
 *     `CentrifugeClientLink.subscribe` returns `authorized ? this.negotiated?.version
 *     : undefined`, and `negotiated` is set by the transport's `connected`
 *     event. `joinFactorySessionView` repairs when `subscription.version !== 1`,
 *     so a double that reported 1 without a connection would hide a missing
 *     `connect()` in the consumer.
 *  2. `ready` resolves only on server authorization, never synchronously at
 *     construction. The real one resolves on the transport's `subscribed`
 *     event.
 *  3. one live subscription per channel. Centrifuge's `newSubscription` THROWS
 *     on a second subscription for a channel that has not been removed, and
 *     `ClientSubscription.unsubscribe` is documented as also DETACHING the
 *     channel for exactly this reason. The join subscribes once per generation
 *     and unsubscribes in a `finally`, so a double that allowed two live
 *     subscriptions per channel would not notice a leaked one.
 *  4. `unsubscribe` is idempotent and never detaches a SUCCESSOR that has taken
 *     the same channel.
 *  5. every published record is validated with the package's own validators
 *     before delivery, and delivery is refused before `ready`. The real link
 *     parses each publication through `validate*` and can only receive one
 *     after the transport reports `subscribed`.
 *  6. `rpc` refuses a request that is not a V1 command envelope and echoes the
 *     caller's `command_id`, because that is the property `PendingCommand`
 *     checks (`CommandIdentityMismatchError`) and a double that minted its own
 *     id would make every identity assertion vacuous.
 */
import {
  validateCommandStatus,
  validateEnduringPublication,
  validateEphemeralPublication,
  validateSessionReset,
  validateVersionNegotiationResponse,
  type ClientLink,
  type ClientLinkState,
  type ClientSubscription,
  type ClientSubscriptionState,
  type CommandStatus,
  type SubscribeOptions,
  type VersionNegotiationResponse,
} from "@looprig/client";

/** Mirrors `clientlink.ts`'s reversible channel spelling. */
function sessionChannel(tenantId: string, sessionId: string): string {
  return `session:${encodeURIComponent(tenantId)}:${encodeURIComponent(sessionId)}`;
}

interface LiveSubscription {
  readonly channel: string;
  readonly options: SubscribeOptions;
  authorize(): void;
  authorized: boolean;
}

export type RpcHandler = (method: string, request: Record<string, unknown>) => CommandStatus | Error;

export class FakeClientLink implements ClientLink {
  #state: ClientLinkState = "disconnected";
  #negotiated: VersionNegotiationResponse | undefined;
  readonly #channels = new Map<string, LiveSubscription>();
  /** Every request byte-string this link was asked to send, in order. */
  readonly rpcRequests: { method: string; bytes: string }[] = [];
  #rpc: RpcHandler = () => new Error("no rpc handler installed");

  get state(): ClientLinkState {
    return this.#state;
  }

  onRpc(handler: RpcHandler): void {
    this.#rpc = handler;
  }

  connect(): Promise<VersionNegotiationResponse> {
    this.#state = "connecting";
    // Validated, not asserted: the real link runs the server's connect payload
    // through this same validator and rejects `connect()` if it fails.
    this.#negotiated = validateVersionNegotiationResponse({ version: 1 });
    this.#state = "connected";
    return Promise.resolve(this.#negotiated);
  }

  disconnect(): void {
    this.#state = "disconnected";
    this.#negotiated = undefined;
  }

  subscribe(options: SubscribeOptions): ClientSubscription {
    const channel = sessionChannel(options.tenantId, options.sessionId);
    if (this.#channels.has(channel)) {
      // Centrifuge's own behaviour, and the reason `unsubscribe()` detaches.
      throw new Error(`subscription to ${channel} already exists`);
    }
    let authorize!: () => void;
    const ready = new Promise<void>((resolve) => {
      authorize = resolve;
    });
    const entry: LiveSubscription = { channel, options, authorize, authorized: false };
    this.#channels.set(channel, entry);
    const link = this;
    let released = false;
    return {
      get state(): ClientSubscriptionState {
        return released ? "unsubscribed" : entry.authorized ? "subscribed" : "subscribing";
      },
      ready,
      get version(): number | undefined {
        return entry.authorized ? link.#negotiated?.version : undefined;
      },
      unsubscribe(): void {
        if (released) return;
        released = true;
        // BY IDENTITY, not by channel name: a successor that has already taken
        // this channel must survive a late `unsubscribe` from its predecessor.
        if (link.#channels.get(channel) === entry) link.#channels.delete(channel);
      },
    };
  }

  /** Server-side authorization of the currently open subscription for a session. */
  authorize(tenantId: string, sessionId: string): void {
    const entry = this.#require(tenantId, sessionId);
    entry.authorized = true;
    entry.authorize();
  }

  publishEnduring(tenantId: string, sessionId: string, record: unknown): void {
    this.#deliver(tenantId, sessionId, (entry) => entry.options.onPublication(validateEnduringPublication(record)));
  }

  publishEphemeral(tenantId: string, sessionId: string, record: unknown): void {
    this.#deliver(tenantId, sessionId, (entry) => entry.options.onPublication(validateEphemeralPublication(record)));
  }

  publishReset(tenantId: string, sessionId: string, record: unknown): void {
    this.#deliver(tenantId, sessionId, (entry) => entry.options.onReset(validateSessionReset(record)));
  }

  /** How many live (subscribed-and-not-released) channels this link holds. */
  get openChannels(): number {
    return this.#channels.size;
  }

  /** Live channels the server has not yet authorized -- what a fresh join generation is waiting on. */
  get unauthorizedChannels(): number {
    let count = 0;
    for (const entry of this.#channels.values()) if (!entry.authorized) count += 1;
    return count;
  }

  async rpc(method: string, request: unknown): Promise<CommandStatus> {
    const bytes = JSON.stringify(request);
    this.rpcRequests.push({ method, bytes });
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      throw new Error("rpc request must be a command envelope object");
    }
    const envelope = request as Record<string, unknown>;
    if (envelope["version"] !== 1
      || typeof envelope["command_id"] !== "string"
      || typeof envelope["session_id"] !== "string") {
      throw new Error("rpc request is not a V1 command envelope");
    }
    const outcome = this.#rpc(method, envelope);
    if (outcome instanceof Error) throw outcome;
    const status = validateCommandStatus(outcome);
    if (status.command_id !== envelope["command_id"]) {
      throw new Error("fake link tried to answer with a different command identity");
    }
    return status;
  }

  #require(tenantId: string, sessionId: string): LiveSubscription {
    const entry = this.#channels.get(sessionChannel(tenantId, sessionId));
    if (entry === undefined) throw new Error(`no live subscription for ${sessionId}`);
    return entry;
  }

  #deliver(tenantId: string, sessionId: string, send: (entry: LiveSubscription) => void): void {
    const entry = this.#require(tenantId, sessionId);
    if (!entry.authorized) throw new Error("a publication cannot arrive before the subscription is authorized");
    send(entry);
  }
}
