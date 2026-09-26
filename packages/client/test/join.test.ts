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
import { describe, expect, it, vi } from "vitest";
import {
  joinFactorySessionView,
  joinSessionView,
  type FactoryJoinEvent,
  type FactoryJoinLink,
  type FactoryJoinReads,
  type JoinEvent,
  type JournalReader,
  type LiveFrameSource,
} from "../src/join.js";
import type { ClientSubscription, SubscribeOptions } from "../src/clientlink.js";
import { CoreInvalidRequestError } from "../src/errors.js";
import type { ReadHistoryOptions } from "../src/transport.js";
import type { EnduringSseFrame, EphemeralSseFrame, SseFrame } from "../src/sse.js";
import type { EventEnvelope, EventJournalPage, StatusEvent } from "../src/types.js";
import type { FactoryPublication, FactorySessionStatus, PublicJournalPage, SessionReset } from "../src/types.js";

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

  /** Rejects the OLDEST not-yet-resolved `readHistory()` call — the reject counterpart to `resolveNext()`, for exercising join.ts's error/reconnect paths (Fix 3/4 coverage). */
  rejectNext(err: unknown): void {
    const next = this.pending.shift();
    if (!next) throw new Error("FakeJournalReader.rejectNext: no pending readHistory() call to reject");
    next.reject(err);
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

  /** Number of times this connection's async iterator's `.return()` was called — lets a test confirm join.ts's cleanup (`liveIterator.return?.()` in its `finally` block) actually ran, e.g. before reconnecting. */
  returnCalls = 0;

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

// --- Factory subscribe-first join --------------------------------------------

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }
}

class FakeFactoryLink implements FactoryJoinLink {
  options: SubscribeOptions | undefined;
  readonly ready = new Deferred<void>();
  unsubscribed = 0;

  constructor(readonly version = 1, readonly includeVersion = true) {}

  subscribe(options: SubscribeOptions): ClientSubscription {
    this.options = options;
    return {
      state: "subscribing",
      ready: this.ready.promise,
      ...(this.includeVersion ? { version: this.version } : {}),
      unsubscribe: () => { this.unsubscribed += 1; },
    };
  }

  publish(publication: FactoryPublication): void { this.options?.onPublication(publication); }
  reset(reset: SessionReset): void { this.options?.onReset(reset); }
  fail(error: Error): void { this.options?.onError?.(error); }
}

class FakeFactoryReads implements FactoryJoinReads {
  readonly status = new Deferred<FactorySessionStatus>();
  readonly journal = new Deferred<PublicJournalPage>();
  statusCalls = 0;
  journalOptions: Array<{ tail?: number; limit?: number; signal?: AbortSignal }> = [];
  readStatus(_sessionId: string, _options?: { signal?: AbortSignal }): Promise<FactorySessionStatus> {
    this.statusCalls += 1;
    return this.status.promise;
  }
  readJournal(
    _sessionId: string,
    options: { tail?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<PublicJournalPage> {
    this.journalOptions.push(options);
    return this.journal.promise;
  }
}

const factoryStatus = (tip: number): FactorySessionStatus => ({
  session_id: "session-1",
  agent_id: "agent-1",
  state: "running",
  residency: "resident",
  journal_tip: tip,
  updated_at: "2026-09-01T12:00:00Z",
});

const publicEvent = (seq: number, id = `event-${seq}`) => ({
  event_id: id,
  journal_seq: seq,
  body: { type: "session.message", text: `message-${seq}` },
});

const publication = (seq: number, id = `event-${seq}`): FactoryPublication => ({
  type: "enduring_publication",
  tenant_id: "tenant-1",
  session_id: "session-1",
  event_id: id,
  journal_seq: seq,
  covered_through: seq,
  body: { type: "session.message", text: `message-${seq}` },
});

const ephemeralPublication = (): FactoryPublication => ({
  type: "ephemeral_publication",
  tenant_id: "tenant-1",
  session_id: "session-1",
  body: { type: "typing" },
});

const tipPublication = (tip: number): FactoryPublication => ({
  type: "journal_tip",
  tenant_id: "tenant-1",
  session_id: "session-1",
  journal_tip: tip,
});

/**
 * A link that hands every generation its own already-authorized subscription,
 * so a test can drive many repair cycles without wiring one `FakeFactoryLink`
 * per generation by hand. `links[i]` is generation i+1's.
 */
class ScriptedFactoryLink implements FactoryJoinLink {
  readonly links: FakeFactoryLink[] = [];
  subscribe(options: SubscribeOptions): ClientSubscription {
    const link = new FakeFactoryLink();
    link.ready.resolve();
    this.links.push(link);
    return link.subscribe(options);
  }
}

/**
 * Resolves each generation's status/tail pair from a script, repeating the
 * last entry forever. Unlike `FakeFactoryReads` these resolve on their own —
 * which is the point for the repair-bound tests, where the failure is
 * immediate and every await in the join is a microtask.
 */
class ScriptedFactoryReads implements FactoryJoinReads {
  statusCalls = 0;
  readonly journalOptions: Array<{ tail?: number; limit?: number; signal?: AbortSignal }> = [];
  private index = 0;
  constructor(private readonly script: Array<{ status: FactorySessionStatus; page: PublicJournalPage }>) {}
  private step(): { status: FactorySessionStatus; page: PublicJournalPage } {
    return this.script[Math.min(this.index, this.script.length - 1)]!;
  }
  async readStatus(): Promise<FactorySessionStatus> {
    this.statusCalls += 1;
    return this.step().status;
  }
  async readJournal(
    _sessionId: string,
    options: { tail?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<PublicJournalPage> {
    this.journalOptions.push(options);
    const step = this.step();
    this.index += 1;
    return step.page;
  }
}

/** A tail page that fails a coverage guard on every generation. */
const behindPage: PublicJournalPage = { journal_tip: 4, covered_through: 4, events: [] };

it("a failed journal read aborts its generation's still-pending status read", async () => {
  const controller = new AbortController();
  const first = new FakeFactoryLink();
  const second = new FakeFactoryLink();
  first.ready.resolve();
  let subscriptions = 0;
  const link: FactoryJoinLink = {
    subscribe: (options) => (subscriptions++ === 0 ? first : second).subscribe(options),
  };
  const signals: AbortSignal[] = [];
  const reads: FactoryJoinReads = {
    readStatus: (_sessionId, options) => {
      signals.push(options!.signal!);
      return new Promise(() => {});
    },
    readJournal: async () => { throw new Error("journal unavailable"); },
  };
  const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
    signal: controller.signal, repairDelayMs: 0,
  });
  const pending = gen.next();
  try {
    await vi.waitFor(() => expect(subscriptions).toBe(2));
    expect(signals[0]?.aborted).toBe(true);
  } finally {
    controller.abort();
    await pending;
    await gen.return();
  }
});

type JournalRequest = { tail?: number; limit?: number; cursor?: string; fromSeq?: number; signal?: AbortSignal };

/**
 * Answers a scripted sequence of journal pages — one per read, ACROSS
 * generations — and records every request. Unlike `ScriptedFactoryReads` it
 * scripts the journal alone, because a captured-tail continuation issues
 * several journal reads against ONE status read, and it records the `cursor`
 * each one carried, which is the whole point of these cases.
 */
class TailPageReads implements FactoryJoinReads {
  statusCalls = 0;
  readonly journalOptions: JournalRequest[] = [];
  private index = 0;
  constructor(
    private readonly status: FactorySessionStatus,
    private readonly pages: PublicJournalPage[],
  ) {}
  async readStatus(): Promise<FactorySessionStatus> {
    this.statusCalls += 1;
    return this.status;
  }
  async readJournal(_sessionId: string, options: JournalRequest = {}): Promise<PublicJournalPage> {
    this.journalOptions.push(options);
    const page = this.pages[Math.min(this.index, this.pages.length - 1)]!;
    this.index += 1;
    return page;
  }
}

/** Every journal read parks on its own deferred, so a test can abort mid-walk. */
class DeferredTailReads implements FactoryJoinReads {
  readonly status = new Deferred<FactorySessionStatus>();
  readonly journals: Deferred<PublicJournalPage>[] = [];
  readonly journalOptions: JournalRequest[] = [];
  readStatus(): Promise<FactorySessionStatus> {
    return this.status.promise;
  }
  readJournal(_sessionId: string, options: JournalRequest = {}): Promise<PublicJournalPage> {
    this.journalOptions.push(options);
    const deferred = new Deferred<PublicJournalPage>();
    this.journals.push(deferred);
    return deferred.promise;
  }
}

async function factoryNext(gen: AsyncGenerator<FactoryJoinEvent>): Promise<FactoryJoinEvent> {
  const next = await gen.next();
  if (next.done) throw new Error("factory join ended unexpectedly");
  return next.value;
}

async function factoryResult(result: Promise<IteratorResult<FactoryJoinEvent>>): Promise<FactoryJoinEvent> {
  const resolved = await result;
  if (resolved.done) throw new Error("factory join ended unexpectedly");
  return resolved.value;
}

describe("joinFactorySessionView", () => {
  it("authorizes before REST and emits projection plus the bounded immutable tail exactly once", async () => {
    const reads = new FakeFactoryReads();
    const link = new FakeFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { tailLimit: 3 });
    const first = gen.next();
    expect(link.options).toBeDefined();
    expect(reads.statusCalls).toBe(0);
    expect(reads.journalOptions).toStrictEqual([]);

    link.publish(publication(5));
    // The synchronous assertions above only prove the reads were not issued
    // SYNCHRONOUSLY; they say nothing about "not before authorization", since
    // no microtask has drained yet. Drain the microtask queue AND a real timer
    // with `ready` still pending, so the assertion is about the ordering this
    // row is named for.
    for (let drain = 0; drain < 50; drain += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads.statusCalls).toBe(0);
    expect(reads.journalOptions).toStrictEqual([]);

    link.ready.resolve();
    await vi.waitFor(() => expect(reads.statusCalls).toBe(1));
    expect(reads.journalOptions).toMatchObject([{ tail: 3, limit: 3 }]);
    expect("cursor" in reads.journalOptions[0]!).toBe(false);

    reads.status.resolve(factoryStatus(5));
    reads.journal.resolve({
      journal_tip: 5,
      covered_through: 5,
      events: [publicEvent(2), publicEvent(5)],
    });
    const events = [await factoryResult(first), await factoryNext(gen), await factoryNext(gen)];
    expect(events.map((event) => event.kind)).toStrictEqual(["projection", "public", "public"]);
    expect(events.map((event) => event.coveredThrough)).toStrictEqual([0, 2, 5]);
    expect(events.filter((event): event is Extract<FactoryJoinEvent, { kind: "public" }> => event.kind === "public")
      .map((event) => event.event.event_id))
      .toStrictEqual(["event-2", "event-5"]);
    await gen.return();
    expect(link.unsubscribed).toBe(1);
  });

  it("orders buffered publications above T and uses validated watermarks to cover private gaps", async () => {
    const reads = new FakeFactoryReads();
    const link = new FakeFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 3,
    });
    const first = gen.next();
    link.ready.resolve();
    await Promise.resolve();
    link.publish(publication(7));
    link.publish(publication(6));
    reads.status.resolve(factoryStatus(5));
    reads.journal.resolve({ journal_tip: 5, covered_through: 5, events: [publicEvent(5)] });
    const events = [await factoryResult(first), await factoryNext(gen), await factoryNext(gen), await factoryNext(gen)];
    expect(events.filter((event): event is Extract<FactoryJoinEvent, { kind: "public" }> => event.kind === "public")
      .map((event) => event.event.journal_seq))
      .toStrictEqual([5, 6, 7]);
    expect(events.slice(1).map((event) => event.coveredThrough)).toStrictEqual([5, 6, 7]);
    await gen.return();
  });

