import { Centrifuge } from "centrifuge";
import {
  errorFromCoreEnvelope,
  RealtimeTransportError,
} from "./errors.js";
import type {
  CommandStatus,
  FactoryPublication,
  SessionReset,
  VersionNegotiationResponse,
} from "./types.js";
import {
  ContractValidationError,
  validateCommandStatus,
  validateCoreErrorEnvelope,
  validateEnduringPublication,
  validateEphemeralPublication,
  validateJournalTip,
  validateSessionReset,
  validateVersionNegotiationResponse,
} from "./validate.js";

export type ClientLinkState = "disconnected" | "connecting" | "connected";
export type ClientSubscriptionState = "unsubscribed" | "subscribing" | "subscribed";

export interface ClientLinkCredentials {
  connectionToken?(): Promise<string>;
  subscriptionToken?(context: { channel: string }): Promise<string>;
  subscriptionData?(context: { channel: string }): Promise<unknown>;
}

export interface ClientSubscription {
  readonly state: ClientSubscriptionState;
  /** Resolves only after the server has authorized and opened the subscription. */
  readonly ready: Promise<void>;
  /** Negotiated sessionwire version, available after `ready` settles successfully. */
  readonly version?: number;
  /**
   * Ends the subscription AND detaches its channel, so the same
   * `(tenantId, sessionId)` can be subscribed again on this link.
   *
   * The detach is the load-bearing half. Centrifuge allows one subscription per
   * channel per client and `newSubscription` THROWS on a second one, while
   * `Subscription.unsubscribe()` alone is documented as keeping position state
   * and leaves the channel in the client's registry forever. A consumer that
   * re-subscribes a session — on a new connection, or on a view remount —
   * therefore cannot be served by `unsubscribe()` alone. Idempotent: a second
   * call is a no-op and in particular never detaches a SUCCESSOR subscription
   * that has since taken the same channel.
   */
  unsubscribe(): void;
}

export interface SubscribeOptions {
  tenantId: string;
  sessionId: string;
  onPublication(publication: FactoryPublication): void;
  onReset(reset: SessionReset): void;
  onError?(error: Error): void;
}

export interface ClientLink {
  readonly state: ClientLinkState;
  connect(): Promise<VersionNegotiationResponse>;
  disconnect(): void;
  subscribe(options: SubscribeOptions): ClientSubscription;
  rpc(method: string, request: unknown): Promise<CommandStatus>;
}

export interface ClientLinkOptions {
  endpoint?: string;
  credentials?: ClientLinkCredentials;
}

export type ClientLinkConstructor = (options?: ClientLinkOptions) => ClientLink;

interface TransportOptions extends Record<string, unknown> {
  data: unknown;
  getToken?: () => Promise<string>;
  name: string;
  version: string;
}

/** Internal structural seam used to test the adapter without an actual socket. */
export interface ClientLinkTransportSubscription {
  readonly state: string;
  on(event: string, handler: (context: any) => void): this;
  subscribe(): void;
  /**
   * Unsubscribes and removes the subscription from the transport's per-channel
   * registry. There is deliberately no plain `unsubscribe()` on this seam: no
   * caller wants the position-keeping half without the detach, and offering it
   * would let a rejoin path compile against the weaker of the two.
   */
  release(): void;
}

/** Internal structural seam used to test the adapter without an actual socket. */
export interface ClientLinkTransport {
  readonly state: string;
  on(event: string, handler: (context: any) => void): this;
  connect(): void;
  disconnect(): void;
  /** Throws if `channel` already has a subscription that has not been released. */
  newSubscription(channel: string, options: Record<string, unknown>): ClientLinkTransportSubscription;
  rpc(method: string, data: unknown): Promise<unknown>;
}

export type ClientLinkTransportFactory = (endpoint: string, options: TransportOptions) => ClientLinkTransport;

export interface ClientLinkInternalOptions extends ClientLinkOptions {
  transportFactory: ClientLinkTransportFactory;
}

class CentrifugeSubscriptionAdapter implements ClientLinkTransportSubscription {
  #released = false;

