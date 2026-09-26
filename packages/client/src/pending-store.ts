import { CommandIdentityMismatchError, PendingCommand, type FactoryCommandMethod, type FactoryCommandRequest } from './commands.js';
import { CoreProtocolError, errorFromCoreEnvelope } from './errors.js';
import { validateCommandStatus, validateCoreErrorEnvelope } from './validate.js';
import type { ClientLink } from './clientlink.js';
import type { CommandStatus } from './types.js';
import type { FetchLike, RequestOptions } from './transport.js';

/**
 * Reload-durable pending commands.
 *
 * `PendingCommand` fixes a command's identity before it is sent, so a
 * lost acknowledgement is recovered by replaying the same bytes. The in-memory client keeps it
 * in memory only; this module keeps it in localStorage so a reload (or a
 * second tab) recovers the same command instead of minting another one.
 *
 * One slot per control: the injected namespace plus `.create` for a new thread
 * and `.<sessionId>` for a thread's composer input. A slot is
 * written BEFORE the first send and removed only on a durable outcome
 * (accepted, applied or rejected). Recovery reads the command back by its
 * identity: found means it was admitted (never resend), Factory's 404
 * `command_not_found` means it never was (resend the same id and bytes),
 * anything else keeps the slot. The route resolves the session before the
 * command, so a `session.create` that was never admitted has no session yet
 * and Factory answers 404 `session_not_found` instead; for a create slot (and
 * only a create slot) that means "never admitted" too.
 */

export function pendingCreateKey(namespace: string): string {
  return `${namespace}.create`;
}
export function pendingInputKey(sessionId: string, namespace: string): string {
  return `${namespace}.${sessionId}`;
}

/**
 * How long a send in flight in some tab holds off another tab's resend. A tab
 * that dies mid-send leaves its lease behind, so it must expire; the resend it
 * then allows is safe anyway, because it carries the same command identity.
 */
export const SEND_LEASE_MS = 15_000;

export type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface CommandResolver {
  resolve(sessionId: string, commandId: string, options?: RequestOptions): Promise<CommandStatus>;
}

/** The command-status route answered 404 `command_not_found`: this identity was never admitted. */
export class CommandNotFoundError extends Error {
  constructor(readonly sessionId: string, readonly commandId: string) {
    super('The command was not admitted.');
    this.name = 'CommandNotFoundError';
  }
}

/**
 * The command-status route answered 404 `session_not_found`. Factory resolves
 * the session before the command, so for a `session.create` this is how a
 * never-admitted command reads; for any other method the session is gone and
 * nothing is known about the command.
 */
export class PendingSessionNotFoundError extends CoreProtocolError {
  constructor(readonly sessionId: string, readonly commandId: string, body: ConstructorParameters<typeof CoreProtocolError>[0]) {
    super(body);
    this.name = 'PendingSessionNotFoundError';
  }
}

function errorCode(data: unknown): unknown {
  const error = data && typeof data === 'object' ? (data as { error?: unknown }).error : undefined;
  return error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
}

/** Whether a read-back failure means `pending` was never admitted, so resending its bytes is safe. */
function neverAdmitted(pending: PendingCommand, cause: unknown): boolean {
  if (cause instanceof CommandNotFoundError) return true;
  return pending.method === 'session.create' && cause instanceof PendingSessionNotFoundError
    && cause.sessionId === pending.sessionId && cause.commandId === pending.commandId;
}

/** Reads `GET <baseUrl>/v1/sessions/{sid}/commands/{cid}` through the injected fetch. */
export function createCommandResolver(fetchImpl: FetchLike, baseUrl = ''): CommandResolver {
  return {
    async resolve(sessionId, commandId, options = {}) {
      const url = `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}`;
      const response = await fetchImpl(url, { method: 'GET', signal: options.signal });
      const data: unknown = await response.json().catch(() => undefined);
      // Only Factory's own answer means "never admitted"; a 404 from anything
      // else (a proxy, a missing route) says nothing about the command.
      if (response.status === 404 && errorCode(data) === 'command_not_found') throw new CommandNotFoundError(sessionId, commandId);
      if (!response.ok) {
        try {
          const envelope = validateCoreErrorEnvelope(data);
          if (response.status === 404 && envelope.error.code === 'session_not_found') throw new PendingSessionNotFoundError(sessionId, commandId, envelope);
          throw errorFromCoreEnvelope(envelope);
        } catch (cause) {
          if (cause instanceof CoreProtocolError) throw cause;
          throw new Error(`Command status request failed (${response.status}).`, { cause });
        }
      }
      const status = validateCommandStatus(data);
      if (status.command_id !== commandId) throw new CommandIdentityMismatchError(commandId as never, status.command_id);
      return status;
    },
  };
}

