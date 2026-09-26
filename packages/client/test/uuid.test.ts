import { expect, it, vi } from 'vitest';
import { createFactoryClient, createFactoryCommands, uuidV4 } from '../src/index.js';
import type { ClientLink } from '../src/index.js';

it('mints default Factory IDs on a plain HTTP origin without randomUUID', () => {
  const original = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) });
  try {
    const link = { state: 'disconnected' } as ClientLink;
    const client = createFactoryClient({ clientLinkFactory: () => link });
    const ids = new Set(Array.from({ length: 64 }, () => client.idGenerator()));
    expect(ids.size).toBe(64);
    const command = createFactoryCommands({ link }).create({ agentId: 'agent' });
    ids.add(command.commandId);
    ids.add(command.sessionId);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('builds UUID v4 bits from injected random bytes', () => {
  const zeros = { getRandomValues: <T extends ArrayBufferView>(b: T) => b };
  expect(uuidV4(zeros)).toBe('00000000-0000-4000-8000-000000000000');
});
