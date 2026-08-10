/**
 * Thin composition tying a `LooprigTransport` implementation to the public
 * `@looprig/client` surface. At this stage (Phase 1a — cold reads only)
 * `LooprigClient` is exactly `LooprigTransport`: there is no client-only
 * behavior to layer on top yet, so this is a type alias rather than a
 * hand-written wrapper that would just forward every call unchanged. As later
 * tasks add live/control methods to LooprigTransport (and any second
 * transport, e.g. Task 28's ServeTransport), LooprigClient tracks them for
 * free.
 *
 * `createClient` accepts any LooprigTransport, so a consumer that constructs
 * its own transport (or a test with a fake one) isn't forced through
 * `createBFFClient`. `createBFFClient` is the ergonomic default entry point
 * for the same-origin browser case this package is built for.
 */
import { BFFTransport, type BFFTransportOptions, type LooprigTransport } from "./transport.js";

export type LooprigClient = LooprigTransport;

/** Wraps any LooprigTransport as the public client surface. */
export function createClient(transport: LooprigTransport): LooprigClient {
  return transport;
}

/** Constructs a BFFTransport and wraps it as the public client surface — the default for same-origin browser apps. */
export function createBFFClient(options?: BFFTransportOptions): LooprigClient {
  return createClient(new BFFTransport(options));
}
