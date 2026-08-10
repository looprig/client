/**
 * Coverage for the exact history-to-live join (src/join.ts).
 *
 * ## Test-timing-control infrastructure
 *
 * The whole point of this suite is to control the exact interleaving of
 * "cold journal read in flight" vs. "live frame arrives" — real timers or
 * real network calls can't give that precision. Three fakes provide it:
 *
 *  - `FakeJournalReader`: `readHistory()` never resolves on its own; it
 *    records the call (`calls`) and stashes its resolver. The test decides
 *    exactly when (and with what page) each call resolves via
 *    `resolveNext()`, in FIFO order across however many pages a test needs.
 *  - `FakeLiveConnection` / `FakeLiveSource`: `FakeLiveSource.open` is the
 *    `LiveFrameSource` passed to `joinSessionView`; each call opens a new
 *    `FakeLiveConnection` (recorded in `.connections`, so a reconnect test
 *    can grab a handle to connection #1 vs. #2 specifically) whose `push()`
 *    lets the test inject a frame at a precise moment and whose `end()`/
 *    `fail()` simulate the connection dropping.
 *  - Exploiting a real, spec-guaranteed JS property: calling `gen.next()`
 *    on an async generator runs its body SYNCHRONOUSLY up to the first
 *    `await` that doesn't resolve immediately. `joinSessionView`'s first
 *    `await` is `journal.readHistory(...)` (subscribing to the live source
 *    happens synchronously just before it) — so a test can call
 *    `gen.next()` (without awaiting the returned promise yet), then
 *    synchronously assert the live connection is already open and the cold
 *    read is already in flight, THEN push live frames into the buffer,
 *    THEN resolve the cold read — deterministically placing a frame
 *    "inside the join window" (arrived after subscribe, before the cold
 *    read resolved) without any timers or races.
 */
import { describe, expect, it } from "vitest";
import { joinSessionView, type JoinEvent, type JournalReader, type LiveFrameSource } from "../src/join.js";
import type { ReadHistoryOptions } from "../src/transport.js";
import type { EnduringSseFrame, EphemeralSseFrame, SseFrame } from "../src/sse.js";
import type { EventEnvelope, EventJournalPage, StatusEvent } from "../src/types.js";

// --- Fixture builders ---------------------------------------------------------

