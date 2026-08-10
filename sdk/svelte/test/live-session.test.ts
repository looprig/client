/**
 * Reactivity-lifecycle tests for `LiveSessionViewStore` (live-session.svelte.ts).
 * `JournalReader`/`LiveFrameSource` are hand-rolled fakes — no network
 * involved, no real `joinSessionView` timing races to fight — mirroring both
 * this package's own session.test.ts (fakes over a real transport) and
 * sdk/core's join.test.ts (`FakeJournalReader`/`FakeLiveConnection`, the
 * shape these fakes are deliberately kept close to, since this store drives
 * the exact same `joinSessionView` join.test.ts already proves correct — the
 * scope here is the STORE's own republishing/lifecycle behavior on top of
 * it, not re-proving the join algorithm itself).
 *
 * The flagship case ("stop() during an idle live wait...") reproduces the
 * exact scenario live-session.svelte.ts's own module comment describes and
 * this task flagged as the real risk: `joinSessionView` parked mid-await at
 * `queue.next()` with nothing pushed and the connection not ended — the
 * state a live session sits in for almost its entire lifetime. It asserts
 * both that the live connection's `.return()` was actually invoked (proving
 * the cancellation reached past `joinSessionView`'s own generator queue) and
 * that no new connection is opened afterward (proving the abort signal
 * correctly suppressed the `autoReconnect` that would otherwise follow the
 * connection merely ending).
 */
import { describe, expect, it } from "vitest";
import type {
  EventJournalPage,
  JournalReader,
  LiveFrameSource,
  ReadHistoryOptions,
  SseFrame,
} from "@looprig/client";
import { LiveSessionViewStore } from "../src/live-session.svelte.js";

// --- Test doubles (mirroring sdk/core/test/join.test.ts's own fakes) --------

class FakeJournalReader implements JournalReader {
  readonly calls: ReadHistoryOptions[] = [];
  private readonly pending: Array<{ resolve: (p: EventJournalPage) => void; reject: (e: unknown) => void }> = [];

  readHistory(_sessionId: string, options: ReadHistoryOptions = {}): Promise<EventJournalPage> {
    this.calls.push(options);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  resolveNext(page: EventJournalPage): void {
    const next = this.pending.shift();
    if (!next) throw new Error("FakeJournalReader.resolveNext: no pending readHistory() call");
    next.resolve(page);
  }
}

class FakeLiveConnection {
  private readonly buffered: SseFrame[] = [];
  private readonly waiters: Array<{ resolve: (r: IteratorResult<SseFrame, undefined>) => void; reject: (e: unknown) => void }> = [];
  private ended = false;

  /** Number of times this connection's iterator's `.return()` was called. */
  returnCalls = 0;

