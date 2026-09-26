import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ClientSubscription } from "../src/clientlink.js";
import {
  createClientLink,
  createClientLinkWithTransport,
  type ClientLinkTransport,
  type ClientLinkTransportSubscription,
} from "../src/clientlink.js";
import { CoreRuntimeUnavailableError, RealtimeTransportError } from "../src/errors.js";
import { ContractValidationError } from "../src/validate.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureDir}${name}.json`, "utf8"));
}

type Handler = (context: any) => void;

class FakeSubscription implements ClientLinkTransportSubscription {
  readonly handlers = new Map<string, Handler[]>();
  state = "unsubscribed";
  subscribeCalls = 0;
  releaseCalls = 0;

  constructor(
    readonly channel: string,
    private readonly onRelease: (sub: FakeSubscription) => void = () => {},
  ) {}

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  subscribe(): void {
    this.subscribeCalls += 1;
    this.state = "subscribed";
  }

  release(): void {
    this.releaseCalls += 1;
    this.state = "unsubscribed";
    this.onRelease(this);
  }

  emit(event: string, context: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(context);
  }
}

class FakeTransport implements ClientLinkTransport {
  readonly handlers = new Map<string, Handler[]>();
  readonly subscriptions: Array<{ channel: string; options: Record<string, unknown>; sub: FakeSubscription }> = [];
  /** The channels currently registered, mirroring Centrifuge's `_subs`. */
  readonly registry = new Map<string, FakeSubscription>();
  state = "disconnected";
  rpcResult: unknown = { data: fixture("command_status") };
  rpcFailure: unknown;
  connectCalls = 0;
  disconnectCalls = 0;
  emitDisconnectedOnDisconnect = false;

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  connect(): void {
    this.connectCalls += 1;
    this.state = "connecting";
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.state = "disconnected";
    if (this.emitDisconnectedOnDisconnect) this.emit("disconnected", { code: 0, reason: "client disconnect" });
  }

  /**
   * Mirrors `Centrifuge.newSubscription`, which throws when the channel is
   * already in the client's registry, and `removeSubscription`, which is the
   * only thing that takes it back out. A fake that accepted a second
   * subscription to one channel would let a rejoin path pass here and throw in
   * a browser.
   */
  newSubscription(channel: string, options: Record<string, unknown>): FakeSubscription {
    if (this.registry.has(channel)) {
      throw new Error("Subscription to the channel " + channel + " already exists");
    }
    const sub = new FakeSubscription(channel, (released) => {
      // By channel, exactly as `_removeSubscription` is — but only while this
      // subscription is still the registered one, matching the adapter's
      // release guard.
      if (this.registry.get(channel) === released) this.registry.delete(channel);
    });
    this.registry.set(channel, sub);
    this.subscriptions.push({ channel, options, sub });
    return sub;
  }

  async rpc(): Promise<unknown> {
    if (this.rpcFailure !== undefined) throw this.rpcFailure;
    return this.rpcResult;
  }

  emit(event: string, context: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(context);
  }
}

function setup() {
  const transport = new FakeTransport();
  const constructed: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const credentials = {
    connectionToken: vi.fn(async () => "connection-token"),
    subscriptionToken: vi.fn(async ({ channel }: { channel: string }) => `token:${channel}`),
    subscriptionData: vi.fn(async ({ channel }: { channel: string }) => ({ authorize: channel })),
  };
  const link = createClientLinkWithTransport({
    endpoint: "/v1/realtime",
    credentials,
    transportFactory: (endpoint, options) => {
      constructed.push({ endpoint, options });
      return transport;
    },
  });
  return { link, transport, credentials, constructed };
}

