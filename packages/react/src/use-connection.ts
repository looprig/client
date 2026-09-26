import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createFactoryClient, FactoryRestReads } from "@looprig/client";
import type {
  FactoryBootstrap,
  FactoryClient,
  FactoryClientOptions,
  FactoryCredentials,
  SessionViewStore,
} from "@looprig/client";
import {
  FactoryLinkStore,
  SessionConnectionStore,
  type ConnectionStatus,
  type FactoryLinkStatus,
  type SessionBinding,
  type SessionBindingOptions,
} from "./stores/connection.js";
import { asError } from "./stores/publisher.js";
import { useStore } from "./use-store.js";

export type { ConnectionState, ConnectionStatus } from "./stores/connection.js";
export type {
  FactoryLinkState,
  FactoryLinkStatus,
  SessionBinding,
  SessionBindingOptions,
} from "./stores/connection.js";

/**
 * One session's connection state, as a renderable value.
 *
 * This is the hook the design brief's §6.10l is about: the plan assumed `live`
 * and `error` were fields on the view snapshot, and they are not. Errors arrive
 * on `SessionViewStore.subscribeErrors`, a separate, deliberately
 * NON-COALESCED channel, and liveness on `subscribeLifecycle`. Neither is on
 * the snapshot, and neither can be: coalescing two errors inside one frame
 * would collapse them to one, and an error immediately followed by a success
 * would vanish entirely.
 *
 * A NON-FATAL error and a terminal one are kept apart rather than folded into
 * one `error` field:
 *
 *  - `warningCount` / `lastWarning` — the fold skipped one bad input, or the
 *    live queue dropped frames. The join kept going and `connected` stays
 *    true. Render this as a badge, never as a teardown.
 *  - `failure` — this ended the join. `connected` is false and `state` is
 *    `"failed"`.
 *
 * See `stores/connection.ts` for how the two are told apart.
 *
 * This hook does NOT start or stop the store; `useSessionView` owns that. Pass
 * it the same store.
 */
export function useConnection(store: SessionViewStore): ConnectionStatus {
  const connection = useMemo(() => new SessionConnectionStore(store), [store]);
  useEffect(() => connection.attach(), [connection]);
  return useStore(connection);
}

/**
 * The raw fold/join error channel, as events.
 *
 * `useConnection` is the state; this is the stream, for a consumer that wants
 * every error — a toast, a console log, a telemetry sink — including the two it
 * would otherwise only see as a count. Delivered synchronously, in order, at
 * the moment each is folded.
 *
 * `onError` is held in a ref, so an inline arrow (which is every real call
 * site) does not tear the subscription down and reopen it on each render — an
 * error delivered in that window would simply be lost.
 *
 * Classify with `error instanceof FoldError` from `@looprig/client` for the
 * non-fatal case; use `useConnection` when the distinction between a warning
 * and a terminal failure is what you are rendering.
 */
export function useSessionViewErrors(
  store: SessionViewStore,
  onError: (error: Error) => void,
): void {
  const listenerRef = useRef(onError);
  useEffect(() => {
    listenerRef.current = onError;
  }, [onError]);

  useEffect(() => store.subscribeErrors((error) => listenerRef.current(error)), [store]);
}

/**
 * The application-scoped Factory plane: one client, one `ClientLink`, one
 * `FactoryLinkStore` over it.
 */
export interface FactoryScope {
  readonly client: FactoryClient;
  readonly link: FactoryLinkStore;
}

const FactoryTenantContext = createContext<string | null>(null);

export interface FactoryIdentityProviderProps extends FactoryLinkProviderProps {
  /**
   * Identity-owner supplied generation. Changing it tears down the old client
   * and every descendant view before asking Factory who the new caller is.
   * Ambient cookies have no browser change notification; an application with
   * login/logout controls must increment this value at that transition.
   */
  authGeneration?: string | number;
  /** Rendered while the authenticated tenant is being verified. */
  pending?: ReactNode;
  /** Rendered after bootstrap fails. The callback's retry uses current credentials. */
  renderBootstrapError?: (error: Error, retry: () => void) => ReactNode;
  /** Narrow test seam; production uses FactoryRestReads.readBootstrap. */
  readBootstrap?: (
    signal: AbortSignal,
    credentials: FactoryCredentials,
  ) => Promise<FactoryBootstrap>;
}

/**
 * Verifies the browser principal before constructing or exposing a Factory
 * client. A generation change replaces this whole keyed subtree, so a cached
 * session view from the previous principal cannot render during bootstrap.
 */
export function FactoryIdentityProvider(props: FactoryIdentityProviderProps): ReactElement {
  const generation = props.authGeneration ?? 0;
  return createElement(FactoryIdentityGeneration, { ...props, key: `${typeof generation}:${generation}` });
}

