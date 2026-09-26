import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoreProtocolError,
  createFactoryCommands,
  NetworkError,
  type ClientLink,
  type CommandStatus,
} from '../src/index.js';
import {
  CommandNotFoundError,
  createCommandResolver,
  pendingCreateKey,
  pendingInputKey,
  pendingInputText,
  PendingController,
  PendingPersistError,
  PendingSlot,
  RECOVERY_BASE_DELAY_MS,
  PendingSessionNotFoundError,
  submitInput,
  UNCONFIRMED_AFTER_FAILURES,
  sendOrAdopt,
  STALE_SLOT_MS,
  SWEEP_SLOT_MS,
  sweepPendingSlots,
  type CommandResolver,
  type LockManagerLike,
} from '../src/pending-store.js';

const NAMESPACE = 'oxy.factory.pending';
const PENDING_CREATE_KEY = pendingCreateKey(NAMESPACE);
const SESSION = '3f0c2a52-5b1e-4d6f-9a0e-2b7c1d4e5f60';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
}

type Sent = { method: string; request: unknown; bytes: string };

/** A link whose RPC answers are scripted per call; every call is recorded. */
function scriptedLink(answers: Array<(request: { command_id: string }) => Promise<CommandStatus>>) {
  const sent: Sent[] = [];
  const link = {
    state: 'connected',
    connect: async () => { throw new Error('not used'); },
    disconnect() {},
    subscribe() { throw new Error('not used'); },
    rpc(method: string, request: unknown) {
      sent.push({ method, request, bytes: JSON.stringify(request) });
      const answer = answers.shift();
      if (!answer) return Promise.reject(new Error('unexpected rpc'));
      return answer(request as { command_id: string });
    },
  } as unknown as ClientLink;
  return { link, sent };
}

const accepted = (request: { command_id: string }): Promise<CommandStatus> =>
  Promise.resolve({ command_id: request.command_id, status: 'accepted', accepted_order: 1 } as CommandStatus);
const lost = (): Promise<CommandStatus> => Promise.reject(new NetworkError('/v1/realtime'));

function resolver(answer: (sessionId: string, commandId: string) => Promise<CommandStatus>) {
  const calls: string[] = [];
  const value: CommandResolver = {
    resolve(sessionId, commandId) {
      calls.push(`${sessionId}/${commandId}`);
      return answer(sessionId, commandId);
    },
  };
  return { value, calls };
}
const notFound = () => Promise.reject(new CommandNotFoundError('s', 'c'));
/**
 * Factory's real answer for a create that was never admitted: the audit route
 * resolves the session before the command, so it is 404 `session_not_found`.
 */
const factorySessionNotFound = createCommandResolver(async () => new Response(
  JSON.stringify({ error: { code: 'session_not_found', message: 'session not found', retryable: false } }),
  { status: 404 },
));
const createNotFound = (sessionId: string, commandId: string) => factorySessionNotFound.resolve(sessionId, commandId);