export type PendingOutcome =
  /** Admitted (accepted or applied): the slot is cleared. */
  | { kind: 'accepted'; sessionId: string; commandId: string; status: CommandStatus }
  /** Decided against: the slot is cleared, nothing was admitted. */
  | { kind: 'rejected'; sessionId: string; commandId: string; error: Error }
  /** Not known yet: the slot is kept for a later recovery. */
  | { kind: 'unknown'; sessionId: string; commandId: string; reason: UnknownReason; error?: unknown }
  /**
   * Never admitted, and retained longer than `STALE_SLOT_MS`: nothing was
   * sent, because resending something that old needs the user's confirmation.
   */
  | { kind: 'unsent'; sessionId: string; commandId: string }
  /** Nothing was sent: this control already retains another command. */
  | { kind: 'busy'; sessionId: string; commandId: string };

/**
 * Why an outcome is unknown. Only `unreadable` (the read-back itself failed:
 * a network fault, or a status Factory could not describe) says nothing about
 * whether it ever will be known; callers count those.
 */
export type UnknownReason = 'unreadable' | 'lost' | 'in-flight' | 'moved';

/** The result of giving up on a retained command after one last read-back. */
export type AbandonOutcome =
  | Extract<PendingOutcome, { kind: 'accepted' }>
  | { kind: 'abandoned'; sessionId: string; commandId: string; request: FactoryCommandRequest };

/** A retained command older than this is never resent without the user's confirmation. */
export const STALE_SLOT_MS = 10 * 60_000;
/** A retained command older than this is dropped at startup. */
export const SWEEP_SLOT_MS = 7 * 24 * 60 * 60_000;


/** The part of the Web Locks API a slot needs. */
export interface LockManagerLike {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
}

function defaultLocks(): LockManagerLike | null {
  const locks = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return null;
  return { request: (name, callback) => (locks as unknown as LockManagerLike).request(name, () => callback()) };
}

/** The slot could not be persisted, so nothing was sent. */
export class PendingPersistError extends Error {
  constructor(cause: unknown) {
    super('The command could not be saved before sending.', { cause });
    this.name = 'PendingPersistError';
  }
}

type StoredSlot = {
  v: 2;
  commandId: string;
  method: FactoryCommandMethod;
  /** `PendingCommand.bytes`, verbatim. */
  request: string;
  /** Epoch ms until which some tab's send is in flight; 0 when none is. */
  inFlightUntil: number;
  /** Epoch ms of the first persist; 0 for a v1 slot, which recorded none (treated as old). */
  createdAt: number;
};

const METHODS: readonly FactoryCommandMethod[] = ['session.create', 'session.input', 'session.interrupt', 'session.restore', 'gate.respond'];

function parseSlot(raw: string | null): StoredSlot | undefined {
  if (raw === null) return;
  try {
    const value = JSON.parse(raw) as Partial<Omit<StoredSlot, 'v'>> & { v?: unknown };
    if ((value.v !== 1 && value.v !== 2) || typeof value.request !== 'string' || typeof value.commandId !== 'string') return;
    if (!METHODS.includes(value.method as FactoryCommandMethod)) return;
    const request = JSON.parse(value.request) as Partial<FactoryCommandRequest>;
    if (request.command_id !== value.commandId || typeof request.session_id !== 'string') return;
    return {
      v: 2,
      commandId: value.commandId,
      method: value.method as FactoryCommandMethod,
      request: value.request,
      inFlightUntil: Number(value.inFlightUntil) || 0,
      createdAt: value.v === 2 ? Number(value.createdAt) || 0 : 0,
    };
  } catch {
    return;
  }
}

function asError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback, { cause });
}

/**
 * Drops every pending slot older than `SWEEP_SLOT_MS`; returns the keys it
 * removed. A v1 slot recorded no age and is left for its control to settle.
 */
