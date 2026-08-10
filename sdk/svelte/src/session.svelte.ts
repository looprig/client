/**
 * Svelte 5 reactivity wrappers over `@looprig/client` (sdk/core)'s read-plane
 * transport methods (`LooprigTransport.listSessions` / `.readStatus` /
 * `.readHistory` — see sdk/core/src/transport.ts). This package owns ONLY the
 * reactive-wrapper layer: each store below calls straight into a
 * `LooprigTransport` it's handed and republishes the result as `$state`, with
 * no parsing, validation, or protocol-shape logic of its own (that already
 * happened inside the transport call, via sdk/core's ajv validators).
 *
 * sdk/core's cold reads (Phase 1a): a page of session summaries, one
 * session's projected status, and a page of a session's durable event
 * journal. The stores below wrap exactly those three one-shot calls.
 *
 * The live/streaming counterpart — driving sdk/core's `joinSessionView`
 * (join.ts, Phase 1c) and republishing its ongoing `SessionView` updates —
 * lives alongside these in `live-session.svelte.ts`, as `LiveSessionViewStore`,
 * not in this file: a live join is an ONGOING SUBSCRIPTION (start/stop
 * lifecycle), not a single request/response `refresh()` call, so it doesn't
 * fit this file's shared `RefreshGuard` pattern — see that file's own module
 * comment for the full reasoning.
 *
 * A note on `npm run build`: `tsc` alone does NOT compile rune syntax —
 * `$state(...)`/`$derived(...)` are Svelte-compiler intrinsics, not real
 * runtime functions, so `tsc -p tsconfig.json`'s emitted `dist/*.js` still
 * contains the literal (uncompiled) rune calls and is not directly
 * executable on its own; running it outside a Svelte-aware bundler throws
 * `ReferenceError: $state is not defined` (verified empirically — see the
 * package's build note in package.json's sibling docs / task report). The
 * `build` script exists for the same reason sdk/core's does — a
 * type-declaration (`.d.ts`) emit and a consistent `npm run build -w
 * <pkg>` convention across the workspace — not to produce a
 * directly-runnable artifact. Real consumption of this package (a future
 * task's concern) should resolve to *this source*, letting the consuming
 * app's own Vite + `@sveltejs/vite-plugin-svelte` pipeline (already present
 * for `app/`) compile the runes, exactly like every other `.svelte.ts` file
 * in that app. This mirrors how Svelte 5 component libraries are normally
 * shipped (raw `.svelte`/`.svelte.ts` source, compiled by the consumer's own
 * Svelte version) rather than pre-compiled — `@sveltejs/package`, the
 * official tool for pre-compiling a publishable Svelte library, is not in
 * this repo's approved-dependency list and was deliberately not added for
 * this task.
 */
import type {
  EventJournalPage,
  ListSessionsOptions,
  LooprigTransport,
  ReadHistoryOptions,
  RequestOptions,
  SessionList,
  SessionStatus,
  SessionSummary,
  StatusEvent,
} from "@looprig/client";

/**
 * Tracks overlapping `refresh()` calls for one store instance so that, if
 * responses resolve out of order (a double-click, a re-firing `$effect`,
 * rapid paging), only the LAST-STARTED call's result is ever committed to
 * `$state` — an earlier call's now-stale response is discarded rather than
 * clobbering a fresher one. Shared by all three stores below since each
 * follows the identical "start a generation, await the transport call,
 * commit only if this generation is still current" shape.
 */
class RefreshGuard {
  private generation = 0;

  /**
   * Begins a new call, superseding any earlier one still in flight. Returns
   * this call's generation number — pass it to `isCurrent()` once the
   * awaited transport call resolves, to decide whether to commit.
   */
  start(): number {
    this.generation += 1;
    return this.generation;
  }

  /** True if `generation` is still the most recently started call, i.e. no newer `refresh()` has begun since. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}

/**
 * Reactive wrapper over `LooprigTransport.listSessions`: a page of session
 * summaries plus the paging cursor (`skip`/`limit`/`nextSkip`/`done`, mirrored
 * from `SessionList` — see sdk/core's `session_list.schema.json`), exposed as
 * Svelte state. Every field resets to its default at the start of a
 * `refresh()` call: `loading` flips true, `error` clears; on success the page
 * fields populate and `loading` flips false; on failure `error` is set (with
 * the previous `sessions`/paging fields left untouched — a failed refresh
 * doesn't discard already-displayed data) and `loading` still flips false.
 *
 * No subscription, timer, or effect is created anywhere in this class, so
 * there is nothing to unsubscribe or tear down: `refresh()` is a plain async
 * method a consumer calls (e.g. from a component's `$effect` or an event
 * handler), and the last call's result — or in-flight state — is all that's
 * ever live.
 *
 * `refresh()` calls may overlap (e.g. a double-click, a re-firing `$effect`,
 * rapid paging). A `RefreshGuard` ensures that if responses arrive out of
 * order, only the LAST-STARTED call's result is committed: a stale response
 * is discarded silently, and `loading` stays `true` until the latest call
 * settles rather than flipping `false` when a superseded call finishes.
 */
export class SessionListStore {
  sessions = $state<SessionSummary[]>([]);
  skip = $state(0);
  limit = $state(0);
  nextSkip = $state(0);
  done = $state(false);
  loading = $state(false);
  error = $state<Error | null>(null);

