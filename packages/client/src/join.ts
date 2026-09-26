/** Factory subscription, durable capture and repair join. */
import type {
  EnduringPublication,
  EphemeralPublication,
  FactoryPublication,
  FactorySessionStatus,
  PublicJournalPage,
} from "./types.js";
import type { ClientSubscription, SubscribeOptions } from "./clientlink.js";
import type { FactoryJournalOptions } from "./factory-rest.js";
import {
  validateEnduringPublication,
  validateEphemeralPublication,
  validateFactorySessionStatus,
  validateJournalTip,
  validatePublicJournalPage,
  validateSessionReset,
} from "./validate.js";

// --- Factory sessionwire/v1 join --------------------------------------------

export interface FactoryJoinReads {
  readStatus(sessionId: string, options?: { signal?: AbortSignal }): Promise<FactorySessionStatus>;
  readJournal(sessionId: string, options?: FactoryJournalOptions): Promise<PublicJournalPage>;
}

export interface FactoryJoinLink {
  subscribe(options: SubscribeOptions): ClientSubscription;
}

export interface FactoryJoinOptions {
  /** Greatest authenticated sequence durably persisted by the application. */
  initialCoveredThrough?: number;
  /**
   * Per-page bound: the `tail` the capture is taken with, and the `limit` every
   * continuation page of that capture is read with. Default 256. It bounds ONE
   * page; `maxTailPages`/`maxTailEvents`/`maxTailBytes` bound the walk.
   */
  tailLimit?: number;
  /** Maximum publications retained while the tail is in flight. Default 256. */
  maxPrejoinPublications?: number;
  /**
   * Consecutive repairs that make NO coverage progress before the join gives
   * up and throws. Default 32. A repair cycle that advances `coveredThrough`
   * past the sequence the generation started from resets the counter, so a
   * slow-but-progressing recovery is never cut off; only a genuinely stuck
   * loop (a Factory permanently behind the persisted cursor, a page whose
   * coverage never reaches its own tip, a reset that repeats forever) is
   * terminated. Without this the loop below is unbounded — see the "Repair is
   * bounded" note on `joinFactorySessionView`.
   */
  maxRepairAttempts?: number;
  /**
   * Journal reads allowed per generation to walk ONE captured tail, including
   * the `tail` read that captured it. Default `DEFAULT_MAX_TAIL_PAGES`. A
   * capture that has not reached its own `journal_tip` when this is spent is
   * REFUSED — see `CapturedTail`.
   */
  maxTailPages?: number;
  /** Public events admitted across one captured tail. Default `DEFAULT_MAX_TAIL_EVENTS`. */
  maxTailEvents?: number;
  /** Encoded event bytes admitted across one captured tail. Default `DEFAULT_MAX_TAIL_BYTES`. */
  maxTailBytes?: number;
  /**
   * Base delay before the SECOND and later consecutive non-progressing repair
   * attempts, doubling per attempt and capped at eight times this value.
   * Default 250 (milliseconds). The first repair after progress retries with
   * a zero delay, exactly like the legacy join's clean-end reconnect. Note
   * that a zero delay is still awaited through a real timer: every repair
   * cycle yields a MACROTASK, which is what makes `options.signal`'s abort
   * listener (and any test timer) reachable at all — see `joinFactorySessionView`.
   */
  repairDelayMs?: number;
  signal?: AbortSignal;
}

export type FactoryJoinEvent =
  | {
    kind: "projection";
    generation: number;
    status: FactorySessionStatus;
    coveredThrough: number;
  }
  | {
    kind: "public";
    generation: number;
    status: FactorySessionStatus;
    event: PublicJournalPage["events"][number];
    coveredThrough: number;
  }
  | {
    kind: "ephemeral";
    generation: number;
    status: FactorySessionStatus;
    publication: EphemeralPublication;
    coveredThrough: number;
  }
  | {
    kind: "coverage";
    generation: number;
    status: FactorySessionStatus;
    coveredThrough: number;
  };

type FactorySignal =
  | { kind: "publication"; publication: FactoryPublication }
  | { kind: "repair"; error?: Error };

/**
 * Shared defaults for the protocol join and framework adapters. React delegates
 * live reconciliation to this join and uses CapturedTail independently for an
 * initial REST snapshot while realtime authorization is unavailable.
 */
export const DEFAULT_FACTORY_TAIL_LIMIT = 256;
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 32;
export const DEFAULT_REPAIR_DELAY_MS = 250;
export const MAX_REPAIR_BACKOFF_FACTOR = 8;

