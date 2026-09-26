import type { FetchLike } from './transport.js';

/** Adds same-origin credentials and retries a replayable 401 after the injected auth refresh succeeds. */
export function createRefreshingFetch(fetchImpl: FetchLike, refresh: () => Promise<boolean>): FetchLike {
  let refreshing: Promise<boolean> | undefined;
  const refreshOnce = () => {
    refreshing ??= Promise.resolve().then(refresh).catch(() => false).finally(() => { refreshing = undefined; });
    return refreshing;
  };
  return async (url, init) => {
    const request: RequestInit = { ...init, credentials: 'same-origin' };
    const response = await fetchImpl(url, request);
    const replayable = init?.body === undefined || init.body === null || typeof init.body === 'string';
    if (response.status !== 401 || !replayable || !(await refreshOnce())) return response;
    return fetchImpl(url, request);
  };
}
