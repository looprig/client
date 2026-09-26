import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  CapturedTail,
  CoreProtocolError,
  DEFAULT_FACTORY_TAIL_LIMIT,
  DEFAULT_MAX_TAIL_BYTES,
  DEFAULT_MAX_TAIL_EVENTS,
  DEFAULT_MAX_TAIL_PAGES,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_REPAIR_DELAY_MS,
  decodeFactoryLiveDelta,
  isRejectedJournalCursor,
  joinFactorySessionView,
  withJournalTip,
  validateFactory,
  type CapturedTailBounds,
  type FactoryJournalOptions,
  type FactoryPageOptions,
  type FactorySessionStatus,
  type PublicGatePage,
  type PublicJournalPage,
  type RequestOptions,
} from "@looprig/client";
import { asError, Publisher } from "./stores/publisher.js";
import { useFactoryLink } from "./use-connection.js";
import type { FactoryLinkStore } from "./stores/connection.js";
import { useStore } from "./use-store.js";

// --- The Factory cold-read + join state machine -------------------------------

/** One public journal event, in the shape a tail page and a publication share. */
export type PublicJournalEvent = PublicJournalPage["events"][number];

/**
 * The three durable reads a session view opens with. Narrow on purpose: a real
 * `FactoryReads` (and so `FactoryClient.reads`) satisfies it structurally, so a
 * caller needs no adapter and a test double needs three methods rather than
 * seven.
 */
export interface FactoryColdReads {
  readStatus(sessionId: string, options?: RequestOptions): Promise<FactorySessionStatus>;
  listGates(sessionId: string, options?: FactoryPageOptions): Promise<PublicGatePage>;
  readJournal(sessionId: string, options?: FactoryJournalOptions): Promise<PublicJournalPage>;
}

/**
 * `"reading"` while the initial REST capture is in flight, `"ready"` once a
 * durable capture has landed, and `"failed"` when no usable capture is available.
 * A ready view remains visible during realtime repair. `"joining"` is retained
 * for compatibility and is the construction snapshot before effects start.
 */
export type FactorySessionViewState = "joining" | "reading" | "ready" | "failed";

export interface FactorySessionViewOptions {
  tenantId: string;
  sessionId: string;
  /**
   * Greatest sequence the application has already durably applied.
   *
   * A construction input, read when this view's machine is built — which is
   * when the session identity changes, not on every render. Moving it alone
   * does nothing until then, and the alternative is worse rather than
   * stricter: see the memo in `useFactorySessionView`.
   */
  coveredThrough?: number;
  /**
   * Per-page bound: the `tail` each capture is taken with, and the `limit`
   * every continuation page of that capture is read with. Defaults to
   * protocol's `DEFAULT_FACTORY_TAIL_LIMIT`. The walk itself is bounded by
   * `maxTailPages`/`maxTailEvents`/`maxTailBytes`. A construction input, like
   * the continuation and repair bounds below.
   */
  tailLimit?: number;
  /**
   * Consecutive repairs that make NO coverage progress before the view gives
   * up and reports a failure. Defaults to protocol's
   * `DEFAULT_MAX_REPAIR_ATTEMPTS`. A construction input, like `coveredThrough`
   * and for the same reason: see the memo in `useFactorySessionView`. A repair
   * cycle that advances `coveredThrough` past the sequence its cycle started
   * from resets the counter, so a slow but progressing recovery is never cut
   * off; only a genuinely stuck condition terminates.
   */
  maxRepairAttempts?: number;
  /**
   * Base delay before the SECOND and later consecutive non-progressing repairs,
   * doubling per attempt and capped at `MAX_REPAIR_BACKOFF_FACTOR` times this
   * value; the curve is protocol's `repairBackoffMs`, not a second copy of it.
   * Defaults to protocol's `DEFAULT_REPAIR_DELAY_MS`. A construction input,
   * like `coveredThrough` and for the same reason. The first repair after progress
   * uses a zero delay — but still a real timer, because the macrotask is the
   * point: it is what turns a burst of frames arriving in one turn into one
   * read rather than one read each.
   */
  repairDelayMs?: number;
  /**
   * The bounds on ONE captured tail's continuation walk, defaulting to
   * protocol's. Construction inputs, like `coveredThrough` and for the same
   * reason: a capture is walked whole or refused, so changing a ceiling
   * mid-capture would describe neither the walk in flight nor the one before
   * it. `maxTailPages` counts the capturing `tail` read itself, so `1` admits
   * no continuation at all.
   */
  maxTailPages?: number;
  maxTailEvents?: number;
  maxTailBytes?: number;
  /**
   * Base delay, in milliseconds, before re-reading the gate page while it
   * cannot be trusted to be current. Default `DEFAULT_GATE_REFRESH_MS`. A
   * construction input.
   *
   * A gate's answerability is attested ONLY by the gate page, and it changes
   * with no journal event: a gate reads `unavailable` while its session has no
   * live owner (a Host failover, a warm release) and `resident` again once a
   * Host holds it — and since harness v0.39.0 an open gate SURVIVES that
   * failover. Likewise a gate opened live is unattested until a page names it.
   * Without a re-read the card would keep whichever answer the last page gave
   * until the next realtime repair. The view therefore re-reads the page while
   * any gate is `suspended`/`submitted`/`unavailable`, or a `GateOpened` is
   * newer than the page, backing off (doubling, capped at eight times this) while
   * nothing changes.
   */
  gateRefreshMs?: number;
}

