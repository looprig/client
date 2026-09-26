/**
 * The mechanical half of the Svelte-to-React port. Where
 * `client/sdk/svelte/src/*.svelte.ts` wrote `this.loading = true` against a
 * `$state` field, this writes `this.publish({ loading: true })`: one immutable
 * snapshot object, swapped wholesale, then every listener notified.
 *
 * The snapshot reference changes on every publish and NEVER between publishes,
 * which is the caching `useSyncExternalStore` requires (see `use-store.ts`).
 * Nothing in this file imports React.
 */
export abstract class Publisher<S> {
  #snapshot: S;
  readonly #listeners = new Set<() => void>();

  protected constructor(initial: S) {
    this.#snapshot = initial;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot = (): S => this.#snapshot;

  /**
   * Copy the listener set before iterating. NOT for the reason 04-react.md
   * gives — a `Set` iterator is already safe under self-removal, so a listener
   * unsubscribing itself needs no copy and that claim is pinned by nothing.
   * The copy is load-bearing for INSERTION: a `Set` added to during iteration
   * yields the new entry in the same loop, so a listener that subscribes from
   * inside a notify would be invoked re-entrantly for a state change that
   * happened before it subscribed.
   */
  protected publish(patch: Partial<S>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * Carried over verbatim from `client/sdk/svelte/src/session.svelte.ts`. Tracks
 * overlapping calls for one store so that if responses resolve out of order,
 * only the LAST-STARTED call's result is ever committed.
 */
export class RefreshGuard {
  #generation = 0;

  start(): number {
    this.#generation += 1;
    return this.#generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }
}

/** Every rejection a `LooprigTransport` produces is already a real Error; this
 *  only narrows `strict`'s `unknown` catch type without an `as`. */
export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

/**
 * Wraps a cancellation so that at most one call reaches `cancel`, however many
 * callers hold the result and however often each calls it.
 *
 * Two owners legitimately hold a session binding's cancellation: the view whose
 * effect created it, and the application-scoped link that tears every binding
 * down when it closes. Neither can know whether the other ran first — React
 * gives no ordering guarantee between a parent's cleanup and a child's — so the
 * "cancelled exactly once" property has to live in the value they share rather
 * than in either caller. `stores/connection.test.ts` counts the calls that
 * reach the subscription for both orders.
 */
export function cancelOnce(cancel: () => void): () => void {
  let cancelled = false;
  return () => {
    if (cancelled) return;
    cancelled = true;
    cancel();
  };
}
