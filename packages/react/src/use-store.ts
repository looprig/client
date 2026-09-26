import { useCallback, useSyncExternalStore } from "react";

/**
 * The framework-neutral store shape this package adapts. `@looprig/client`'s
 * `FactorySessionViewStore` satisfies it structurally, and so does every store in
 * `src/stores/`.
 */
export interface ReadableStore<S> {
  subscribe(listener: () => void): () => void;
  /** MUST return the identical reference until the next notify. */
  snapshot(): S;
}

function identity<S>(snapshot: S): S {
  return snapshot;
}

/**
 * Subscribes to `store` and returns `select(store.snapshot())`.
 *
 * Two rules, both enforced by this module's tests:
 *
 *  - `subscribe` is memoized on the store's identity. An inline arrow would
 *    make React tear down and reopen the subscription on every single render.
 *  - `select` MUST return something that already lives in the snapshot — a row
 *    object, a number, a string. It must NEVER build a fresh object or array,
 *    because `useSyncExternalStore` compares with `Object.is` and a fresh
 *    object is never equal to itself; React detects the resulting loop and
 *    throws "The result of getSnapshot should be cached to avoid an infinite
 *    loop". Derive shapes in `useMemo` on the value this returns, not in here.
 *
 * `select` is deliberately NOT memoized: React reads it during render and
 * stores it through a ref, so its identity is free to change. Only the VALUE
 * has to be stable.
 */
export function useStoreSelector<S, T>(store: ReadableStore<S>, select: (snapshot: S) => T): T {
  const subscribe = useCallback((onStoreChange: () => void) => store.subscribe(onStoreChange), [store]);
  const getSelection = (): T => select(store.snapshot());
  // The third argument is the server snapshot. This SPA never server-renders,
  // but passing it keeps the hook safe if `app/` is ever prerendered.
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

/** `useStoreSelector` with the whole snapshot. */
export function useStore<S>(store: ReadableStore<S>): S {
  return useStoreSelector(store, identity);
}