  it("deduplicates a post-tail resend by sequence and EventID before applying the next live publication", async () => {
    const reads = new FakeFactoryReads();
    const link = new FakeFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1");
    const projection = gen.next();
    link.ready.resolve();
    await vi.waitFor(() => expect(reads.statusCalls).toBe(1));
    reads.status.resolve(factoryStatus(5));
    reads.journal.resolve({ journal_tip: 5, covered_through: 5, events: [publicEvent(5)] });
    await factoryResult(projection);
    await factoryNext(gen);
    const next = gen.next();
    link.publish(publication(5));
    link.publish(publication(6));
    const live = await factoryResult(next);
    expect(live).toMatchObject({ kind: "public", coveredThrough: 6, event: { event_id: "event-6" } });
    await gen.return();
  });

  it("repairs a forged live watermark without committing it", async () => {
    const reads = new FakeFactoryReads();
    const firstLink = new FakeFactoryLink();
    const secondLink = new FakeFactoryLink();
    const controller = new AbortController();
    let index = 0;
    const link: FactoryJoinLink = { subscribe: (options) => [firstLink, secondLink][index++]!.subscribe(options) };
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      signal: controller.signal,
    });
    const projection = gen.next();
    firstLink.ready.resolve();
    await vi.waitFor(() => expect(reads.statusCalls).toBe(1));
    reads.status.resolve(factoryStatus(5));
    reads.journal.resolve({ journal_tip: 5, covered_through: 5, events: [publicEvent(5)] });
    await factoryResult(projection);
    await factoryNext(gen);
    void gen.next();
    firstLink.publish({ ...publication(6), covered_through: 99 } as never);
    await vi.waitFor(() => expect(firstLink.unsubscribed).toBe(1));
    expect(index).toBe(2);
    controller.abort();
    await gen.return();
  });

  it("repairs a conflicting EventID for an already seen sequence", async () => {
    const reads = new FakeFactoryReads();
    const firstLink = new FakeFactoryLink();
    const secondLink = new FakeFactoryLink();
    const controller = new AbortController();
    let index = 0;
    const link: FactoryJoinLink = { subscribe: (options) => [firstLink, secondLink][index++]!.subscribe(options) };
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { signal: controller.signal });
    const projection = gen.next();
    firstLink.ready.resolve();
    await vi.waitFor(() => expect(reads.statusCalls).toBe(1));
    reads.status.resolve(factoryStatus(5));
    reads.journal.resolve({ journal_tip: 5, covered_through: 5, events: [publicEvent(5)] });
    await factoryResult(projection);
    await factoryNext(gen);
    void gen.next();
    firstLink.publish(publication(5, "conflicting-event"));
    await vi.waitFor(() => expect(firstLink.unsubscribed).toBe(1));
    expect(index).toBe(2);
    controller.abort();
    await gen.return();
  });

  it("repairs from the last committed cursor on reset and makes old callbacks inert", async () => {
    const reads1 = new FakeFactoryReads();
    const reads2 = new FakeFactoryReads();
    const links = [new FakeFactoryLink(), new FakeFactoryLink()];
    let generation = 0;
    const reads: FactoryJoinReads = {
      readStatus: (...args) => (generation === 0 ? reads1 : reads2).readStatus(...args),
      readJournal: (...args) => (generation++ === 0 ? reads1 : reads2).readJournal(...args),
    };
    let linkIndex = 0;
    const link: FactoryJoinLink = { subscribe: (options) => links[linkIndex++]!.subscribe(options) };
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { initialCoveredThrough: 3 });
    const first = gen.next();
    links[0]!.ready.resolve();
    await Promise.resolve();
    reads1.status.resolve(factoryStatus(5));
    reads1.journal.resolve({ journal_tip: 5, covered_through: 5, events: [publicEvent(5)] });
    await first;
    await factoryNext(gen);
    const repairing = gen.next();
    links[0]!.reset({
      type: "session.reset", tenant_id: "tenant-1", session_id: "session-1", last_contiguous: 5, journal_tip: 8,
    });
    await vi.waitFor(() => expect(links[0]!.unsubscribed).toBe(1));
    links[1]!.ready.resolve();
    await Promise.resolve();
    links[0]!.publish(publication(99));
    reads2.status.resolve(factoryStatus(6));
    reads2.journal.resolve({ journal_tip: 6, covered_through: 6, events: [publicEvent(6)] });
    const projection = await repairing;
    expect(projection.value).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 5 });
    const publicUpdate = await factoryNext(gen);
    expect(publicUpdate).toMatchObject({ kind: "public", generation: 2, coveredThrough: 6 });
    await gen.return();
  });

  it("repairs instead of committing an overflowing prejoin buffer", async () => {
    const reads = new FakeFactoryReads();
    const firstLink = new FakeFactoryLink();
    const secondLink = new FakeFactoryLink();
    const controller = new AbortController();
    let index = 0;
    const link: FactoryJoinLink = { subscribe: (options) => [firstLink, secondLink][index++]!.subscribe(options) };
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 3,
      maxPrejoinPublications: 1,
      signal: controller.signal,
    });
    void gen.next();
    firstLink.publish(publication(4));
    firstLink.publish(publication(5));
    firstLink.ready.resolve();
    await vi.waitFor(() => expect(firstLink.unsubscribed).toBe(1));
    expect(index).toBe(2);
    controller.abort();
    await gen.return();
  });

  it("accepts exactly the configured prejoin bound", async () => {
    const reads = new FakeFactoryReads();
    const link = new FakeFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { maxPrejoinPublications: 1 });
    const projection = gen.next();
    link.publish(publication(6));
    link.ready.resolve();
    await vi.waitFor(() => expect(reads.statusCalls).toBe(1));
    reads.status.resolve(factoryStatus(5));
    reads.journal.resolve({ journal_tip: 5, covered_through: 5, events: [publicEvent(5)] });
    await factoryResult(projection);
    await factoryNext(gen);
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", coveredThrough: 6 });
    await gen.return();
  });

  it.each([
    { name: "an old enduring duplicate", traffic: publication(5) },
    { name: "an ephemeral publication", traffic: ephemeralPublication() },
    { name: "a journal-tip hint", traffic: tipPublication(99) },
  ])("does not charge $name against the max-one prejoin enduring bound", async ({ traffic }) => {
    const reads = new FakeFactoryReads();
    const link = new FakeFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 5,
      maxPrejoinPublications: 1,
    });
    const projection = gen.next();
    link.publish(traffic);
    link.publish(publication(6));
    link.ready.resolve();
    await vi.waitFor(() => expect(reads.statusCalls).toBe(1));
    reads.status.resolve(factoryStatus(5));
    reads.journal.resolve({ journal_tip: 5, covered_through: 5, events: [] });
    await factoryResult(projection);
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", coveredThrough: 6 });
    expect(link.unsubscribed).toBe(0);
    await gen.return();
  });

  it("repairs an invalid relevant prejoin frame before it can be committed", async () => {
    const first = new FakeFactoryLink();
    const second = new FakeFactoryLink();
    let index = 0;
    const link: FactoryJoinLink = { subscribe: (options) => [first, second][index++]!.subscribe(options) };
    const controller = new AbortController();
    const gen = joinFactorySessionView(new FakeFactoryReads(), link, "tenant-1", "session-1", {
      signal: controller.signal,
    });
    void gen.next();
    first.publish({ ...publication(1), journal_seq: Number.MAX_SAFE_INTEGER + 1 } as never);
    await vi.waitFor(() => expect(first.unsubscribed).toBe(1));
    expect(index).toBe(2);
    controller.abort();
    await gen.return();
  });

  it("repairs transport errors delivered while authorization is pending", async () => {
    const first = new FakeFactoryLink();
    const second = new FakeFactoryLink();
    let index = 0;
    const link: FactoryJoinLink = { subscribe: (options) => [first, second][index++]!.subscribe(options) };
    const controller = new AbortController();
    const gen = joinFactorySessionView(new FakeFactoryReads(), link, "tenant-1", "session-1", {
      signal: controller.signal,
    });
    void gen.next();
    first.fail(new Error("socket failed"));
    await vi.waitFor(() => expect(first.unsubscribed).toBe(1));
    expect(index).toBe(2);
    controller.abort();
    await gen.return();
  });

  it("repairs a negotiated wire-version mismatch from the last committed cursor", async () => {
    const reads = new FakeFactoryReads();
    const first = new FakeFactoryLink(2);
    const second = new FakeFactoryLink(1);
    let index = 0;
    const link: FactoryJoinLink = { subscribe: (options) => [first, second][index++]!.subscribe(options) };
    const controller = new AbortController();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 7,
      signal: controller.signal,
    });
    const projection = gen.next();
    first.ready.resolve();
    await vi.waitFor(() => expect(first.unsubscribed).toBe(1));
    expect(reads.statusCalls).toBe(0);
    expect(reads.journalOptions).toHaveLength(0);
    expect(index).toBe(2);
    second.ready.resolve();
    await vi.waitFor(() => expect(reads.statusCalls).toBe(1));
    reads.status.resolve(factoryStatus(7));
    reads.journal.resolve({ journal_tip: 7, covered_through: 7, events: [] });
    expect(await factoryResult(projection)).toMatchObject({
      kind: "projection",
      generation: 2,
      coveredThrough: 7,
    });
    await gen.return();
  });

  it("repairs an omitted negotiated wire version from the unchanged committed cursor", async () => {
    const reads = new FakeFactoryReads();
    const first = new FakeFactoryLink(1, false);
    const second = new FakeFactoryLink(1);
    let index = 0;
    const link: FactoryJoinLink = { subscribe: (options) => [first, second][index++]!.subscribe(options) };
    const controller = new AbortController();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 7,
      signal: controller.signal,
    });
    const projection = gen.next();
    first.ready.resolve();
    await vi.waitFor(() => expect(first.unsubscribed).toBe(1));
    expect(reads.statusCalls).toBe(0);
    expect(reads.journalOptions).toHaveLength(0);
    expect(index).toBe(2);
    second.ready.resolve();
    await vi.waitFor(() => expect(reads.statusCalls).toBe(1));
    reads.status.resolve(factoryStatus(7));
    reads.journal.resolve({ journal_tip: 7, covered_through: 7, events: [] });
    expect(await factoryResult(projection)).toMatchObject({
      kind: "projection",
      generation: 2,
      coveredThrough: 7,
    });
    await gen.return();
  });

  it("repairs an unsafe tail coordinate before Number-keyed deduplication can collide", async () => {
    const reads = new FakeFactoryReads();
    const first = new FakeFactoryLink();
    const second = new FakeFactoryLink();
    let index = 0;
    const link: FactoryJoinLink = { subscribe: (options) => [first, second][index++]!.subscribe(options) };
    const controller = new AbortController();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { signal: controller.signal });
    void gen.next();
    first.ready.resolve();
    await vi.waitFor(() => expect(reads.statusCalls).toBe(1));
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    reads.status.resolve(factoryStatus(unsafe));
    reads.journal.resolve({
      journal_tip: unsafe,
      covered_through: unsafe,
      events: [publicEvent(unsafe), publicEvent(unsafe + 1)],
    });
    await vi.waitFor(() => expect(first.unsubscribed).toBe(1));
    expect(index).toBe(2);
    controller.abort();
    await gen.return();
  });

  it("repairs a page containing more events than the requested tail limit", async () => {
    const reads = new FakeFactoryReads();
    const first = new FakeFactoryLink();
    const second = new FakeFactoryLink();
    let index = 0;
    const link: FactoryJoinLink = { subscribe: (options) => [first, second][index++]!.subscribe(options) };
    const controller = new AbortController();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      tailLimit: 1,
      signal: controller.signal,
    });
    void gen.next();
    first.ready.resolve();
    await vi.waitFor(() => expect(reads.statusCalls).toBe(1));
    reads.status.resolve(factoryStatus(2));
    reads.journal.resolve({ journal_tip: 2, covered_through: 2, events: [publicEvent(1), publicEvent(2)] });
    await vi.waitFor(() => expect(first.unsubscribed).toBe(1));
    expect(index).toBe(2);
    controller.abort();
    await gen.return();
  });

  it("aborts cleanly while subscription readiness is pending", async () => {
    const link = new FakeFactoryLink();
    const controller = new AbortController();
    const gen = joinFactorySessionView(new FakeFactoryReads(), link, "tenant-1", "session-1", {
      signal: controller.signal,
    });
    const pending = gen.next();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(link.unsubscribed).toBe(1);
  });

  it("aborts the in-flight tail request and unsubscribes", async () => {
    const reads = new FakeFactoryReads();
    const link = new FakeFactoryLink();
    const controller = new AbortController();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { signal: controller.signal });
    const pending = gen.next();
    link.ready.resolve();
    await vi.waitFor(() => expect(reads.journalOptions).toHaveLength(1));
    controller.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(reads.journalOptions[0]!.signal?.aborted).toBe(true);
    expect(link.unsubscribed).toBe(1);
  });

  // --- Coverage that stops short of the tip ------------------------------------

  it("repairs a tail page whose coverage stops short of the immutable tip", async () => {
    // The exact fail-open shape: T comes from `journal_tip` (5) but only
    // events at or below `covered_through` (2) are attested, and sequence 5
    // committed BEFORE this join subscribed, so it is in neither the page nor
    // the prejoin buffer. Measured without the guard: the join rendered
    // [1, 2, 4], silently dropping public sequence 5, and the next live
    // publication walked the durable cursor over it to 6 — a transcript
    // missing an event plus a persisted claim that it was covered.
    const generation1 = new FakeFactoryReads();
    const generation2 = new ScriptedFactoryReads([{
      status: factoryStatus(5),
      page: { journal_tip: 5, covered_through: 5, events: [publicEvent(1), publicEvent(2), publicEvent(4), publicEvent(5)] },
    }]);
    let read = 0;
    const reads: FactoryJoinReads = {
      readStatus: (...args) => (read === 0 ? generation1 : generation2).readStatus(...args),
      readJournal: (...args) => (read++ === 0 ? generation1 : generation2).readJournal(...args),
    };
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { repairDelayMs: 0 });
    const first = gen.next();
    await vi.waitFor(() => expect(generation1.statusCalls).toBe(1));
    link.links[0]!.publish(publication(4));
    generation1.status.resolve(factoryStatus(5));
    generation1.journal.resolve({ journal_tip: 5, covered_through: 2, events: [publicEvent(1), publicEvent(2)] });

    // Nothing at all is emitted from the doomed generation: the first update a
    // consumer ever sees is generation 2's projection. Asserted BEFORE pulling
    // the rest, so the unguarded behaviour fails on this line rather than by
    // waiting out a timeout for a fifth update that never arrives.
    expect(await factoryResult(first)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 0 });
    const events = [await factoryNext(gen), await factoryNext(gen), await factoryNext(gen), await factoryNext(gen)];
    expect(events.map((event) => event.generation)).toStrictEqual([2, 2, 2, 2]);
    expect(events.map((event) => event.kind)).toStrictEqual(["public", "public", "public", "public"]);
    expect(events.filter((event): event is Extract<FactoryJoinEvent, { kind: "public" }> => event.kind === "public")
      .map((event) => event.event.journal_seq))
      .toStrictEqual([1, 2, 4, 5]);
    expect(link.links[0]!.unsubscribed).toBe(1);
    await gen.return();
  });

  it("takes the journal tip from the page when the projection disagrees (a Host session's status reads 0)", async () => {
    // Factory answers /status for a Host (disposition) session from the
    // catalog, which keeps no journal tip, and /journal from the runtime
    // journal. Requiring the two to agree repaired every generation forever.
    const reads = new ScriptedFactoryReads([
      { status: factoryStatus(0), page: { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] } },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { repairDelayMs: 0 });
    const projection = await factoryNext(gen);
    expect(projection).toMatchObject({ kind: "projection", generation: 1, coveredThrough: 0 });
    expect(projection.status.journal_tip).toBe(5);
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 1, coveredThrough: 5 });
    expect(link.links).toHaveLength(1);
    await gen.return();
  });

  it("still repairs a projection for another session", async () => {
    const reads = new ScriptedFactoryReads([
      { status: { ...factoryStatus(5), session_id: "session-2" }, page: { journal_tip: 5, covered_through: 5, events: [] } },
      { status: factoryStatus(5), page: { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] } },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { repairDelayMs: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 0 });
    await gen.return();
  });

  it("repairs a tail page whose coverage is behind the committed cursor", async () => {
    const reads = new ScriptedFactoryReads([
      { status: factoryStatus(3), page: { journal_tip: 3, covered_through: 3, events: [] } },
      { status: factoryStatus(5), page: { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] } },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 4,
      repairDelayMs: 0,
    });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 4 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 5 });
    await gen.return();
  });

  it("repairs a live publication at a sequence the page watermark already covered", async () => {
    // Sequence 3 was withheld as private (the page bridges it via
    // `covered_through`) and then arrives live as a public record. Applying it
    // would move the durable cursor BACKWARD from 5 to 3.
    const reads = new ScriptedFactoryReads([
      { status: factoryStatus(5), page: { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] } },
      { status: factoryStatus(5), page: { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] } },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { repairDelayMs: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 1, coveredThrough: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 1, coveredThrough: 5 });
    const next = gen.next();
    link.links[0]!.publish(publication(3));
    expect(await factoryResult(next)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 5 });
    expect(link.links[0]!.unsubscribed).toBe(1);
    await gen.return();
  });

  // --- Bounded repair ----------------------------------------------------------

  it("lowers the committed cursor to a truncating reset's last_contiguous", async () => {
    // The direction that livelocks without this: the session truncated behind
    // the persisted cursor, so every page the replacement generation reads
    // reports LESS coverage than the cursor demands and repairs again forever.
    const reads = new ScriptedFactoryReads([
      { status: factoryStatus(5), page: { journal_tip: 5, covered_through: 5, events: [] } },
      { status: factoryStatus(3), page: { journal_tip: 3, covered_through: 3, events: [publicEvent(3)] } },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 5,
      maxRepairAttempts: 2,
      repairDelayMs: 0,
    });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 1, coveredThrough: 5 });
    const repairing = gen.next();
    link.links[0]!.reset({
      type: "session.reset", tenant_id: "tenant-1", session_id: "session-1", last_contiguous: 2, journal_tip: 2,
    });
    expect(await factoryResult(repairing)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 2 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 3 });
    await gen.return();
  });

  it("repairs a reset for another session without moving the committed cursor", async () => {
    const reads = new ScriptedFactoryReads([
      { status: factoryStatus(5), page: { journal_tip: 5, covered_through: 5, events: [] } },
      { status: factoryStatus(5), page: { journal_tip: 5, covered_through: 5, events: [] } },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 5,
      maxRepairAttempts: 2,
      repairDelayMs: 0,
    });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 1, coveredThrough: 5 });
    const repairing = gen.next();
    link.links[0]!.reset({
      type: "session.reset", tenant_id: "tenant-2", session_id: "session-9", last_contiguous: 0, journal_tip: 0,
    });
    expect(await factoryResult(repairing)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 5 });
    await gen.return();
  });

  it("yields a macrotask on every repair, so a timer-driven abort can still run", async () => {
    // The reviewer's probe shape: a persisted cursor ahead of this Factory's
    // coverage repairs on every attempt. Every await in the loop resolves as a
    // microtask, so without a real timer in the cycle the loop never reaches
    // the timer queue and `controller.abort()` below never runs at all — the
    // measured behaviour was a worker that hung until it was killed, with the
    // runner's own test timeout never firing. `maxRepairAttempts` is set high
    // enough that the CAP is not what ends this: if the abort is unreachable
    // the join gives up and this rejects, rather than passing for the wrong
    // reason.
    const reads = new ScriptedFactoryReads([{ status: factoryStatus(4), page: behindPage }]);
    const link = new ScriptedFactoryLink();
    const controller = new AbortController();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 40,
      maxRepairAttempts: 1000,
      repairDelayMs: 0,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 0);
    await expect(gen.next()).resolves.toMatchObject({ done: true });
    expect(link.links.length).toBeLessThan(1000);
  });

  it("keeps repairing at the configured attempt threshold", async () => {
    const reads = new ScriptedFactoryReads([
      { status: factoryStatus(4), page: behindPage },
      { status: factoryStatus(4), page: behindPage },
      { status: factoryStatus(41), page: { journal_tip: 41, covered_through: 41, events: [] } },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 40,
      maxRepairAttempts: 2,
      repairDelayMs: 0,
    });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 3, coveredThrough: 40 });
    expect(link.links).toHaveLength(3);
    await gen.return();
  });

  it("gives up one repair past the configured attempt threshold", async () => {
    const reads = new ScriptedFactoryReads([{ status: factoryStatus(4), page: behindPage }]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 40,
      maxRepairAttempts: 2,
      repairDelayMs: 0,
    });
    // Raced against a timer rather than awaited outright, so an unbounded loop
    // fails THIS assertion in milliseconds instead of running until the test
    // runner's own timeout expires.
    const outcome = await Promise.race([
      gen.next().then(() => "resolved" as const, (error: unknown) => String(error)),
      new Promise<string>((resolve) => { setTimeout(() => resolve("still repairing"), 50); }),
    ]);
    expect(outcome).toMatch(/gave up after 3 consecutive repairs without coverage progress/);
    expect(link.links).toHaveLength(3);
    expect(link.links.every((entry) => entry.unsubscribed === 1)).toBe(true);
  });

  it("does not charge a repair that advanced coverage against the attempt cap", async () => {
    // Three generations, each of which applies a real event and is then forced
    // to repair by a conflicting resend. A counter that ignored progress would
    // give up at the second repair; a legitimate slow recovery must not be.
    const reads = new ScriptedFactoryReads([
      { status: factoryStatus(5), page: { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] } },
      { status: factoryStatus(6), page: { journal_tip: 6, covered_through: 6, events: [publicEvent(6)] } },
      { status: factoryStatus(7), page: { journal_tip: 7, covered_through: 7, events: [publicEvent(7)] } },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      maxRepairAttempts: 1,
      repairDelayMs: 0,
    });
    const applied: number[] = [];
    let event = await factoryNext(gen);
    for (const [index, seq] of [5, 6].entries()) {
      expect(event).toMatchObject({ kind: "projection", generation: index + 1 });
      expect(await factoryNext(gen)).toMatchObject({ kind: "public", coveredThrough: seq });
      applied.push(seq);
      const pending = gen.next();
      link.links[index]!.publish(publication(seq, "conflicting-event"));
      event = await factoryResult(pending);
    }
    expect(applied).toStrictEqual([5, 6]);
    expect(event).toMatchObject({ kind: "projection", generation: 3, coveredThrough: 6 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 3, coveredThrough: 7 });
    await gen.return();
  });

  // --- Bounded captured-tail continuation --------------------------------------

  it("follows the captured tail's cursor to its own tip, without ever restarting at zero", async () => {
    const reads = new TailPageReads(factoryStatus(5), [
      { journal_tip: 5, covered_through: 2, events: [publicEvent(2)], next_cursor: "cursor-1" },
      { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      tailLimit: 3,
      repairDelayMs: 0,
    });
    const events = [await factoryNext(gen), await factoryNext(gen), await factoryNext(gen)];
    expect(events.map((event) => event.kind)).toStrictEqual(["projection", "public", "public"]);
    // ONE generation: a byte-budgeted page is a continuation, not a failure.
    expect(events.map((event) => event.generation)).toStrictEqual([1, 1, 1]);
    expect(events.map((event) => event.coveredThrough)).toStrictEqual([0, 2, 5]);
    // The captured tail is entered ONCE, by `tail`, and continued ONLY by the
    // opaque cursor the page handed back: no second `tail`, and nothing that
    // walks the journal from sequence 0.
    expect(reads.journalOptions).toMatchObject([
      { tail: 3, limit: 3 },
      { cursor: "cursor-1", limit: 3 },
    ]);
    expect("cursor" in reads.journalOptions[0]!).toBe(false);
    expect("tail" in reads.journalOptions[1]!).toBe(false);
    expect(reads.statusCalls).toBe(1);
    await gen.return();
  });

  it("bridges a private byte-limited page that carries no events at all", async () => {
    const reads = new TailPageReads(factoryStatus(6), [
      { journal_tip: 6, covered_through: 3, events: [], next_cursor: "cursor-1" },
      { journal_tip: 6, covered_through: 6, events: [publicEvent(6)] },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { repairDelayMs: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 1, coveredThrough: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 1, coveredThrough: 6 });
    await gen.return();
  });

  it("repairs, rather than covering, a continuation that exhausts the page budget", async () => {
    // Two reads are allowed and neither reaches the tip. The generation must
    // end with NOTHING emitted — coverage that stopped short is the one thing a
    // durable cursor may never be advanced over.
    const reads = new TailPageReads(factoryStatus(9), [
      { journal_tip: 9, covered_through: 2, events: [publicEvent(2)], next_cursor: "cursor-1" },
      { journal_tip: 9, covered_through: 4, events: [publicEvent(4)], next_cursor: "cursor-2" },
      { journal_tip: 9, covered_through: 9, events: [publicEvent(9)] },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      maxTailPages: 2,
      repairDelayMs: 0,
    });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 9 });
    expect(link.links[0]!.unsubscribed).toBe(1);
    await gen.return();
  });

  it("repairs, rather than covering, a captured tail over its byte budget", async () => {
    const heavy = {
      event_id: "event-2",
      journal_seq: 2,
      body: { type: "session.message", text: "x".repeat(512) },
    };
    const reads = new TailPageReads(factoryStatus(5), [
      { journal_tip: 5, covered_through: 2, events: [heavy], next_cursor: "cursor-1" },
      { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      // Comfortably above one ordinary event's encoding — the REPAIRING
      // generation's page has to fit, or this passes for the wrong reason —
      // and far below the 512-character body above.
      maxTailBytes: 256,
      repairDelayMs: 0,
    });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 5 });
    await gen.return();
  });

  it("measures captured-tail budgets in UTF-8 bytes rather than UTF-16 code units", async () => {
    const multibyte = {
      event_id: "event-2",
      journal_seq: 2,
      body: { type: "session.message", text: "é".repeat(64) },
    };
    const utf16Length = JSON.stringify([multibyte]).length;
    expect(new TextEncoder().encode(JSON.stringify([multibyte])).length).toBeGreaterThan(utf16Length);
    const reads = new TailPageReads(factoryStatus(2), [
      { journal_tip: 2, covered_through: 2, events: [multibyte] },
      { journal_tip: 2, covered_through: 2, events: [publicEvent(2)] },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      maxTailBytes: utf16Length,
      repairDelayMs: 0,
    });

    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 2 });
    await gen.return();
  });

  it("repairs a continuation that hands back a cursor it has already been given", async () => {
    const reads = new TailPageReads(factoryStatus(9), [
      { journal_tip: 9, covered_through: 2, events: [publicEvent(2)], next_cursor: "cursor-1" },
      { journal_tip: 9, covered_through: 4, events: [publicEvent(4)], next_cursor: "cursor-1" },
      { journal_tip: 9, covered_through: 9, events: [publicEvent(9)] },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { repairDelayMs: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 9 });
    await gen.return();
  });

  it.each([
    {
      name: "coverage that does not advance",
      page: { journal_tip: 9, covered_through: 2, events: [], next_cursor: "cursor-2" },
    },
    {
      name: "a tip that moved under the capture",
      page: { journal_tip: 11, covered_through: 9, events: [publicEvent(9)], next_cursor: "cursor-2" },
    },
    {
      name: "a contradicted event identity",
      page: { journal_tip: 9, covered_through: 9, events: [publicEvent(2, "other-event"), publicEvent(9)] },
    },
  ])("repairs a continuation page carrying $name", async ({ page }) => {
    const reads = new TailPageReads(factoryStatus(9), [
      { journal_tip: 9, covered_through: 2, events: [publicEvent(2)], next_cursor: "cursor-1" },
      page,
      { journal_tip: 9, covered_through: 9, events: [publicEvent(9)] },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { repairDelayMs: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 9 });
    await gen.return();
  });

  it("aborts an in-flight continuation request and unsubscribes", async () => {
    const reads = new DeferredTailReads();
    const link = new FakeFactoryLink();
    const controller = new AbortController();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { signal: controller.signal });
    const pending = gen.next();
    link.ready.resolve();
    await vi.waitFor(() => expect(reads.journals).toHaveLength(1));
    reads.status.resolve(factoryStatus(5));
    reads.journals[0]!.resolve({
      journal_tip: 5,
      covered_through: 2,
      events: [publicEvent(2)],
      next_cursor: "cursor-1",
    });
    await vi.waitFor(() => expect(reads.journals).toHaveLength(2));

    controller.abort();

    // The continuation is CANCELLED, not merely ignored, and the generation
    // ends without ever emitting the partial coverage it had accumulated.
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(reads.journalOptions[1]!.signal?.aborted).toBe(true);
    expect(link.unsubscribed).toBe(1);
  });
});