  private readonly guard = new RefreshGuard();

  constructor(private readonly transport: LooprigTransport) {}

  /** Issues `listSessions(options)` and republishes the page as state — unless a newer `refresh()` call has since superseded this one. */
  async refresh(options?: ListSessionsOptions): Promise<void> {
    const generation = this.guard.start();
    this.loading = true;
    this.error = null;
    try {
      const page: SessionList = await this.transport.listSessions(options);
      if (!this.guard.isCurrent(generation)) return;
      this.sessions = page.sessions;
      this.skip = page.skip;
      this.limit = page.limit;
      this.nextSkip = page.next_skip;
      this.done = page.done;
      this.loading = false;
    } catch (err) {
      if (!this.guard.isCurrent(generation)) return;
      this.error = asError(err);
      this.loading = false;
    }
  }
}

/**
 * Reactive wrapper over `LooprigTransport.readStatus` for a single, fixed
 * session id: exposes that session's last-projected `SessionStatus` as
 * state. Same loading/error contract as `SessionListStore.refresh` — a
 * failed `refresh()` sets `error` and leaves the previous `status` in place
 * rather than clearing it. Same overlapping-call guard as `SessionListStore`
 * (see `RefreshGuard`): a stale response from a superseded `refresh()` call
 * is discarded, and `loading` reflects the latest call only.
 */
export class SessionStatusStore {
  status = $state<SessionStatus | null>(null);
  loading = $state(false);
  error = $state<Error | null>(null);

  private readonly guard = new RefreshGuard();

  constructor(
    private readonly transport: LooprigTransport,
    private readonly sessionId: string,
  ) {}

  /** Issues `readStatus(sessionId, options)` and republishes the result as state — unless a newer `refresh()` call has since superseded this one. */
  async refresh(options?: RequestOptions): Promise<void> {
    const generation = this.guard.start();
    this.loading = true;
    this.error = null;
    try {
      const status = await this.transport.readStatus(this.sessionId, options);
      if (!this.guard.isCurrent(generation)) return;
      this.status = status;
      this.loading = false;
    } catch (err) {
      if (!this.guard.isCurrent(generation)) return;
      this.error = asError(err);
      this.loading = false;
    }
  }
}

/**
 * Reactive wrapper over `LooprigTransport.readHistory` for a single, fixed
 * session id: exposes one page of that session's durable event journal
 * (`EventJournalPage` — see sdk/core's `event_journal_page.schema.json`) as
 * state. `refresh()` fetches and *replaces* the current page — it does not
 * accumulate pages across calls. Deliberately: sdk/core has no history-join
 * logic yet (merging journal pages, or journal + live events, into one
 * ordered feed is exactly the "own history join" this package must not grow
 * — see the module comment), so this store does no more than mirror
 * `SessionListStore`'s single-page-replace pattern for the journal's page
 * shape. A caller that wants the next page passes
 * `{ fromJournalSeq: store.nextJournalSeq }` to the next `refresh()` call
 * itself. Same overlapping-call guard as `SessionListStore` (see
 * `RefreshGuard`): a stale response from a superseded `refresh()` call is
 * discarded, and `loading` reflects the latest call only.
 */
export class SessionHistoryStore {
  events = $state<StatusEvent[]>([]);
  nextJournalSeq = $state(0);
  done = $state(false);
  loading = $state(false);
  error = $state<Error | null>(null);

  private readonly guard = new RefreshGuard();

  constructor(
    private readonly transport: LooprigTransport,
    private readonly sessionId: string,
  ) {}

  /** Issues `readHistory(sessionId, options)` and republishes the page as state — unless a newer `refresh()` call has since superseded this one. */
  async refresh(options?: ReadHistoryOptions): Promise<void> {
    const generation = this.guard.start();
    this.loading = true;
    this.error = null;
    try {
      const page: EventJournalPage = await this.transport.readHistory(this.sessionId, options);
      if (!this.guard.isCurrent(generation)) return;
      this.events = page.events;
      this.nextJournalSeq = page.next_journal_seq;
      this.done = page.done;
      this.loading = false;
    } catch (err) {
      if (!this.guard.isCurrent(generation)) return;
      this.error = asError(err);
      this.loading = false;
    }
  }
}

/**
 * Every rejection a `LooprigTransport` method can produce (any `LooprigError`
 * subclass, or the transport-level `RequestAbortedError` / `NetworkError` /
 * `MalformedResponseError` from errors.ts) is already a real `Error`
 * instance, so this only exists to satisfy `strict`'s `unknown` catch-clause
 * type without resorting to `as` — an actual non-Error throw (which none of
 * this package's dependencies produce) is still wrapped rather than
 * silently coerced.
 */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}