/** See `FactorySessionViewOptions.gateRefreshMs`. */
export const DEFAULT_GATE_REFRESH_MS = 1000;
const MAX_GATE_REFRESH_FACTOR = 8;
/** Answerability values a later page may change without any journal event. */
const TRANSIENT_ANSWERABILITY: ReadonlySet<string> = new Set(["suspended", "submitted", "unavailable"]);

/**
 * Whether the gate page may be stale in a way only another page read can fix:
 * a gate whose answerability is transient, or a gate the journal shows OPEN
 * (a `GateOpened` with no later `GateResolved`) that the page does not list.
 *
 * The comparison is by gate id, not by the page's `journal_tip`: for a Host
 * session Factory reads the gate page's tip from the catalog, which keeps no
 * journal tip (it reads 0), so "opened after the page" cannot be told from the
 * sequence.
 */
export function gatePageNeedsRefresh(gates: PublicGatePage | null, events: readonly PublicJournalEvent[]): boolean {
  if (gates === null) return false;
  const listed = new Set<string>();
  const records: unknown = (gates as unknown as Record<string, unknown>)["gates"];
  if (Array.isArray(records)) {
    for (const record of records) {
      if (typeof record !== "object" || record === null) continue;
      const entry = record as Record<string, unknown>;
      if (typeof entry["gate_id"] === "string") listed.add(entry["gate_id"]);
      const answerability = entry["answerability"];
      if (typeof answerability === "string" && TRANSIENT_ANSWERABILITY.has(answerability)) return true;
    }
  }
  const open = new Set<string>();
  for (const event of events) {
    const body = event.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) continue;
    const raw = body as Record<string, unknown>;
    if (raw["type"] === "GateOpened") {
      const gate = raw["gate"];
      const id = typeof gate === "object" && gate !== null ? (gate as Record<string, unknown>)["id"] : undefined;
      if (typeof id === "string" && id !== "") open.add(id);
    } else if (raw["type"] === "GateResolved" && typeof raw["gate_id"] === "string") {
      open.delete(raw["gate_id"]);
    }
  }
  for (const id of open) if (!listed.has(id)) return true;
  return false;
}

export interface UseFactorySessionViewResult {
  readonly state: FactorySessionViewState;
  /** Realtime progress is independent of whether a durable snapshot is ready. */
  readonly liveState: "joining" | "repairing" | "live" | "failed";
  /** The durable session/residency projection, or null before the first read. */
  readonly status: FactorySessionStatus | null;
  /** The bounded public gate projection, or null before the first read. */
  readonly gates: PublicGatePage | null;
  /** Current cold/live events plus one replaceable earlier page, ascending by `journal_seq`. */
  readonly events: readonly PublicJournalEvent[];
  /** Uncommitted assistant text from this join generation. */
  readonly liveText: readonly { readonly loopId: string; readonly turnId: string; readonly text: string }[];
  /** Uncommitted assistant reasoning from this join generation. */
  readonly liveReasoning: readonly { readonly loopId: string; readonly turnId: string; readonly text: string }[];
  /** Greatest sequence this view has covered, from a page or a publication. */
  readonly coveredThrough: number;
  /** The last error seen, from a cold read or from the binding. */
  readonly error: Error | null;
  /** State of the explicit, one-request-per-action beginning-first history walk. */
  readonly earlierState: "idle" | "loading" | "available" | "complete" | "failed";
  /** Reads at most one bounded page. The first call has neither cursor nor tail. */
  readonly browseEarlier: () => Promise<void>;
}

/**
 * The bounds and the backoff schedule come from `@looprig/client`, which is a
 * workspace package here rather than a pinned dependency. Retyping the four
 * numbers and the curve let this file and `joinFactorySessionView` drift in
 * either direction with nothing failing; importing them makes the drift
 * impossible instead of merely tested for.
 */

type FactorySessionViewSnapshot = Omit<UseFactorySessionViewResult, "browseEarlier">;

