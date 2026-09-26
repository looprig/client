import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRefreshingFetch, LinkRecoveryController, reopenFailedLink } from '../src/index.js';

const REFRESH_PATH = '/test/refresh';
type Seen = { url: string; method: string; credentials?: RequestCredentials; contentType: string | null; body: string };

function recorder(statuses: Record<string, number[]>) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      method: init?.method ?? 'GET',
      credentials: init?.credentials,
      contentType: new Headers(init?.headers).get('Content-Type'),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const status = statuses[url]?.shift() ?? 200;
    return new Response(status === 204 ? null : '{}', { status });
  };
  return { seen, fetchImpl };
}

describe('createRefreshingFetch', () => {
  it('sends same-origin credentials and does not mint while authenticated', async () => {
    const { seen, fetchImpl } = recorder({});
    const response = await createRefreshingFetch(fetchImpl, () => fetchImpl(REFRESH_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.ok))('/api/agents/ui/threads?skip=0');
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ url: '/api/agents/ui/threads?skip=0', method: 'GET', credentials: 'same-origin', contentType: null, body: '' }]);
  });

  it('mints the owner cookie once on 401 and retries the request', async () => {
    const { seen, fetchImpl } = recorder({ '/api/agents/v1/bootstrap': [401, 200], [REFRESH_PATH]: [204] });
    const response = await createRefreshingFetch(fetchImpl, () => fetchImpl(REFRESH_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.ok))('/api/agents/v1/bootstrap');
    expect(response.status).toBe(200);
    expect(seen.map(({ url, method }) => `${method} ${url}`)).toEqual([
      'GET /api/agents/v1/bootstrap',
      'POST /test/refresh',
      'GET /api/agents/v1/bootstrap',
    ]);
    expect(seen[1]).toMatchObject({ credentials: 'same-origin', contentType: 'application/json', body: '{}' });
  });

  it('surfaces a second 401 without minting again', async () => {
    const { seen, fetchImpl } = recorder({ '/api/agents/ui/threads': [401, 401], [REFRESH_PATH]: [204] });
    const response = await createRefreshingFetch(fetchImpl, () => fetchImpl(REFRESH_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.ok))('/api/agents/ui/threads');
    expect(response.status).toBe(401);
    expect(seen.filter(({ url }) => url === REFRESH_PATH)).toHaveLength(1);
    expect(seen).toHaveLength(3);
  });

  it('surfaces the original 401 when the mint is refused', async () => {
    const { seen, fetchImpl } = recorder({ '/api/agents/ui/journal': [401], [REFRESH_PATH]: [403] });
    const response = await createRefreshingFetch(fetchImpl, () => fetchImpl(REFRESH_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.ok))('/api/agents/ui/journal');
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(2);
  });

  it('shares one mint between concurrent 401s', async () => {
    const { seen, fetchImpl } = recorder({ '/a': [401, 200], '/b': [401, 200], [REFRESH_PATH]: [204, 204] });
    const refreshing = createRefreshingFetch(fetchImpl, () => fetchImpl(REFRESH_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.ok));
    const [a, b] = await Promise.all([refreshing('/a'), refreshing('/b')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(seen.filter(({ url }) => url === REFRESH_PATH)).toHaveLength(1);
  });

  it('retries a JSON POST with the same body and headers', async () => {
    const { seen, fetchImpl } = recorder({ '/api/agents/ui/maintenance': [401, 200], [REFRESH_PATH]: [204] });
    await createRefreshingFetch(fetchImpl, () => fetchImpl(REFRESH_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.ok))('/api/agents/ui/maintenance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"action":"scan"}',
    });
    expect(seen[2]).toEqual({ url: '/api/agents/ui/maintenance', method: 'POST', credentials: 'same-origin', contentType: 'application/json', body: '{"action":"scan"}' });
  });
});