export function sweepPendingSlots(storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'>, namespace: string, now = Date.now()): string[] {
  const slotPrefix = `${namespace}.`;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(slotPrefix)) keys.push(key);
  }
  return keys.filter((key) => {
    const slot = parseSlot(storage.getItem(key));
    if (!slot?.createdAt || now - slot.createdAt <= SWEEP_SLOT_MS) return false;
    storage.removeItem(key);
    return true;
  });
}

type Claim = { kind: 'claimed' } | { kind: 'busy' | 'moved' | 'leased' | 'stale'; held?: StoredSlot };

/** One control's durable pending command. Cheap to construct; holds no state beyond storage. */
export class PendingSlot {
  constructor(
    private readonly storage: PendingStorage,
    readonly key: string,
    private readonly link: ClientLink,
    private readonly resolver: CommandResolver,
    private readonly now: () => number = Date.now,
    /** Serializes check-and-write across tabs; `null` checks and writes unlocked. */
    private readonly locks: LockManagerLike | null = defaultLocks(),
  ) {}

  /** The retained command, rebuilt from storage with its original identity and bytes. */
  read(): PendingCommand | undefined {
    const slot = this.slot();
    if (!slot) return;
    return new PendingCommand(slot.method, JSON.parse(slot.request) as FactoryCommandRequest, this.link, this.resolver);
  }

  /** Persists `pending`, then sends it once. Refuses when another command is retained. */
  async send(pending: PendingCommand): Promise<PendingOutcome> {
    const claim = await this.claim(pending, { held: false, lease: false, fresh: false });
    if (claim.kind !== 'claimed') {
      const held = claim.held;
      return { kind: 'busy', sessionId: held ? String(JSON.parse(held.request).session_id) : pending.sessionId, commandId: held?.commandId ?? pending.commandId };
    }
    return this.settle(pending, await pending.attempt());
  }

  /**
   * Settles whatever this slot retains: read back by identity first, and only
   * resend (same id, same bytes) when the command was never admitted, no tab's
   * send is in flight and the command is not old. `confirmed` accepts an old
   * command's resend (the user asked for it); `force` also skips the lease (an
   * explicit retry).
   */
  async recover({ force = false, confirmed = force }: { force?: boolean; confirmed?: boolean } = {}): Promise<PendingOutcome | undefined> {
    const pending = this.read();
    if (!pending) return;
    try {
      return await this.settleStatus(pending, await pending.resolve());
    } catch (cause) {
      if (!neverAdmitted(pending, cause)) return this.unknown(pending, 'unreadable', cause);
    }
    const claim = await this.claim(pending, { held: true, lease: !force, fresh: !confirmed });
    if (claim.kind === 'stale') return { kind: 'unsent', sessionId: pending.sessionId, commandId: pending.commandId };
    if (claim.kind === 'leased') return this.unknown(pending, 'in-flight');
    if (claim.kind !== 'claimed') return this.unknown(pending, 'moved');
    return this.settle(pending, await pending.attempt());
  }

  /** Whether some tab's send of the retained command is in flight (its lease has not expired). */
  inFlight(): boolean {
    return this.leaseRemaining() > 0;
  }

  /** Milliseconds until some tab's in-flight lease on the retained command expires; 0 when none is held. */
  leaseRemaining(): number {
    return Math.max(0, (this.slot()?.inFlightUntil ?? 0) - this.now());
  }

  /** Whether the retained command is old enough that resending it needs confirmation. */
  stale(): boolean {
    const slot = this.slot();
    return Boolean(slot) && this.isStale(slot!);
  }

  /** Forgets the retained command if it is still `commandId`. The user gave up on knowing. */
  async discard(commandId: string): Promise<void> {
    await this.exclusive(() => {
      if (this.slot()?.commandId === commandId) this.storage.removeItem(this.key);
    });
  }

  /**
   * Gives up on the retained command after one last read-back: if it was
   * admitted after all it settles as accepted; otherwise (never admitted,
   * rejected, or still unknowable) it is dropped.
   */
  async abandon(): Promise<AbandonOutcome | undefined> {
    const pending = this.read();
    if (!pending) return;
    try {
      const status = await pending.resolve();
      if (status.status === 'accepted' || status.status === 'applied') {
        await this.discard(pending.commandId);
        return { kind: 'accepted', sessionId: pending.sessionId, commandId: pending.commandId, status };
      }
    } catch {
      // Unknowable: the user chose to stop waiting anyway.
    }
    await this.discard(pending.commandId);
    return { kind: 'abandoned', sessionId: pending.sessionId, commandId: pending.commandId, request: pending.request };
  }