  constructor(
    private readonly subscription: ReturnType<Centrifuge["newSubscription"]>,
    private readonly client: Centrifuge,
  ) {}
  get state(): string { return this.subscription.state; }
  on(event: string, handler: (context: any) => void): this {
    this.subscription.on(event as never, handler as never);
    return this;
  }
  subscribe(): void { this.subscription.subscribe(); }
  /**
   * `removeSubscription` unsubscribes first when the subscription is still
   * live, so this is the whole teardown. Guarded because it deletes the
   * registry entry BY CHANNEL: a second call after a successor has taken the
   * same channel would deregister the successor and let a third subscription
   * open on a channel the server permits only one of.
   */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.client.removeSubscription(this.subscription);
  }
}

class CentrifugeTransportAdapter implements ClientLinkTransport {
  private readonly client: Centrifuge;

  constructor(endpoint: string, options: TransportOptions) {
    this.client = new Centrifuge(endpoint, options);
  }

  get state(): string { return this.client.state; }
  on(event: string, handler: (context: any) => void): this {
    this.client.on(event as never, handler as never);
    return this;
  }
  connect(): void { this.client.connect(); }
  disconnect(): void { this.client.disconnect(); }
  newSubscription(channel: string, options: Record<string, unknown>): ClientLinkTransportSubscription {
    return new CentrifugeSubscriptionAdapter(this.client.newSubscription(channel, options), this.client);
  }
  rpc(method: string, data: unknown): Promise<unknown> { return this.client.rpc(method, data); }
}

function subscriptionState(state: string): ClientSubscriptionState {
  switch (state) {
    case "subscribing": return "subscribing";
    case "subscribed": return "subscribed";
    default: return "unsubscribed";
  }
}

function linkState(state: string): ClientLinkState {
  switch (state) {
    case "connecting": return "connecting";
    case "connected": return "connected";
    default: return "disconnected";
  }
}

function recordType(data: unknown): unknown {
  return typeof data === "object" && data !== null && "type" in data ? data.type : undefined;
}

/** Reversible canonical spelling for opaque IDs inside the colon-delimited channel grammar. */
function sessionChannel(tenantId: string, sessionId: string): string {
  return `session:${encodeURIComponent(tenantId)}:${encodeURIComponent(sessionId)}`;
}

function publication(data: unknown): FactoryPublication | SessionReset {
  switch (recordType(data)) {
    case "enduring_publication": return validateEnduringPublication(data);
    case "ephemeral_publication": return validateEphemeralPublication(data);
    case "journal_tip": return validateJournalTip(data);
    case "session.reset": return validateSessionReset(data);
    default: throw new ContractValidationError("enduring_publication", []);
  }
}

function transportError(error: unknown): Error {
  if (typeof error === "object" && error !== null && "data" in error) {
    try {
      return errorFromCoreEnvelope(validateCoreErrorEnvelope(error.data));
    } catch (validationError) {
      if (!(validationError instanceof ContractValidationError)) {
        return validationError instanceof Error
          ? validationError
          : new RealtimeTransportError("error mapping failed", undefined, { cause: validationError });
      }
    }
  }
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
    ? error.code
    : undefined;
  const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "realtime transport error";
  return new RealtimeTransportError(message, code, { cause: error });
}

/**
 * The ClientLink APPLICATION protocol this package speaks, as Factory's
 * ClientLink names it (`factory/internal/realtime/clientlink.ProtocolVersion`).
 *
 * Factory decides a handshake on `protocol_version` alone and answers
 * `{ protocol_version, factory_version }`. Every released Factory refuses a
 * connect that does not name it (Centrifuge disconnect, no reply), which is
 * what every wui <= v0.2.0 bundle did: it sent only Core's
 * `{ supported_versions: [1] }` and so never reached realtime against a real
 * Factory. Both members are sent now: Factory's decoder ignores the one it
 * does not read, and a test double that speaks Core's negotiation still works.
 */
export const CLIENTLINK_PROTOCOL_VERSION = "1";