describe("ClientLink", () => {
  it("negotiates Core wire version 1 while exposing only Looprig connection state", async () => {
    const { link, transport, constructed } = setup();
    const connected = link.connect();

    expect(link.state).toBe("connecting");
    expect(transport.connectCalls).toBe(1);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.endpoint).toBe("/v1/realtime");
    expect(constructed[0]?.options.data).toStrictEqual({ supported_versions: [1], protocol_version: "1" });

    transport.state = "connected";
    transport.emit("connected", { client: "sdk-private", transport: "websocket", data: { version: 1 } });
    await expect(connected).resolves.toStrictEqual({ version: 1 });
    expect(link.state).toBe("connected");

    const alreadyConnected = link.connect();
    expect(transport.connectCalls).toBe(1);
    await expect(alreadyConnected).resolves.toStrictEqual({ version: 1 });

    const binding = link.subscribe({
      tenantId: "tenant-1",
      sessionId: "session-1",
      onPublication: () => undefined,
      onReset: () => undefined,
    });
    expect(binding.version).toBeUndefined();
    transport.subscriptions[0]!.sub.emit("subscribed", {});
    await binding.ready;
    expect(binding.version).toBe(1);
    binding.unsubscribe();

    link.disconnect();
    expect(transport.disconnectCalls).toBe(1);
    expect(link.state).toBe("disconnected");
  });

  it("rejects unvalidated connect data at the realtime boundary", async () => {
    const { link, transport } = setup();
    transport.emitDisconnectedOnDisconnect = true;
    const connected = link.connect();
    transport.emit("connected", { data: { version: 999 } });
    await expect(connected).rejects.toBeInstanceOf(ContractValidationError);
    expect(transport.disconnectCalls).toBe(1);
    expect(link.state).toBe("disconnected");
  });

  it("accepts Factory's ClientLink reply and refuses one naming another ClientLink protocol", async () => {
    // factory/internal/realtime/clientlink answers a connect with
    // {protocol_version, factory_version}, not Core's {version}.
    const accepted = setup();
    const connected = accepted.link.connect();
    accepted.transport.state = "connected";
    accepted.transport.emit("connected", { data: { protocol_version: "1", factory_version: "v0.10.0" } });
    await expect(connected).resolves.toStrictEqual({ version: 1 });
    expect(accepted.link.state).toBe("connected");

    const refused = setup();
    refused.transport.emitDisconnectedOnDisconnect = true;
    const mismatched = refused.link.connect();
    refused.transport.emit("connected", { data: { protocol_version: "2", factory_version: "v9.0.0" } });
    await expect(mismatched).rejects.toBeInstanceOf(RealtimeTransportError);
    expect(refused.transport.disconnectCalls).toBe(1);
    expect(refused.link.state).toBe("disconnected");
  });

  it("reports a transport drop and the automatic re-subscribe so the join repairs (no replay exists)", async () => {
    // centrifuge-js moves a subscription to `subscribing` on a socket drop and
    // re-subscribes by itself: no `unsubscribed`, no `error`. Factory keeps no
    // replay, so records committed meanwhile are never delivered.
    const { link, transport } = setup();
    const errors: Error[] = [];
    const binding = link.subscribe({
      tenantId: "tenant-1", sessionId: "session-1",
      onPublication: () => undefined, onReset: () => undefined, onError: (error) => errors.push(error),
    });
    const sub = transport.subscriptions[0]!.sub;
    sub.emit("subscribing", { code: 0, reason: "subscribe called" }); // the initial subscribe is not a drop
    sub.emit("subscribed", {});
    await binding.ready;
    expect(errors).toStrictEqual([]);

    transport.emit("disconnected", { code: 3, reason: "transport closed" });
    sub.emit("subscribing", { code: 3, reason: "transport closed" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RealtimeTransportError);
    sub.emit("subscribed", {});
    expect(errors).toHaveLength(1); // one repair per interruption
  });

  it("repairs on a second `subscribed` even if the drop itself was never observed", async () => {
    const { link, transport } = setup();
    const errors: Error[] = [];
    const binding = link.subscribe({
      tenantId: "tenant-1", sessionId: "session-1",
      onPublication: () => undefined, onReset: () => undefined, onError: (error) => errors.push(error),
    });
    const sub = transport.subscriptions[0]!.sub;
    sub.emit("subscribed", {});
    await binding.ready;
    sub.emit("subscribed", {});
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("resubscribed");
  });

  it("authorizes one opaque session channel and validates publication/reset callbacks", async () => {
    const { link, transport, credentials } = setup();
    const publications: unknown[] = [];
    const resets: unknown[] = [];
    const errors: Error[] = [];
    const binding = link.subscribe({
      tenantId: "tenant/a",
      sessionId: "session:1",
      onPublication: (publication) => publications.push(publication),
      onReset: (reset) => resets.push(reset),
      onError: (error) => errors.push(error),
    });
    const created = transport.subscriptions[0];
    let ready = false;
    binding.ready.then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    created?.sub.emit("subscribed", { channel: created.channel });
    await expect(binding.ready).resolves.toBeUndefined();
    expect(created?.channel).toBe("session:tenant%2Fa:session%3A1");
    expect(created?.sub.subscribeCalls).toBe(1);
    await expect((created?.options.getToken as () => Promise<string>)()).resolves.toBe(
      "token:session:tenant%2Fa:session%3A1",
    );
    await expect((created?.options.getData as () => Promise<unknown>)()).resolves.toStrictEqual({
      authorize: "session:tenant%2Fa:session%3A1",
    });
    expect(credentials.subscriptionToken).toHaveBeenCalledWith({ channel: created?.channel });
    expect(credentials.subscriptionData).toHaveBeenCalledWith({ channel: created?.channel });

    created?.sub.emit("publication", { channel: created.channel, data: fixture("enduring_publication") });
    created?.sub.emit("publication", { channel: created.channel, data: fixture("session_reset") });
    expect(publications).toStrictEqual([fixture("enduring_publication")]);
    expect(resets).toStrictEqual([fixture("session_reset")]);
    expect(errors).toStrictEqual([]);

    created?.sub.emit("publication", { channel: created.channel, data: { type: "enduring_publication" } });
    expect(errors[0]).toBeInstanceOf(ContractValidationError);
    expect(publications).toHaveLength(1);

    created?.sub.emit("unsubscribed", { channel: created.channel, code: 103, reason: "permission denied" });
    expect(errors[1]).toMatchObject({
      name: RealtimeTransportError.name,
      message: "permission denied",
      transportCode: 103,
    });

    binding.unsubscribe();
    expect(created?.sub.releaseCalls).toBe(1);
    expect(binding.state).toBe("unsubscribed");
  });

  it("rejects subscription readiness when authorization fails before open", async () => {
    const { link, transport } = setup();
    const binding = link.subscribe({
      tenantId: "tenant-1",
      sessionId: "session-1",
      onPublication: () => undefined,
      onReset: () => undefined,
    });
    transport.subscriptions[0]!.sub.emit("unsubscribed", { code: 103, reason: "permission denied" });
    await expect(binding.ready).rejects.toMatchObject({ message: "permission denied", transportCode: 103 });
  });

  it("settles readiness when a code-zero unsubscribe terminates the subscription before open", async () => {
    const { link, transport } = setup();
    const onError = vi.fn();
    const binding = link.subscribe({
      tenantId: "tenant-1",
      sessionId: "session-1",
      onPublication: () => undefined,
      onReset: () => undefined,
      onError,
    });
    transport.subscriptions[0]!.sub.emit("unsubscribed", { code: 0, reason: "closed before authorization" });
    await expect(binding.ready).rejects.toMatchObject({
      message: "closed before authorization",
      transportCode: 0,
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not report a normal code-zero unsubscribe after readiness as an authorization failure", async () => {
    const { link, transport } = setup();
    const onError = vi.fn();
    const binding = link.subscribe({
      tenantId: "tenant-1",
      sessionId: "session-1",
      onPublication: () => undefined,
      onReset: () => undefined,
      onError,
    });
    const sub = transport.subscriptions[0]!.sub;
    sub.emit("subscribed", {});
    await expect(binding.ready).resolves.toBeUndefined();
    sub.emit("unsubscribed", { code: 0, reason: "normal close" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("never turns a REST-only DTO into a publication or RPC result", async () => {
    const { link, transport } = setup();
    const publications: unknown[] = [];
    const errors: Error[] = [];
    link.subscribe({
      tenantId: "tenant-1",
      sessionId: "session-1",
      onPublication: (publication) => publications.push(publication),
      onReset: () => undefined,
      onError: (error) => errors.push(error),
    });
    transport.subscriptions[0]?.sub.emit("publication", {
      channel: "session:tenant-1:session-1",
      data: fixture("recent_session_page"),
    });
    expect(publications).toStrictEqual([]);
    expect(errors[0]).toBeInstanceOf(ContractValidationError);

    transport.rpcResult = { data: fixture("recent_session_page") };
    await expect(link.rpc("session.input", { version: 1, command_id: "command-1" })).rejects.toBeInstanceOf(
      ContractValidationError,
    );
  });

  it("validates RPC data as CommandStatus and maps Core and transport failures to owned errors", async () => {
    const { link, transport } = setup();
    await expect(link.rpc("session.input", { version: 1, command_id: "command-1" })).resolves.toStrictEqual(
      fixture("command_status"),
    );

    transport.rpcResult = { data: fixture("error_envelope") };
    await expect(link.rpc("session.input", {})).rejects.toBeInstanceOf(CoreRuntimeUnavailableError);

    transport.rpcResult = { data: fixture("command_status") };
    transport.rpcFailure = { code: 104, message: "method not found" };
    await expect(link.rpc("missing", {})).rejects.toMatchObject({
      name: RealtimeTransportError.name,
      transportCode: 104,
    });
  });

  it("rejects schema-valid but semantically incoherent repair records", () => {
    const { link, transport } = setup();
    const errors: Error[] = [];
    link.subscribe({
      tenantId: "tenant-1",
      sessionId: "session-1",
      onPublication: () => undefined,
      onReset: () => undefined,
      onError: (error) => errors.push(error),
    });
    const sub = transport.subscriptions[0]!.sub;
    const enduring = fixture("enduring_publication") as Record<string, unknown>;
    sub.emit("publication", { data: { ...enduring, covered_through: 999 } });
    const reset = fixture("session_reset") as Record<string, unknown>;
    sub.emit("publication", { data: { ...reset, last_contiguous: 999 } });
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error instanceof ContractValidationError)).toBe(true);
  });
  // A session is subscribed more than once in normal operation: a view remounts,
  // or a consumer rejoins every binding on a new connection. Centrifuge permits
  // one subscription per channel per client and `newSubscription` THROWS on the
  // second, so `unsubscribe()` has to hand the channel back or the second
  // subscribe is unreachable. `real Centrifuge` below pins the same property
  // against the library rather than against this fake.
  it("refuses a second live subscription to one session and frees the channel on unsubscribe", () => {
    const { link, transport } = setup();
    const options = {
      tenantId: "tenant-1",
      sessionId: "session-1",
      onPublication: () => undefined,
      onReset: () => undefined,
    };
    const first = link.subscribe(options);
    expect(() => link.subscribe(options)).toThrow(/already exists/);
    // A different session is a different channel and is unaffected.
    link.subscribe({ ...options, sessionId: "session-2" });

    first.unsubscribe();
    const second = link.subscribe(options);
    expect(transport.subscriptions.filter((entry) => entry.channel.endsWith("session-1"))).toHaveLength(2);

    // The stale handle releasing a second time must not deregister its
    // successor: doing so would let a third subscription open on a channel the
    // server permits only one of.
    first.unsubscribe();
    expect(() => link.subscribe(options)).toThrow(/already exists/);
    second.unsubscribe();
    expect(() => link.subscribe(options)).not.toThrow();
  });
});

// The adapter's fake transport is only as good as the library it stands in for,
// so the two constraints the fake encodes are read straight off Centrifuge here.
// No socket is involved: the registry is client-side and populated by
// `newSubscription` before any connect.
describe("ClientLink over real Centrifuge", () => {
  const options = {
    tenantId: "tenant-1",
    sessionId: "session-1",
    onPublication: () => undefined,
    onReset: () => undefined,
    onError: () => undefined,
  };

  it("throws on a second live subscription to one session", () => {
    const link = createClientLink({ endpoint: "ws://127.0.0.1:1/connection/websocket" });
    link.subscribe(options);
    expect(() => link.subscribe(options)).toThrow(/already exists/);
  });

  // `removeSubscription` deletes the registry entry BY CHANNEL, so a stale
  // handle unsubscribing a second time would take the successor's entry out and
  // let a third subscription open on a channel the server permits one of.
  it("does not let a stale handle detach its successor", () => {
    const link = createClientLink({ endpoint: "ws://127.0.0.1:1/connection/websocket" });
    const first = link.subscribe(options);
    first.ready.catch(() => {});
    first.unsubscribe();
    const second = link.subscribe(options);
    second.ready.catch(() => {});

    first.unsubscribe();
    expect(() => link.subscribe(options)).toThrow(/already exists/);
  });

  it("accepts a resubscribe after unsubscribe, which is what the rejoin path needs", () => {
    const link = createClientLink({ endpoint: "ws://127.0.0.1:1/connection/websocket" });
    const first = link.subscribe(options);
    // Real behaviour the React fake does not mirror: tearing a subscription
    // down before it is authorized REJECTS `ready`. `FactoryLinkStore` observes
    // that rejection; an unobserved one here would surface as a suite error.
    first.ready.catch(() => {});
    first.unsubscribe();
    let second: ClientSubscription | undefined;
    expect(() => { second = link.subscribe(options); }).not.toThrow();
    second?.ready.catch(() => {});
  });
});