  private isStale(slot: StoredSlot): boolean {
    return slot.createdAt === 0 || this.now() - slot.createdAt > STALE_SLOT_MS;
  }

  /**
   * The atomic step: under the slot's cross-tab lock, check what is retained
   * and (only if the checks pass) write `pending` with a fresh send lease.
   */
  private claim(pending: PendingCommand, { held: requireHeld, lease, fresh }: { held: boolean; lease: boolean; fresh: boolean }): Promise<Claim> {
    return this.exclusive((): Claim => {
      const held = this.slot();
      if (held && held.commandId !== pending.commandId) return { kind: requireHeld ? 'moved' : 'busy', held };
      if (!held && requireHeld) return { kind: 'moved' };
      if (held && lease && held.inFlightUntil > this.now()) return { kind: 'leased', held };
      if (held && fresh && this.isStale(held)) return { kind: 'stale', held };
      try {
        this.write({
          v: 2,
          commandId: pending.commandId,
          method: pending.method,
          request: pending.bytes,
          inFlightUntil: this.now() + SEND_LEASE_MS,
          createdAt: held?.createdAt || this.now(),
        });
      } catch (cause) {
        throw new PendingPersistError(cause);
      }
      return { kind: 'claimed' };
    });
  }

  private exclusive<T>(work: () => T): Promise<T> {
    if (!this.locks) return (async () => work())();
    return this.locks.request(this.key, work);
  }

  private async settle(pending: PendingCommand, attempt: Awaited<ReturnType<PendingCommand['attempt']>>): Promise<PendingOutcome> {
    if (attempt.outcome === 'resolved') return this.settleStatus(pending, attempt.status);
    if (attempt.outcome === 'rejected') {
      await this.bestEffort(() => this.discard(pending.commandId));
      return { kind: 'rejected', sessionId: pending.sessionId, commandId: pending.commandId, error: attempt.error };
    }
    // The send happened; releasing its lease early only lets a resend come
    // sooner, so a failed write here (a full quota) is not the caller's error.
    await this.bestEffort(() => this.exclusive(() => {
      const current = this.slot();
      if (current?.commandId === pending.commandId) this.write({ ...current, inFlightUntil: 0 });
    }));
    return this.unknown(pending, 'lost', attempt.error);
  }

  private async settleStatus(pending: PendingCommand, status: CommandStatus): Promise<PendingOutcome> {
    if (status.status === 'accepted' || status.status === 'applied') {
      await this.bestEffort(() => this.discard(pending.commandId));
      return { kind: 'accepted', sessionId: pending.sessionId, commandId: pending.commandId, status };
    }
    if (status.status === 'rejected') {
      await this.bestEffort(() => this.discard(pending.commandId));
      const message = status.error?.message || status.error?.code || 'The command was rejected.';
      return { kind: 'rejected', sessionId: pending.sessionId, commandId: pending.commandId, error: new Error(message) };
    }
    return this.unknown(pending, 'unreadable');
  }

  private async bestEffort(work: () => Promise<void>): Promise<void> {
    try { await work(); } catch { /* storage refused; the outcome stands */ }
  }

  private unknown(pending: PendingCommand, reason: UnknownReason, cause?: unknown): PendingOutcome {
    return { kind: 'unknown', sessionId: pending.sessionId, commandId: pending.commandId, reason, ...(cause === undefined ? {} : { error: asError(cause, 'The command outcome is unknown.') }) };
  }

  private slot(): StoredSlot | undefined {
    const raw = this.storage.getItem(this.key);
    const slot = parseSlot(raw);
    // A slot this build cannot read is never sent: drop it rather than guess.
    if (raw !== null && !slot) this.storage.removeItem(this.key);
    return slot;
  }

  private write(slot: StoredSlot): void {
    this.storage.setItem(this.key, JSON.stringify(slot));
  }
}

/**
 * One user action on a single-command control: if a command is already
 * retained (a lost acknowledgement, or another tab's send), complete THAT one
 * rather than minting another; otherwise mint, persist and send. The action
 * itself confirms resending an old retained command.
 */