// --- Released-stack behaviour: resume, gap resets, opaque cursors ------------

/** Answers each journal read from a function of its request, recording it. */
class RoutedJournalReads implements FactoryJoinReads {
  readonly journalOptions: JournalRequest[] = [];
  constructor(
    private readonly status: () => FactorySessionStatus,
    private readonly journal: (request: JournalRequest, index: number) => PublicJournalPage,
  ) {}
  async readStatus(): Promise<FactorySessionStatus> {
    return this.status();
  }
  async readJournal(_sessionId: string, options: JournalRequest = {}): Promise<PublicJournalPage> {
    this.journalOptions.push(options);
    return this.journal(options, this.journalOptions.length - 1);
  }
}

/** Factory's answer to a cursor it did not issue: 400 invalid_request, "restart the walk". */
function rejectedCursor(): CoreInvalidRequestError {
  return new CoreInvalidRequestError({
    version: 1,
    error: {
      code: "invalid_request",
      message: "the cursor is not one this session issued; restart the walk",
      retryable: false,
    },
  });
}

/** Drains the generator's `public` events until one reaches `through`. */
async function publicUntil(gen: AsyncGenerator<FactoryJoinEvent>, through: number): Promise<FactoryJoinEvent[]> {
  const seen: FactoryJoinEvent[] = [];
  for (;;) {
    const event = await factoryNext(gen);
    seen.push(event);
    if (event.kind !== "projection" && event.coveredThrough >= through) return seen;
  }
}

