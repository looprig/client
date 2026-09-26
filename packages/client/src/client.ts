import { uuidV4 } from "./uuid.js";
import { FactoryRestReads, type FactoryReads, type FactoryRestCredentials } from "./factory-rest.js";
import {
  createClientLink,
  type ClientLink,
  type ClientLinkCredentials,
  type ClientLinkConstructor,
} from "./clientlink.js";
import { createFactoryCommands, type FactoryCommands } from "./commands.js";

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
