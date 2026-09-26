import { expect, test } from "vitest";
import { Publisher, RefreshGuard, asError, cancelOnce } from "./publisher.js";

interface Snapshot {
  readonly n: number;
  readonly s: string;
}

class TestPublisher extends Publisher<Snapshot> {
  constructor() {
    super({ n: 0, s: "a" });
  }
  set(patch: Partial<Snapshot>): void {
    this.publish(patch);
  }
}

test("the snapshot reference changes on a publish and never between publishes", () => {
  const store = new TestPublisher();
  const before = store.snapshot();

  expect(store.snapshot()).toBe(before);
  expect(store.snapshot()).toBe(before);

  store.set({ n: 1 });

  const after = store.snapshot();
  expect(after).not.toBe(before);
  expect(after).toStrictEqual({ n: 1, s: "a" });
  expect(store.snapshot()).toBe(after);
});

test("a listener subscribed from inside a notify is not called for that same publish", () => {
  const store = new TestPublisher();
  const seen: string[] = [];
  let latecomerSubscribed = false;

  store.subscribe(() => {
    seen.push("first");
    if (latecomerSubscribed) return;
    latecomerSubscribed = true;
    store.subscribe(() => {
      seen.push("latecomer");
    });
  });

  store.set({ n: 1 });
  store.set({ n: 2 });

  // This is what copying the listener set before iterating actually buys.
  // Iterating the live Set is SAFE under self-removal — the iterator has
  // already moved past the deleted entry — so 04-react.md's stated rationale
  // ("a listener may unsubscribe from within its own call") is pinned by
  // nothing; that mutation survives. Insertion is the real hazard: a Set added
  // to during iteration yields the new entry in the SAME loop, so a listener
  // that subscribes during a notify would be called re-entrantly, for a state
  // change that predates its subscription.
  expect(seen).toStrictEqual(["first", "first", "latecomer"]);
});

test("a listener that unsubscribes itself mid-notify stops after that publish", () => {
  const store = new TestPublisher();
  const seen: string[] = [];
  const off = store.subscribe(() => {
    seen.push("first");
    off();
  });
  store.subscribe(() => {
    seen.push("second");
  });

  store.set({ n: 1 });
  store.set({ n: 2 });

  expect(seen).toStrictEqual(["first", "second", "second"]);
});

test("unsubscribing stops further notifications", () => {
  const store = new TestPublisher();
  let calls = 0;
  const off = store.subscribe(() => {
    calls += 1;
  });

  store.set({ n: 1 });
  off();
  store.set({ n: 2 });

  expect(calls).toBe(1);
});

test("RefreshGuard treats only the last-started generation as current", () => {
  const guard = new RefreshGuard();

  const first = guard.start();
  const second = guard.start();

  expect(guard.isCurrent(first)).toBe(false);
  expect(guard.isCurrent(second)).toBe(true);
});

test("asError passes an Error through and wraps anything else", () => {
  const real = new Error("boom");

  expect(asError(real)).toBe(real);
  expect(asError("nope")).toBeInstanceOf(Error);
  expect(asError("nope").message).toBe("nope");
  expect(asError("nope").cause).toBe("nope");
});

// Enumerated rather than a single pair: one repeat cannot tell "at most once"
// from "at most twice", and the property is about any number of callers.
for (const calls of [1, 2, 3, 5]) {
  test(`cancelOnce forwards the first of ${calls} call(s) and no other`, () => {
    let reached = 0;
    const cancel = cancelOnce(() => {
      reached += 1;
    });

    for (let index = 0; index < calls; index += 1) cancel();

    expect(reached).toBe(1);
  });
}

test("cancelOnce that is never called never reaches its subject", () => {
  let reached = 0;
  cancelOnce(() => {
    reached += 1;
  });

  expect(reached).toBe(0);
});