describe("joinFactorySessionView against the released Factory/Host stack", () => {
  it("resumes a committed cursor with a forward read, so a gap wider than one tail window is not skipped", async () => {
    // The checkpoint is at 3, the tip is at 40 and the window is 4. A tail
    // read would capture (36, 40] and silently advance the cursor over 4..36.
    const reads = new RoutedJournalReads(() => factoryStatus(40), (request) => {
      if (request.fromSeq === 4) {
        return { journal_tip: 40, covered_through: 20, events: [publicEvent(4), publicEvent(20)], next_cursor: "j1.a.b" };
      }
      if (request.cursor === "j1.a.b") {
        return { journal_tip: 40, covered_through: 40, events: [publicEvent(33), publicEvent(40)] };
      }
      throw new Error(`unexpected read ${JSON.stringify(request)}`);
    });
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 3, tailLimit: 4, repairDelayMs: 0,
    });
    const events = await publicUntil(gen, 40);
    expect(events.filter((event) => event.kind === "public").map((event) => event.coveredThrough))
      .toStrictEqual([4, 20, 33, 40]);
    expect(reads.journalOptions[0]).toMatchObject({ fromSeq: 4, limit: 4 });
    expect("tail" in reads.journalOptions[0]!).toBe(false);
    expect(reads.journalOptions[1]).toMatchObject({ cursor: "j1.a.b", limit: 4 });
    await gen.return();
  });

  it("repairs a mid-stream gap reset forward from the committed cursor and continues live", async () => {
    // A Host session's live tail skipped 6..8 and Factory reset viewers to the
    // REAL journal tip (9). The replacement generation must read 6..9 from the
    // journal — not a tail window — and then apply the next live record.
    let generation = 0;
    const reads = new RoutedJournalReads(() => factoryStatus(generation === 1 ? 5 : 9), (request) => {
      if (request.tail !== undefined) return { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] };
      if (request.fromSeq === 6) {
        return { journal_tip: 9, covered_through: 9, events: [publicEvent(6), publicEvent(8), publicEvent(9)] };
      }
      throw new Error(`unexpected read ${JSON.stringify(request)}`);
    });
    const link: ScriptedFactoryLink = new ScriptedFactoryLink();
    const counting: FactoryJoinLink = { subscribe: (options) => { generation += 1; return link.subscribe(options); } };
    const gen = joinFactorySessionView(reads, counting, "tenant-1", "session-1", { repairDelayMs: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 1, coveredThrough: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 1, coveredThrough: 5 });

    const repairing = gen.next();
    link.links[0]!.reset({
      type: "session.reset", tenant_id: "tenant-1", session_id: "session-1", last_contiguous: 9, journal_tip: 9,
    });
    expect(await factoryResult(repairing)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 5 });
    const replayed = [await factoryNext(gen), await factoryNext(gen), await factoryNext(gen)];
    expect(replayed.map((event) => event.kind === "public" ? event.event.journal_seq : -1)).toStrictEqual([6, 8, 9]);
    // A reset ABOVE the cursor never moves it: only a lower floor does.
    expect(reads.journalOptions[1]).toMatchObject({ fromSeq: 6 });

    const live = gen.next();
    link.links[1]!.publish(publication(10));
    expect(await factoryResult(live)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 10 });
    await gen.return();
  });

  it("restarts the walk when Factory refuses a continuation cursor (400), never replaying the stale cursor", async () => {
    // Pre-v0.9.0 cursors (`c2.`) and a `j1.` cursor minted for an older binding
    // are both answered 400 invalid_request. The next generation starts over.
    const reads = new RoutedJournalReads(() => factoryStatus(6), (request, index) => {
      if (request.cursor === "c2.stale") throw rejectedCursor();
      if (index === 0) return { journal_tip: 6, covered_through: 2, events: [publicEvent(2)], next_cursor: "c2.stale" };
      return { journal_tip: 6, covered_through: 6, events: [publicEvent(2), publicEvent(6)] };
    });
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { tailLimit: 8, repairDelayMs: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 0 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 2 });
    expect(await factoryNext(gen)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 6 });
    expect(reads.journalOptions.map((request) => request.cursor)).toStrictEqual([undefined, "c2.stale", undefined]);
    expect(reads.journalOptions[2]).toMatchObject({ tail: 8 });
    expect(link.links[0]!.unsubscribed).toBe(1);
    await gen.return();
  });

  it("restarts a refused cursor from the COMMITTED sequence once one exists", async () => {
    const reads = new RoutedJournalReads(() => factoryStatus(12), (request) => {
      if (request.cursor === "j1.old") throw rejectedCursor();
      if (request.fromSeq === 5 && reads.journalOptions.length === 1) {
        return { journal_tip: 12, covered_through: 7, events: [publicEvent(7)], next_cursor: "j1.old" };
      }
      if (request.fromSeq === 5) return { journal_tip: 12, covered_through: 12, events: [publicEvent(7), publicEvent(12)] };
      throw new Error(`unexpected read ${JSON.stringify(request)}`);
    });
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 4, repairDelayMs: 0,
    });
    const events = await publicUntil(gen, 12);
    expect(events.at(-1)).toMatchObject({ kind: "public", generation: 2, coveredThrough: 12 });
    expect(reads.journalOptions.map((request) => request.fromSeq ?? request.cursor))
      .toStrictEqual([5, "j1.old", 5]);
    await gen.return();
  });

  it("commits a forward capture's attested prefix when it runs out of budget, and resumes past it", async () => {
    const reads = new RoutedJournalReads(() => factoryStatus(9), (request) => {
      if (request.fromSeq === 3) return { journal_tip: 9, covered_through: 4, events: [publicEvent(4)], next_cursor: "j1.p1" };
      if (request.cursor === "j1.p1") return { journal_tip: 9, covered_through: 6, events: [publicEvent(6)], next_cursor: "j1.p2" };
      if (request.fromSeq === 7) return { journal_tip: 9, covered_through: 9, events: [publicEvent(9)] };
      throw new Error(`unexpected read ${JSON.stringify(request)}`);
    });
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 2, maxTailPages: 2, maxRepairAttempts: 1, repairDelayMs: 0,
    });
    const events = await publicUntil(gen, 9);
    expect(events.map((event) => `${event.kind}@${event.generation}:${event.coveredThrough}`)).toStrictEqual([
      "projection@1:2", "public@1:4", "public@1:6", "projection@2:6", "public@2:9",
    ]);
    // `j1.p2` is never followed: it belonged to the refused capture.
    expect(reads.journalOptions.map((request) => request.fromSeq ?? request.cursor)).toStrictEqual([3, "j1.p1", 7]);
    await gen.return();
  });

  it("never commits a TAIL capture's prefix over budget: its prefix is not contiguous with any cursor", async () => {
    const reads = new TailPageReads(factoryStatus(9), [
      { journal_tip: 9, covered_through: 6, events: [publicEvent(6)], next_cursor: "cursor-1" },
      { journal_tip: 9, covered_through: 9, events: [publicEvent(9)] },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", { maxTailPages: 1, repairDelayMs: 0 });
    const first = await factoryNext(gen);
    expect(first).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 0 });
    await gen.return();
  });
});

