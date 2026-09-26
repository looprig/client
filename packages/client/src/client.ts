import { uuidV4 } from "./uuid.js";
/**
 * Thin composition tying a `LooprigTransport` implementation to the public
 * `@looprig/client` client surface. `LooprigClient` is exactly
 * `LooprigTransport`: there is no client-only behavior to layer on top, so
 * this is a type alias rather than a hand-written wrapper that would just
 * forward every call unchanged. As methods are added to `LooprigTransport`,
 * `LooprigClient` tracks them for free.
 *
 * `createClient` accepts any LooprigTransport, so a consumer that constructs
 * its own transport (or a test with a fake one) isn't forced through
 * `createHostTransport`.
 *
 * `createHostTransport` is THE entry point a wui-hosted app calls (00-plan.md
 * §2's cross-phase contract names it): same-origin `/v1/...`, and — because
 * `wui/handler.go` wraps every state-changing control route in `wui/csrf.go`'s
 * CSRFGuard — the CSRF token carriage those routes demand. `ServeTransport` is
 * the other implementation and is deliberately NOT reachable from a factory
 * here: it is for non-browser callers talking to a bare `pkg/serve` endpoint,
 * it needs an explicit `baseUrl` and (usually) a bearer token, and it sends no
 * CSRF token — constructing it by hand is the point at which a caller states
 * it is not a browser.
 */
import { HostTransport, type HostTransportOptions, type LooprigTransport } from "./transport.js";
import { FactoryRestReads, type FactoryReads, type FactoryRestCredentials } from "./factory-rest.js";
import {
  createClientLink,
  type ClientLink,
  type ClientLinkCredentials,
  type ClientLinkConstructor,
} from "./clientlink.js";
import { createFactoryCommands, type FactoryCommands } from "./commands.js";

export type LooprigClient = LooprigTransport;

/** Wraps any LooprigTransport as the public client surface. */
export function createClient(transport: LooprigTransport): LooprigClient {
  return transport;
}

/**
 * Constructs the browser transport for a wui-hosted server — same-origin
 * `/v1/...`, lazily minting and echoing the CSRF token `wui/csrf.go` demands
 * on every state-changing request — and wraps it as the public client surface.
 * Synchronous by design: it mints nothing at construction, so it is safe as a
 * component/prop default.
 */
export function createHostTransport(options?: HostTransportOptions): LooprigClient {
  return createClient(new HostTransport(options));
}

export interface FactoryCredentials extends FactoryRestCredentials, ClientLinkCredentials {}

export type Clock = () => number;
export type IdGenerator = () => string;
export type FactoryClientLinkFactory = ClientLinkConstructor;

export interface FactoryClientOptions {
  fetch?: import("./transport.js").FetchLike;
  baseUrl?: string;
  realtimeUrl?: string;
  credentials?: FactoryCredentials;
  clock?: Clock;
  idGenerator?: IdGenerator;
  clientLinkFactory?: FactoryClientLinkFactory;
}

export interface FactoryClient {
  readonly reads: FactoryReads;
  readonly link: ClientLink;
  readonly commands: FactoryCommands;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

function realtimeEndpoint(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return "/v1/realtime";
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/realtime`;
  return endpoint.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

/** Constructs one application-scoped ClientLink plus the independent REST repair/cold-read plane. */
export function createFactoryClient(options: FactoryClientOptions = {}): FactoryClient {
  const credentials = options.credentials ?? {};
  const reads = new FactoryRestReads({ fetch: options.fetch, baseUrl: options.baseUrl, credentials });
  const constructLink = options.clientLinkFactory ?? createClientLink;
  const link = constructLink({
    endpoint: options.realtimeUrl ?? realtimeEndpoint(options.baseUrl),
    credentials,
  });
  const clock = options.clock ?? Date.now;
  const idGenerator = options.idGenerator ?? (() => uuidV4());
  const commands = createFactoryCommands({
    link,
    fetch: options.fetch,
    baseUrl: options.baseUrl,
    credentials,
    idGenerator,
  });
  return { reads, link, commands, clock, idGenerator };
}