/**
 * The negotiated wire version from a connect reply: Factory's
 * `{ protocol_version: "1", factory_version }`, or Core's
 * `VersionNegotiationResponse`. A reply naming another ClientLink protocol is
 * refused rather than read as Core's shape.
 */
function negotiatedFromConnectReply(data: unknown): VersionNegotiationResponse {
  if (typeof data === "object" && data !== null && !Array.isArray(data) && "protocol_version" in data) {
    const protocol = (data as Record<string, unknown>)["protocol_version"];
    if (protocol !== CLIENTLINK_PROTOCOL_VERSION) {
      throw new RealtimeTransportError(
        `Factory speaks ClientLink protocol ${JSON.stringify(protocol)}, this client speaks ${CLIENTLINK_PROTOCOL_VERSION}`,
      );
    }
    return validateVersionNegotiationResponse({ version: 1 });
  }
  return validateVersionNegotiationResponse(data);
}

class CentrifugeClientLink implements ClientLink {
  private readonly transport: ClientLinkTransport;
  private readonly credentials: ClientLinkCredentials;
  private currentState: ClientLinkState = "disconnected";
  private negotiated: VersionNegotiationResponse | undefined;
  private pendingConnect: {
    promise: Promise<VersionNegotiationResponse>;
    resolve(value: VersionNegotiationResponse): void;
    reject(reason: unknown): void;
  } | undefined;

  constructor(options: ClientLinkInternalOptions) {
    this.credentials = options.credentials ?? {};
    const endpoint = options.endpoint ?? "/v1/realtime";
    this.transport = options.transportFactory(endpoint, {
      data: { supported_versions: [1], protocol_version: CLIENTLINK_PROTOCOL_VERSION },
      ...(options.credentials?.connectionToken === undefined
        ? {}
        : { getToken: () => options.credentials!.connectionToken!() }),
      name: "looprig-protocol",
      version: "0.1.0",
    });
    this.transport.on("connecting", () => { this.currentState = "connecting"; });
    this.transport.on("connected", (context: unknown) => {
      this.currentState = "connected";
      try {
        const data = typeof context === "object" && context !== null && "data" in context ? context.data : undefined;
        this.negotiated = negotiatedFromConnectReply(data);
        this.pendingConnect?.resolve(this.negotiated);
      } catch (error) {
        this.currentState = "disconnected";
        this.negotiated = undefined;
        const pending = this.pendingConnect;
        this.pendingConnect = undefined;
        pending?.reject(error);
        this.transport.disconnect();
      } finally {
        this.pendingConnect = undefined;
      }
    });
    this.transport.on("disconnected", (context: unknown) => {
      this.currentState = "disconnected";
      this.negotiated = undefined;
      if (this.pendingConnect !== undefined) {
        this.pendingConnect.reject(transportError(context));
        this.pendingConnect = undefined;
      }
    });
  }

  get state(): ClientLinkState {
    return this.currentState === "disconnected" ? linkState(this.transport.state) : this.currentState;
  }

  connect(): Promise<VersionNegotiationResponse> {
    if (this.currentState === "connected" && this.negotiated !== undefined) {
      return Promise.resolve(this.negotiated);
    }
    if (this.pendingConnect !== undefined) return this.pendingConnect.promise;
    let resolve!: (value: VersionNegotiationResponse) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<VersionNegotiationResponse>((res, rej) => { resolve = res; reject = rej; });
    this.pendingConnect = { promise, resolve, reject };
    this.currentState = "connecting";
    this.transport.connect();
    return promise;
  }

  disconnect(): void {
    this.currentState = "disconnected";
    this.negotiated = undefined;
    this.pendingConnect?.reject(new RealtimeTransportError("connection closed"));
    this.pendingConnect = undefined;
    this.transport.disconnect();
  }