// --- Gate fix round: link-scoped resets, budget refusals, a journal model ------

/**
 * A journal with a real tip, sparse public records, and cursors that pin the
 * captured tip — the shape sessionstore serves through Factory.
 */
class ModelJournal implements FactoryJoinReads {
  tip = 0;
  readonly publicSeqs = new Set<number>();
  refuseCursorOnce = false;
  readonly requests: JournalRequest[] = [];
  append(count: number, isPublic: (seq: number) => boolean = () => true): void {
    for (let index = 0; index < count; index += 1) {
      this.tip += 1;
      if (isPublic(this.tip)) this.publicSeqs.add(this.tip);
    }
  }
  async readStatus(): Promise<FactorySessionStatus> {
    return factoryStatus(0); // a Host session's /status tip reads 0
  }
  async readJournal(_sessionId: string, options: JournalRequest = {}): Promise<PublicJournalPage> {
    this.requests.push(options);
    const limit = options.limit ?? 256;
    let from: number;
    let captured = this.tip;
    if (options.cursor !== undefined) {
      if (this.refuseCursorOnce) {
        this.refuseCursorOnce = false;
        throw rejectedCursor();
      }
      const [, next, tip] = options.cursor.split(":");
      from = Number(next);
      captured = Number(tip);
    } else if (options.fromSeq !== undefined) {
      from = Math.max(options.fromSeq, 1);
    } else {
      from = this.tip >= limit ? this.tip - limit + 1 : 1;
    }
    let covered = Math.min(from - 1, captured);
    const events: ReturnType<typeof publicEvent>[] = [];
    for (let seq = from, scanned = 0; seq <= captured && scanned < limit; seq += 1, scanned += 1) {
      covered = seq;
      if (this.publicSeqs.has(seq)) events.push(publicEvent(seq));
    }
    return {
      journal_tip: captured, covered_through: covered, events,
      ...(covered < captured ? { next_cursor: `c:${covered + 1}:${captured}` } : {}),
    };
  }
  label(request: JournalRequest): string | number {
    return request.fromSeq ?? request.cursor ?? `tail${request.tail}`;
  }
}

