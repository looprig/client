/**
 * One logical user action, one command identity, retained until it reaches a
 * durable outcome.
 *
 * ## Where the identity lives, and where it deliberately does not
 *
 * `@looprig/client`'s `PendingCommand` already owns the retry-stable half:
 * it snapshots the exact V1 envelope once, `retry()` replays those same bytes
 * without minting a replacement, and `submit()` throws
 * `CommandIdentityMismatchError` on a reply naming another command. What it
 * does NOT own is WHICH envelope a control is currently holding — a class with
 * no name for "the input command this session's composer is waiting on" cannot
 * stop a second click from constructing a second one.
 *
 * That naming is what this module adds, and it is scoped to
 * `FactoryClient.commands` — the command plane — NOT to `FactoryLinkStore`.
 * The link is a socket: it reconnects, it drops bindings, it knows nothing
 * about user actions, and hanging pending-command state off it would tie the
 * lifetime of a durable identity to the lifetime of a transport.
 *
 * ## Why the retained envelopes outlive the store that made them
 *
 * A React component unmounts for reasons that have nothing to do with the
 * command it sent: a route change, a suspense boundary, a `key` change,
 * StrictMode's own mount/unmount/mount. If the envelope died with the
 * component, the retry after a remount would mint a NEW identity — which is
 * exactly the duplicate logical command this whole task exists to prevent, and
 * it would be minted by the recovery path rather than by the user.
 *
 * So the slots live in a `WeakMap` keyed by the `FactoryCommands` instance —
 * i.e. by the application's one command plane, released when the client is —
 * and sub-keyed by session. A store instance is a VIEW onto them: it adopts
 * whatever is retained the moment it attaches, which is what makes a remount
 * inherit rather than restart. Nothing is keyed by component identity, because
 * component identity is precisely the thing that does not survive.
 *
 * ## What is deliberately NOT serialized
 *
 * A scope is one session, and within a scope a slot is one CONTROL (the
 * composer's input, the interrupt, one gate). Two sessions therefore never
 * contend, and neither do the composer and a gate in the same session: a
 * retained envelope blocks a second envelope for ITS OWN control and nothing
 * else. A single global "one command in flight" latch would be simpler and
 * would be wrong — one slow session would freeze every other tab pane.
 */
import { CoreProtocolError, errorFromCoreEnvelope } from "@looprig/client";
import type {
  CommandAttempt,
  CommandStatus,
  CoreErrorEnvelope,
  FactoryCommandRequest,
  FactoryCommands,
  PendingCommand,
} from "@looprig/client";
import { Publisher, asError } from "./publisher.js";

/**
 * What a renderer needs about one retained envelope: which command it is,
 * whether an attempt is in flight, and the request it will replay.
 *
 * `request` is a FRESH parse per READ — it is a getter over
 * `PendingCommand.request`, which is that class's own contract, and it is
 * deliberately not cached. Caching one parse and handing it to every view
 * would be cheaper and would quietly remove the property that makes it safe:
 * the object is not frozen, so one consumer writing to `request.blocks[0]`
 * would be seen by every other view of the same slot. The retry itself is
 * unaffected either way — `PendingCommand.submit` re-reads its own snapshot —
 * so this is about what a renderer may believe about the value it was handed.
 */
export interface PendingCommandView {
  readonly commandId: string;
  /** True while an attempt is in flight; false while it waits for a retry. */
  readonly sending: boolean;
  readonly request: FactoryCommandRequest;
}

/**
 * The outcome of one attempt, with ambiguity preserved as data.
 *
 * `accepted` and `rejected` are DURABLE and release the envelope: Core's
 * `CommandStatus` defines `accepted` and `applied` as admitted records and
 * `rejected` as a decision. `pending` and `unknown` retain it — the first
 * because Core has not decided yet, the second because the reply was lost and
 * admission may already have committed, which is the one case where minting a
 * second identity would double-apply the user's action.
 */