  subscribe(options: SubscribeOptions): ClientSubscription {
    const channel = sessionChannel(options.tenantId, options.sessionId);
    const subscriptionOptions: Record<string, unknown> = {};
    if (this.credentials.subscriptionToken !== undefined) {
      subscriptionOptions.getToken = () => this.credentials.subscriptionToken!({ channel });
    }
    if (this.credentials.subscriptionData !== undefined) {
      subscriptionOptions.getData = () => this.credentials.subscriptionData!({ channel });
    }
    const transportSubscription = this.transport.newSubscription(channel, subscriptionOptions);
    let resolveReady!: () => void;
    let rejectReady!: (reason: unknown) => void;
    let readySettled = false;
    let authorized = false;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const settleReady = (error?: Error): void => {
      if (readySettled) return;
      readySettled = true;
      if (error === undefined) resolveReady();
      else rejectReady(error);
    };
    // A transport drop does NOT end a Centrifuge subscription: the client
    // moves it to `subscribing` and re-subscribes by itself once the socket is
    // back, emitting no `unsubscribed` and no `error`. Factory keeps no replay
    // for the new binding (recovery is off), so every record committed while
    // the socket was down is simply never delivered, and the next live record
    // would be appended above that hole. Both transitions are therefore
    // reported through `onError` once the subscription has been authorized, so
    // the join repairs from its committed cursor: `subscribing` as soon as the
    // drop is seen (the view stops claiming to be live), and a second
    // `subscribed` as the backstop if the drop was never observed.
    let interrupted = false;
    const interruption = (reason: string, context: unknown): void => {
      if (!authorized || interrupted) return;
      interrupted = true;
      options.onError?.(new RealtimeTransportError(reason, undefined, { cause: context }));
    };
    transportSubscription.on("subscribing", (context: unknown) => {
      interruption("subscription interrupted by a transport drop", context);
    });
    transportSubscription.on("subscribed", (context: unknown) => {
      if (readySettled) {
        interruption("resubscribed after a transport interruption", context);
        return;
      }
      authorized = true;
      settleReady();
    });
    transportSubscription.on("publication", (context: unknown) => {
      try {
        const data = typeof context === "object" && context !== null && "data" in context ? context.data : undefined;
        const parsed = publication(data);
        if (parsed.type === "session.reset") options.onReset(parsed);
        else options.onPublication(parsed);
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new RealtimeTransportError("publication callback failed", undefined, { cause: error }));
      }
    });
    transportSubscription.on("error", (context: unknown) => {
      const error = typeof context === "object" && context !== null && "error" in context ? context.error : context;
      const mapped = transportError(error);
      settleReady(mapped);
      options.onError?.(mapped);
    });
    transportSubscription.on("unsubscribed", (context: unknown) => {
      const code = typeof context === "object" && context !== null && "code" in context && typeof context.code === "number"
        ? context.code
        : undefined;
      const reason = typeof context === "object" && context !== null && "reason" in context && typeof context.reason === "string"
        ? context.reason
        : "subscription removed";
      if (code === 0 && readySettled) return;
      const error = new RealtimeTransportError(reason, code, { cause: context });
      settleReady(error);
      options.onError?.(error);
    });
    transportSubscription.subscribe();
    const thisLink = this;
    return {
      get state(): ClientSubscriptionState { return subscriptionState(transportSubscription.state); },
      ready,
      get version(): number | undefined { return authorized ? thisLink.negotiated?.version : undefined; },
      unsubscribe: () => transportSubscription.release(),
    };
  }

  async rpc(method: string, request: unknown): Promise<CommandStatus> {
    let result: unknown;
    try {
      result = await this.transport.rpc(method, request);
    } catch (error) {
      throw transportError(error);
    }
    const data = typeof result === "object" && result !== null && "data" in result ? result.data : undefined;
    if (typeof data === "object" && data !== null && "error" in data && !("command_id" in data)) {
      throw errorFromCoreEnvelope(validateCoreErrorEnvelope(data));
    }
    return validateCommandStatus(data);
  }
}

export function createClientLinkWithTransport(options: ClientLinkInternalOptions): ClientLink {
  return new CentrifugeClientLink(options);
}

export function createClientLink(options: ClientLinkOptions = {}): ClientLink {
  return createClientLinkWithTransport({
    ...options,
    transportFactory: (endpoint, transportOptions) => new CentrifugeTransportAdapter(endpoint, transportOptions),
  });
}