/** A view that drops rows above a LOWERED projection, as `useFactorySessionView` does. */
function heldBy(events: FactoryJoinEvent[], initial: number[]): { held: number[]; duplicates: number[] } {
  const held = new Set(initial);
  const duplicates: number[] = [];
  let coverage = Math.max(0, ...initial);
  for (const event of events) {
    if (event.kind === "projection" && event.coveredThrough < coverage) {
      for (const seq of [...held]) if (seq > event.coveredThrough) held.delete(seq);
    }
    if (event.kind === "public") {
      if (held.has(event.event.journal_seq)) duplicates.push(event.event.journal_seq);
      held.add(event.event.journal_seq);
    }
    coverage = event.coveredThrough;
  }
  return { held: [...held].sort((a, b) => a - b), duplicates };
}

async function until(gen: AsyncGenerator<FactoryJoinEvent>, coverage: number, out: FactoryJoinEvent[]): Promise<void> {
  for (;;) {
    const event = await factoryNext(gen);
    out.push(event);
    if (event.coveredThrough >= coverage) return;
  }
}

describe("joinFactorySessionView: resets are link-scoped, budgets commit, consistency never does", () => {
  it("a reset whose last_contiguous is 0 (the link delivered nothing) never throws the view back to the tail", async () => {
    const journal = new ModelJournal();
    journal.append(10);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(journal, link, "tenant-1", "session-1", {
      initialCoveredThrough: 10, tailLimit: 8, repairDelayMs: 0,
    });
    const out: FactoryJoinEvent[] = [await factoryNext(gen)];
    journal.append(90);
    const repairing = gen.next();
    link.links[0]!.reset({
      type: "session.reset", tenant_id: "tenant-1", session_id: "session-1", last_contiguous: 0, journal_tip: 100,
    });
    out.push(await factoryResult(repairing));
    await until(gen, 100, out);
    await gen.return();
    const { held, duplicates } = heldBy(out, Array.from({ length: 10 }, (_, index) => index + 1));
    expect(held).toStrictEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(duplicates).toStrictEqual([]);
    expect(journal.requests.some((request) => request.tail !== undefined)).toBe(false);
    expect(journal.label(journal.requests[1]!)).toBe(11);
  });

  it("a sticky last_contiguous below the cursor (sparse public records) resumes from the cursor", async () => {
    const journal = new ModelJournal();
    journal.append(30, (seq) => seq % 3 !== 0);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(journal, link, "tenant-1", "session-1", {
      initialCoveredThrough: 30, tailLimit: 8, repairDelayMs: 0,
    });
    const out: FactoryJoinEvent[] = [await factoryNext(gen)];
    journal.append(20, (seq) => seq % 3 !== 0);
    const repairing = gen.next();
    link.links[0]!.reset({
      type: "session.reset", tenant_id: "tenant-1", session_id: "session-1", last_contiguous: 5, journal_tip: 50,
    });
    out.push(await factoryResult(repairing));
    await until(gen, 50, out);
    await gen.return();
    expect(journal.label(journal.requests[1]!)).toBe(31);
    const published = out.filter((event) => event.kind === "public").map((event) => (event as { event: { journal_seq: number } }).event.journal_seq);
    expect(published).toStrictEqual([...journal.publicSeqs].filter((seq) => seq > 30).sort((a, b) => a - b));
  });

  it("a gap far beyond budget, a refused cursor mid-walk and a racing live record deliver exactly the public set", async () => {
    const journal = new ModelJournal();
    journal.append(5);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(journal, link, "tenant-1", "session-1", {
      initialCoveredThrough: 5, tailLimit: 4, maxTailPages: 2, maxTailEvents: 6, repairDelayMs: 0, maxRepairAttempts: 3,
    });
    const out: FactoryJoinEvent[] = [await factoryNext(gen)];
    journal.append(60, (seq) => seq % 7 !== 0);
    journal.refuseCursorOnce = true;
    const repairing = gen.next();
    link.links[0]!.reset({
      type: "session.reset", tenant_id: "tenant-1", session_id: "session-1", last_contiguous: 5, journal_tip: 65,
    });
    out.push(await factoryResult(repairing));
    await until(gen, 65, out);
    journal.append(1);
    const live = gen.next();
    link.links.at(-1)!.publish(publication(66));
    out.push(await factoryResult(live));
    await gen.return();
    const published = out.filter((event) => event.kind === "public").map((event) => (event as { event: { journal_seq: number } }).event.journal_seq);
    expect(published).toStrictEqual([...journal.publicSeqs].filter((seq) => seq > 5).sort((a, b) => a - b));
  });

  it("a reset whose journal_tip is BELOW the cursor (the journal shrank) lowers it to last_contiguous", async () => {
    const reads = new ScriptedFactoryReads([
      { status: factoryStatus(9), page: { journal_tip: 9, covered_through: 9, events: [] } },
      { status: factoryStatus(6), page: { journal_tip: 6, covered_through: 6, events: [] } },
    ]);
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 9, repairDelayMs: 0,
    });
    expect(await factoryNext(gen)).toMatchObject({ kind: "projection", generation: 1, coveredThrough: 9 });
    const repairing = gen.next();
    link.links[0]!.reset({
      type: "session.reset", tenant_id: "tenant-1", session_id: "session-1", last_contiguous: 4, journal_tip: 6,
    });
    expect(await factoryResult(repairing)).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 4 });
    expect(reads.journalOptions[1]).toMatchObject({ fromSeq: 5 });
    await gen.return();
  });

  it.each([
    ["event_budget", { maxTailEvents: 2 }],
    ["byte_budget", { maxTailBytes: 300 }],
  ] as const)("commits a forward capture's prefix on %s and resumes past it", async (_reason, bounds) => {
    const reads = new RoutedJournalReads(() => factoryStatus(9), (request) => {
      if (request.fromSeq === 3) return { journal_tip: 9, covered_through: 4, events: [publicEvent(4)], next_cursor: "j1.p1" };
      if (request.cursor === "j1.p1") {
        return { journal_tip: 9, covered_through: 7, events: [publicEvent(5), publicEvent(6), publicEvent(7)], next_cursor: "j1.p2" };
      }
      if (request.fromSeq === 5) return { journal_tip: 9, covered_through: 9, events: [publicEvent(5), publicEvent(9)] };
      throw new Error(`unexpected read ${JSON.stringify(request)}`);
    });
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 2, maxRepairAttempts: 1, repairDelayMs: 0, ...bounds,
    });
    const events: FactoryJoinEvent[] = [];
    await until(gen, 9, events);
    expect(events.map((event) => `${event.kind}@${event.generation}:${event.coveredThrough}`)).toStrictEqual([
      "projection@1:2", "public@1:4", "projection@2:4", "public@2:5", "public@2:9",
    ]);
    await gen.return();
  });

  it.each([
    ["tip_moved", { journal_tip: 12, covered_through: 12, events: [publicEvent(12)] }],
    ["coverage_stalled", { journal_tip: 9, covered_through: 4, events: [], next_cursor: "j1.again" }],
    ["missing_cursor", { journal_tip: 9, covered_through: 6, events: [publicEvent(6)] }],
    ["event_conflict", { journal_tip: 9, covered_through: 9, events: [publicEvent(4, "other-event"), publicEvent(9)] }],
  ] as const)("never partially commits a forward capture refused for %s", async (_reason, second) => {
    const reads = new RoutedJournalReads(() => factoryStatus(9), (request, index) => {
      if (index === 0) return { journal_tip: 9, covered_through: 4, events: [publicEvent(4)], next_cursor: "j1.p1" };
      if (index === 1) return second as unknown as PublicJournalPage;
      return { journal_tip: 9, covered_through: 9, events: [publicEvent(4), publicEvent(9)] };
    });
    const link = new ScriptedFactoryLink();
    const gen = joinFactorySessionView(reads, link, "tenant-1", "session-1", {
      initialCoveredThrough: 2, repairDelayMs: 0,
    });
    const first = await factoryNext(gen);
    // Nothing from the refused generation: it is repaired whole.
    expect(first).toMatchObject({ kind: "projection", generation: 2, coveredThrough: 2 });
    expect(reads.journalOptions[2]).toMatchObject({ fromSeq: 3 });
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

// --- 7. Error paths: readHistory() rejecting, and the live connection failing ---
//
// Fix 3/4 coverage: these two failure sources (readHistory() rejecting
// mid-catch-up; the live connection's async iterator throwing) were always
// correctly PROPAGATED by join.ts (verified by the reviewer), but had no
// test exercising them, and — until Fix 4 — `autoReconnect: true` didn't
// actually cover either of them (only a CLEAN live-stream end triggered a
// reconnect; an error always propagated regardless of `autoReconnect`).
// Each failure source gets one test proving the `autoReconnect: false`
// propagation-plus-cleanup behavior, and one proving the NEW
// `autoReconnect: true` reconnect-instead-of-propagate behavior.

describe("joinSessionView: readHistory() rejecting", () => {
  it("propagates the rejection to the caller and cleans up the live connection, when autoReconnect is false", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const gen = joinSessionView(journal, "sid-err-1", liveSource.open); // autoReconnect defaults false

    const firstNext = gen.next();
    expect(journal.calls).toHaveLength(1);
    const conn = liveSource.connections[0]!;

    const boom = new Error("journal read failed");
    journal.rejectNext(boom);

    await expect(firstNext).rejects.toBe(boom);
    // Cleanup happened as part of the generator unwinding through its
    // `finally` block (no hang: the rejection above already proves that) —
    // the live connection's iterator `.return()` was invoked.
    expect(conn.returnCalls).toBeGreaterThan(0);
  });

  it("triggers a reconnect attempt instead of propagating, when autoReconnect is true", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const gen = joinSessionView(journal, "sid-err-2", liveSource.open, { autoReconnect: true, reconnectDelayMs: 0 });

    const firstNext = gen.next();
    expect(liveSource.connections).toHaveLength(1);
    expect(journal.calls).toHaveLength(1);
    const conn1 = liveSource.connections[0]!;

    const boom = new Error("transient failure");
    journal.rejectNext(boom);

    // firstNext must NOT reject: the error is swallowed internally and the
    // join reconnects instead, so this promise stays pending until the
    // reconnected cycle actually yields something. Give the reconnect
    // loop's microtasks a chance to run before asserting on it.
    for (let i = 0; i < 10 && liveSource.connections.length < 2; i++) await Promise.resolve();
    expect(liveSource.connections).toHaveLength(2); // a fresh connection was opened
    expect(conn1.returnCalls).toBeGreaterThan(0); // the old one was cleaned up first
    expect(journal.calls).toHaveLength(2); // a fresh readHistory() call was issued
    expect(journal.calls[1]).toMatchObject({ fromJournalSeq: 0 }); // nothing was durably applied yet, so it resumes from 0

    // Resolve the fresh cold read so the generator can make progress and
    // firstNext finally settles — proving it never rejected.
    journal.resolveNext({ events: [mkStatusEvent(0)], next_journal_seq: 1, done: true });
    const first = await firstNext;
    if (first.done) throw new Error("unreachable");
    expect(first.value.ok).toBe(true);
    expect(seqOf(first.value)).toBe(0);
    expect(first.value.input.segment).toBe("history");

    await gen.return();
  });
});