let ids = 0;
function commandsOver(link: ClientLink) {
  return createFactoryCommands({ link, idGenerator: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` });
}

describe('PendingSlot', () => {
  it('persists the exact envelope before the first send and clears it on acceptance', async () => {
    const storage = new MemoryStorage();
    let persistedBeforeSend: string | undefined;
    const { link, sent } = scriptedLink([(request) => {
      persistedBeforeSend = storage.getItem(pendingInputKey(SESSION, NAMESPACE)) ?? undefined;
      return accepted(request);
    }]);
    const pending = commandsOver(link).input(SESSION, { blocks: [{ type: 'text', Text: 'Hello' }] });
    const slot = new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), link, resolver(notFound).value);

    const outcome = await slot.send(pending);

    expect(persistedBeforeSend).toBeDefined();
    expect(JSON.parse(persistedBeforeSend!)).toMatchObject({ method: 'session.input', request: pending.bytes, commandId: pending.commandId });
    expect(sent[0]?.bytes).toBe(pending.bytes);
    expect(outcome).toMatchObject({ kind: 'accepted', commandId: pending.commandId });
    expect(storage.getItem(pendingInputKey(SESSION, NAMESPACE))).toBeNull();
  });

  it('reloads with a lost acknowledgement: 404 resends the same command id and byte-equal body', async () => {
    const storage = new MemoryStorage();
    const first = scriptedLink([lost]);
    const pending = commandsOver(first.link).input(SESSION, { blocks: [{ type: 'text', Text: 'Did this land?' }] });
    const before = await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), first.link, resolver(notFound).value).send(pending);
    expect(before.kind).toBe('unknown');
    expect(storage.getItem(pendingInputKey(SESSION, NAMESPACE))).not.toBeNull();

    // A reload: a new link, a new slot object over the same storage.
    const second = scriptedLink([accepted]);
    const lookups = resolver(notFound);
    const reloaded = new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), second.link, lookups.value);
    expect(reloaded.read()?.commandId).toBe(pending.commandId);
    const outcome = await reloaded.recover();

    expect(lookups.calls).toEqual([`${SESSION}/${pending.commandId}`]);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]?.method).toBe('session.input');
    expect(second.sent[0]?.bytes).toBe(pending.bytes);
    expect(second.sent[0]?.bytes).toBe(first.sent[0]?.bytes);
    expect(outcome).toMatchObject({ kind: 'accepted', commandId: pending.commandId });
    expect(storage.getItem(pendingInputKey(SESSION, NAMESPACE))).toBeNull();
  });

  it('does not resend when the lost command was admitted', async () => {
    const storage = new MemoryStorage();
    const first = scriptedLink([lost]);
    const pending = commandsOver(first.link).create({ agentId: 'oxi' });
    await new PendingSlot(storage, PENDING_CREATE_KEY, first.link, resolver(createNotFound).value).send(pending);

    const second = scriptedLink([]);
    const found = resolver(async (_sid, commandId) => ({ command_id: commandId, status: 'applied', accepted_order: 4 } as CommandStatus));
    const outcome = await new PendingSlot(storage, PENDING_CREATE_KEY, second.link, found.value).recover();

    expect(outcome).toMatchObject({ kind: 'accepted', sessionId: pending.sessionId, commandId: pending.commandId });
    expect(second.sent).toEqual([]);
    expect(storage.getItem(PENDING_CREATE_KEY)).toBeNull();
  });

  it('resends a never-admitted create, which Factory answers 404 session_not_found, with the same id and bytes', async () => {
    const storage = new MemoryStorage();
    const first = scriptedLink([lost]);
    const pending = commandsOver(first.link).create({ agentId: 'oxi' });
    await new PendingSlot(storage, PENDING_CREATE_KEY, first.link, resolver(createNotFound).value).send(pending);

    const second = scriptedLink([accepted]);
    const lookups = resolver(createNotFound);
    const outcome = await new PendingSlot(storage, PENDING_CREATE_KEY, second.link, lookups.value).recover();

    expect(lookups.calls).toEqual([`${pending.sessionId}/${pending.commandId}`]);
    expect(second.sent.map((entry) => [entry.method, entry.bytes])).toEqual([['session.create', pending.bytes]]);
    expect(second.sent[0]?.bytes).toBe(first.sent[0]?.bytes);
    expect(outcome).toMatchObject({ kind: 'accepted', sessionId: pending.sessionId, commandId: pending.commandId });
    expect(storage.getItem(PENDING_CREATE_KEY)).toBeNull();
  });

  it('does not treat session_not_found as never admitted for an input', async () => {
    const storage = new MemoryStorage();
    const first = scriptedLink([lost]);
    const pending = commandsOver(first.link).input(SESSION, { blocks: [{ type: 'text', Text: 'gone?' }] });
    await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), first.link, resolver(notFound).value).send(pending);

    const second = scriptedLink([]);
    const outcome = await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), second.link, resolver(createNotFound).value).recover();

    expect(outcome).toMatchObject({ kind: 'unknown', reason: 'unreadable' });
    expect(second.sent).toEqual([]);
    expect(storage.getItem(pendingInputKey(SESSION, NAMESPACE))).not.toBeNull();
  });

  it('clears a rejected command, whether read back or refused on send', async () => {
    const storage = new MemoryStorage();
    const first = scriptedLink([lost]);
    const pending = commandsOver(first.link).input(SESSION, { blocks: [{ type: 'text', Text: 'x' }] });
    await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), first.link, resolver(notFound).value).send(pending);
    const rejectedStatus = resolver(async (_sid, commandId) => ({
      command_id: commandId, status: 'rejected', error: { code: 'command_rejected', message: 'No.', retryable: false },
    } as CommandStatus));
    const second = scriptedLink([]);
    const readBack = await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), second.link, rejectedStatus.value).recover();
    expect(readBack).toMatchObject({ kind: 'rejected' });
    expect(second.sent).toEqual([]);
    expect(storage.getItem(pendingInputKey(SESSION, NAMESPACE))).toBeNull();

    const refusing = scriptedLink([() => Promise.reject(new CoreProtocolError({ error: { code: 'runtime_unavailable', message: 'Model not configured.', retryable: true } }))]);
    const next = commandsOver(refusing.link).input(SESSION, { blocks: [{ type: 'text', Text: 'y' }] });
    const refused = await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), refusing.link, resolver(notFound).value).send(next);
    expect(refused).toMatchObject({ kind: 'rejected' });
    expect(refused.kind === 'rejected' && refused.error.message).toBe('Model not configured.');
    expect(storage.getItem(pendingInputKey(SESSION, NAMESPACE))).toBeNull();
  });

  it('shares one slot between two tabs without a second send while the first is in flight', async () => {
    const storage = new MemoryStorage();
    let release!: () => void;
    const tabA = scriptedLink([(request) => new Promise((resolve) => { release = () => resolve({ command_id: request.command_id, status: 'accepted' } as CommandStatus); })]);
    const pending = commandsOver(tabA.link).create({ agentId: 'oxi' });
    const inFlight = new PendingSlot(storage, PENDING_CREATE_KEY, tabA.link, resolver(createNotFound).value).send(pending);

    const tabB = scriptedLink([]);
    let admitted = false;
    const lookups = resolver(async (_sid, commandId) => {
      if (!admitted) return createNotFound(_sid, commandId);
      return { command_id: commandId, status: 'accepted' } as CommandStatus;
    });
    const slotB = new PendingSlot(storage, PENDING_CREATE_KEY, tabB.link, lookups.value);
    expect(slotB.inFlight()).toBe(true);
    const waiting = await slotB.recover();
    expect(waiting).toMatchObject({ kind: 'unknown', commandId: pending.commandId });
    expect(tabB.sent).toEqual([]);
    // A tab refuses to mint a second create over the retained one.
    const second = commandsOver(tabB.link).create({ agentId: 'oxi' });
    await expect(slotB.send(second)).resolves.toMatchObject({ kind: 'busy', commandId: pending.commandId });
    expect(tabB.sent).toEqual([]);

    admitted = true;
    release();
    await expect(inFlight).resolves.toMatchObject({ kind: 'accepted' });
    expect(slotB.inFlight()).toBe(false);
    expect(await slotB.recover()).toBeUndefined();
    expect(tabA.sent).toHaveLength(1);
    expect(tabB.sent).toEqual([]);
  });

  it('retries a crashed tab\'s in-flight send once its lease expires, and a forced retry at once', async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const crashed = scriptedLink([() => new Promise(() => {})]);
    const pending = commandsOver(crashed.link).create({ agentId: 'oxi' });
    void new PendingSlot(storage, PENDING_CREATE_KEY, crashed.link, resolver(createNotFound).value, () => now).send(pending);

    const reloaded = scriptedLink([accepted]);
    const slot = new PendingSlot(storage, PENDING_CREATE_KEY, reloaded.link, resolver(createNotFound).value, () => now);
    await expect(slot.recover()).resolves.toMatchObject({ kind: 'unknown' });
    expect(reloaded.sent).toEqual([]);
    now += 60_000;
    await expect(slot.recover()).resolves.toMatchObject({ kind: 'accepted' });
    expect(reloaded.sent.map((entry) => entry.bytes)).toEqual([pending.bytes]);

    const forcedLink = scriptedLink([lost, accepted]);
    const forced = new PendingSlot(storage, PENDING_CREATE_KEY, forcedLink.link, resolver(createNotFound).value, () => now);
    const again = commandsOver(forcedLink.link).create({ agentId: 'oxi' });
    await forced.send(again);
    await expect(forced.recover({ force: true })).resolves.toMatchObject({ kind: 'accepted' });
    expect(forcedLink.sent.map((entry) => entry.bytes)).toEqual([again.bytes, again.bytes]);
  });

  it('keeps the slot when the outcome stays unknown and drops a corrupt slot without sending', async () => {
    const storage = new MemoryStorage();
    const first = scriptedLink([lost]);
    const pending = commandsOver(first.link).input(SESSION, { blocks: [{ type: 'text', Text: 'z' }] });
    await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), first.link, resolver(notFound).value).send(pending);
    const offline = resolver(() => Promise.reject(new NetworkError('/v1/sessions')));
    const second = scriptedLink([]);
    await expect(new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), second.link, offline.value).recover()).resolves.toMatchObject({ kind: 'unknown' });
    expect(storage.getItem(pendingInputKey(SESSION, NAMESPACE))).not.toBeNull();
    expect(second.sent).toEqual([]);

    storage.setItem(pendingInputKey('other', NAMESPACE), '{"method":"session.input","request":"not json"}');
    const corrupt = new PendingSlot(storage, pendingInputKey('other', NAMESPACE), second.link, offline.value);
    expect(corrupt.read()).toBeUndefined();
    await expect(corrupt.recover()).resolves.toBeUndefined();
    expect(storage.getItem(pendingInputKey('other', NAMESPACE))).toBeNull();
    expect(second.sent).toEqual([]);
  });

  it('discards only the command it names', async () => {
    const storage = new MemoryStorage();
    const { link } = scriptedLink([lost]);
    const pending = commandsOver(link).input(SESSION, { blocks: [{ type: 'text', Text: 'keep me' }] });
    const slot = new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), link, resolver(notFound).value);
    await slot.send(pending);
    slot.discard('another-command');
    expect(slot.read()?.commandId).toBe(pending.commandId);
    expect(pendingInputText(slot.read()!.request)).toBe('keep me');
    slot.discard(pending.commandId);
    expect(slot.read()).toBeUndefined();
  });
});

describe('sendOrAdopt (new thread)', () => {
  it('completes a retained create instead of minting a second thread', async () => {
    const storage = new MemoryStorage();
    const first = scriptedLink([lost]);
    const retained = commandsOver(first.link).create({ agentId: 'oxi' });
    await new PendingSlot(storage, PENDING_CREATE_KEY, first.link, resolver(createNotFound).value).send(retained);

    const second = scriptedLink([accepted]);
    let minted = 0;
    const outcome = await sendOrAdopt(new PendingSlot(storage, PENDING_CREATE_KEY, second.link, resolver(createNotFound).value), () => {
      minted += 1;
      return commandsOver(second.link).create({ agentId: 'oxi' });
    });
    expect(minted).toBe(0);
    expect(outcome).toMatchObject({ kind: 'accepted', sessionId: retained.sessionId });
    expect(second.sent.map((entry) => entry.bytes)).toEqual([retained.bytes]);
  });

  it('mints and sends when nothing is retained', async () => {
    const storage = new MemoryStorage();
    const { link, sent } = scriptedLink([accepted]);
    const outcome = await sendOrAdopt(new PendingSlot(storage, PENDING_CREATE_KEY, link, resolver(createNotFound).value), () => commandsOver(link).create({ agentId: 'oxi' }));
    expect(outcome.kind).toBe('accepted');
    expect(sent).toHaveLength(1);
    expect(outcome.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('createCommandResolver', () => {
  it('reads the audit route through the given fetch and validates the status', async () => {
    const seen: string[] = [];
    const lookups = createCommandResolver(async (url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify({ command_id: 'c/1', status: 'accepted', accepted_order: 2 }), { status: 200 });
    }, '/api/agents');
    await expect(lookups.resolve(SESSION as never, 'c/1' as never)).resolves.toMatchObject({ status: 'accepted' });
    expect(seen).toEqual([`GET /api/agents/v1/sessions/${SESSION}/commands/c%2F1`]);
  });

  it('maps only a command_not_found 404 to CommandNotFoundError, types a session_not_found 404, and anything else is an unknown failure', async () => {
    const missing = createCommandResolver(async () => new Response(JSON.stringify({ error: { code: 'command_not_found', retryable: false } }), { status: 404 }));
    await expect(missing.resolve(SESSION as never, 'c' as never)).rejects.toBeInstanceOf(CommandNotFoundError);
    const routeMissing = createCommandResolver(async () => new Response('404 page not found', { status: 404 }));
    await expect(routeMissing.resolve(SESSION as never, 'c' as never)).rejects.not.toBeInstanceOf(CommandNotFoundError);
    const otherCode = createCommandResolver(async () => new Response(JSON.stringify({ error: { code: 'session_not_found', message: 'gone', retryable: false } }), { status: 404 }));
    await expect(otherCode.resolve(SESSION as never, 'c' as never)).rejects.not.toBeInstanceOf(CommandNotFoundError);
    // A session_not_found 404 is typed so a create slot (only) can read it as never admitted.
    await expect(otherCode.resolve(SESSION as never, 'c' as never)).rejects.toBeInstanceOf(PendingSessionNotFoundError);
    const proxied = createCommandResolver(async () => new Response(JSON.stringify({ error: { code: 'session_not_found', message: 'gone', retryable: false } }), { status: 502 }));
    await expect(proxied.resolve(SESSION as never, 'c' as never)).rejects.not.toBeInstanceOf(PendingSessionNotFoundError);
    const failing = createCommandResolver(async () => new Response('{}', { status: 503 }));
    await expect(failing.resolve(SESSION as never, 'c' as never)).rejects.not.toBeInstanceOf(CommandNotFoundError);
    const other = createCommandResolver(async () => new Response(JSON.stringify({ command_id: 'other', status: 'accepted' }), { status: 200 }));
    await expect(other.resolve(SESSION as never, 'c' as never)).rejects.toThrow(/does not match/);
  });
});

it('sends nothing when the slot cannot be persisted first', async () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  const { link, sent } = scriptedLink([accepted]);
  const pending = commandsOver(link).input(SESSION, { blocks: [{ type: 'text', Text: 'x' }] });
  await expect(new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), link, resolver(notFound).value).send(pending)).rejects.toThrow();
  expect(sent).toEqual([]);
});

const serverError = () => Promise.reject(new CoreProtocolError({ error: { code: 'internal_error', message: 'unreadable', retryable: true } }));
const admitted = (_sid: string, commandId: string) => Promise.resolve({ command_id: commandId, status: 'accepted', accepted_order: 1 } as CommandStatus);

describe('PendingSlot age', () => {
  it('stamps createdAt once and keeps it across a resend', async () => {
    const storage = new MemoryStorage();
    let now = 5_000;
    const { link } = scriptedLink([lost, lost]);
    const pending = commandsOver(link).input(SESSION, { blocks: [{ type: 'text', Text: 'aging' }] });
    const slot = new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), link, resolver(notFound).value, () => now);
    await slot.send(pending);
    expect(JSON.parse(storage.getItem(pendingInputKey(SESSION, NAMESPACE))!)).toMatchObject({ v: 2, createdAt: 5_000 });
    now += 60_000;
    await slot.recover({ force: true });
    expect(JSON.parse(storage.getItem(pendingInputKey(SESSION, NAMESPACE))!)).toMatchObject({ createdAt: 5_000 });
  });

  it('asks before resending a never-admitted command older than ten minutes', async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const first = scriptedLink([lost]);
    const pending = commandsOver(first.link).input(SESSION, { blocks: [{ type: 'text', Text: 'old' }] });
    await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), first.link, resolver(notFound).value, () => now).send(pending);

    now += STALE_SLOT_MS + 1;
    const second = scriptedLink([accepted]);
    const slot = new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), second.link, resolver(notFound).value, () => now);
    await expect(slot.recover()).resolves.toMatchObject({ kind: 'unsent', commandId: pending.commandId });
    expect(second.sent).toEqual([]);
    expect(slot.read()?.commandId).toBe(pending.commandId);
    await expect(slot.recover({ confirmed: true })).resolves.toMatchObject({ kind: 'accepted' });
    expect(second.sent.map((entry) => entry.bytes)).toEqual([pending.bytes]);
  });

  it('still settles an old command that was admitted, without asking', async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const first = scriptedLink([lost]);
    const pending = commandsOver(first.link).input(SESSION, { blocks: [{ type: 'text', Text: 'old' }] });
    await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), first.link, resolver(notFound).value, () => now).send(pending);
    now += STALE_SLOT_MS + 1;
    const slot = new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), scriptedLink([]).link, resolver(admitted).value, () => now);
    await expect(slot.recover()).resolves.toMatchObject({ kind: 'accepted' });
  });

  it('reads a v1 slot without createdAt and treats it as old', async () => {
    const storage = new MemoryStorage();
    const first = scriptedLink([]);
    const pending = commandsOver(first.link).input(SESSION, { blocks: [{ type: 'text', Text: 'v1' }] });
    storage.setItem(pendingInputKey(SESSION, NAMESPACE), JSON.stringify({ v: 1, commandId: pending.commandId, method: pending.method, request: pending.bytes, inFlightUntil: 0 }));
    const second = scriptedLink([accepted]);
    const slot = new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), second.link, resolver(notFound).value);
    expect(pendingInputText(slot.read()!.request)).toBe('v1');
    await expect(slot.recover()).resolves.toMatchObject({ kind: 'unsent' });
    expect(second.sent).toEqual([]);
  });

  it('sweeps pending slots older than seven days at startup', () => {
    const storage = new MemoryStorage();
    const now = 100 * SWEEP_SLOT_MS;
    const { link } = scriptedLink([]);
    const slotOf = (text: string, createdAt?: number) => {
      const pending = commandsOver(link).input(SESSION, { blocks: [{ type: 'text', Text: text }] });
      return JSON.stringify({ v: createdAt === undefined ? 1 : 2, commandId: pending.commandId, method: pending.method, request: pending.bytes, inFlightUntil: 0, ...(createdAt === undefined ? {} : { createdAt }) });
    };
    storage.setItem('oxy.factory.pending.expired', slotOf('expired', now - SWEEP_SLOT_MS - 1));
    storage.setItem('oxy.factory.pending.recent', slotOf('recent', now - SWEEP_SLOT_MS + 1));
    storage.setItem('oxy.factory.pending.legacy', slotOf('legacy'));
    storage.setItem('oxy.agent.draft.expired', 'not a slot');
    expect(sweepPendingSlots(storage, NAMESPACE, now)).toEqual(['oxy.factory.pending.expired']);
    expect([...storage.values.keys()].sort()).toEqual(['oxy.agent.draft.expired', 'oxy.factory.pending.legacy', 'oxy.factory.pending.recent']);
  });
});

/** A Web Locks stand-in: one holder per name, FIFO; records whether a lock is held. */
class FakeLocks implements LockManagerLike {
  readonly held = new Set<string>();
  readonly names: string[] = [];
  private tails = new Map<string, Promise<unknown>>();
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
    this.names.push(name);
    const run = (this.tails.get(name) ?? Promise.resolve()).then(async () => {
      this.held.add(name);
      try { return await callback(); } finally { this.held.delete(name); }
    });
    this.tails.set(name, run.catch(() => undefined));
    return run;
  }
}

describe('PendingSlot cross-tab atomicity', () => {
  it('checks and writes the slot while holding a lock named by its key', async () => {
    const storage = new MemoryStorage();
    const locks = new FakeLocks();
    const writes: boolean[] = [];
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => { writes.push(locks.held.has(key)); setItem(key, value); };
    const { link } = scriptedLink([accepted]);
    const pending = commandsOver(link).input(SESSION, { blocks: [{ type: 'text', Text: 'locked' }] });
    await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), link, resolver(notFound).value, Date.now, locks).send(pending);
    expect(locks.names[0]).toBe(pendingInputKey(SESSION, NAMESPACE));
    expect(writes[0]).toBe(true);
  });

  it('a tab waiting on the lock sees the other tab\'s slot and sends nothing', async () => {
    const storage = new MemoryStorage();
    const locks = new FakeLocks();
    const tabA = scriptedLink([]);
    const commandA = commandsOver(tabA.link).create({ agentId: 'oxi' });
    let releaseA!: () => void;
    // Tab A holds the lock across its check-and-write.
    const holding = locks.request(PENDING_CREATE_KEY, () => new Promise<void>((resolve) => { releaseA = resolve; }));
    const tabB = scriptedLink([accepted]);
    const sending = new PendingSlot(storage, PENDING_CREATE_KEY, tabB.link, resolver(createNotFound).value, Date.now, locks)
      .send(commandsOver(tabB.link).create({ agentId: 'oxi' }));
    await Promise.resolve();
    storage.setItem(PENDING_CREATE_KEY, JSON.stringify({ v: 2, commandId: commandA.commandId, method: commandA.method, request: commandA.bytes, inFlightUntil: Date.now() + 15_000, createdAt: Date.now() }));
    releaseA();
    await holding;
    await expect(sending).resolves.toMatchObject({ kind: 'busy', commandId: commandA.commandId });
    expect(tabB.sent).toEqual([]);
  });

  it('falls back to an unlocked check-and-write where Web Locks are unavailable', async () => {
    const storage = new MemoryStorage();
    const { link, sent } = scriptedLink([accepted]);
    const pending = commandsOver(link).input(SESSION, { blocks: [{ type: 'text', Text: 'plain' }] });
    await expect(new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), link, resolver(notFound).value, Date.now, null).send(pending)).resolves.toMatchObject({ kind: 'accepted' });
    expect(sent).toHaveLength(1);
  });
});

describe('PendingSlot failures', () => {
  it('throws PendingPersistError only when the slot cannot be written before sending', async () => {
    const storage = new MemoryStorage();
    storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    const { link, sent } = scriptedLink([accepted]);
    const pending = commandsOver(link).input(SESSION, { blocks: [{ type: 'text', Text: 'x' }] });
    await expect(new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), link, resolver(notFound).value).send(pending)).rejects.toBeInstanceOf(PendingPersistError);
    expect(sent).toEqual([]);
  });

  it('does not fail a sent command when the post-send lease write hits the quota', async () => {
    const storage = new MemoryStorage();
    let writes = 0;
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => { if (writes++ > 0) throw new DOMException('full', 'QuotaExceededError'); setItem(key, value); };
    const { link, sent } = scriptedLink([lost]);
    const pending = commandsOver(link).input(SESSION, { blocks: [{ type: 'text', Text: 'x' }] });
    await expect(new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), link, resolver(notFound).value).send(pending)).resolves.toMatchObject({ kind: 'unknown' });
    expect(sent).toHaveLength(1);
  });

  it('marks an unreadable read-back so callers can count it', async () => {
    const storage = new MemoryStorage();
    const first = scriptedLink([lost]);
    const pending = commandsOver(first.link).create({ agentId: 'oxi' });
    await new PendingSlot(storage, PENDING_CREATE_KEY, first.link, resolver(createNotFound).value).send(pending);
    const slot = new PendingSlot(storage, PENDING_CREATE_KEY, scriptedLink([]).link, resolver(serverError).value);
    await expect(slot.recover()).resolves.toMatchObject({ kind: 'unknown', reason: 'unreadable' });
  });

  it('abandons with one final read-back: admitted settles as accepted, anything else is dropped', async () => {
    const storage = new MemoryStorage();
    const first = scriptedLink([lost, lost]);
    const one = commandsOver(first.link).input(SESSION, { blocks: [{ type: 'text', Text: 'one' }] });
    await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), first.link, resolver(notFound).value).send(one);
    const found = new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), first.link, resolver(admitted).value);
    await expect(found.abandon()).resolves.toMatchObject({ kind: 'accepted', commandId: one.commandId });
    expect(found.read()).toBeUndefined();

    const two = commandsOver(first.link).input(SESSION, { blocks: [{ type: 'text', Text: 'two' }] });
    await new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), first.link, resolver(notFound).value).send(two);
    const failing = new PendingSlot(storage, pendingInputKey(SESSION, NAMESPACE), first.link, resolver(serverError).value);
    await expect(failing.abandon()).resolves.toMatchObject({ kind: 'abandoned', commandId: two.commandId });
    expect(failing.read()).toBeUndefined();
  });
});

it('sendOrAdopt treats the click as confirmation for an old retained create', async () => {
  const storage = new MemoryStorage();
  let now = 1_000;
  const first = scriptedLink([lost]);
  const retained = commandsOver(first.link).create({ agentId: 'oxi' });
  await new PendingSlot(storage, PENDING_CREATE_KEY, first.link, resolver(createNotFound).value, () => now).send(retained);
  now += STALE_SLOT_MS + 1;
  const second = scriptedLink([accepted]);
  const outcome = await sendOrAdopt(new PendingSlot(storage, PENDING_CREATE_KEY, second.link, resolver(createNotFound).value, () => now), () => commandsOver(second.link).create({ agentId: 'oxi' }));
  expect(outcome).toMatchObject({ kind: 'accepted', sessionId: retained.sessionId });
});

/** A storage-event source the test fires by hand. */
class FakeEvents {
  readonly listeners = new Set<(event: { key: string | null }) => void>();
  addEventListener(_type: 'storage', listener: (event: { key: string | null }) => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'storage', listener: (event: { key: string | null }) => void) { this.listeners.delete(listener); }
  fire(key: string | null) { for (const listener of this.listeners) listener({ key }); }
}

function controllerHarness({ answers = [], lookup = notFound as (sid: string, cid: string) => Promise<CommandStatus>, storage = new MemoryStorage(), key = pendingInputKey(SESSION, NAMESPACE), now = () => Date.now() } = {} as {
  answers?: Array<(request: { command_id: string }) => Promise<CommandStatus>>;
  lookup?: (sid: string, cid: string) => Promise<CommandStatus>;
  storage?: MemoryStorage;
  key?: string;
  now?: () => number;
}) {
  const { link, sent } = scriptedLink(answers);
  const lookups = resolver((sid, cid) => lookup(sid, cid));
  const events = new FakeEvents();
  const seen = { accepted: [] as string[], returned: [] as string[], rejected: [] as string[] };
  const controller = new PendingController(new PendingSlot(storage, key, link, lookups.value, now, null), {
    events,
    persistMessage: 'The message could not be saved before sending.',
    handlers: {
      onAccepted: (outcome, text) => seen.accepted.push(`${outcome.commandId}:${text}`),
      onReturned: (text) => seen.returned.push(text),
      onRejected: (error) => seen.rejected.push(error.message),
    },
  });
  const commands = commandsOver(link);
  const mint = (text: string) => commands.input(SESSION, { blocks: [{ type: 'text', Text: text }] });
  return { controller, link, sent, lookups, events, seen, storage, commands, mint };
}

describe('PendingController (composer input)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('clears the draft for an accepted input and reports it', async () => {
    const h = controllerHarness({ answers: [accepted] });
    h.controller.start();
    await expect(submitInput(h.controller, '  hello  ', h.mint)).resolves.toBe(true);
    expect(h.sent.map((entry) => JSON.parse(entry.bytes).blocks[0].Text)).toEqual(['hello']);
    expect(h.seen.accepted).toHaveLength(1);
    expect(h.controller.snapshot()).toEqual({ pending: null, error: null });
  });

  it('keeps the draft on a refusal, a blank text and a persist failure, and never claims a post-send failure was unsaved', async () => {
    const refused = controllerHarness({ answers: [() => Promise.reject(new CoreProtocolError({ error: { code: 'runtime_unavailable', message: 'Model not configured.', retryable: true } }))] });
    await expect(submitInput(refused.controller, 'x', refused.mint)).resolves.toBe(false);
    expect(refused.controller.snapshot().error?.message).toBe('Model not configured.');
    expect(refused.seen.returned).toEqual([]);
    await expect(submitInput(refused.controller, '   ', refused.mint)).resolves.toBe(false);

    const full = new MemoryStorage();
    full.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    const unsaved = controllerHarness({ storage: full, answers: [accepted] });
    await expect(submitInput(unsaved.controller, 'x', unsaved.mint)).resolves.toBe(false);
    expect(unsaved.controller.snapshot().error?.message).toBe('The message could not be saved before sending.');
    expect(unsaved.sent).toEqual([]);

    const afterSend = new MemoryStorage();
    let writes = 0;
    const setItem = afterSend.setItem.bind(afterSend);
    afterSend.setItem = (key, value) => { if (writes++ > 0) throw new DOMException('full', 'QuotaExceededError'); setItem(key, value); };
    const sentThenFull = controllerHarness({ storage: afterSend, answers: [lost] });
    await expect(submitInput(sentThenFull.controller, 'x', sentThenFull.mint)).resolves.toBe(true);
    expect(sentThenFull.controller.snapshot().error).toBeNull();
  });

  it('refuses a second submit while one is sending (busy) and while an input is retained', async () => {
    let release!: () => void;
    const h = controllerHarness({ answers: [(request) => new Promise((resolve) => { release = () => resolve({ command_id: request.command_id, status: 'accepted' } as CommandStatus); })] });
    const first = submitInput(h.controller, 'one', h.mint);
    await expect(submitInput(h.controller, 'two', h.mint)).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.snapshot().pending).toMatchObject({ text: 'one', phase: 'sending' });
    release();
    await expect(first).resolves.toBe(true);
    expect(h.sent).toHaveLength(1);

    const retained = controllerHarness({ answers: [lost] });
    await submitInput(retained.controller, 'kept', retained.mint);
    await expect(submitInput(retained.controller, 'next', retained.mint)).resolves.toBe(false);
    expect(retained.sent).toHaveLength(1);
    expect(retained.controller.snapshot().pending?.text).toBe('kept');
  });

  it('recovers a lost acknowledgement in the background: kicked at once, then resends the same bytes on 404', async () => {
    const h = controllerHarness({ answers: [lost, accepted] });
    h.controller.start();
    await expect(submitInput(h.controller, 'lost', h.mint)).resolves.toBe(true);
    expect(h.controller.snapshot().pending).toMatchObject({ text: 'lost', phase: 'waiting' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lookups.calls).toHaveLength(1);
    expect(h.sent.map((entry) => entry.bytes)).toEqual([h.sent[0]!.bytes, h.sent[0]!.bytes]);
    expect(h.seen.accepted).toHaveLength(1);
    expect(h.controller.snapshot().pending).toBeNull();
  });

  it('hands the text back when recovery finds the input rejected', async () => {
    const h = controllerHarness({ answers: [lost], lookup: async (_sid, commandId) => ({ command_id: commandId, status: 'rejected', error: { code: 'command_rejected', message: 'No.', retryable: false } } as CommandStatus) });
    h.controller.start();
    await submitInput(h.controller, 'refused later', h.mint);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.seen.returned).toEqual(['refused later']);
    expect(h.controller.snapshot().pending).toBeNull();
  });

  it('shows "unconfirmed" after repeated unreadable read-backs, then stops waiting with one final read-back', async () => {
    const h = controllerHarness({ answers: [lost], lookup: serverError });
    h.controller.start();
    await submitInput(h.controller, 'stuck', h.mint);
    for (let index = 0; index < UNCONFIRMED_AFTER_FAILURES; index++) await vi.advanceTimersByTimeAsync(30_000);
    expect(h.lookups.calls.length).toBeGreaterThanOrEqual(UNCONFIRMED_AFTER_FAILURES);
    expect(h.controller.snapshot().pending).toMatchObject({ phase: 'unconfirmed', sending: false });
    const lookupsBefore = h.lookups.calls.length;
    await h.controller.discard();
    expect(h.lookups.calls.length).toBe(lookupsBefore + 1);
    expect(h.seen.returned).toEqual(['stuck']);
    expect(h.controller.snapshot().pending).toBeNull();
    expect(h.storage.getItem(pendingInputKey(SESSION, NAMESPACE))).toBeNull();
  });

  it('settles as accepted, returning nothing, when the final read-back finds the input admitted', async () => {
    let admittedYet = false;
    const h = controllerHarness({ answers: [lost], lookup: (sid, cid) => admittedYet ? admitted(sid, cid) : serverError() });
    await submitInput(h.controller, 'arrived', h.mint);
    admittedYet = true;
    await h.controller.discard();
    expect(h.seen.accepted).toHaveLength(1);
    expect(h.seen.returned).toEqual([]);
  });

  it('asks before resending an old never-admitted input, and resends on retry', async () => {
    let now = 1_000;
    const storage = new MemoryStorage();
    const seed = controllerHarness({ storage, answers: [lost], now: () => now });
    await submitInput(seed.controller, 'old', seed.mint);
    now += 11 * 60_000;
    const h = controllerHarness({ storage, answers: [accepted], now: () => now });
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.snapshot().pending).toMatchObject({ text: 'old', phase: 'confirm' });
    await vi.advanceTimersByTimeAsync(10 * RECOVERY_BASE_DELAY_MS);
    expect(h.sent).toEqual([]);
    // It waits for the user rather than polling.
    expect(h.lookups.calls).toHaveLength(1);
    await h.controller.retry();
    expect(h.sent).toHaveLength(1);
    expect(h.seen.accepted).toHaveLength(1);
  });

  it('schedules the first retry when another tab\'s send lease expires, not after lease plus backoff', async () => {
    const storage = new MemoryStorage();
    const other = controllerHarness({ storage, answers: [() => new Promise(() => {})] });
    void submitInput(other.controller, 'elsewhere', other.mint);
    await vi.advanceTimersByTimeAsync(0);
    const h = controllerHarness({ storage, answers: [accepted] });
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lookups.calls).toHaveLength(1);
    expect(h.controller.snapshot().pending).toMatchObject({ phase: 'sending' });
    await vi.advanceTimersByTimeAsync(15_000 - 1);
    expect(h.lookups.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.lookups.calls).toHaveLength(2);
    expect(h.sent).toHaveLength(1);
  });

  it('follows another tab through storage events, including localStorage.clear()', async () => {
    const storage = new MemoryStorage();
    const h = controllerHarness({ storage, answers: [lost] });
    h.controller.start();
    await submitInput(h.controller, 'shared', h.mint);
    expect(h.controller.snapshot().pending).not.toBeNull();
    storage.values.clear();
    h.events.fire('some.other.key');
    expect(h.controller.snapshot().pending).not.toBeNull();
    h.events.fire(null);
    expect(h.controller.snapshot().pending).toBeNull();
  });

  it('stops recovering once stopped, and can be started again', async () => {
    const h = controllerHarness({ answers: [lost], lookup: serverError });
    const stop = h.controller.start();
    await submitInput(h.controller, 'x', h.mint);
    await vi.advanceTimersByTimeAsync(0);
    const calls = h.lookups.calls.length;
    stop();
    expect(h.events.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.lookups.calls.length).toBe(calls);
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lookups.calls.length).toBe(calls + 1);
  });
});

describe('PendingController (new thread)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('lets the user escape a create whose status Factory keeps answering 500', async () => {
    const h = controllerHarness({ key: PENDING_CREATE_KEY, answers: [lost], lookup: serverError });
    h.controller.start();
    const create = () => h.commands.create({ agentId: 'oxi' });
    const first = await h.controller.send(create, { adopt: true });
    expect(first).toMatchObject({ kind: 'unknown' });
    // Every later click adopts the same create; the read-back keeps failing.
    for (let index = 0; index < UNCONFIRMED_AFTER_FAILURES; index++) {
      await expect(h.controller.send(create, { adopt: true })).resolves.toMatchObject({ kind: 'unknown', reason: 'unreadable', commandId: first!.commandId });
    }
    expect(h.controller.snapshot().pending).toMatchObject({ phase: 'unconfirmed' });
    expect(h.sent).toHaveLength(1);

    await h.controller.discard();
    expect(h.controller.snapshot().pending).toBeNull();
    const fresh = scriptedLink([accepted]);
    const next = new PendingController(new PendingSlot(h.storage, PENDING_CREATE_KEY, fresh.link, resolver(createNotFound).value, Date.now, null), { events: null });
    await expect(next.send(() => commandsOver(fresh.link).create({ agentId: 'oxi' }), { adopt: true })).resolves.toMatchObject({ kind: 'accepted' });
    expect(fresh.sent).toHaveLength(1);
    expect(JSON.parse(fresh.sent[0]!.bytes).command_id).not.toBe(first!.commandId);
  });
});
