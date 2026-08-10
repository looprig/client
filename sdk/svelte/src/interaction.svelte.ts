/**
 * Svelte 5 reactivity wrappers over `@looprig/client` (sdk/core)'s two
 * human-interactive control methods: `LooprigTransport.submit` (Task 28) and
 * `.respondGate` (Task 28). These are the WRITE half of the control plane a
 * chat UI drives — distinct from session.svelte.ts's cold reads and
 * live-session.svelte.ts's live join, which are both read-only.
 *
 * ## Where "is there an open gate right now" comes from
 *
 * `SessionView` (fold.ts/join.ts) has no representation of an open gate: the
 * vendored event schema's foldable shape doesn't carry gate state (Task 23's
 * finding), and `GatePrepared` — the durable event a gate's opening would
 * otherwise appear as — is explicitly excluded from the journal page
 * (`event_journal_page.schema.json`'s own description: "GatePrepared never
 * appears"). The actual source of truth is `SessionStatus.waiting_gate_id`
 * (`session_status.schema.json`): "omitted unless ... a gate is open." No
 * store anywhere in this app already polls `readStatus` on a running session
 * (session.svelte.ts's `SessionStatusStore` is a one-shot `refresh()`, used
 * today only by... nothing yet — nothing in `app/` calls it), so `GateStore`
 * below owns that polling itself, self-rescheduling on a plain
 * `setTimeout` loop (not a raw `setInterval`, which could pile up overlapping
 * requests if a response ever took longer than the interval) rather than
 * reusing/mutating `SessionStatusStore`'s one-shot contract.
 */
import {
  textBlock,
  type GateApprovalAction,
  type LooprigTransport,
  type RequestOptions,
  type SessionStatus,
} from "@looprig/client";

/** Same overlapping-call discipline as session.svelte.ts's `RefreshGuard` (duplicated rather than shared across packages — see that file's own doc comment for the reasoning each store here follows identically). */
class RefreshGuard {
  private generation = 0;

  start(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}

/**
 * Reactive wrapper over `LooprigTransport.submit`: the interactive chat
 * composer's write path. `submit(text)` trims `text`, no-ops on an empty (or
 * whitespace-only) result — mirroring a disabled-submit-button UX rather than
 * sending a request harness would reject as a structurally valid but useless
 * empty blocks array — builds a single `textBlock` (sdk/core's `content.ts`)
 * as the request body, and reports success/failure via the return value AND
 * `error`. `submitting` flips synchronously before the transport call
 * settles, matching every other store in this package.
 *
 * Deliberately holds NO input-text state of its own: the composer's draft
 * text is ordinary component-local UI state (a plain `$state` string bound to
 * an `<input>`), not something this store's job to own — this store is only
 * the transport-facing write path, the same division session.svelte.ts's
 * stores draw between "the data" and "how a component displays/edits it."
 */
export class SessionComposerStore {
  submitting = $state(false);
  error = $state<Error | null>(null);

  private readonly guard = new RefreshGuard();

  constructor(
    private readonly transport: LooprigTransport,
    private readonly sessionId: string,
  ) {}

  /**
   * Submits `text` as a single text content block. Returns `true` on success
   * (the caller should clear its input), `false` on a no-op (empty text) or a
   * failed submission (the caller should leave the input as-is so the user
   * doesn't lose what they typed; inspect `error` for why). Overlapping calls
   * follow the same last-started-wins discipline as every other store here:
   * a stale response can still flip `submitting` back to `false`d only if no
   * newer call has since superseded it.
   */
  async submit(text: string, options?: RequestOptions): Promise<boolean> {
    const trimmed = text.trim();
    if (trimmed === "" || this.submitting) return false;

    const generation = this.guard.start();
    this.submitting = true;
    this.error = null;
    try {
      await this.transport.submit(this.sessionId, { blocks: [textBlock(trimmed)] }, options);
      if (this.guard.isCurrent(generation)) this.submitting = false;
      return true;
    } catch (err) {
      if (this.guard.isCurrent(generation)) {
        this.error = asError(err);
        this.submitting = false;
      }
      return false;
    }
  }
}

/** How often `GateStore.start()` polls `readStatus` by default, in milliseconds. */
const DEFAULT_GATE_POLL_INTERVAL_MS = 2000;

/**
 * Reactive wrapper owning BOTH halves of the gate-approval UI's data needs:
 * polling `SessionStatus.waiting_gate_id` to know whether a gate is
 * currently open (see this module's doc comment for why that's the real
 * source, not the event fold), and submitting the human's answer via
 * `respondGate`. Kept as one store rather than two separate ones because a
 * gate UI's own two concerns are tightly coupled in practice — the whole
 * point of polling is to notice when `respond()` actually closed the gate —
 * and `respond()` triggers one immediate out-of-cycle poll on success so
 * `waitingGateId` reflects the resolution without waiting up to
 * `intervalMs` for the next scheduled tick.
 *
 * `start()`/`stop()` mirror `LiveSessionViewStore`'s subscription lifecycle
 * (idempotent start, generation-guarded against a stale loop iteration
 * committing state after a `stop()`), NOT `SessionStatusStore`'s one-shot
 * `refresh()` — this store's whole purpose is the ongoing "is a gate open
 * right now" question a chat UI needs live, not a single point-in-time read.
 */
export class GateStore {
  status = $state<SessionStatus | null>(null);
  /** True from `start()` until `stop()` — NOT tied to whether a poll request is currently in flight. */
  polling = $state(false);
  /** Set when the most recent poll failed; the previous `status` (and therefore `waitingGateId`) is left in place, same as every cold-read store's failure contract. */
  pollError = $state<Error | null>(null);
  /** True while a `respondGate` call is in flight. */
  responding = $state(false);
  /** Set when the most recent `respond()` call failed. */
  respondError = $state<Error | null>(null);