function FactoryIdentityGeneration(props: FactoryIdentityProviderProps): ReactElement {
  const credentialsRef = useRef(props.credentials);
  useEffect(() => {
    credentialsRef.current = props.credentials;
  });
  const restCredentials = useMemo<FactoryCredentials>(() => ({
    restHeaders: () => credentialsRef.current?.restHeaders?.() ?? {},
  }), []);
  const bootstrapRef = useRef(props.readBootstrap);
  useEffect(() => {
    bootstrapRef.current = props.readBootstrap;
  });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const [result, setResult] = useState<
    { state: "reading" } | { state: "ready"; tenantId: string } | { state: "failed"; error: Error }
  >({ state: "reading" });

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setResult({ state: "reading" });
    const load = bootstrapRef.current ?? ((signal: AbortSignal, credentials: FactoryCredentials) => {
      const reads = new FactoryRestReads({
        fetch: props.options?.fetch,
        baseUrl: props.options?.baseUrl,
        credentials,
      });
      return reads.readBootstrap({ signal });
    });
    void load(controller.signal, restCredentials).then(
      (bootstrap) => {
        if (current && !controller.signal.aborted) {
          setResult({ state: "ready", tenantId: bootstrap.tenant_id });
        }
      },
      (cause: unknown) => {
        if (current && !controller.signal.aborted) setResult({ state: "failed", error: asError(cause) });
      },
    );
    return () => {
      current = false;
      controller.abort();
    };
    // `options` and the bootstrap seam are construction inputs, matching
    // FactoryLinkProvider. Current credentials are forwarded through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, restCredentials]);

  if (result.state === "reading") return createElement("div", null, props.pending ?? null);
  if (result.state === "failed") {
    return createElement(
      "div",
      null,
      props.renderBootstrapError?.(result.error, retry)
        ?? createElement("div", { role: "alert" }, result.error.message),
    );
  }
  return createElement(
    FactoryLinkProvider,
    { credentials: props.credentials, options: props.options, create: props.create },
    createElement(FactoryTenantContext.Provider, { value: result.tenantId }, props.children),
  );
}

/** The tenant returned by Factory for this authenticated provider generation. */
export function useFactoryTenantId(): string {
  const tenantId = useContext(FactoryTenantContext);
  if (tenantId === null) throw new Error("useFactoryTenantId requires a verified <FactoryIdentityProvider>");
  return tenantId;
}

const FactoryScopeContext = createContext<FactoryScope | null>(null);

export interface FactoryLinkProviderProps {
  /**
   * Read on EVERY token request, not captured at mount: a call site that writes
   * `credentials={{ connectionToken: () => store.token() }}` inline hands a new
   * object to every render, and a link built around the first one would keep
   * minting from a closure over whatever the token store held at startup.
   */
  credentials?: FactoryCredentials;
  /** Everything else `createFactoryClient` takes, read once, at construction. */
  options?: Omit<FactoryClientOptions, "credentials">;
  /** Injected for tests. Defaults to protocol's `createFactoryClient`. */
  create?: (options: FactoryClientOptions) => FactoryClient;
  children?: ReactNode;
}

/**
 * Constructs the Factory client and its link ONCE, above the route, and opens
 * the connection from an effect.
 *
 * ## Why the client is not built in `useMemo`
 *
 * React double-invokes a `useMemo` factory in StrictMode and keeps one result.
 * For a pure derivation that is free; for a constructor that allocates a
 * WebSocket client it means a second client nothing will ever close. A ref
 * initialized on first use is the pattern that runs exactly once per mounted
 * component, and `use-factory-link.strict.test.tsx` counts the constructions.
 *
 * `options` and `create` are therefore read on the first render only, which is
 * exactly the "one Factory client per application" the runbook asks for; the
 * one input that must stay live is `credentials`, and that is why it alone is
 * forwarded through a ref.
 */
export function FactoryLinkProvider(props: FactoryLinkProviderProps): ReactElement {
  const credentialsRef = useRef<FactoryCredentials | undefined>(props.credentials);
  // An effect with no dependency array: it runs after every commit, so the ref
  // holds the credentials of the last RENDERED tree. A render-phase write would
  // be unsafe under concurrent rendering, and nothing reads these before the
  // effect that opens the connection has run.
  useEffect(() => {
    credentialsRef.current = props.credentials;
  });

  const scopeRef = useRef<FactoryScope | null>(null);
  if (scopeRef.current === null) {
    const construct = props.create ?? createFactoryClient;
    const client = construct({
      ...(props.options ?? {}),
      credentials: forwardCredentials(() => credentialsRef.current, props.credentials),
    });
    scopeRef.current = { client, link: new FactoryLinkStore(client.link) };
  }
  const scope = scopeRef.current;

  useEffect(() => {
    scope.link.open();
    return () => {
      scope.link.close();
    };
  }, [scope]);

  return createElement(FactoryScopeContext.Provider, { value: scope }, props.children);
}