export type CommandResult =
  | { readonly outcome: "accepted"; readonly commandId: string; readonly status: CommandStatus }
  | { readonly outcome: "pending"; readonly commandId: string; readonly status: CommandStatus }
  | { readonly outcome: "rejected"; readonly commandId: string; readonly error: CoreProtocolError }
  | { readonly outcome: "unknown"; readonly commandId: string; readonly error: Error }
  /** Nothing was sent: an envelope for this control is already retained. Its id is returned. */
  | { readonly outcome: "refused"; readonly commandId: string }
  /** The retained envelope was cancelled or superseded while this attempt was in flight. */
  | { readonly outcome: "cancelled"; readonly commandId: string }
  /** Nothing was sent and nothing is retained — an empty draft, a retry with no envelope, a refused input. */
  | { readonly outcome: "none" };

export interface SessionCommandSnapshot {
  /** The retained envelope for each control key that has one. */
  readonly pending: ReadonlyMap<string, PendingCommandView>;
  /** The last failure for each control key — retryable while its envelope is retained, final once it is not. */
  readonly errors: ReadonlyMap<string, Error>;
}

const EMPTY: SessionCommandSnapshot = { pending: new Map(), errors: new Map() };

interface Slot {
  readonly command: PendingCommand;
  sending: boolean;
}

/**
 * The retained state for one session, shared by every store instance that
 * names it. `listeners` is what lets two views of the same session agree, and
 * together with `slots` it is what decides when the scope may be discarded.
 */
class CommandScope {
  readonly slots = new Map<string, Slot>();
  readonly errors = new Map<string, Error>();
  readonly listeners = new Set<() => void>();

  notify(): void {
    // Copied before iterating, for the reason `Publisher.publish` gives.
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Nothing retained and nobody watching. An error alone does not keep a scope
   * alive: it is presentation state for a command that is already over, and
   * the last unmount is the moment it stops being renderable.
   */
  get disposable(): boolean {
    return this.slots.size === 0 && this.listeners.size === 0;
  }
}

const SCOPES = new WeakMap<FactoryCommands, Map<string, CommandScope>>();

function scopeOf(commands: FactoryCommands, sessionId: string): CommandScope {
  let bySession = SCOPES.get(commands);
  if (bySession === undefined) {
    bySession = new Map();
    SCOPES.set(commands, bySession);
  }
  let scope = bySession.get(sessionId);
  if (scope === undefined) {
    scope = new CommandScope();
    bySession.set(sessionId, scope);
  }
  return scope;
}

/**
 * Drops a scope that retains nothing and is watched by nobody, so the map does
 * not grow by one entry per session a tab ever opened. Safe because a store
 * resolves its scope on every operation rather than holding one: a discarded
 * empty scope and a freshly created one are indistinguishable.
 */
/** Reads a scope without creating one. See `SessionCommandStore`'s constructor. */
function peekScope(commands: FactoryCommands, sessionId: string): CommandScope | undefined {
  return SCOPES.get(commands)?.get(sessionId);
}

function disposeScope(commands: FactoryCommands, sessionId: string): void {
  const bySession = SCOPES.get(commands);
  const scope = bySession?.get(sessionId);
  if (bySession !== undefined && scope !== undefined && scope.disposable) bySession.delete(sessionId);
}

/**
 * Core's `CommandStatus` makes `error` optional even on a `rejected` record, so
 * a rejection with no detail is mapped to `command_rejected` — the code Core's
 * own vocabulary already defines for exactly this decision — rather than to an
 * invented one. Either way the caller gets a typed `CoreProtocolError` and
 * never has to read a message string.
 */
function rejection(status: CommandStatus): CoreProtocolError {
  const envelope: CoreErrorEnvelope = {
    error: status.error ?? { code: "command_rejected", retryable: false },
  };
  return errorFromCoreEnvelope(envelope);
}

/** The write half of one session's controls: mint once, retain, replay, release. */
export abstract class SessionCommandStore extends Publisher<SessionCommandSnapshot> {
  readonly #commands: FactoryCommands;
  readonly #sessionId: string;
  /** Whether this store's own listener is on the scope. See `#emit`. */
  #attached = false;

  protected constructor(commands: FactoryCommands, sessionId: string) {
    super(EMPTY);
    this.#commands = commands;
    this.#sessionId = sessionId;
    // Adopt whatever is already retained BEFORE the first render reads the
    // snapshot. A remount that showed an empty composer for one frame and then
    // filled it in from an effect would flicker, and a caller that submitted in
    // that frame would be refused by a control it had not been told about.
    this.#sync();
  }

