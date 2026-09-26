export async function reopenFailedLink(probe: () => Promise<unknown>, open: () => void): Promise<void> {
  try { await probe(); } catch { /* the reconnect below reports its own failure */ }
  open();
}

const LINK_RETRY_BASE_MS = 2_000;
const LINK_RETRY_MAX_MS = 60_000;
const LINK_PROBE_TIMEOUT_MS = 5_000;

export type LinkRecoveryDeps = {
  /** An authenticated REST read through an injected authenticated fetch (its 401 re-mints the auth state). */
  probe(signal: AbortSignal): Promise<unknown>;
  open(): void;
  timeoutSignal?: (ms: number) => AbortSignal;
};

/**
 * Reopens a link after a failed connect, with backoff:
 * 2 s, doubling to 60 s, reset once connected. Each attempt probes (bounded
 * at 5 s) before it reopens, so an expired auth state is re-minted first. Only an
 * attempt that actually fires counts toward the backoff, so a schedule that
 * is cancelled and made again (React StrictMode's effect replay) does not
 * lengthen it; cancelling also aborts a probe in flight and skips its reopen.
 */
export class LinkRecoveryController {
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private probing: AbortController | undefined;

  constructor(private readonly deps: LinkRecoveryDeps) {}

  update(state: string): void {
    if (state === 'connected') {
      this.attempts = 0;
      this.cancel();
      return;
    }
    if (state !== 'failed' || this.timer !== undefined || this.probing) return;
    const delay = Math.min(LINK_RETRY_BASE_MS * 2 ** this.attempts, LINK_RETRY_MAX_MS);
    this.timer = setTimeout(() => void this.attempt(), delay);
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.probing?.abort();
    this.probing = undefined;
  }

  private async attempt(): Promise<void> {
    this.timer = undefined;
    this.attempts += 1;
    const controller = new AbortController();
    this.probing = controller;
    const timeout = (this.deps.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms)))(LINK_PROBE_TIMEOUT_MS);
    await reopenFailedLink(
      () => this.deps.probe(AbortSignal.any([controller.signal, timeout])),
      () => { if (!controller.signal.aborted) this.deps.open(); },
    );
    if (this.probing === controller) this.probing = undefined;
  }
}