function mkEnvelope(seq: number, type = "TurnDone"): EventEnvelope {
  return {
    type,
    v: 1,
    session_id: "00000000-0000-0000-0000-000000000000",
    event_id: `10000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
  };
}

function mkStatusEvent(seq: number, type = "TurnDone"): StatusEvent {
  return { journal_seq: seq, event: mkEnvelope(seq, type) };
}

function mkEnduringFrame(seq: number, type = "TurnDone"): EnduringSseFrame {
  return { type: "enduring", journalSeq: seq, data: { v: 1, event: mkEnvelope(seq, type) } };
}

function mkEphemeralFrame(): EphemeralSseFrame {
  return { type: "ephemeral", data: { v: 1, kind: "input_queued" } };
}

// --- Test doubles ---------------------------------------------------------------

class FakeJournalReader implements JournalReader {
  readonly calls: ReadHistoryOptions[] = [];
  private readonly pending: Array<{ resolve: (p: EventJournalPage) => void; reject: (e: unknown) => void }> = [];

  readHistory(_sessionId: string, options: ReadHistoryOptions = {}): Promise<EventJournalPage> {
    this.calls.push(options);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  /** Resolves the OLDEST not-yet-resolved `readHistory()` call, FIFO across however many pages a test needs. */
  resolveNext(page: EventJournalPage): void {
    const next = this.pending.shift();
    if (!next) throw new Error("FakeJournalReader.resolveNext: no pending readHistory() call to resolve");
    next.resolve(page);
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

class FakeLiveConnection {
  private readonly buffered: SseFrame[] = [];
  private readonly waiters: Array<{ resolve: (r: IteratorResult<SseFrame, undefined>) => void; reject: (e: unknown) => void }> = [];
  private ended = false;
  private failure: unknown;
  private hasFailure = false;

  /** Injects one frame. If the connection is currently being awaited on (a `next()` call is pending), it's delivered immediately; otherwise it's buffered until read. */
  push(frame: SseFrame): void {
    if (this.ended) throw new Error("FakeLiveConnection.push() after end()/fail()");
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: frame, done: false });
    else this.buffered.push(frame);
  }

  /** Simulates the connection closing cleanly (server closed it, or the client tore it down). */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  /** Simulates the connection failing (e.g. a network error mid-stream). */
  fail(err: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.hasFailure = true;
    this.failure = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  [Symbol.asyncIterator](): AsyncIterator<SseFrame> {
    return {
      next: (): Promise<IteratorResult<SseFrame, undefined>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift() as SseFrame, done: false });
        }
        if (this.ended) {
          return this.hasFailure ? Promise.reject(this.failure) : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
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

// --- Collection helpers ---------------------------------------------------------

/** Pulls exactly `n` items from the join. Throws if the generator completes first (surfaces a wrong-count bug loudly instead of silently truncating). */
async function collectN(gen: AsyncGenerator<JoinEvent, void, void>, n: number): Promise<JoinEvent[]> {
  const out: JoinEvent[] = [];
  while (out.length < n) {
    const r = await gen.next();
    if (r.done) throw new Error(`join generator completed after only ${out.length} of ${n} expected items`);
    out.push(r.value);
  }
  return out;
}

/** Pulls every item until the join ends on its own (used for "the join terminates cleanly" cases). */
async function collectAll(gen: AsyncGenerator<JoinEvent, void, void>): Promise<JoinEvent[]> {
  const out: JoinEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** journalSeq of an applied `enduring` StatusEventMarker, whichever segment it came from, or undefined for anything else. */
function seqOf(ev: JoinEvent): number | undefined {
  if (ev.input.segment === "history") return ev.input.event.journal_seq;
  if (ev.input.frame.type === "enduring") return ev.input.frame.journalSeq;
  return undefined;
}

function assertAllOk(events: JoinEvent[]): void {
  for (const ev of events) {
    if (!ev.ok) throw new Error(`expected ok:true, got FoldError(${ev.error.reason}): ${ev.error.message}`);
  }
}

// --- 1. The critical test: exactly-once across the join window --------------------

describe("joinSessionView: the join window", () => {
  it("an enduring frame that arrives after subscribe but before the cold read resolves is applied exactly once; an overlapping duplicate is dropped exactly once", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const gen = joinSessionView(journal, "sid-1", liveSource.open);

    // Drive the generator's synchronous prefix: Step 1 (subscribe live) and the
    // start of Step 2 (the first readHistory() call) both happen synchronously
    // before the generator's first `await` actually suspends it.
    const firstNext = gen.next();

    expect(liveSource.connections).toHaveLength(1);
    expect(journal.calls).toHaveLength(1);
    expect(journal.pendingCount).toBe(1);
    const conn = liveSource.connections[0]!;

    // The cold read (about to resolve) will cover journal_seq 0..3, tip = 4.
    // While it's still in flight, two live frames land in the buffer:
    //  - journalSeq 3: a duplicate of what the cold page is about to deliver —
    //    must be dropped (never yielded at all: it was already covered).
    //  - journalSeq 4: brand new, sitting exactly AT the tip boundary — this is
    //    the frame "inside the join window": it must be applied exactly once,
    //    not zero times (lost) and not twice (duplicated).
    conn.push(mkEnduringFrame(3));
    conn.push(mkEnduringFrame(4));

    journal.resolveNext({
      events: [mkStatusEvent(0), mkStatusEvent(1), mkStatusEvent(2), mkStatusEvent(3)],
      next_journal_seq: 4,
      done: true,
    });

    const first = await firstNext;
    if (first.done) throw new Error("unreachable: expected the first history item");
    const rest = await collectN(gen, 4); // journal_seq 1,2,3 (history) + journal_seq 4 (live, exactly once)
    const collected = [first.value, ...rest];

    assertAllOk(collected);
    expect(collected).toHaveLength(5);

    // Exactly one applied item per journal_seq 0..4 — no gap, no duplicate.
    expect(collected.map(seqOf)).toEqual([0, 1, 2, 3, 4]);

    // journalSeq 3 was NOT re-applied from the live buffer: only one item
    // carries seq 3, and it's the history one.
    const seq3Items = collected.filter((ev) => seqOf(ev) === 3);
    expect(seq3Items).toHaveLength(1);
    expect(seq3Items[0]!.input.segment).toBe("history");

    // journalSeq 4 — the critical "inside the window" frame — was applied
    // exactly once, and it came from the live buffer (never appeared in any
    // cold page), proving it wasn't silently lost either.
    const seq4Items = collected.filter((ev) => seqOf(ev) === 4);
    expect(seq4Items).toHaveLength(1);
    expect(seq4Items[0]!.input.segment).toBe("live");

    if (collected[4]!.ok) {
      expect(collected[4]!.view.statusEvents).toHaveLength(5);
      expect(collected[4]!.view.statusEvents.map((m) => m.journalSeq)).toEqual([0, 1, 2, 3, 4]);
    }

    await gen.return();
  });
});

// --- 2. Multi-page cold journal ------------------------------------------------

describe("joinSessionView: multi-page cold journal", () => {
  it("pages through the entire cold history (not just one page) before computing the tip", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const gen = joinSessionView(journal, "sid-2", liveSource.open);

    const firstNext = gen.next();
    expect(liveSource.connections).toHaveLength(1);
    const conn = liveSource.connections[0]!;

    // A frame that lands during the SECOND page's flight — must survive to be
    // applied exactly once after both pages are read.
    conn.push(mkEnduringFrame(4));

    journal.resolveNext({ events: [mkStatusEvent(0), mkStatusEvent(1)], next_journal_seq: 2, done: false });

    // The join can't request page 2 until its `for...of` over page 1's events
    // has run past its LAST item — which only happens on the resumption
    // AFTER that item's `yield`, not the one that produces it. So: 2 events
    // needs 2 `.next()` calls to yield them, plus a 3rd to drive the
    // generator far enough to notice the loop is exhausted and actually
    // issue the page-2 `readHistory()` call (same synchronous-prefix trick
    // as this suite's other tests: the 3rd call need not be awaited yet to
    // have already driven that call).
    const first = await firstNext; // journal_seq 0
    if (first.done) throw new Error("unreachable");
    const second = await gen.next(); // journal_seq 1
    if (second.done) throw new Error("unreachable");
    const thirdNext = gen.next();

    expect(journal.calls).toHaveLength(2);
    expect(journal.calls[1]).toMatchObject({ fromJournalSeq: 2 });
    journal.resolveNext({ events: [mkStatusEvent(2), mkStatusEvent(3)], next_journal_seq: 4, done: true });

    const third = await thirdNext; // journal_seq 2
    if (third.done) throw new Error("unreachable");
    const rest = await collectN(gen, 2); // journal_seq 3 (page 2) + the live journal_seq-4 frame
    const collected = [first.value, second.value, third.value, ...rest];

    assertAllOk(collected);
    expect(collected.map(seqOf)).toEqual([0, 1, 2, 3, 4]);
    expect(collected[4]!.input.segment).toBe("live");

    await gen.return();
  });
});

// --- 3. Empty journal (brand-new session) --------------------------------------

describe("joinSessionView: empty journal", () => {
  it("a brand-new session with no history yet moves straight to live once the trivial catch-up completes", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const gen = joinSessionView(journal, "sid-3", liveSource.open);

    const firstNext = gen.next();
    expect(journal.calls).toHaveLength(1);
    expect(journal.calls[0]).toMatchObject({ fromJournalSeq: 0 });
    const conn = liveSource.connections[0]!;

    conn.push(mkEnduringFrame(0));

    journal.resolveNext({ events: [], next_journal_seq: 0, done: true });

    const first = await firstNext;
    if (first.done) throw new Error("unreachable: expected the live seq-0 frame");
    assertAllOk([first.value]);
    expect(seqOf(first.value)).toBe(0);
    expect(first.value.input.segment).toBe("live");
    if (first.value.ok) expect(first.value.view.statusEvents).toHaveLength(1);

    await gen.return();
  });
});

// --- 4. Ephemeral frames during the buffering window ---------------------------

describe("joinSessionView: ephemeral frames are unsequenced but never lost or duplicated", () => {
  it("an ephemeral frame that arrives purely during the buffering phase is applied exactly once, once catch-up completes", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const gen = joinSessionView(journal, "sid-4", liveSource.open);

    const firstNext = gen.next();
    const conn = liveSource.connections[0]!;

    // Arrives while the cold read is still in flight, well before live-following starts.
    conn.push(mkEphemeralFrame());

    journal.resolveNext({ events: [mkStatusEvent(0)], next_journal_seq: 1, done: true });

    const first = await firstNext; // history seq 0
    if (first.done) throw new Error("unreachable");
    const [ephemeralEvent] = await collectN(gen, 1);

    assertAllOk([first.value, ephemeralEvent!]);
    expect(first.value.input.segment).toBe("history");
    expect(ephemeralEvent!.input.segment).toBe("live");
    if (ephemeralEvent!.input.segment === "live") expect(ephemeralEvent!.input.frame.type).toBe("ephemeral");
    if (ephemeralEvent!.ok) {
      expect(ephemeralEvent!.view.queuedInputs).toHaveLength(1); // applied exactly once
      expect(ephemeralEvent!.view.statusEvents).toHaveLength(1); // still just the one history item
    }

    await gen.return();
  });
});

// --- 5. Session ends cleanly ------------------------------------------------------

describe("joinSessionView: the live stream ending", () => {
  it("terminates cleanly (no hang, no unhandled rejection) when the live connection closes and autoReconnect is off", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const gen = joinSessionView(journal, "sid-5", liveSource.open); // autoReconnect defaults to false

    const firstNext = gen.next();
    const conn = liveSource.connections[0]!;
    conn.push(mkEnduringFrame(1));
    journal.resolveNext({ events: [mkStatusEvent(0)], next_journal_seq: 1, done: true });

    // Give the join's cold-read + drain phase a chance to run before the
    // connection closes, so the close is observed by the live-follow loop
    // (Step 4), not mid-buffering.
    await firstNext;
    await Promise.resolve();
    conn.end();

    const collected = await collectAll(gen); // must resolve — this is the "no hang" assertion
    assertAllOk(collected);
    // Depending on exact microtask ordering the seq-1 live frame may have been
    // drained in Step 3 or followed in Step 4 — either way, exactly once.
    const withSeq1 = collected.filter((ev) => seqOf(ev) === 1);
    expect(withSeq1).toHaveLength(1);
  });

  it("a pre-aborted signal ends the join immediately with no items", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const controller = new AbortController();
    controller.abort();

    const gen = joinSessionView(journal, "sid-5b", liveSource.open, { signal: controller.signal });
    const r = await gen.next();
    expect(r.done).toBe(true);
  });
});

// --- 6. Reconnect mid-stream -------------------------------------------------------

describe("joinSessionView: reconnect mid-stream", () => {
  it("no gap and no duplicate across a dropped-and-reopened live connection", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const gen = joinSessionView(journal, "sid-6", liveSource.open, { autoReconnect: true });

    // --- Cycle 1 ---
    const firstNext = gen.next();
    expect(liveSource.connections).toHaveLength(1);
    const conn1 = liveSource.connections[0]!;

    // Cold page covers 0..2 (tip=3); two live frames (3, 4) land during/after
    // the cold read, both new (not covered) — then the connection drops.
    conn1.push(mkEnduringFrame(3));
    journal.resolveNext({ events: [mkStatusEvent(0), mkStatusEvent(1), mkStatusEvent(2)], next_journal_seq: 3, done: true });

    const first = await firstNext;
    if (first.done) throw new Error("unreachable");
    const cycle1Rest = await collectN(gen, 3); // history 1,2 + live 3
    conn1.push(mkEnduringFrame(4));
    const [seq4Event] = await collectN(gen, 1);
    conn1.end(); // connection drops

    const cycle1 = [first.value, ...cycle1Rest, seq4Event!];
    assertAllOk(cycle1);
    expect(cycle1.map(seqOf)).toEqual([0, 1, 2, 3, 4]);

    // --- Cycle 2: the join must reconnect on its own (autoReconnect: true). ---
    // Give the reconnect loop a turn to open a fresh connection and issue a
    // fresh readHistory() call before driving it further.
    let secondNext = gen.next();
    for (let i = 0; i < 5 && liveSource.connections.length < 2; i++) await Promise.resolve();
    expect(liveSource.connections).toHaveLength(2);
    const conn2 = liveSource.connections[1]!;

    // The reconnect's cold catch-up only re-reads the GAP: from journal_seq 5
    // (the highest seq already applied, +1), not from 0.
    expect(journal.calls).toHaveLength(2);
    expect(journal.calls[1]).toMatchObject({ fromJournalSeq: 5 });

    // A duplicate (seq 5, already implied by the new page below) AND a brand
    // new frame (seq 6) both land during the second connection's join window.
    conn2.push(mkEnduringFrame(5));
    conn2.push(mkEnduringFrame(6));
    journal.resolveNext({ events: [mkStatusEvent(5)], next_journal_seq: 6, done: true });

    const secondFirst = await secondNext;
    if (secondFirst.done) throw new Error("unreachable");
    const [seq6Event] = await collectN(gen, 1);
    const cycle2 = [secondFirst.value, seq6Event!];

    assertAllOk(cycle2);
    expect(cycle2.map(seqOf)).toEqual([5, 6]);
    expect(cycle2[0]!.input.segment).toBe("history"); // seq 5 came from the cold page, not the dropped live duplicate
    expect(cycle2[1]!.input.segment).toBe("live");

    const all = [...cycle1, ...cycle2];
    expect(all.map(seqOf)).toEqual([0, 1, 2, 3, 4, 5, 6]); // no gap, no duplicate across the reconnect boundary

    await gen.return();
  });
});