/**
 * The bounds on ONE captured tail's continuation, exported for the same reason
 * the four above are: `packages/react`'s `useFactorySessionView` drives the same
 * `CapturedTail` over its own transport seam.
 *
 * `DEFAULT_MAX_TAIL_PAGES` counts the capturing `tail` read too, so the default
 * admits the capture plus seven continuations — `DEFAULT_MAX_TAIL_PAGES` times
 * `DEFAULT_FACTORY_TAIL_LIMIT` events, which is what `DEFAULT_MAX_TAIL_EVENTS`
 * is. The byte ceiling is the one that actually binds against a Factory paging
 * on a byte budget: it is the reason a page may come back EMPTY with coverage
 * that still advanced.
 */
export const DEFAULT_MAX_TAIL_PAGES = 8;
export const DEFAULT_MAX_TAIL_EVENTS = 2048;
export const DEFAULT_MAX_TAIL_BYTES = 1_048_576;

// --- The bounded captured-tail continuation -----------------------------------

/** Why a captured tail was refused. Reported, never repaired in place. */
export type CapturedTailRefusal =
  | "page_budget"
  | "event_budget"
  | "byte_budget"
  | "page_limit_exceeded"
  | "tip_moved"
  | "coverage_stalled"
  | "missing_cursor"
  | "cursor_repeated"
  | "event_conflict";

/**
 * What to do after a page: read `cursor` next, stop (the capture is whole), or
 * abandon this capture entirely.
 */
export type CapturedTailStep =
  | { readonly kind: "complete" }
  | { readonly kind: "continue"; readonly cursor: string }
  | { readonly kind: "refused"; readonly reason: CapturedTailRefusal };

export interface CapturedTailBounds {
  /** Journal reads per capture, INCLUDING the `tail` read that captured it. */
  maxPages: number;
  /** Public events admitted across the whole capture. */
  maxEvents: number;
  /** Encoded event bytes admitted across the whole capture. */
  maxBytes: number;
  /** Per-page event ceiling: the `limit` the reads are issued with. */
  pageLimit: number;
}

/** A whole capture: every public event in it, and the coverage it attests. */
export interface CapturedTailResult {
  readonly events: PublicJournalPage["events"];
  readonly coveredThrough: number;
}

/**
 * Accumulates ONE captured tail across a Factory's byte-budgeted continuation
 * pages, and refuses anything that is not that.
 *
 * ## What this is for
 *
 * A tail read captures a tip `T` and answers with as much of `(0, T]` as its
 * budget allowed: `covered_through` may stop short of `T`, `events` may be
 * EMPTY (a page holding only private records still advances coverage), and the
 * page hands back an opaque `next_cursor` for the rest. Before this class the
 * join treated `covered_through !== journal_tip` as a fault and repaired, which
 * is correct only while every tail read is whole: against a Factory that pages,
 * a bounded session repairs forever and never renders.
 *
 * ## What it will not do
 *
 * It follows the cursor the pages hand back, and NOTHING else. It never issues
 * a second read of its own, never names a sequence, and so can never restart
 * at zero or walk an entire history: the only reachable content is `(0, T]`
 * for the ONE `T` the capture began with, under three finite ceilings
 * (`maxPages`, `maxEvents`, `maxBytes`) that bound the walk even if the
 * Factory keeps offering cursors. The capture's FIRST page is the caller's:
 * a tail read, or a forward read at a committed cursor.
 *
 * Every step is checked against the capture rather than believed:
 *
 *  - the tip must not move (`tip_moved`) — a page describing a different tip
 *    describes a different capture, and a later generation recaptures it;
 *  - coverage must strictly ADVANCE (`coverage_stalled`), which is also what
 *    makes the walk terminate rather than loop on a stationary page;
 *  - a cursor is used at most once (`cursor_repeated`), so a Factory handing
 *    back the cursor it was given cannot spin the caller;
 *  - a `journal_seq` present twice must carry one `event_id`
 *    (`event_conflict`).
 *
 * ## Refusal is not partial success
 *
 * `result` is `undefined` unless the capture reached its own tip, so a caller
 * cannot advance a durable cursor over coverage that was never attested — the
 * fail-open direction the join's `covered_through !== journal_tip` guard was
 * written for, which this class preserves rather than relaxes. A refused
 * capture is repaired from the last COMMITTED cursor, exactly like every other
 * fault in the join.
 *
 * Nothing here does I/O: the caller owns the reads, their cancellation and
 * their generation, which is what lets `joinFactorySessionView` and
 * `packages/react`'s `useFactorySessionView` share one set of rules over two
 * very different transport seams.
 */
export class CapturedTail {
  readonly #bounds: CapturedTailBounds;
  readonly #tip: number;
  readonly #events = new Map<number, PublicJournalPage["events"][number]>();
  readonly #cursors = new Set<string>();
  #coveredThrough = -1;
  #pages = 0;
  #eventCount = 0;
  #bytes = 0;
  #step: CapturedTailStep;