// Earlier history has its own finite retention policy: one requested page,
// independently capped at the same conservative encoded-event ceiling used by
// a default captured tail. This does not claim to bound the separate current
// cold/live event map.
//
// `#currentEvents` really is unbounded, and the reason it is not simply capped
// here is a missing CLIENT capability rather than a missing wire one. A
// bounded BACKWARD page genuinely does not exist: Core's `previous_cursor`
// (`sessionwire/v1/queries.go`) and this repo's own
// `public_journal_page.schema.json` declare the field, but neither `factory`
// nor `sessionstore` ever sets it (runbook 06 U2.1 step 7 asks for one; it is
// unimplemented). That much is real.
//
// But Factory already serves a bounded FORWARD page positioned at an
// arbitrary sequence — `GET .../journal?from_seq=N&limit=M`
// (`factory/internal/httpapi/sessions.go`, `journalPositionOf` and the
// `ReadPublicJournal` call it feeds; exercised in `sessions_test.go` and
// backed by `sessionstore.ReadPublicJournalRequest.FromSeq`). So an evicted
// middle would be reachable in one bounded request, not by replay from
// sequence zero — `FactoryJournalOptions` here just doesn't plumb `from_seq`
// yet (it only carries `cursor`, `limit` and `tail`). Adding that plumbing,
// plus an eviction policy for this map, is a reasonable follow-up; it is
// simply not done here. It does not need a backward page first.
const MAX_EARLIER_PAGE_BYTES = DEFAULT_MAX_TAIL_BYTES;
// Text and reasoning share one cap so adding a second preview cannot double memory use.
const MAX_LIVE_PREVIEW_BYTES = 65_536;
const MAX_LIVE_PREVIEW_KEYS = 16;
const MAX_LIVE_PREVIEW_TOMBSTONES = 256;
const earlierPageEncoder = new TextEncoder();

const COLD: Omit<FactorySessionViewSnapshot, "coveredThrough"> = {
  state: "joining",
  liveState: "joining",
  status: null,
  gates: null,
  events: [],
  liveText: [],
  liveReasoning: [],
  error: null,
  earlierState: "idle",
};

/**
 * REST can render a cold snapshot before realtime is available. Once authorized,
 * the protocol join is the sole owner of live ordering, buffering and repair.
 * The cold capture is never used as that join's starting cursor: events produced
 * between its capture and authorization must still be reconciled.
 */
class FactoryColdJoin extends Publisher<FactorySessionViewSnapshot> {
  readonly #currentEvents = new Map<number, PublicJournalEvent>();
  readonly #liveText = new Map<string, { loopId: string; turnId: string; text: string; bytes: number }>();
  readonly #liveReasoning = new Map<string, { loopId: string; turnId: string; text: string; bytes: number }>();
  #livePreviewBytes = 0;
  readonly #endedTurns = new Set<string>();
  readonly #suppressedLiveKeys = new Set<string>();
  #sessionStopped = false;
  #joinGeneration = 0;
  #cancelLiveFrame: (() => void) | undefined;
  readonly #earlierEvents = new Map<number, PublicJournalEvent>();
  #controller: AbortController | undefined;
  #coldController: AbortController | undefined;
  #generation = 0;
  #earlierCursor: string | undefined;
  #earlierStarted = false;
  #earlierController: AbortController | undefined;
  #earlierInFlight: Promise<void> | undefined;
  #gateTimer: ReturnType<typeof setTimeout> | undefined;
  #gateController: AbortController | undefined;
  #gateIdleRefreshes = 0;
  /**
   * The newest gate page any path has read. Two paths read it — each realtime
   * generation's status read and the refresh below — so each read takes a
   * ticket when it STARTS and a page is adopted only over an older ticket: a
   * slow read can never replace the answer a later one already gave.
   */
  #gates: PublicGatePage | null = null;
  #gateTickets = 0;
  #adoptedGateTicket = 0;

  constructor(
    readonly tenantId: string,
    readonly sessionId: string,
    readonly initialCoveredThrough: number,
    readonly reads: () => FactoryColdReads,
    readonly tailLimit: number,
    readonly maxRepairAttempts: number,
    readonly repairDelayMs: number,
    readonly tailBounds: Omit<CapturedTailBounds, "pageLimit">,
    readonly link: FactoryLinkStore,
    readonly gateRefreshMs: number = DEFAULT_GATE_REFRESH_MS,
  ) {
    super({ ...COLD, coveredThrough: initialCoveredThrough });
  }

  /**
   * Every snapshot change passes through here so the gate re-read is scheduled
   * from what was actually published — one place, rather than a call after
   * each of the dozen publish sites that could leave the page stale.
   */
  protected override publish(patch: Partial<FactorySessionViewSnapshot>): void {
    super.publish(patch);
    this.#scheduleGateRefresh();
  }