/**
 * A `FactoryCredentials` whose functions delegate to whatever the provider was
 * last rendered with.
 *
 * The two halves are treated differently because the two consumers read them at
 * different times, and the difference is mechanical rather than a preference:
 *
 *  - `FactoryRestReads` calls `restHeaders` per request and re-checks whether it
 *    exists, so this forwards it unconditionally and a capability that appears
 *    later is picked up;
 *  - `protocol/src/clientlink.ts` decides at CONSTRUCTION whether to install
 *    Centrifuge's `getToken`/`getData` hooks. Defining a token forwarder for a
 *    caller that supplies none would install a hook that can only fail, so which
 *    link capabilities exist is fixed by the credentials present at mount. Only
 *    the function behind each one is live.
 */
function forwardCredentials(
  current: () => FactoryCredentials | undefined,
  initial: FactoryCredentials | undefined,
): FactoryCredentials {
  const forwarder: FactoryCredentials = {
    restHeaders: () => current()?.restHeaders?.() ?? {},
  };
  if (initial?.connectionToken !== undefined) {
    forwarder.connectionToken = async (): Promise<string> => {
      const mint = current()?.connectionToken;
      if (mint === undefined) throw new Error("no connection token provider");
      return mint();
    };
  }
  if (initial?.subscriptionToken !== undefined) {
    forwarder.subscriptionToken = async (context): Promise<string> => {
      const mint = current()?.subscriptionToken;
      if (mint === undefined) throw new Error("no subscription token provider");
      return mint(context);
    };
  }
  if (initial?.subscriptionData !== undefined) {
    forwarder.subscriptionData = async (context): Promise<unknown> => {
      const build = current()?.subscriptionData;
      if (build === undefined) throw new Error("no subscription data provider");
      return build(context);
    };
  }
  return forwarder;
}

function useFactoryScope(): FactoryScope {
  const scope = useContext(FactoryScopeContext);
  if (scope === null) {
    throw new Error("a Factory hook requires a <FactoryLinkProvider> above it");
  }
  return scope;
}

/** The application's one Factory client: REST reads, commands, clock, IDs. */
export function useFactoryClient(): FactoryClient {
  return useFactoryScope().client;
}

/** The application's one link store, for a caller that binds by hand. */
export function useFactoryLink(): FactoryLinkStore {
  return useFactoryScope().link;
}

/** The link's connection state, as a renderable value. */
export function useFactoryLinkStatus(): FactoryLinkStatus {
  return useStore(useFactoryScope().link);
}

/** What a session view holds: its binding's identity and its cursor. */
export interface SessionBindingHandle {
  readonly sessionId: string;
  /** The bound cursor, or 0 before the binding's effect has run. */
  readonly cursor: number;
  advance(sequence: number): void;
}

/**
 * Subscribes one session view to the application's link for as long as it is
 * mounted.
 *
 * The view owns a binding and a cursor and nothing else — no client, no link,
 * no connection lifecycle. The callbacks are inline arrows at every real call
 * site, so they are read through a ref: depending on their identity would
 * cancel and reopen the subscription on every render, and a publication
 * arriving in that window would simply be lost.
 *
 * The cursor lives in the binding, and `advance` and `cursor` here are pure
 * delegation — there is deliberately no second copy in this hook. A cursor
 * survives a RECONNECT, which is the case that matters and which the binding
 * already handles; it does not survive a rebind, because this effect rebinds
 * only when the session, tenant or link changes, and a journal sequence
 * measured on one session means nothing on another. A rebind therefore starts
 * from the `cursor` option, exactly as the first bind does.
 */
export function useSessionBinding(options: SessionBindingOptions): SessionBindingHandle {
  const link = useFactoryLink();
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const bindingRef = useRef<SessionBinding | null>(null);
  const { tenantId, sessionId } = options;

  useEffect(() => {
    const binding = link.bind({
      tenantId,
      sessionId,
      cursor: optionsRef.current.cursor ?? 0,
      onPublication: (publication) => optionsRef.current.onPublication(publication),
      onReset: (reset) => optionsRef.current.onReset(reset),
      onJoin: (cursor) => optionsRef.current.onJoin?.(cursor),
      onRejoin: (cursor) => optionsRef.current.onRejoin?.(cursor),
      onError: (error) => optionsRef.current.onError?.(error),
    });
    bindingRef.current = binding;
    return () => {
      bindingRef.current = null;
      binding.cancel();
    };
  }, [link, tenantId, sessionId]);

  return useMemo(
    () => ({
      get sessionId(): string {
        return sessionId;
      },
      get cursor(): number {
        return bindingRef.current?.cursor ?? 0;
      },
      advance: (sequence: number): void => {
        bindingRef.current?.advance(sequence);
      },
    }),
    [sessionId],
  );
}