  /** `first` is the answered `tail` read, already validated by the caller. */
  constructor(first: PublicJournalPage, bounds: CapturedTailBounds) {
    this.#bounds = bounds;
    this.#tip = first.journal_tip;
    this.#step = this.#admit(first);
  }

  /** The tip this capture is pinned to, for the whole walk. */
  get tip(): number {
    return this.#tip;
  }

  /** What the last admitted page asks the caller to do next. */
  get step(): CapturedTailStep {
    return this.#step;
  }

  /**
   * The prefix of the capture that pages have ATTESTED so far: every admitted
   * event at or below the last admitted `covered_through`, and that watermark.
   * `undefined` before any page was admitted.
   *
   * This is NOT the capture's result and says nothing about `(coveredThrough,
   * tip]`. It is only safe to commit when the capture was a FORWARD read that
   * began exactly one past the caller's committed cursor, because then the
   * prefix is contiguous with what the caller already holds. A `tail` capture
   * starts at `tip - limit + 1`, so its prefix can sit above a hole — that is
   * the fail-open case `result` exists to refuse, and `joinFactorySessionView`
   * reads this only for a forward capture.
   */
  get attested(): CapturedTailResult | undefined {
    if (this.#coveredThrough < 0) return undefined;
    const covered = this.#coveredThrough;
    const events = [...this.#events.entries()]
      .filter(([sequence]) => sequence <= covered)
      .sort(([left], [right]) => left - right)
      .map(([, event]) => event);
    return { events, coveredThrough: covered };
  }

  /** The capture, or `undefined` until it has actually reached its tip. */
  get result(): CapturedTailResult | undefined {
    if (this.#step.kind !== "complete") return undefined;
    const events = [...this.#events.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, event]) => event);
    return { events, coveredThrough: this.#coveredThrough };
  }

  /** Admits one continuation page, read with the cursor `step` named. */
  accept(page: PublicJournalPage): CapturedTailStep {
    if (this.#step.kind !== "continue") return this.#step;
    this.#step = page.journal_tip === this.#tip
      ? this.#admit(page)
      : { kind: "refused", reason: "tip_moved" };
    return this.#step;
  }

  #admit(page: PublicJournalPage): CapturedTailStep {
    this.#pages += 1;
    if (page.events.length > this.#bounds.pageLimit) return refused("page_limit_exceeded");
    if (page.covered_through <= this.#coveredThrough) return refused("coverage_stalled");
    if (page.covered_through > this.#tip) return refused("tip_moved");
    this.#eventCount += page.events.length;
    if (this.#eventCount > this.#bounds.maxEvents) return refused("event_budget");
    this.#bytes += capturedTailBytes(page);
    if (this.#bytes > this.#bounds.maxBytes) return refused("byte_budget");
    for (const event of page.events) {
      const prior = this.#events.get(event.journal_seq);
      if (prior === undefined) this.#events.set(event.journal_seq, event);
      else if (prior.event_id !== event.event_id) return refused("event_conflict");
    }
    this.#coveredThrough = page.covered_through;
    if (this.#coveredThrough === this.#tip) return { kind: "complete" };
    const cursor = page.next_cursor;
    // Coverage stopped short and the Factory offered no way to continue: the
    // gap is real, and this is where the join's original fail-closed reading
    // still applies.
    if (cursor === undefined || cursor === "") return refused("missing_cursor");
    if (this.#cursors.has(cursor)) return refused("cursor_repeated");
    this.#cursors.add(cursor);
    if (this.#pages >= this.#bounds.maxPages) return refused("page_budget");
    return { kind: "continue", cursor };
  }
}

function refused(reason: CapturedTailRefusal): CapturedTailStep {
  return { kind: "refused", reason };
}

/**
 * The refusals that mean "this capture was too BIG for one generation", not
 * "this capture is inconsistent". Only these let a forward capture commit the
 * prefix it attested and continue from there in the next generation.
 */
const BUDGET_REFUSALS: ReadonlySet<CapturedTailRefusal> = new Set(["page_budget", "event_budget", "byte_budget"]);

const capturedTailEncoder = new TextEncoder();

/**
 * The encoded size of a page's events, in UTF-8 bytes rather than UTF-16 code
 * units: a `length` would UNDER-count every non-ASCII transcript, which is the
 * wrong direction for a ceiling.
 */
function capturedTailBytes(page: PublicJournalPage): number {
  return capturedTailEncoder.encode(JSON.stringify(page.events)).length;
}

/**
 * Reads `tail`'s continuation pages until it is whole, refused, aborted, or the
 * generation is superseded by something the queue is holding.
 *
 * Each read carries `controller.signal` and NO `tail` parameter, so a
 * cancelled generation cancels the walk in flight and a continuation can never
 * re-enter the journal anywhere but where the cursor points.
 */
async function followCapturedTail(
  reads: FactoryJoinReads,
  sessionId: string,
  tail: CapturedTail,
  pageLimit: number,
  queue: FactorySignalQueue,
  controller: AbortController,
  signal?: AbortSignal,
): Promise<"complete" | "repair" | "aborted"> {
  let step = tail.step;
  while (step.kind === "continue") {
    if (signal?.aborted) return "aborted";
    const page = reads.readJournal(sessionId, {
      cursor: step.cursor,
      limit: pageLimit,
      signal: controller.signal,
    });
    const result = await raceGeneration(page, queue, signal);
    if (typeof result === "string") return result === "repair" ? "repair" : "aborted";
    step = tail.accept(validatePublicJournalPage(result.value));
  }
  return step.kind === "complete" ? "complete" : "repair";
}

/**
 * Subscribe-first Factory join. Each repair replaces the complete generation;
 * callbacks close over its token and are inert as soon as it is superseded.
 *
 * ## Repair is bounded, and every repair yields a macrotask
 *
 * Step 6 of the algorithm ("if a remaining gap appears, discard and repeat")
 * is a loop with no natural fixed point: a Factory whose coverage sits behind
 * the application's persisted cursor, or a tail page whose `covered_through`
 * never reaches its own `journal_tip`, repairs on every attempt forever. Two
 * bounds close that.
 *
 * FIRST, the loop yields a real timer on every repair, even a zero-delay one.
 * This is not cosmetic. Every `await` in the loop body — subscription
 * readiness, the two REST reads, the queue — resolves as a MICROTASK when the
 * failure is immediate, so an unbounded loop drains the microtask queue
 * forever and never reaches the timer queue. A `setTimeout`-driven
 * `controller.abort()` therefore never runs: the abort path is structurally
 * unreachable while the loop spins, which turns a livelock into a hang that
 * cancellation cannot break. Measured before this delay existed: a join with
 * `initialCoveredThrough: 40` against a page reporting `covered_through: 4`
 * hung its worker until the process was killed, with the test runner's own
 * timeout never firing.
 *
 * SECOND, consecutive repairs that make no coverage progress are counted and
 * capped (`options.maxRepairAttempts`), with the delay doubling in between
 * (`options.repairDelayMs`). Under real network latency the unbounded form
 * does not freeze — it degrades into an unthrottled subscribe/REST storm, one
 * full cycle per round trip, which is a client-caused outage amplifier. A
 * cycle that advances `coveredThrough` past the sequence its generation
 * started from resets the counter, so a legitimate slow recovery is never cut
 * off; only a stuck loop terminates, and it terminates by THROWING, so the
 * failure is reported rather than silently retried forever.
 *
 * ## `session.reset` lowers the cursor only when the journal shrank
 *
 * A `session.reset` always repairs. Its `last_contiguous` describes what
 * Factory delivered to this LINK (often 0), not the journal, so it never moves
 * the cursor. Its `journal_tip`, when BELOW this join's committed
 * `coveredThrough`, means the session truncated behind us, and repairing from
 * the unchanged cursor would ask for coverage that no longer exists — every
 * subsequent page fails `page.covered_through < coveredThrough` and repairs
 * again. Only then is `last_contiguous` (what this link was delivered in
 * order, never above `journal_tip`) applied as a floor on the cursor before
 * the replacement generation starts. A reset that fails validation, or that names
 * another tenant/session, still forces a repair (matching every publication
 * path) but must NOT move the cursor.
 *
 * ## The tail may arrive in several pages, and only within itself
 *
 * The tail read captures a tip `T` and may answer with less than `(0, T]` when
 * the Factory is paging on a byte budget — coverage short of `T`, possibly no
 * events at all, plus an opaque `next_cursor`. `CapturedTail` walks that
 * continuation, under finite page/event/byte ceilings, and NOTHING else: the
 * walk cannot re-enter the journal at a sequence, so it can never restart at
 * zero or wander off the captured tail. A capture that has not reached `T` when
 * a ceiling is spent, or that fails any of that class's consistency rules, is
 * REFUSED and repaired from the last committed cursor — never committed
 * halfway, because a durable cursor over unattested coverage is the failure
 * this join exists to prevent.
 *
 * ## A committed cursor is resumed FORWARD, not re-tailed
 *
 * Once this join has committed a cursor (`initialCoveredThrough`, or anything
 * applied since), every generation's first read is a forward read at
 * `coveredThrough + 1` rather than a tail. The two differ exactly when the
 * outage was longer than one tail window: a tail captures `(T - limit, T]`,
 * and merging it above a cursor at `C < T - limit` would advance the cursor
 * over `(C, T - limit]` without ever having read it. That is what a Host
 * session's gap `session.reset` and every reconnect after a long disconnect
 * would otherwise produce. A forward capture starts contiguous with the
 * cursor, so when it runs out of budget its attested prefix is committed and
 * the next generation continues past it (see `CapturedTail.attested`); a
 * capture that fails any CONSISTENCY rule is still refused whole.
 *
 * Continuation cursors are opaque and belong to the one capture that issued
 * them. None is ever carried into a later generation, so a cursor Factory no
 * longer honours (a `j1.` wrapper minted before a re-placement, or a cursor
 * from before a Factory upgrade — answered 400 `invalid_request`) costs one
 * repair: the next generation starts a fresh walk from the committed sequence.
 */
export async function* joinFactorySessionView(
  reads: FactoryJoinReads,
  link: FactoryJoinLink,
  tenantId: string,
  sessionId: string,
  options: FactoryJoinOptions = {},
): AsyncGenerator<FactoryJoinEvent, void, void> {
  const tailLimit = positiveBound(options.tailLimit ?? DEFAULT_FACTORY_TAIL_LIMIT, "tailLimit");
  const maxBuffered = positiveBound(options.maxPrejoinPublications ?? DEFAULT_FACTORY_TAIL_LIMIT, "maxPrejoinPublications");
  const maxRepairAttempts = positiveBound(options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS, "maxRepairAttempts");
  const tailBounds: CapturedTailBounds = {
    maxPages: positiveBound(options.maxTailPages ?? DEFAULT_MAX_TAIL_PAGES, "maxTailPages"),
    maxEvents: positiveBound(options.maxTailEvents ?? DEFAULT_MAX_TAIL_EVENTS, "maxTailEvents"),
    maxBytes: positiveBound(options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES, "maxTailBytes"),
    pageLimit: tailLimit,
  };
  const repairDelayMs = safeSequence(options.repairDelayMs ?? DEFAULT_REPAIR_DELAY_MS, "repairDelayMs");
  let coveredThrough = safeSequence(options.initialCoveredThrough ?? 0, "initialCoveredThrough");
  let generation = 0;
  let activeToken = 0;
  let attempted = false;
  /** The previous generation's `generationBase`, for the progress test below. */
  let previousBase = coveredThrough;
  let consecutiveRepairs = 0;
  let resetFloor: number | undefined;

  while (!options.signal?.aborted) {
    if (attempted) {
      // Only reachable when the previous generation ended in repair. Coverage
      // that moved past that generation's base is progress and clears the
      // counter; anything else is one more step toward giving up.
      consecutiveRepairs = coveredThrough > previousBase ? 0 : consecutiveRepairs + 1;
      if (consecutiveRepairs > maxRepairAttempts) {
        throw new Error(`factory join gave up after ${consecutiveRepairs} consecutive repairs without coverage progress`);
      }
      // Awaited unconditionally, including at zero: the macrotask is the point.
      await repairDelay(repairBackoffMs(consecutiveRepairs, repairDelayMs), options.signal);
      if (options.signal?.aborted) return;
      if (resetFloor !== undefined) {
        if (resetFloor < coveredThrough) coveredThrough = resetFloor;
        resetFloor = undefined;
      }
    }
    attempted = true;
    const token = ++activeToken;
    const currentGeneration = ++generation;
    // Per-generation, and captured by this generation's callbacks below.
    const generationBase = coveredThrough;
    const forward = generationBase > 0;
    previousBase = generationBase;
    const queue = new FactorySignalQueue(maxBuffered);
    let prejoinOpen = true;
    const push = (signal: FactorySignal): void => {
      if (token === activeToken) queue.push(signal);
    };
    const admitPublication = (value: FactoryPublication): void => {
      if (token !== activeToken) return;
      try {
        if (value.type === "enduring_publication") {
          const parsed = validateEnduringPublication(value);
          if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId) {
            push({ kind: "repair" });
            return;
          }
          if (prejoinOpen && parsed.journal_seq <= generationBase) return;
          push({ kind: "publication", publication: parsed });
          return;
        }
        if (value.type === "ephemeral_publication") {
          const parsed = validateEphemeralPublication(value);
          if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId) {
            push({ kind: "repair" });
            return;
          }
          if (!prejoinOpen) push({ kind: "publication", publication: parsed });
          return;
        }
        const parsed = validateJournalTip(value);
        if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId) {
          push({ kind: "repair" });
          return;
        }
        if (!prejoinOpen) push({ kind: "publication", publication: parsed });
      } catch (error) {
        push({ kind: "repair", error: error instanceof Error ? error : undefined });
      }
    };
    const subscription = link.subscribe({
      tenantId,
      sessionId,
      onPublication: admitPublication,
      onReset: (value) => {
        // A reset ALWAYS repairs, but only a validated reset for this exact
        // channel is allowed to move the durable cursor: a forged or
        // wrong-session frame that lowered it would re-expose already-applied
        // sequences. See "session.reset lowers the cursor only when the journal shrank" above.
        try {
          const parsed = validateSessionReset(value);
          // `last_contiguous` is NOT a statement about the journal: Factory
          // names the greatest sequence it published to THIS link in an
          // unbroken run (factory internal/routing/repair.go, deliveryBinding),
          // which is 0 for a binding that has delivered nothing and sticks at
          // the first sparse gap. Below the cursor it is ordinary, and lowering
          // to it threw a view back to the tail window. The only evidence of a
          // journal that truly shrank is a reset tip below what this join has
          // committed. Then nothing above the in-order run this link was
          // actually delivered can be trusted, so the floor is
          // `last_contiguous` (Core holds it at or below `journal_tip`).
          if (token === activeToken
            && parsed.tenant_id === tenantId
            && parsed.session_id === sessionId
            && parsed.journal_tip < coveredThrough) {
            resetFloor = resetFloor === undefined
              ? parsed.last_contiguous
              : Math.min(resetFloor, parsed.last_contiguous);
          }
        } catch { /* still repair, but never move the cursor */ }
        push({ kind: "repair" });
      },
      onError: (error) => push({ kind: "repair", error }),
    });

    let repair = false;
    try {
      const ready = await raceGeneration(subscription.ready, queue, options.signal);
      if (typeof ready === "string") { repair = ready === "repair"; continue; }
      if (subscription.version !== 1) { repair = true; continue; }
      if (queue.requiresRepair) { repair = true; continue; }

      const controller = new AbortController();
      const abort = (): void => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      let status: FactorySessionStatus;
      let tail: CapturedTail;
      let followed: "complete" | "repair" | "aborted";
      try {
        // A view holding a committed cursor RESUMES from it: a forward read at
        // `coveredThrough + 1` (Factory's `from_seq`) captures the tip at read
        // time and its continuation cursor walks to that tip, so a reconnect
        // after a long outage — or a `session.reset` naming a gap — re-reads
        // every public event since the checkpoint rather than only the newest
        // tail window, which would leave `(coveredThrough, tip - limit]` a
        // silent hole. A view with nothing committed reads the bounded tail:
        // opening a session never replays it from sequence zero.
        const firstPage: FactoryJournalOptions = forward
          ? { fromSeq: generationBase + 1, limit: tailLimit, signal: controller.signal }
          : { tail: tailLimit, limit: tailLimit, signal: controller.signal };
        const cold = Promise.all([
          reads.readStatus(sessionId, { signal: controller.signal }),
          reads.readJournal(sessionId, firstPage),
        ]);
        const result = await raceGeneration(cold, queue, options.signal);
        if (typeof result === "string") {
          controller.abort();
          repair = result === "repair";
          continue;
        }
        const captured = validatePublicJournalPage(result.value[1]);
        // The PAGE is the authority on the journal tip; see `withJournalTip`.
        status = withJournalTip(validateFactorySessionStatus(result.value[0]), captured.journal_tip);
        // Checked BEFORE any continuation is paid for: a status for another
        // session is not a projection of this capture.
        if (status.session_id !== sessionId) {
          controller.abort();
          repair = true;
          continue;
        }
        tail = new CapturedTail(captured, tailBounds);
        followed = await followCapturedTail(reads, sessionId, tail, tailLimit, queue, controller, options.signal);
      } finally {
        options.signal?.removeEventListener("abort", abort);
        // Promise.all may reject while its sibling request is still in flight.
        // Every exit ends this generation's REST work, including read failures.
        controller.abort();
      }
      // A capture is committed WHOLE or not at all. `tail.result` is defined
      // only once coverage actually reached the captured tip, which is the
      // fail-CLOSED half of taking T from `journal_tip`: only events at or
      // below `covered_through` are attested (the validator rejects any event
      // above it), so coverage short of T leaves (covered_through, T] neither
      // in the capture, nor necessarily in the prejoin buffer — anything that
      // committed there BEFORE subscribe was never buffered — nor repaired.
      // Measured before the guard existed, a page {journal_tip: 5,
      // covered_through: 2, events: [1, 2]} plus a prejoin publication at 4
      // rendered [1, 2, 4], silently dropping public sequence 5, and then
      // walked the durable cursor over it to 6: a missing event AND a
      // persisted cursor asserting it was covered. What U5.2 changed is only
      // WHERE that coverage may come from — the continuation pages of the same
      // capture now count, a budget-exhausted walk still does not.
      if (followed !== "complete") {
        controller.abort();
        repair = followed === "repair";
        if (!repair) continue;
        // A FORWARD capture that ran out of budget before its tip still
        // attested a contiguous prefix starting at `generationBase + 1`. Commit
        // that prefix — it is exactly as attested as a whole capture, only
        // shorter — so the next generation resumes past it. Without this a
        // gap larger than one generation's budget repairs forever without
        // progress and the join gives up; with it, every generation advances.
        const step = tail.step;
        const prefix = tail.attested;
        if (forward && step.kind === "refused" && BUDGET_REFUSALS.has(step.reason)
          && prefix !== undefined && prefix.coveredThrough > coveredThrough) {
          yield { kind: "projection", generation: currentGeneration, status, coveredThrough };
          for (const event of prefix.events) {
            if (event.journal_seq <= coveredThrough) continue;
            coveredThrough = event.journal_seq;
            yield { kind: "public", generation: currentGeneration, status, event, coveredThrough };
          }
          if (prefix.coveredThrough > coveredThrough) {
            coveredThrough = prefix.coveredThrough;
            yield { kind: "coverage", generation: currentGeneration, status, coveredThrough };
          }
        }
        continue;
      }
      const captured = tail.result;
      if (captured === undefined || captured.coveredThrough < coveredThrough) {
        repair = true;
        continue;
      }
      if (queue.requiresRepair) { repair = true; continue; }
      const tip = tail.tip;
      const prejoin = queue.drainPublications();
      prejoinOpen = false;
      if (queue.requiresRepair) { repair = true; continue; }
      yield { kind: "projection", generation: currentGeneration, status, coveredThrough };

      const enduring = prejoin.filter((item): item is EnduringPublication => item.type === "enduring_publication");
      const candidates = mergeFactoryEvents(captured.events, enduring, coveredThrough, tip);
      if (candidates === undefined) { repair = true; continue; }
      const seen = new Map<number, string>();
      for (const event of candidates) {
        seen.set(event.journal_seq, event.event_id);
        if (event.journal_seq <= coveredThrough) continue;
        coveredThrough = event.journal_seq;
        yield { kind: "public", generation: currentGeneration, status, event, coveredThrough };
      }
      if (captured.coveredThrough > coveredThrough) {
        coveredThrough = captured.coveredThrough;
        yield { kind: "coverage", generation: currentGeneration, status, coveredThrough };
      }

      const aboveTip = enduring.filter((item) => item.journal_seq > tip).sort((a, b) => a.journal_seq - b.journal_seq);
      for (const item of aboveTip) {
        const parsed = validateEnduringPublication(item);
        // `parsed.covered_through < parsed.journal_seq` is UNREACHABLE while
        // Core enforces `covered_through === journal_seq` on every
        // enduring_publication (validate.ts rejects any inequality before this
        // line, and the contract schema documents the invariant), which also
        // makes step 5's "otherwise repair from SessionStore" unable to fire
        // on the live path. Do not delete it: a guard whose input is currently
        // impossible is not a redundant guard, and it is the fail-closed
        // reading if that Core invariant is ever relaxed.
        if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId || parsed.covered_through < parsed.journal_seq) {
          repair = true;
          break;
        }
        const prior = seen.get(parsed.journal_seq);
        if (prior !== undefined) {
          if (prior !== parsed.event_id) { repair = true; break; }
          continue;
        }
        if (parsed.journal_seq <= generationBase) continue;
        if (parsed.journal_seq <= coveredThrough) { repair = true; break; }
        seen.set(parsed.journal_seq, parsed.event_id);
        coveredThrough = parsed.covered_through;
        yield { kind: "public", generation: currentGeneration, status, event: factoryEvent(parsed), coveredThrough };
      }
      if (repair) continue;

      for (;;) {
        const next = await queue.next(options.signal);
        if (next === undefined) return;
        if (next.kind === "repair") { repair = true; break; }
        const value = next.publication;
        if (value.type === "journal_tip") {
          const tipHint = validateJournalTip(value);
          if (tipHint.tenant_id !== tenantId || tipHint.session_id !== sessionId) { repair = true; break; }
          continue;
        }
        if (value.type === "ephemeral_publication") {
          const parsed = validateEphemeralPublication(value);
          if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId) { repair = true; break; }
          yield { kind: "ephemeral", generation: currentGeneration, status, publication: parsed, coveredThrough };
          continue;
        }
        const parsed = validateEnduringPublication(value);
        if (parsed.tenant_id !== tenantId || parsed.session_id !== sessionId) { repair = true; break; }
        const prior = seen.get(parsed.journal_seq);
        if (prior !== undefined) {
          if (prior !== parsed.event_id) { repair = true; break; }
          continue;
        }
        if (parsed.journal_seq <= generationBase) continue;
        if (parsed.journal_seq <= coveredThrough) { repair = true; break; }
        seen.set(parsed.journal_seq, parsed.event_id);
        coveredThrough = parsed.covered_through;
        yield { kind: "public", generation: currentGeneration, status, event: factoryEvent(parsed), coveredThrough };
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      repair = true;
    } finally {
      activeToken += 1;
      subscription.unsubscribe();
    }
    if (!repair) return;
  }
}

/**
 * `status` with its `journal_tip` replaced by the tip a journal page captured.
 *
 * The two reads are made by different parts of Factory, and for a Host-owned
 * session they do not agree: Factory (<= v0.10.0) answers `/status` from the
 * catalog, which keeps NO journal tip for a disposition session (it reads 0),
 * while `/journal` reads the runtime's own journal through the composition's
 * journal resolver. Requiring the two to be equal — as wui <= v0.2.0 did —
 * repaired every generation of every Host session forever: the view never
 * went live. Even for a legacy session the two are separate reads of a moving
 * tip. The page's tip is the one this capture's coverage is measured against,
 * so it is the one every consumer of the yielded status sees.
 */
export function withJournalTip(status: FactorySessionStatus, tip: number): FactorySessionStatus {
  return status.journal_tip === tip ? status : { ...status, journal_tip: tip };
}

/**
 * Zero for the first repair after progress (retry immediately, as the legacy
 * join does on a clean end); from the second consecutive non-progressing
 * repair onward, `base` doubling per attempt and capped at eight times base.
 */
/**
 * The delay before the `consecutiveRepairs`-th consecutive non-progressing
 * repair: zero for the first, then `base` doubling per attempt and capped at
 * `MAX_REPAIR_BACKOFF_FACTOR` times it. Exported for the same reason the
 * constants above are.
 */
export function repairBackoffMs(consecutiveRepairs: number, base: number): number {
  if (consecutiveRepairs <= 1) return 0;
  return base * Math.min(2 ** (consecutiveRepairs - 2), MAX_REPAIR_BACKOFF_FACTOR);
}

/** Always a real timer, so the repair loop reaches the macrotask queue. */
function repairDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function safeSequence(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function factoryEvent(publication: EnduringPublication): PublicJournalPage["events"][number] {
  return { event_id: publication.event_id, journal_seq: publication.journal_seq, body: publication.body };
}

function mergeFactoryEvents(
  pageEvents: PublicJournalPage["events"],
  publications: EnduringPublication[],
  coveredThrough: number,
  tip: number,
): PublicJournalPage["events"] | undefined {
  const bySequence = new Map<number, PublicJournalPage["events"][number]>();
  for (const event of pageEvents) bySequence.set(event.journal_seq, event);
  for (const publication of publications) {
    if (publication.journal_seq > tip || publication.journal_seq <= coveredThrough) continue;
    const event = factoryEvent(validateEnduringPublication(publication));
    const prior = bySequence.get(event.journal_seq);
    if (prior !== undefined && prior.event_id !== event.event_id) return undefined;
    bySequence.set(event.journal_seq, prior ?? event);
  }
  return [...bySequence.values()].sort((a, b) => a.journal_seq - b.journal_seq);
}

class FactorySignalQueue {
  private readonly items: FactorySignal[] = [];
  private waiter: ((value: FactorySignal | undefined) => void) | undefined;
  private readonly repairWaiters = new Set<() => void>();
  requiresRepair = false;

  constructor(private readonly maxBuffered: number) {}

  push(item: FactorySignal): void {
    if (item.kind === "repair") {
      this.requiresRepair = true;
      for (const resolve of this.repairWaiters) resolve();
      this.repairWaiters.clear();
    }
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter(item);
      return;
    }
    this.items.push(item);
    const publicationCount = this.items.filter((entry) => entry.kind === "publication").length;
    if (publicationCount > this.maxBuffered) {
      this.requiresRepair = true;
      this.items.length = 0;
      for (const resolve of this.repairWaiters) resolve();
      this.repairWaiters.clear();
    }
  }

  drainPublications(): FactoryPublication[] {
    const publications: FactoryPublication[] = [];
    for (const item of this.items.splice(0)) {
      if (item.kind === "repair") this.requiresRepair = true;
      else publications.push(item.publication);
    }
    return publications;
  }

  waitForRepair(signal?: AbortSignal): Promise<"repair" | "aborted"> {
    if (this.requiresRepair) return Promise.resolve("repair");
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise((resolve) => {
      const repaired = (): void => {
        signal?.removeEventListener("abort", aborted);
        resolve("repair");
      };
      const aborted = (): void => {
        this.repairWaiters.delete(repaired);
        resolve("aborted");
      };
      this.repairWaiters.add(repaired);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  async next(signal?: AbortSignal): Promise<FactorySignal | undefined> {
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (signal?.aborted) return undefined;
    return new Promise((resolve) => {
      const abort = (): void => { this.waiter = undefined; resolve(undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiter = (value) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
    });
  }
}

async function raceGeneration<T>(
  promise: Promise<T>,
  queue: FactorySignalQueue,
  signal?: AbortSignal,
): Promise<{ readonly value: T } | "repair" | "aborted"> {
  return Promise.race([
    promise.then((value) => ({ value } as const)),
    queue.waitForRepair(signal),
  ]);
}
