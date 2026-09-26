import type { ListSessionsOptions, LooprigTransport, SessionList, SessionSummary } from "@looprig/client";
import { Publisher, RefreshGuard, asError } from "./publisher.js";

export interface SessionListSnapshot {
  readonly sessions: readonly SessionSummary[];
  readonly skip: number;
  readonly limit: number;
  readonly nextSkip: number;
  readonly done: boolean;
  readonly loading: boolean;
  readonly error: Error | null;
}

const EMPTY: SessionListSnapshot = {
  sessions: [],
  skip: 0,
  limit: 0,
  nextSkip: 0,
  done: false,
  loading: false,
  error: null,
};

/**
 * Port of `client/sdk/svelte/src/session.svelte.ts`'s `SessionListStore`. Same
 * contract: `loading` flips true at the start of a refresh, a failure sets
 * `error` and LEAVES the previously loaded page in place (a failed refresh
 * never blanks the list), and overlapping refreshes are last-started-wins so a
 * double-click or a re-firing effect cannot commit a stale page — nor clear
 * `loading` while a newer call is still in flight.
 */
export class SessionListStore extends Publisher<SessionListSnapshot> {
  readonly #guard = new RefreshGuard();
  readonly #transport: LooprigTransport;

  constructor(transport: LooprigTransport) {
    super(EMPTY);
    this.#transport = transport;
  }

  async refresh(options?: ListSessionsOptions): Promise<void> {
    const generation = this.#guard.start();
    this.publish({ loading: true, error: null });
    try {
      const page: SessionList = await this.#transport.listSessions(options);
      if (!this.#guard.isCurrent(generation)) return;
      this.publish({
        sessions: page.sessions,
        skip: page.skip,
        limit: page.limit,
        nextSkip: page.next_skip,
        done: page.done,
        loading: false,
      });
    } catch (err) {
      if (!this.#guard.isCurrent(generation)) return;
      this.publish({ error: asError(err), loading: false });
    }
  }
}
