import { expect, test, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useStore, useStoreSelector } from "./use-store.js";

interface Snapshot {
  readonly count: number;
  readonly label: string;
}

/** The store contract this package requires: one frozen snapshot object,
 *  swapped wholesale, published to listeners. Counts subscriptions so the test
 *  can prove React did not re-subscribe on every render. */
class CountingStore {
  subscribeCount = 0;
  #snapshot: Snapshot = { count: 0, label: "a" };
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.subscribeCount += 1;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot = (): Snapshot => this.#snapshot;

  publish(patch: Partial<Snapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
}

test("mounts with exactly one render and no cached-getSnapshot error", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const store = new CountingStore();
  let renders = 0;

  const { result } = await renderHook(() => {
    renders += 1;
    return useStore(store);
  });

  expect(result.current).toStrictEqual({ count: 0, label: "a" });
  // Exactly one. A second render here is the canary for a getSnapshot that
  // builds a fresh object per call; do not loosen this to a range.
  expect(renders).toBe(1);
  expect(consoleError.mock.calls.flat().join(" ")).not.toContain("getSnapshot");
  consoleError.mockRestore();
});

test("returns the store's own snapshot reference, not a copy of it", async () => {
  const store = new CountingStore();

  const { result } = await renderHook(() => useStore(store));

  // The identity, not the value. `useSyncExternalStore` compares with
  // Object.is, so a hook that rebuilt the snapshot would re-render forever —
  // and a per-row selector built on it (Task 4.9) would never bail out.
  expect(result.current).toBe(store.snapshot());
});

test("re-rendering does not re-subscribe", async () => {
  const store = new CountingStore();
  const { rerender } = await renderHook(() => useStore(store));

  await rerender();
  await rerender();

  expect(store.subscribeCount).toBe(1);
});

test("a publish re-renders and hands back the new snapshot", async () => {
  const store = new CountingStore();
  let renders = 0;

  const { result, act } = await renderHook(() => {
    renders += 1;
    return useStore(store);
  });

  await act(() => {
    store.publish({ count: 7 });
  });

  expect(renders).toBe(2);
  expect(result.current).toStrictEqual({ count: 7, label: "a" });
});

test("a selector re-renders only when its own slice changes", async () => {
  const store = new CountingStore();
  let renders = 0;

  const { result, act } = await renderHook(() => {
    renders += 1;
    return useStoreSelector(store, (snapshot) => snapshot.label);
  });

  // A new snapshot object whose `label` is Object.is-equal must NOT re-render:
  // this is the exact bail-out that makes per-row selectors work in Task 4.9.
  await act(() => {
    store.publish({ count: 1 });
  });
  expect(renders).toBe(1);
  expect(result.current).toBe("a");

  await act(() => {
    store.publish({ label: "b" });
  });
  expect(renders).toBe(2);
  expect(result.current).toBe("b");
});

test("a selector whose identity changes every render does not re-subscribe", async () => {
  const store = new CountingStore();

  // A NEW arrow on every render, which is how every real call site writes it.
  // React reads `getSnapshot` through a ref, so only `subscribe` has to be
  // stable — memoizing the selector too would be dead weight, and depending on
  // its identity would reopen the subscription on every render.
  const { rerender } = await renderHook(() => useStoreSelector(store, (s) => s.label));

  await rerender();
  await rerender();

  expect(store.subscribeCount).toBe(1);
});