  /** The command plane this store mints on. Subclasses build their own envelopes from it. */
  protected get commands(): FactoryCommands {
    return this.#commands;
  }

  protected get sessionId(): string {
    return this.#sessionId;
  }

  /**
   * Watches the shared scope for as long as the view is mounted, and returns
   * the detach. Call it from an effect: a store constructed during a render
   * that never commits must not leave a listener behind.
   */
  attach = (): (() => void) => {
    const scope = scopeOf(this.#commands, this.#sessionId);
    const listener = (): void => this.#sync();
    scope.listeners.add(listener);
    this.#attached = true;
    this.#sync();
    return () => {
      scope.listeners.delete(listener);
      this.#attached = false;
      disposeScope(this.#commands, this.#sessionId);
    };
  };

  /**
   * Publishes one change to every store watching this scope, including this
   * one — but exactly once each.
   *
   * An attached store is reached through its own listener; an unattached one
   * (a store built during a render that has not committed, or a plain
   * non-React caller) has no listener and syncs itself. Doing both would notify
   * React twice for one transition, which `clearError`'s own test counts.
   */
  #emit(scope: CommandScope): void {
    scope.notify();
    if (!this.#attached) this.#sync();
  }

  /**
   * Sends one logical action under `key`, minting an envelope only if none is
   * retained.
   *
   * A retained envelope REFUSES rather than being replayed with the new
   * payload: replaying is `retry`'s job and is explicit, because a `submit`
   * that silently sent yesterday's draft would be a worse surprise than a
   * refusal the caller can see in `pending`.
   */
  protected async send(key: string, mint: () => PendingCommand): Promise<CommandResult> {
    const scope = scopeOf(this.#commands, this.#sessionId);
    const retained = scope.slots.get(key);
    if (retained !== undefined) return { outcome: "refused", commandId: retained.command.commandId };

    let command: PendingCommand;
    try {
      command = mint();
    } catch (cause) {
      // Envelope construction enforces Core's identity rules, and every input it
      // reads comes from outside this module: a session id passed as a prop, a
      // gate id and an opened event id read off a board page Factory served.
      // A throw here must not escape as a rejected promise — these are `onClick`
      // handlers, so what the user would get is an unhandled rejection rather
      // than an error state, and the three hooks all promise "never rejects".
      // Nothing was sent and nothing is retained, so the outcome is `"none"`;
      // the reason is in `errors`, which is what tells it apart from an empty
      // draft.
      scope.errors.set(key, asError(cause));
      this.#emit(scope);
      return { outcome: "none" };
    }
    const slot: Slot = { command, sending: true };
    scope.slots.set(key, slot);
    scope.errors.delete(key);
    this.#emit(scope);
    return this.#attempt(scope, key, slot);
  }

  /** Replays the retained envelope for `key`. Never mints — that is the whole point. */
  protected async replay(key: string): Promise<CommandResult> {
    const scope = scopeOf(this.#commands, this.#sessionId);
    const slot = scope.slots.get(key);
    if (slot === undefined) return { outcome: "none" };
    if (slot.sending) return { outcome: "refused", commandId: slot.command.commandId };
    slot.sending = true;
    scope.errors.delete(key);
    this.#emit(scope);
    return this.#attempt(scope, key, slot);
  }

  async #attempt(scope: CommandScope, key: string, slot: Slot): Promise<CommandResult> {
    const attempt = await slot.command.attempt();
    const commandId = slot.command.commandId;
    if (scope.slots.get(key) !== slot) {
      // Cancelled while this attempt was in flight. The reply is discarded
      // rather than published: the user withdrew the action, and writing its
      // outcome into a slot that now belongs to a later action would attribute
      // one command's answer to another.
      return { outcome: "cancelled", commandId };
    }
    slot.sending = false;
    const result = this.#classify(commandId, attempt);
    if (result.outcome === "accepted" || result.outcome === "rejected") scope.slots.delete(key);
    if (result.outcome === "rejected" || result.outcome === "unknown") scope.errors.set(key, result.error);
    this.#emit(scope);
    return result;
  }

  #classify(commandId: string, attempt: CommandAttempt): CommandResult {
    if (attempt.outcome === "rejected") return { outcome: "rejected", commandId, error: attempt.error };
    if (attempt.outcome === "unknown") return { outcome: "unknown", commandId, error: asError(attempt.error) };
    const status = attempt.status;
    if (status.status === "rejected") return { outcome: "rejected", commandId, error: rejection(status) };
    if (status.status === "accepted" || status.status === "applied") {
      return { outcome: "accepted", commandId, status };
    }
    // `pending`, and anything a newer Factory adds that the validator admits:
    // retain. Holding an identity longer than necessary costs a stale control;
    // releasing one that was never durable costs a duplicated user action.
    return { outcome: "pending", commandId, status };
  }

  /**
   * Withdraws the retained envelope for `key`. An attempt still in flight is
   * not aborted — a Centrifuge RPC has no cancellation and admission may
   * already have committed — but its reply is discarded, and the next action
   * on this control is a NEW logical command. That is the honest reading of a
   * user pressing cancel: they are giving up on knowing, not undoing.
   */
  protected discard(key: string): void {
    const scope = scopeOf(this.#commands, this.#sessionId);
    const hadSlot = scope.slots.delete(key);
    const hadError = scope.errors.delete(key);
    if (!hadSlot && !hadError) return;
    this.#emit(scope);
  }

  /** Clears a settled failure for `key`, e.g. when the user edits the draft again. */
  protected forgetError(key: string): void {
    const scope = scopeOf(this.#commands, this.#sessionId);
    if (!scope.errors.delete(key)) return;
    this.#emit(scope);
  }

  /**
   * Drops every error `drop` names.
   *
   * The predicate decides, rather than a "keep" list, and the difference is
   * load-bearing: the scope is shared by every control in the session, so a
   * store sweeping "everything not in my current projection" would silently
   * clear the composer's failure whenever a gate board changed. `drop` must
   * therefore only ever match keys the calling store owns.
   *
   * Retained envelopes are never dropped here: an envelope is the user's
   * outstanding action, released only by an outcome or by `discard`, and a
   * projection that has not caught up must not be able to forget one.
   */
  protected forgetErrorsWhere(drop: (key: string) => boolean): void {
    const scope = scopeOf(this.#commands, this.#sessionId);
    let changed = false;
    for (const key of [...scope.errors.keys()]) {
      if (!drop(key)) continue;
      scope.errors.delete(key);
      changed = true;
    }
    if (changed) this.#emit(scope);
  }

  /**
   * Rebuilds this store's snapshot from the shared scope.
   *
   * Reads the scope WITHOUT creating one, because the constructor calls this:
   * a store built during a render that is then abandoned — a suspended or
   * aborted concurrent render, a sibling that threw — never attaches and never
   * runs the cleanup that disposes a scope, so creating one here would leak an
   * empty entry per abandoned render for the life of the client. That is the
   * exact growth `disposeScope` exists to prevent.
   *
   * `errors` is COPIED rather than aliased. `Publisher`'s snapshot must not
   * change between publishes, and the scope's map is mutated in place by every
   * later transition, so a consumer holding a snapshot would watch its own
   * `errors` change underneath it.
   */
  #sync(): void {
    const scope = peekScope(this.#commands, this.#sessionId);
    const pending = new Map<string, PendingCommandView>();
    const errors = new Map<string, Error>();
    if (scope !== undefined) {
      for (const [key, slot] of scope.slots) {
        pending.set(key, {
          commandId: slot.command.commandId,
          sending: slot.sending,
          // A GETTER, so the parse happens only for a view something actually
          // reads. `#sync` runs for every attached store on every transition,
          // and most of those stores render no draft at all; eagerly parsing
          // one request per slot per store was work nobody asked for. It also
          // strengthens the property: every read is its own parse, so no two
          // readers can share an object even by accident.
          get request(): FactoryCommandRequest {
            return slot.command.request;
          },
        });
      }
      for (const [key, error] of scope.errors) errors.set(key, error);
    }
    this.publish({ pending, errors });
  }
}