describe("joinSessionView: the live connection failing", () => {
  it("propagates the rejection to the caller and cleans up, when autoReconnect is false", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const gen = joinSessionView(journal, "sid-err-3", liveSource.open); // autoReconnect defaults false

    const firstNext = gen.next();
    const conn = liveSource.connections[0]!;
    journal.resolveNext({ events: [mkStatusEvent(0)], next_journal_seq: 1, done: true });

    const first = await firstNext; // history seq 0 delivered fine
    if (first.done) throw new Error("unreachable");

    // Resume the generator past the yield so it reaches step 4's
    // `await queue.next()` (cold catch-up is already done: the single page
    // reported `done: true`), THEN fail the connection.
    const secondNext = gen.next();
    await Promise.resolve();
    const boom = new Error("connection reset");
    conn.fail(boom);

    await expect(secondNext).rejects.toBe(boom);
    expect(conn.returnCalls).toBeGreaterThan(0);
  });

  it("triggers a reconnect attempt instead of propagating, when autoReconnect is true", async () => {
    const journal = new FakeJournalReader();
    const liveSource = new FakeLiveSource();
    const gen = joinSessionView(journal, "sid-err-4", liveSource.open, { autoReconnect: true, reconnectDelayMs: 0 });

    const firstNext = gen.next();
    const conn1 = liveSource.connections[0]!;
    journal.resolveNext({ events: [mkStatusEvent(0)], next_journal_seq: 1, done: true });

    const first = await firstNext;
    if (first.done) throw new Error("unreachable");

    const secondNext = gen.next();
    await Promise.resolve();
    const boom = new Error("connection reset");
    conn1.fail(boom);

    // secondNext must NOT reject: the failure triggers a reconnect instead.
    for (let i = 0; i < 10 && liveSource.connections.length < 2; i++) await Promise.resolve();
    expect(liveSource.connections).toHaveLength(2);
    expect(conn1.returnCalls).toBeGreaterThan(0);
    // The reconnect's cold catch-up resumes from the highest journal_seq
    // already applied (1), not from 0 again — the exact-once property holds
    // across an error-triggered reconnect exactly as it does for a clean one.
    expect(journal.calls[journal.calls.length - 1]).toMatchObject({ fromJournalSeq: 1 });

    const conn2 = liveSource.connections[1]!;
    conn2.push(mkEnduringFrame(1));
    journal.resolveNext({ events: [], next_journal_seq: 1, done: true });

    const second = await secondNext;
    if (second.done) throw new Error("unreachable");
    expect(second.value.ok).toBe(true);
    expect(seqOf(second.value)).toBe(1);
    expect(second.value.input.segment).toBe("live");

    await gen.return();
  });
});