  push(frame: SseFrame): void {
    if (this.ended) throw new Error("FakeLiveConnection.push() after end()");
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: frame, done: false });
    else this.buffered.push(frame);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SseFrame> {
    return {
      next: (): Promise<IteratorResult<SseFrame, undefined>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift() as SseFrame, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        // A genuinely never-resolving wait unless push()/end()/return() is
        // called — this is the "parked mid-await" state under test.
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
      return: (): Promise<IteratorResult<SseFrame, undefined>> => {
        this.returnCalls++;
        this.ended = true;
        for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

class FakeLiveSource {
  readonly connections: FakeLiveConnection[] = [];
  readonly open: LiveFrameSource = () => {
    const conn = new FakeLiveConnection();
    this.connections.push(conn);
    return conn;
  };
}

const sessionId = "11111111-1111-1111-1111-111111111111";

/** Flushes pending microtasks — enough ticks for the store's async pump loop to catch up to whatever was just pushed/resolved. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function mkEnvelope(seq: number): SseFrame {
  return {
    type: "enduring",
    journalSeq: seq,
    data: { v: 1, event: { type: "TurnDone", v: 1, event_id: `10000000-0000-0000-0000-${String(seq).padStart(12, "0")}` } },
  };
}

describe("LiveSessionViewStore lifecycle", () => {
  it("is inactive with an empty view before start()", () => {
    const journal = new FakeJournalReader();
    const live = new FakeLiveSource();
    const store = new LiveSessionViewStore(journal, sessionId, live.open);

    expect(store.active).toBe(false);
    expect(store.view.content).toEqual([]);
    expect(store.error).toBeNull();
  });

  it("flips active synchronously on start(), and republishes SessionView as history/live frames fold in", async () => {
    const journal = new FakeJournalReader();
    const live = new FakeLiveSource();
    const store = new LiveSessionViewStore(journal, sessionId, live.open);

    store.start();
    expect(store.active).toBe(true);

    await flush();
    // Live connection subscribed before the cold read resolves (join.ts's
    // step 1) — confirms the store actually reached into joinSessionView,
    // not just flipped a flag.
    expect(live.connections).toHaveLength(1);

    journal.resolveNext({ events: [], next_journal_seq: 0, done: true });
    await flush();

    live.connections[0]!.push(mkEnvelope(1));
    await flush();

    expect(store.view.statusEvents).toHaveLength(1);
    expect(store.view.statusEvents[0]).toMatchObject({ type: "TurnDone", journalSeq: 1 });
  });

  it("start() is idempotent while already active: does not open a second connection", async () => {
    const journal = new FakeJournalReader();
    const live = new FakeLiveSource();
    const store = new LiveSessionViewStore(journal, sessionId, live.open);

    store.start();
    await flush();
    store.start();
    await flush();

    expect(live.connections).toHaveLength(1);
  });

  it("stop() before start() has ever run is a safe no-op", () => {
    const journal = new FakeJournalReader();
    const live = new FakeLiveSource();
    const store = new LiveSessionViewStore(journal, sessionId, live.open);

    expect(() => store.stop()).not.toThrow();
    expect(store.active).toBe(false);
  });

  it("stop() during an idle live wait genuinely cancels the live connection (bypassing joinSessionView's own generator queue) and does not trigger an autoReconnect", async () => {
    const journal = new FakeJournalReader();
    const live = new FakeLiveSource();
    const store = new LiveSessionViewStore(journal, sessionId, live.open);

    store.start();
    await flush();
    journal.resolveNext({ events: [], next_journal_seq: 0, done: true });
    await flush();

    // At this point joinSessionView has drained the (empty) buffer and moved
    // into its step-4 follow loop, parked at `await queue.next()` — nothing
    // has been pushed and the connection hasn't ended. This is the exact
    // "stuck mid-await" state the module doc describes: a bare
    // `joinGenerator.return()` would NOT unblock this on its own (verified
    // empirically for this task outside this suite). The assertions below
    // are what actually prove the store's stop() does better than that.
    expect(store.active).toBe(true);
    const connection = live.connections[0]!;
    expect(connection.returnCalls).toBe(0);

    store.stop();

    // The cancellation must be synchronous-triggered, not dependent on any
    // further event loop activity from the fake connection itself (nothing
    // was pushed, nothing ended it) — a single flush is enough BECAUSE
    // cancelActive() calls .return() directly, not through joinSessionView's
    // queue.
    await flush();

    // Called at least once by our own cancelActive() (the synchronous,
    // queue-bypassing call this test exists to prove happens); join.ts's own
    // finally block harmlessly calls it again once its generator unwinds, so
    // this asserts "was actually invoked," not an exact call count.
    expect(connection.returnCalls).toBeGreaterThanOrEqual(1);
    expect(store.active).toBe(false);

    // Give any wrongly-triggered reconnect every chance to happen.
    await flush();
    expect(live.connections).toHaveLength(1);
  });

  it("a fold error surfaces via lastFoldError without stopping the loop", async () => {
    const journal = new FakeJournalReader();
    const live = new FakeLiveSource();
    const store = new LiveSessionViewStore(journal, sessionId, live.open);

    store.start();
    await flush();
    journal.resolveNext({ events: [], next_journal_seq: 0, done: true });
    await flush();

    // A malformed token_delta ephemeral frame: valid envelope, but fold.ts's
    // runtime guard rejects a missing "text" field on a "text" chunk_type.
    live.connections[0]!.push({
      type: "ephemeral",
      data: { v: 1, kind: "token_delta", delta: { chunk_type: "text" } },
    } as SseFrame);
    await flush();

    expect(store.lastFoldError).not.toBeNull();
    expect(store.lastFoldError?.reason).toBe("malformed_delta");
    expect(store.active).toBe(true); // the loop kept running past the bad input

    live.connections[0]!.push(mkEnvelope(1));
    await flush();
    expect(store.view.statusEvents).toHaveLength(1);
  });

  it("start() after stop() begins a genuinely fresh join (new connection, view starts over)", async () => {
    const journal = new FakeJournalReader();
    const live = new FakeLiveSource();
    const store = new LiveSessionViewStore(journal, sessionId, live.open);

    store.start();
    await flush();
    journal.resolveNext({ events: [], next_journal_seq: 0, done: true });
    await flush();
    live.connections[0]!.push(mkEnvelope(1));
    await flush();
    expect(store.view.statusEvents).toHaveLength(1);

    store.stop();
    await flush();

    store.start();
    await flush();
    expect(live.connections).toHaveLength(2);

    journal.resolveNext({ events: [], next_journal_seq: 0, done: true });
    await flush();
    // A fresh join starts from an empty view again (this store's own
    // `initialView` isn't carried across stop()/start(); a caller that wants
    // continuity would pass `options.initialView` explicitly).
    expect(store.view.statusEvents).toEqual([]);
  });
});