export async function sendOrAdopt(slot: PendingSlot, mint: () => PendingCommand): Promise<PendingOutcome> {
  const held = slot.read();
  if (held) return (await slot.recover({ confirmed: true })) ?? sendOrAdopt(slot, mint);
  const outcome = await slot.send(mint());
  if (outcome.kind !== 'busy') return outcome;
  return (await slot.recover({ confirmed: true })) ?? { kind: 'unknown', sessionId: outcome.sessionId, commandId: outcome.commandId, reason: 'moved' };
}

/** The text an input command will replay (its text blocks, joined). */
export function pendingInputText(request: FactoryCommandRequest): string {
  const blocks = 'blocks' in request && Array.isArray(request.blocks) ? request.blocks : [];
  return blocks
    .map((block) => (block.type === 'text' && typeof block.Text === 'string' ? block.Text : ''))
    .filter(Boolean)
    .join('\n');
}

export const RECOVERY_BASE_DELAY_MS = 2_000;
export const RECOVERY_MAX_DELAY_MS = 30_000;
/** Consecutive unreadable read-backs after which a retained command is shown as unconfirmable. */
export const UNCONFIRMED_AFTER_FAILURES = 3;

/**
 * Where a retained command stands, as the UI shows it:
 * - `sending`: this tab is acting on it, or some tab's send is in flight;
 * - `waiting`: its outcome is unknown and recovery keeps checking;
 * - `unconfirmed`: `UNCONFIRMED_AFTER_FAILURES` read-backs in a row failed
 *   (e.g. Factory answers 500 for a command rejected mid-attempt), so it may
 *   never be known; recovery keeps checking, but the user is told and can
 *   stop waiting;
 * - `confirm`: never admitted and old, so it is not resent without the user.
 */
export type PendingPhase = 'sending' | 'waiting' | 'unconfirmed' | 'confirm';

/** What a control shows for its retained command. */
export type PendingView = {
  readonly commandId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly phase: PendingPhase;
  /** `phase === 'sending'`. */
  readonly sending: boolean;
};

export type PendingState = { readonly pending: PendingView | null; readonly error: Error | null };

export type PendingOrigin = 'action' | 'recovery';

export interface PendingControllerHandlers {
  /** Admitted, by this tab's action or by recovery (including a final read-back on stop-waiting). */
  onAccepted?(outcome: { sessionId: string; commandId: string }, text: string, origin: PendingOrigin): void;
  /** Decided against. An action's text is still where the user typed it; recovery's is not. */
  onRejected?(error: Error, text: string, origin: PendingOrigin): void;
  /** Not admitted after the text had left the draft (recovery rejected it, or the user stopped waiting): offer it back. */
  onReturned?(text: string): void;
}