  private readonly guard = new RefreshGuard();
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Set the instant `respond()`'s `transport.respondGate()` call resolves
   * successfully, to close the window between that resolution and the
   * confirmatory `pollOnce()` (below, still in flight at that point)
   * actually updating `status`. Without this, `waitingGateId` — and every
   * disabled-state check keyed on it, e.g. the gate-response buttons in
   * `app/src/routes/sessions/[sid]/+page.svelte` — would still reflect the
   * just-answered gate for a network-RTT-sized window after `responding`
   * flips back to `false`, letting a fast double-click fire a second
   * `respondGate` call for a gate the server already resolved (rejected
   * harmlessly server-side as `GateNotReady`, but a wasted round trip and a
   * confusing transient error). Never reset back to `null` afterward: gate
   * ids are opaque and assigned once per gate open (never reused), so once a
   * later poll's `status` reports a *different* `waiting_gate_id` (or none),
   * `waitingGateId`'s comparison below stops matching on its own — no
   * explicit clear is needed.
   */
  private answeredGateId: string | null = null;

  constructor(
    private readonly transport: LooprigTransport,
    private readonly sessionId: string,
    private readonly intervalMs: number = DEFAULT_GATE_POLL_INTERVAL_MS,
  ) {}

  /**
   * The opaque gate id a UI should render a prompt for, or `null` if no gate
   * is currently open. Derived from `status` on every read — never parsed or
   * reconstructed, passed through exactly as the server sent it — EXCEPT
   * that a gate `respond()` has already been told resolved successfully is
   * masked to `null` immediately, ahead of the confirmatory poll that will
   * eventually update `status` to match (see `answeredGateId`'s own comment).
   */
  get waitingGateId(): string | null {
    const id = this.status?.waiting_gate_id ?? null;
    if (id !== null && id === this.answeredGateId) return null;
    return id;
  }

  /** Starts the poll loop. Idempotent: a no-op while already `polling`. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.polling = true;
    void this.pollLoop();
  }

  /** Stops the poll loop. Safe to call when not started. Cancels a pending scheduled tick; does NOT cancel an in-flight `readStatus` request, but that request's result is discarded via the generation guard once it resolves. */
  stop(): void {
    this.stopped = true;
    this.polling = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Submits `action` as the human's answer to the currently-open gate (per
   * `GateResponseRequest.action` — pass one of `GATE_APPROVAL_ACTIONS`'
   * three exact values). A no-op (returns `false` without calling the
   * transport) if no gate is currently open or a response is already in
   * flight. On success, `waitingGateId` is masked to `null` the instant
   * `respondGate` resolves (see `answeredGateId`'s own comment) — before
   * `responding` flips back to `false` — so there is no window where a UI
   * gating on either field would treat this gate as both answerable and
   * already answered. A confirmatory re-poll of status still runs
   * immediately afterward (outside the regular interval) to reconcile
   * `status` itself with the server's view, rather than leaving it stale
   * until up to `intervalMs` later.
   */
  async respond(action: GateApprovalAction, options?: RequestOptions): Promise<boolean> {
    const gateId = this.waitingGateId;
    if (gateId === null || this.responding) return false;

    this.responding = true;
    this.respondError = null;
    try {
      await this.transport.respondGate(this.sessionId, gateId, { action }, options);
      this.answeredGateId = gateId;
      this.responding = false;
      await this.pollOnce();
      return true;
    } catch (err) {
      this.respondError = asError(err);
      this.responding = false;
      return false;
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      await this.pollOnce();
      if (this.stopped) return;
      await this.sleep(this.intervalMs);
    }
  }

  private async pollOnce(): Promise<void> {
    const generation = this.guard.start();
    try {
      const status = await this.transport.readStatus(this.sessionId);
      if (this.guard.isCurrent(generation) && !this.stopped) {
        this.status = status;
        this.pollError = null;
      }
    } catch (err) {
      if (this.guard.isCurrent(generation) && !this.stopped) {
        this.pollError = asError(err);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }
}

/** Same rationale as session.svelte.ts's `asError`: every rejection observable here is already a real `Error`, but `strict`'s `unknown` catch type still needs narrowing without an `as`. */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}