describe('createRefreshingFetch replay safety', () => {
  it('does not replay a body it cannot resend byte-for-byte', async () => {
    const { seen, fetchImpl } = recorder({ '/stream': [401, 200], [REFRESH_PATH]: [204] });
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x')); controller.close(); } });
    const response = await createRefreshingFetch(fetchImpl, () => fetchImpl(REFRESH_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.ok))('/stream', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(401);
    expect(seen.map(({ url }) => url)).toEqual(['/stream']);
  });

  it('still replays an absent or string body', async () => {
    const { seen, fetchImpl } = recorder({ '/empty': [401, 200], [REFRESH_PATH]: [204] });
    const response = await createRefreshingFetch(fetchImpl, () => fetchImpl(REFRESH_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.ok))('/empty', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual(['DELETE /empty', 'POST /test/refresh', 'DELETE /empty']);
  });
});

describe('realtime link recovery', () => {
  it('re-mints the owner cookie with an authenticated read before reopening a failed link', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/test/refresh') return new Response(null, { status: 204 });
      return new Response('{}', { status: calls.filter((call) => call.endsWith('/v1/bootstrap')).length === 1 ? 401 : 200 });
    };
    const refreshing = createRefreshingFetch(fetchImpl, () => fetchImpl(REFRESH_PATH, { method: 'POST' }).then(response => response.ok));
    await reopenFailedLink(() => refreshing('/api/agents/v1/bootstrap').then(() => undefined), () => calls.push('open'));
    expect(calls).toEqual(['GET /api/agents/v1/bootstrap', 'POST /test/refresh', 'GET /api/agents/v1/bootstrap', 'open']);
  });

  it('reopens even when the probe fails, so a transient fault does not strand the link', async () => {
    const calls: string[] = [];
    await reopenFailedLink(async () => { throw new Error('offline'); }, () => calls.push('open'));
    expect(calls).toEqual(['open']);
  });
});

// randomUUID exists only in secure contexts; the tailnet origin is plain HTTP,
// where WUI's default generator threw "crypto.randomUUID is not a function".
describe('LinkRecoveryController', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function harness(probe: (signal: AbortSignal) => Promise<unknown> = async () => undefined) {
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const timeouts: number[] = [];
    const recovery = new LinkRecoveryController({
      probe: (signal) => { calls.push('probe'); signals.push(signal); return probe(signal); },
      open: () => calls.push('open'),
      timeoutSignal: (ms) => { timeouts.push(ms); return new AbortController().signal; },
    });
    return { recovery, calls, signals, timeouts };
  }

  it('probes with a bounded signal, then reopens, backing off per failed attempt', async () => {
    const h = harness();
    h.recovery.update('failed');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual(['probe', 'open']);
    expect(h.timeouts).toEqual([5_000]);
    h.recovery.update('connecting');
    h.recovery.update('failed');
    await vi.advanceTimersByTimeAsync(3_999);
    expect(h.calls).toEqual(['probe', 'open']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual(['probe', 'open', 'probe', 'open']);
  });

  it('resets the backoff once connected', async () => {
    const h = harness();
    h.recovery.update('failed');
    await vi.advanceTimersByTimeAsync(2_000);
    h.recovery.update('connected');
    h.recovery.update('failed');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.calls.filter((call) => call === 'open')).toHaveLength(2);
  });

  it('is StrictMode-safe: a cancelled schedule does not count as an attempt', async () => {
    const h = harness();
    h.recovery.update('failed');
    h.recovery.cancel();
    h.recovery.update('failed');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.calls).toEqual(['probe', 'open']);
  });

  it('cleans up: cancelling during the probe aborts it and never reopens', async () => {
    let finish!: () => void;
    const h = harness(() => new Promise<void>((resolve) => { finish = resolve; }));
    h.recovery.update('failed');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.calls).toEqual(['probe']);
    h.recovery.cancel();
    expect(h.signals[0]?.aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual(['probe']);
  });

  it('re-mints before it reopens: the reopen waits for the probe', async () => {
    let finish!: () => void;
    const h = harness(() => new Promise<void>((resolve) => { finish = resolve; }));
    h.recovery.update('failed');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.calls).toEqual(['probe']);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual(['probe', 'open']);
  });
});
