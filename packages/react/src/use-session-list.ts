import { useCallback, useEffect, useMemo } from "react";
import type { ListSessionsOptions, LooprigTransport } from "@looprig/client";
import { SessionListStore, type SessionListSnapshot } from "./stores/session-list.js";
import { useStore } from "./use-store.js";

/**
 * The paging half of `ListSessionsOptions`, and deliberately not the whole of
 * it: `signal` is the hook's own to manage (see below), so accepting a
 * caller's would be a parameter this hook silently ignores.
 */
export interface SessionListQuery {
  /** Paging offset. Server default: 0. */
  skip?: number;
  /** Page size. Server default: 100. Server-enforced range: [1, 1000]. */
  limit?: number;
}

export interface UseSessionListResult extends SessionListSnapshot {
  /** Re-fetch now — for a retry button or a paging control. Never rejects. */
  refresh: (query?: SessionListQuery) => Promise<void>;
}

/**
 * A page of session summaries, fetched on mount and whenever `query` changes
 * by VALUE.
 *
 * Two React-specific hazards, both handled here rather than in the store:
 *
 *  - `query` is almost always an inline object literal, so an effect keyed on
 *    its identity would refetch on every render. The effect depends on the two
 *    scalars instead. 04-react.md keyed on `JSON.stringify(options)` and then
 *    `JSON.parse`d it back; that is both order-sensitive (`{skip,limit}` and
 *    `{limit,skip}` serialize differently and would spuriously refetch) and
 *    silently lossy for a caller-supplied `AbortSignal`, which is why
 *    `SessionListQuery` exists rather than `ListSessionsOptions`.
 *  - the request is aborted on unmount, and under StrictMode's
 *    mount/unmount/mount the first request's abort rejection lands after the
 *    second request has already started, so `RefreshGuard` discards it. Both
 *    mechanisms are needed: the abort frees the socket, the guard keeps the
 *    stale rejection out of `error`.
 *
 * `refresh()` deliberately carries no signal. It has no unmount hook of its
 * own, and after an unmount its result is discarded by the store nobody is
 * subscribed to anyway; giving it one would mean tying a user-initiated retry
 * to the lifetime of whichever effect happened to run last.
 */
export function useSessionList(transport: LooprigTransport, query?: SessionListQuery): UseSessionListResult {
  // The constructor is side-effect-free, so a StrictMode double-invoke that
  // discards one store costs nothing.
  const store = useMemo(() => new SessionListStore(transport), [transport]);
  const snapshot = useStore(store);
  const skip = query?.skip;
  const limit = query?.limit;

  const refresh = useCallback(
    (override?: SessionListQuery) => store.refresh(listOptions(override ?? { skip, limit })),
    [store, skip, limit],
  );

  useEffect(() => {
    const controller = new AbortController();
    void store.refresh(listOptions({ skip, limit }, controller.signal));
    return () => {
      controller.abort();
    };
  }, [store, skip, limit]);

  return useMemo(() => ({ ...snapshot, refresh }), [snapshot, refresh]);
}

/** Drops absent paging values rather than sending `undefined` through to the query string. */
function listOptions(query: SessionListQuery, signal?: AbortSignal): ListSessionsOptions {
  const options: ListSessionsOptions = {};
  if (query.skip !== undefined) options.skip = query.skip;
  if (query.limit !== undefined) options.limit = query.limit;
  if (signal !== undefined) options.signal = signal;
  return options;
}
