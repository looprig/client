import { afterEach, expect, it } from 'vitest';
import { CommandNotFoundError, NetworkError, PendingSlot, createFactoryCommands, type ClientLink, type CommandStatus, type CommandResolver } from '@looprig/client';

const session = '3f0c2a52-5b1e-4d6f-9a0e-2b7c1d4e5f60';
const key = 'looprig.test.pending.browser';
afterEach(() => localStorage.removeItem(key));
const resolver: CommandResolver = { resolve: async (sid, cid) => { throw new CommandNotFoundError(sid, cid); } };
const accepted = (request: { command_id: string }) => ({ command_id: request.command_id, status: 'accepted', accepted_order: 1 }) as CommandStatus;

function link(send: (request: { command_id: string }) => Promise<CommandStatus>) {
  const bytes: string[] = [];
  const client = { rpc: (_method: string, request: { command_id: string }) => {
    bytes.push(JSON.stringify(request));
    return send(request);
  } } as unknown as ClientLink;
  return { client, bytes };
}

it('keeps one command identity and byte-equal request through a browser storage reload after a lost acknowledgement', async () => {
  const first = link(async () => { throw new NetworkError('/v1/realtime'); });
  const pending = createFactoryCommands({ link: first.client, idGenerator: () => '00000000-0000-4000-8000-000000000001' })
    .input(session, { blocks: [{ type: 'text', Text: 'hello' }] });
  const sent = await new PendingSlot(localStorage, key, first.client, resolver, Date.now, null).send(pending);
  expect(sent.kind).toBe('unknown');
  expect(localStorage.getItem(key)).toContain(pending.commandId);

  const reloaded = link(async (request) => accepted(request));
  const slot = new PendingSlot(localStorage, key, reloaded.client, resolver, Date.now, null);
  expect(slot.read()?.bytes).toBe(pending.bytes);
  const outcome = await slot.recover({ force: true });
  expect(outcome?.kind).toBe('accepted');
  expect(reloaded.bytes).toEqual(first.bytes);
  expect(localStorage.getItem(key)).toBeNull();
});

it('holds a second browser view behind the stored in-flight lease', async () => {
  let finish!: (status: CommandStatus) => void;
  const first = link(() => new Promise<CommandStatus>((resolve) => { finish = resolve; }));
  const pending = createFactoryCommands({ link: first.client, idGenerator: () => '00000000-0000-4000-8000-000000000002' })
    .input(session, { blocks: [{ type: 'text', Text: 'two tabs' }] });
  const sending = new PendingSlot(localStorage, key, first.client, resolver, Date.now, null).send(pending);
  await Promise.resolve();
  const second = link(async (request) => accepted(request));
  const sibling = new PendingSlot(localStorage, key, second.client, resolver, Date.now, null);
  expect((await sibling.recover())?.kind).toBe('unknown');
  expect(second.bytes).toEqual([]);
  finish(accepted({ command_id: pending.commandId }));
  expect((await sending).kind).toBe('accepted');
  expect(localStorage.getItem(key)).toBeNull();
});