export interface PendingTimers {
  set(callback: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

type StorageEventTarget = {
  addEventListener(type: 'storage', listener: (event: { key: string | null }) => void): void;
  removeEventListener(type: 'storage', listener: (event: { key: string | null }) => void): void;
};

const browserTimers: PendingTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export type PendingControllerOptions = {
  handlers?: PendingControllerHandlers;
  /** The text a retained request carries (shown, and handed back). */
  textOf?: (request: FactoryCommandRequest) => string;
  /** The error shown when the slot cannot be persisted, so nothing was sent. */
  persistMessage?: string;
  timers?: PendingTimers;
  /** Where cross-tab `storage` events arrive; `null` for none. */
  events?: StorageEventTarget | null;
};

/**
 * One control's retained command as plain, testable state: sending,
 * background recovery with backoff, cross-tab storage events, stop-waiting and
 * the unconfirmed/confirm phases. A React hook subscribes to it; nothing here
 * depends on React.
 *
 * Operations on the slot are serialized (a background recovery and a click on
 * "Stop waiting" never race each other), but a second user action while one
 * is running is refused rather than queued, so a double click sends once.
 */
export class PendingController {
  private state: PendingState = { pending: null, error: null };
  private readonly listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private acting = false;
  private tracked: string | undefined;
  private failures = 0;
  private confirm = false;
  private alive = false;
  private timer: unknown;
  private delay = 0;
  private handlers: PendingControllerHandlers;
  private readonly textOf: (request: FactoryCommandRequest) => string;
  private readonly timers: PendingTimers;
  private readonly events: StorageEventTarget | null;
  private readonly persistMessage: string;

  constructor(readonly slot: PendingSlot, options: PendingControllerOptions = {}) {
    this.handlers = options.handlers ?? {};
    this.textOf = options.textOf ?? pendingInputText;
    this.timers = options.timers ?? browserTimers;
    this.events = options.events === undefined ? defaultEvents() : options.events;
    this.persistMessage = options.persistMessage ?? 'The command could not be saved before sending.';
    this.refresh();
  }

  /** Replaces the handlers (a React caller passes its latest callbacks from an effect). */
  setHandlers(handlers: PendingControllerHandlers): void {
    this.handlers = handlers;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly snapshot = (): PendingState => this.state;

  /** Starts background recovery and cross-tab listening; returns the stop function. Restartable. */
  readonly start = (): (() => void) => {
    this.alive = true;
    this.events?.addEventListener('storage', this.onStorage);
    this.kick();
    return () => {
      this.alive = false;
      if (this.timer !== undefined) this.timers.clear(this.timer);
      this.timer = undefined;
      this.events?.removeEventListener('storage', this.onStorage);
    };
  };

  /** Runs recovery now, restarting its backoff. */
  readonly kick = (): void => {
    if (!this.alive) return;
    this.delay = 0;
    this.schedule(0);
  };

  /**
   * One user action. With a command already retained it refuses (`busy`)
   * unless `adopt`, when it completes the retained one instead of minting
   * (the action confirms resending an old one). Resolves undefined when
   * nothing was attempted (another action is running, or `mint` threw).
   */
  readonly send = (mint: () => PendingCommand, { adopt = false }: { adopt?: boolean } = {}): Promise<PendingOutcome | undefined> => {
    if (this.acting) return Promise.resolve(undefined);
    this.acting = true;
    return this.serial(async () => {
      try {
        const held = this.slot.read();
        if (held && !adopt) {
          this.refresh();
          return { kind: 'busy', sessionId: held.sessionId, commandId: held.commandId } as const;
        }
        let command = held;
        if (!command) {
          try {
            command = mint();
          } catch (cause) {
            this.update({ error: asError(cause, 'The command could not be prepared.') });
            return undefined;
          }
        }
        const text = this.textOf(command.request);
        this.update({ pending: this.view(command, 'sending'), error: null });
        let outcome: PendingOutcome;
        try {
          const minted = command;
          outcome = held ? await sendOrAdopt(this.slot, mint)
            : adopt ? await sendOrAdopt(this.slot, () => minted)
              : await this.slot.send(command);
        } catch (cause) {
          // Only the pre-send persist is the user's "not saved" error; anything
          // else leaves whatever the slot now holds to recovery.
          this.refresh(cause instanceof PendingPersistError ? new Error(this.persistMessage, { cause }) : asError(cause, 'The outcome is unknown.'));
          return undefined;
        }
        this.settle(outcome, text, 'action');
        return outcome;
      } finally {
        this.acting = false;
      }
    });
  };

  /** Reads back, then resends the SAME command if it was never admitted, even when old (an explicit retry). */
  readonly retry = (): Promise<void> => this.serial(() => this.recoverNow({ force: true }));

  /**
   * Stops waiting: one final read-back first. Admitted after all settles as
   * accepted; otherwise the command is forgotten and its text handed back. It
   * may still have been delivered if the read-back could not tell.
   */
  readonly discard = (): Promise<void> => this.serial(async () => {
    const held = this.slot.read();
    if (!held) { this.refresh(); return; }
    const text = this.textOf(held.request);
    this.update({ pending: this.view(held, 'sending') });
    let outcome: AbandonOutcome | undefined;
    try {
      outcome = await this.slot.abandon();
    } catch (cause) {
      this.refresh(asError(cause, 'Could not stop waiting.'));
      return;
    }
    this.refresh(null);
    if (outcome?.kind === 'accepted') this.handlers.onAccepted?.(outcome, text, 'recovery');
    else if (outcome) this.handlers.onReturned?.(text);
  });

  private readonly onStorage = (event: { key: string | null }): void => {
    // `localStorage.clear()` reports a null key: every slot may have changed.
    if (event.key !== null && event.key !== this.slot.key) return;
    this.refresh();
    this.kick();
  };

  private schedule(ms: number): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => void this.run(), ms);
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    if (!this.alive) return;
    if (!this.slot.read()) { this.delay = 0; this.refresh(); return; }
    await this.serial(() => this.recoverNow({}));
    if (!this.alive || this.timer !== undefined) return;
    if (!this.slot.read()) { this.delay = 0; return; }
    // An old never-admitted command waits for the user (retry or stop waiting).
    if (this.confirm) return;
    // Another tab's send is in flight: look again when its lease runs out.
    const lease = this.slot.leaseRemaining();
    if (lease > 0) { this.schedule(lease); return; }
    this.delay = Math.min(Math.max(this.delay * 2, RECOVERY_BASE_DELAY_MS), RECOVERY_MAX_DELAY_MS);
    this.schedule(this.delay);
  }

  private async recoverNow(options: { force?: boolean }): Promise<void> {
    const held = this.slot.read();
    if (!held) { this.refresh(); return; }
    const text = this.textOf(held.request);
    if (options.force) this.update({ pending: this.view(held, 'sending') });
    let outcome: PendingOutcome | undefined;
    try {
      outcome = await this.slot.recover(options);
    } catch (cause) {
      this.failures += 1;
      this.refresh(asError(cause, 'The outcome is unknown.'));
      return;
    }
    if (outcome) this.settle(outcome, text, 'recovery');
    else this.refresh();
  }

  private settle(outcome: PendingOutcome, text: string, origin: PendingOrigin): void {
    switch (outcome.kind) {
      case 'accepted':
        this.refresh(null);
        this.handlers.onAccepted?.(outcome, text, origin);
        return;
      case 'rejected':
        this.refresh(outcome.error);
        this.handlers.onRejected?.(outcome.error, text, origin);
        if (origin === 'recovery') this.handlers.onReturned?.(text);
        return;
      case 'unknown':
        this.failures = outcome.reason === 'unreadable' ? this.failures + 1 : 0;
        this.confirm = false;
        // The pending view says so; this is not an error to show twice.
        this.refresh(null);
        if (origin === 'action') this.kick();
        return;
      case 'unsent':
        this.failures = 0;
        this.confirm = true;
        this.refresh(null);
        return;
      case 'busy':
        this.refresh();
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private view(pending: PendingCommand, phase?: PendingPhase): PendingView {
    if (pending.commandId !== this.tracked) {
      this.tracked = pending.commandId;
      this.failures = 0;
      this.confirm = false;
    }
    const resolved = phase ?? (this.slot.inFlight() ? 'sending'
      : this.confirm ? 'confirm'
        : this.failures >= UNCONFIRMED_AFTER_FAILURES ? 'unconfirmed' : 'waiting');
    return { commandId: pending.commandId, sessionId: pending.sessionId, text: this.textOf(pending.request), phase: resolved, sending: resolved === 'sending' };
  }

  /** Re-reads the slot; `error` replaces the shown error unless undefined. */
  private refresh(error?: Error | null): void {
    const held = this.slot.read();
    if (!held) { this.tracked = undefined; this.failures = 0; this.confirm = false; }
    this.update({ pending: held ? this.view(held) : null, ...(error === undefined ? {} : { error }) });
  }

  private update(next: Partial<PendingState>): void {
    const pending = next.pending === undefined ? this.state.pending : next.pending;
    const error = next.error === undefined ? this.state.error : next.error;
    if (samePending(pending, this.state.pending) && error === this.state.error) return;
    this.state = { pending, error };
    for (const listener of this.listeners) listener();
  }
}

function samePending(left: PendingView | null, right: PendingView | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.commandId === right.commandId && left.phase === right.phase && left.text === right.text && left.sessionId === right.sessionId;
}

function defaultEvents(): StorageEventTarget | null {
  return typeof window === 'undefined' ? null : window as unknown as StorageEventTarget;
}

/**
 * The composer's submit over a controller. Resolves true when the draft may
 * be cleared: the input was admitted, or it is retained as the pending row.
 * False leaves the draft where it is: nothing was sent (blank, busy, another
 * input retained, not persisted) or the send was refused outright.
 */
export async function submitInput(controller: PendingController, text: string, mint: (trimmed: string) => PendingCommand): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const outcome = await controller.send(() => mint(trimmed));
  return outcome?.kind === 'accepted' || outcome?.kind === 'unknown';
}