  #scheduleGateRefresh(): void {
    if (this.#gateTimer !== undefined || this.#gateController !== undefined) return;
    const snapshot = this.snapshot();
    if (snapshot.state === "failed" && snapshot.status === null) return;
    if (!gatePageNeedsRefresh(snapshot.gates, snapshot.events)) {
      this.#gateIdleRefreshes = 0;
      return;
    }
    const controller = this.#controller;
    if (controller === undefined || controller.signal.aborted) return;
    const generation = this.#generation;
    const delay = this.gateRefreshMs * Math.min(2 ** this.#gateIdleRefreshes, MAX_GATE_REFRESH_FACTOR);
    this.#gateTimer = setTimeout(() => {
      this.#gateTimer = undefined;
      void this.#refreshGates(generation, controller.signal);
    }, delay);
  }

  async #refreshGates(generation: number, parent: AbortSignal): Promise<void> {
    if (!this.#current(generation, parent)) return;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    this.#gateController = controller;
    let changed = false;
    const ticket = ++this.#gateTickets;
    try {
      const page = validateFactory(
        "public_gate_page",
        await this.reads().listGates(this.sessionId, { limit: this.tailLimit, signal: controller.signal }),
      );
      if (!this.#current(generation, parent)) return;
      changed = this.#adoptGates(ticket, page)
        && JSON.stringify(page) !== JSON.stringify(this.snapshot().gates);
      this.#gateIdleRefreshes = changed ? 0 : this.#gateIdleRefreshes + 1;
      this.#gateController = undefined;
      if (changed) this.publish({ gates: page });
    } catch (cause) {
      if (this.#rejectAccess(cause, generation, parent)) return;
      // A transient read failure keeps the last page and backs off.
      this.#gateIdleRefreshes += 1;
    } finally {
      parent.removeEventListener("abort", abort);
      this.#gateController = undefined;
      controller.abort();
    }
    if (!changed) this.#scheduleGateRefresh();
  }

  start(): void {
    const controller = new AbortController();
    const cold = new AbortController();
    this.#controller = controller;
    this.#coldController = cold;
    const generation = ++this.#generation;
    this.publish({ state: "reading" });
    void this.#readCold(generation, cold);
    void this.#follow(generation, controller);
  }

  /** Adopts `page` unless a read that started later was already adopted. */
  #adoptGates(ticket: number, page: PublicGatePage): boolean {
    if (ticket < this.#adoptedGateTicket) return false;
    this.#adoptedGateTicket = ticket;
    this.#gates = page;
    return true;
  }

  stop(): void {
    ++this.#generation;
    this.#controller?.abort();
    this.#coldController?.abort();
    this.#earlierController?.abort();
    this.#gateController?.abort();
    if (this.#gateTimer !== undefined) clearTimeout(this.#gateTimer);
    this.#gateTimer = undefined;
    this.#resetLivePreviews();
  }

  browseEarlier(): Promise<void> {
    if (this.#earlierInFlight !== undefined) return this.#earlierInFlight;
    if (this.snapshot().earlierState === "complete") return Promise.resolve();
    const controller = new AbortController();
    this.#earlierController?.abort();
    this.#earlierController = controller;
    const generation = this.#generation;
    const cursor = this.#earlierCursor;
    const started = this.#earlierStarted;
    this.publish({ earlierState: "loading", error: null });
    const read = this.#readEarlier(generation, controller, started, cursor);
    this.#earlierInFlight = read;
    void read.finally(() => {
      if (this.#earlierInFlight === read) this.#earlierInFlight = undefined;
    });
    return read;
  }

  async #readEarlier(
    generation: number,
    controller: AbortController,
    started: boolean,
    cursor: string | undefined,
  ): Promise<void> {
    const signal = controller.signal;
    try {
      const options: FactoryJournalOptions = { limit: this.tailLimit, signal };
      if (started && cursor !== undefined) options.cursor = cursor;
      let raw: PublicJournalPage;
      try {
        raw = await this.reads().readJournal(this.sessionId, options);
      } catch (cause) {
        // A cursor Factory no longer honours — minted before a Factory upgrade
        // or a re-bind — is answered 400 and means "restart the walk". Keeping
        // it would fail every later click the same way, so the walk restarts
        // from the beginning, once, in this same request.
        if (options.cursor === undefined || !isRejectedJournalCursor(cause) || !this.#current(generation, signal)) {
          throw cause;
        }
        this.#earlierEvents.clear();
        this.#earlierCursor = undefined;
        this.#earlierStarted = false;
        raw = await this.reads().readJournal(this.sessionId, { limit: this.tailLimit, signal });
      }
      const page = validateFactory("public_journal_page", raw);
      if (!this.#current(generation, signal)) return;
      if (page.events.length > this.tailLimit) {
        throw new Error(`factory earlier history event budget exceeded (${this.tailLimit})`);
      }
      const pageBytes = earlierPageEncoder.encode(JSON.stringify(page.events)).length;
      if (pageBytes > MAX_EARLIER_PAGE_BYTES) {
        throw new Error(`factory earlier history byte budget exceeded (${MAX_EARLIER_PAGE_BYTES})`);
      }
      // Explicit history is a bounded viewing window, not a second replay
      // engine. Advancing the opaque cursor replaces the prior older page;
      // current cold/live events stay independently retained.
      this.#earlierEvents.clear();
      for (const event of page.events) this.#earlierEvents.set(event.journal_seq, event);
      this.#earlierStarted = true;
      this.#earlierCursor = page.next_cursor;
      this.publish({
        events: this.#ordered(),
        earlierState: page.next_cursor === undefined ? "complete" : "available",
        error: null,
      });
    } catch (cause) {
      if (this.#rejectAccess(cause, generation, signal)) return;
      if (this.#current(generation, signal)) {
        this.publish({ earlierState: "failed", error: asError(cause) });
      }
    } finally {
      controller.abort();
    }
  }

  #current(generation: number, signal: AbortSignal): boolean {
    return generation === this.#generation && !signal.aborted;
  }

  #rejectAccess(cause: unknown, generation: number, signal: AbortSignal): boolean {
    if (!this.#current(generation, signal) || !(cause instanceof CoreProtocolError)
      || (cause.code !== "unauthenticated" && cause.code !== "not_authorized"
        && cause.code !== "session_not_found")) return false;
    // These are Factory's authoritative scope-invalidating decisions. A
    // verifier outage uses a different code and does not revoke cached state;
    // deletion does, because retaining its projection would render a session
    // Factory has authoritatively said no longer exists.
    this.#currentEvents.clear();
    this.#resetEarlier();
    this.#gates = null;
    this.#resetLivePreviews(false);
    this.publish({
      state: "failed", liveState: "failed", status: null, gates: null,
      events: [], liveText: [], liveReasoning: [], coveredThrough: 0, error: cause, earlierState: "idle",
    });
    this.stop();
    return true;
  }

  async #readCold(generation: number, controller: AbortController): Promise<void> {
    const reads = this.reads();
    const limit = this.tailLimit;
    const signal = controller.signal;
    const gateTicket = ++this.#gateTickets;
    try {
      const [status, gates, page] = await Promise.all([
        reads.readStatus(this.sessionId, { signal }),
        reads.listGates(this.sessionId, { limit, signal }),
        reads.readJournal(this.sessionId, { tail: limit, limit, signal }),
      ]);
      if (!this.#current(generation, signal)) return;
      const gatePage = validateFactory("public_gate_page", gates);
      let tail = new CapturedTail(validateFactory("public_journal_page", page), { ...this.tailBounds, pageLimit: limit });
      // The page is the authority on the journal tip (a Host session's
      // /status reads 0): see protocol's `withJournalTip`.
      let projection = withJournalTip(validateFactory("session_status", status), tail.tip);
      if (projection.session_id !== this.sessionId) {
        throw new Error("factory cold projection names another session");
      }
      let step = tail.step;
      let restarted = false;
      while (step.kind === "continue") {
        let next: PublicJournalPage;
        try {
          next = await reads.readJournal(this.sessionId, { cursor: step.cursor, limit, signal });
        } catch (cause) {
          // The continuation cursor was refused (400: "restart the walk").
          // Recapture once from a fresh tail; a second refusal is a real fault.
          if (restarted || !isRejectedJournalCursor(cause) || !this.#current(generation, signal)) throw cause;
          restarted = true;
          const [again, fresh] = await Promise.all([
            reads.readStatus(this.sessionId, { signal }),
            reads.readJournal(this.sessionId, { tail: limit, limit, signal }),
          ]);
          if (!this.#current(generation, signal)) return;
          tail = new CapturedTail(validateFactory("public_journal_page", fresh), { ...this.tailBounds, pageLimit: limit });
          projection = withJournalTip(validateFactory("session_status", again), tail.tip);
          if (projection.session_id !== this.sessionId) {
            throw new Error("factory cold projection names another session");
          }
          step = tail.step;
          continue;
        }
        if (!this.#current(generation, signal)) return;
        step = tail.accept(validateFactory("public_journal_page", next));
      }
      const captured = tail.result;
      if (captured === undefined) {
        throw new Error(`factory captured tail refused (${step.kind === "refused" ? step.reason : step.kind}) before reaching journal_tip ${tail.tip}`);
      }
      for (const event of captured.events) this.#currentEvents.set(event.journal_seq, event);
      this.#adoptGates(gateTicket, gatePage);
      this.publish({
        state: "ready", status: projection, gates: this.#gates, events: this.#ordered(),
        coveredThrough: Math.max(this.initialCoveredThrough, captured.coveredThrough), error: null,
      });
    } catch (cause) {
      if (this.#rejectAccess(cause, generation, signal)) return;
      if (this.#current(generation, signal)) this.publish({ state: "failed", error: asError(cause) });
    } finally {
      controller.abort();
    }
  }

  async #follow(generation: number, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    let statusGeneration = 0;
    let liveCoverage = this.initialCoveredThrough;
    let projected = false;
    let subscriptions = 0;
    const liveReads = {
      readStatus: async (sessionId: string, options?: RequestOptions): Promise<FactorySessionStatus> => {
        // This seam is reached only after the protocol has awaited authorization.
        // Cancel an initial REST read that has not yet committed.
        this.#coldController?.abort();
        const currentStatus = ++statusGeneration;
        const gateTicket = ++this.#gateTickets;
        const reads = this.reads();
        const [status, page] = await Promise.all([
          reads.readStatus(sessionId, options),
          reads.listGates(sessionId, { ...options, limit: this.tailLimit }),
        ]).catch((cause: unknown) => {
          if (!options?.signal?.aborted) this.#rejectAccess(cause, generation, signal);
          throw cause;
        });
        if (currentStatus === statusGeneration && !options?.signal?.aborted && this.#current(generation, signal)) {
          this.#adoptGates(gateTicket, validateFactory("public_gate_page", page));
        }
        return status;
      },
      readJournal: (sessionId: string, options?: FactoryJournalOptions) =>
        this.reads().readJournal(sessionId, options).catch((cause: unknown) => {
          if (!options?.signal?.aborted) this.#rejectAccess(cause, generation, signal);
          throw cause;
        }),
    };
    try {
      for await (const event of joinFactorySessionView(
        liveReads,
        { subscribe: (options) => {
          this.#resetLivePreviews(false);
          this.publish({ liveState: subscriptions++ === 0 ? "joining" : "repairing", liveText: [], liveReasoning: [] });
          return this.link.bindSubscription(options);
        } },
        this.tenantId,
        this.sessionId,
        {
          initialCoveredThrough: this.initialCoveredThrough,
          tailLimit: this.tailLimit,
          maxRepairAttempts: this.maxRepairAttempts,
          repairDelayMs: this.repairDelayMs,
          maxTailPages: this.tailBounds.maxPages,
          maxTailEvents: this.tailBounds.maxEvents,
          maxTailBytes: this.tailBounds.maxBytes,
          signal,
        },
      )) {
        if (!this.#current(generation, signal)) return;
        if (event.generation !== this.#joinGeneration) {
          const hadPreview = this.snapshot().liveText.length > 0 || this.snapshot().liveReasoning.length > 0;
          this.#resetLivePreviews(false);
          this.#joinGeneration = event.generation;
          if (hadPreview && event.kind === "ephemeral") this.#scheduleLiveFrame(generation, signal);
        }
        if (event.kind === "ephemeral") {
          const delta = decodeFactoryLiveDelta(event.publication.body, this.sessionId);
          if (delta !== null && !this.#sessionStopped) {
            const key = `${delta.loopId}:${delta.turnId}`;
            const suppressionKey = `${delta.kind}:${key}`;
            if (this.#endedTurns.has(key) || this.#suppressedLiveKeys.has(suppressionKey)) continue;
            const previews = delta.kind === "text" ? this.#liveText : this.#liveReasoning;
            const prior = previews.get(key);
            if ("rejected" in delta) {
              this.#remember(this.#suppressedLiveKeys, suppressionKey);
            } else {
              const chunkBytes = earlierPageEncoder.encode(delta.text).byteLength;
              const previousLast = prior?.text.charCodeAt(prior.text.length - 1);
              const nextFirst = delta.text.charCodeAt(0);
              const joinedSurrogate = previousLast !== undefined && previousLast >= 0xd800 && previousLast <= 0xdbff
                && nextFirst >= 0xdc00 && nextFirst <= 0xdfff;
              const addedBytes = chunkBytes - (joinedSurrogate ? 2 : 0);
              if (this.#livePreviewBytes + addedBytes > MAX_LIVE_PREVIEW_BYTES
                || (prior === undefined && this.#liveText.size + this.#liveReasoning.size >= MAX_LIVE_PREVIEW_KEYS)) {
                this.#remember(this.#suppressedLiveKeys, suppressionKey);
              } else {
                previews.set(key, {
                  loopId: delta.loopId, turnId: delta.turnId,
                  text: (prior?.text ?? "") + delta.text, bytes: (prior?.bytes ?? 0) + addedBytes,
                });
                this.#livePreviewBytes += addedBytes;
                this.#scheduleLiveFrame(generation, signal);
              }
            }
          }
          continue;
        }
        let earlierReset = false;
        if (event.kind === "projection") {
          this.#resetLivePreviews(false);
          // A lower committed floor is a protocol-validated reset. Remove rows
          // the server no longer holds before admitting this generation's tail.
          const lowered = projected
            ? event.coveredThrough < liveCoverage
            : event.status.journal_tip < this.snapshot().coveredThrough;
          const ceiling = projected && lowered
            ? event.coveredThrough : event.status.journal_tip;
          for (const sequence of this.#currentEvents.keys()) {
            if (sequence > ceiling) this.#currentEvents.delete(sequence);
          }
          if (lowered) {
            this.#resetEarlier();
            earlierReset = true;
          }
          projected = true;
        } else if (event.kind === "public") {
          this.#currentEvents.set(event.event.journal_seq, event.event);
          this.#reconcileLivePreviews(event.event.body);
        }
        liveCoverage = event.coveredThrough;
        this.publish({
          state: "ready", status: event.status, gates: this.#gates,
          liveState: event.coveredThrough >= event.status.journal_tip ? "live" : "repairing",
          events: this.#ordered(), coveredThrough: event.coveredThrough, error: null,
          liveText: this.#visibleLiveText(),
          liveReasoning: this.#visibleLiveReasoning(),
          ...(earlierReset ? { earlierState: "idle" as const } : {}),
        });
      }
    } catch (cause) {
      if (this.#current(generation, signal)) {
        // A durable snapshot remains useful during a transport repair failure.
        this.#resetLivePreviews(false);
        this.publish({ state: this.snapshot().status === null ? "failed" : "ready", liveState: "failed", liveText: [], liveReasoning: [], error: asError(cause) });
      }
    }
  }

  #visibleLiveText(): FactorySessionViewSnapshot["liveText"] {
    return [...this.#liveText.values()].map(({ loopId, turnId, text }) => ({ loopId, turnId, text }));
  }

  #visibleLiveReasoning(): FactorySessionViewSnapshot["liveReasoning"] {
    return [...this.#liveReasoning.values()].map(({ loopId, turnId, text }) => ({ loopId, turnId, text }));
  }

  #scheduleLiveFrame(generation: number, signal: AbortSignal): void {
    if (this.#cancelLiveFrame !== undefined) return;
    const flush = (): void => {
      this.#cancelLiveFrame = undefined;
      if (this.#current(generation, signal)) this.publish({
        liveText: this.#visibleLiveText(), liveReasoning: this.#visibleLiveReasoning(),
      });
    };
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(flush);
      this.#cancelLiveFrame = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(flush, 16);
      this.#cancelLiveFrame = () => clearTimeout(timer);
    }
  }

  #deleteLiveTurn(key: string): void {
    for (const previews of [this.#liveText, this.#liveReasoning]) {
      const item = previews.get(key);
      if (item !== undefined) {
        this.#livePreviewBytes -= item.bytes;
        previews.delete(key);
      }
    }
  }

  #remember(set: Set<string>, key: string): void {
    set.add(key);
    if (set.size > MAX_LIVE_PREVIEW_TOMBSTONES) {
      const evict = [...set].find((candidate) => {
        if (set !== this.#suppressedLiveKeys) return true;
        const previews = candidate.startsWith("text:") ? this.#liveText : this.#liveReasoning;
        return !previews.has(candidate.slice(candidate.indexOf(":") + 1));
      });
      if (evict !== undefined) set.delete(evict);
    }
  }

  #resetLivePreviews(publish = true): void {
    const visible = this.snapshot().liveText.length > 0 || this.snapshot().liveReasoning.length > 0;
    this.#liveText.clear();
    this.#liveReasoning.clear();
    this.#livePreviewBytes = 0;
    this.#endedTurns.clear();
    this.#suppressedLiveKeys.clear();
    this.#sessionStopped = false;
    this.#joinGeneration = 0;
    this.#cancelLiveFrame?.();
    this.#cancelLiveFrame = undefined;
    if (publish && visible) this.publish({ liveText: [], liveReasoning: [] });
  }

  #reconcileLivePreviews(body: unknown): void {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return;
    const value = body as Record<string, unknown>;
    if (value["type"] === "SessionStopped") {
      this.#liveText.clear();
      this.#liveReasoning.clear();
      this.#livePreviewBytes = 0;
      this.#sessionStopped = true;
    } else if (value["type"] === "StepDone" && typeof value["loop_id"] === "string") {
      for (const [key, item] of this.#liveText) if (item.loopId === value["loop_id"]) this.#deleteLiveTurn(key);
      for (const [key, item] of this.#liveReasoning) if (item.loopId === value["loop_id"]) this.#deleteLiveTurn(key);
      for (const key of this.#suppressedLiveKeys) if (key.includes(`:${value["loop_id"]}:`)) this.#suppressedLiveKeys.delete(key);
    } else if (value["type"] === "TurnStarted") {
      this.#sessionStopped = false;
      if (typeof value["loop_id"] === "string") {
        for (const key of this.#endedTurns) if (key.startsWith(`${value["loop_id"]}:`)) this.#endedTurns.delete(key);
      }
    } else if (value["type"] === "SessionStarted" || value["type"] === "RestoreDone") {
      this.#sessionStopped = false;
    } else if ((value["type"] === "TurnDone" || value["type"] === "TurnFailed"
      || value["type"] === "TurnInterrupted")
      && typeof value["loop_id"] === "string" && typeof value["turn_id"] === "string") {
      const key = `${value["loop_id"]}:${value["turn_id"]}`;
      this.#deleteLiveTurn(key);
      this.#remember(this.#endedTurns, key);
    } else return;
    this.#cancelLiveFrame?.();
    this.#cancelLiveFrame = undefined;
  }

  #ordered(): readonly PublicJournalEvent[] {
    const merged = new Map(this.#earlierEvents);
    for (const [sequence, event] of this.#currentEvents) merged.set(sequence, event);
    return [...merged.values()].sort((left, right) => left.journal_seq - right.journal_seq);
  }

  #resetEarlier(): void {
    this.#earlierController?.abort();
    this.#earlierController = undefined;
    this.#earlierEvents.clear();
    this.#earlierCursor = undefined;
    this.#earlierStarted = false;
  }
}
function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function safeSequence(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Opens one session's durable view over the application's Factory link.
 *
 * Opening a view is a READ. This hook subscribes, reads status, the public gate
 * projection and a bounded tail, and reconciles them; it sends nothing. That is
 * the whole difference from the `useAttachOrRestore` it replaces, which made a
 * `POST /restore` the precondition of rendering anything at all — so merely
 * looking at a cold session placed it, and a list of ten sessions was ten
 * placements away from being browsable.
 *
 * Placement is a consequence of a COMMAND. `FactoryClient.commands` is where
 * one is sent, from an explicit user action, and `use-connection.ts`'s
 * `useFactoryClient` is how a component reaches it.
 *
 * The read implementation is forwarded through a ref so a caller composing
 * an inline three-method object does not restart the join on every render.
 */
export function useFactorySessionView(
  reads: FactoryColdReads,
  options: FactorySessionViewOptions,
): UseFactorySessionViewResult {
  const { tenantId, sessionId } = options;
  const link = useFactoryLink();
  // Validated exactly where `joinFactorySessionView` validates its own, and
  // with its messages: a `maxRepairAttempts` of 0 silently means "give up on
  // the first repair and never read again", a `NaN` delay becomes a zero one,
  // and a `tailLimit` of 0 issues `limit=0` reads. A bound that is not a bound
  // is a programming error, and it is cheaper to fail on it than to serve it.
  const tailLimit = positiveBound(options.tailLimit ?? DEFAULT_FACTORY_TAIL_LIMIT, "tailLimit");
  const maxRepairAttempts = positiveBound(
    options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
    "maxRepairAttempts",
  );
  const repairDelayMs = safeSequence(options.repairDelayMs ?? DEFAULT_REPAIR_DELAY_MS, "repairDelayMs");
  const coveredThrough = safeSequence(options.coveredThrough ?? 0, "coveredThrough");
  const maxTailPages = positiveBound(options.maxTailPages ?? DEFAULT_MAX_TAIL_PAGES, "maxTailPages");
  const maxTailEvents = positiveBound(options.maxTailEvents ?? DEFAULT_MAX_TAIL_EVENTS, "maxTailEvents");
  const maxTailBytes = positiveBound(options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES, "maxTailBytes");
  const gateRefreshMs = positiveBound(options.gateRefreshMs ?? DEFAULT_GATE_REFRESH_MS, "gateRefreshMs");

  const readsRef = useRef(reads);
  // Only the read implementation is refreshed after each committed render.
  useEffect(() => {
    readsRef.current = reads;
  });

  // Cursor and bounds belong to one scoped view. Read the current render's
  // inputs on a tenant/session/link change, never a previous session's cursor.
  // Changing a bound alone does not restart an in-flight captured-tail walk.
  const machine = useMemo(
    () =>
      new FactoryColdJoin(
        tenantId,
        sessionId,
        coveredThrough,
        () => readsRef.current,
        tailLimit,
        maxRepairAttempts,
        repairDelayMs,
        { maxPages: maxTailPages, maxEvents: maxTailEvents, maxBytes: maxTailBytes },
        link,
        gateRefreshMs,
      ),
    // Safe to double-invoke and discard in StrictMode: the constructor opens
    // nothing and issues no read. Everything starts from an effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [tenantId, sessionId, link],
  );

  useEffect(() => {
    machine.start();
    return () => {
      machine.stop();
    };
  }, [machine]);

  const snapshot = useStore(machine);
  const browseEarlier = useCallback(() => machine.browseEarlier(), [machine]);
  return useMemo(() => ({ ...snapshot, browseEarlier }), [snapshot, browseEarlier]);
}
