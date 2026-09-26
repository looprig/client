import { useCallback, useEffect, useMemo } from "react";
import type { FactoryCommands, LooprigTransport } from "@looprig/client";
import {
  SessionCommandStore,
  type CommandResult,
  type PendingCommandView,
} from "./stores/pending.js";
import { Publisher, asError } from "./stores/publisher.js";
import { useFactoryClient } from "./use-connection.js";
import { useStore } from "./use-store.js";

export interface InterruptSnapshot {
  readonly interrupting: boolean;
  readonly error: Error | null;
}

/**
 * Kept private to this module: unlike the list, composer and gate stores, no
 * caller constructs one directly, and there is nothing to construct it around —
 * an interrupt is a single fire-and-report call with no state worth outliving
 * the component.
 */
class InterruptStore extends Publisher<InterruptSnapshot> {
  readonly #transport: LooprigTransport;
  readonly #sessionId: string;

  constructor(transport: LooprigTransport, sessionId: string) {
    super({ interrupting: false, error: null });
    this.#transport = transport;
    this.#sessionId = sessionId;
  }

  async interrupt(): Promise<boolean> {
    if (this.snapshot().interrupting) return false;
    this.publish({ interrupting: true, error: null });
    try {
      const response = await this.#transport.interrupt(this.#sessionId);
      this.publish({ interrupting: false });
      // harness reports whether any RUNNING turn was actually cancelled.
      // `false` is a normal answer for an idle session, not a failure — which
      // is why the return value is NOT "did the request succeed".
      return response.interrupted;
    } catch (err) {
      this.publish({ interrupting: false, error: asError(err) });
      return false;
    }
  }
}

export interface UseInterruptResult extends InterruptSnapshot {
  /** Never rejects. Resolves to harness's `interrupted` — `false` also covers a refused duplicate and a failure now in `error`. */
  interrupt: () => Promise<boolean>;
}

/**
 * Cancels every in-flight turn in a session that is live in the serving
 * process.
 *
 * `POST /v1/sessions/{sid}/interrupt` resolves `{sid}` against the live
 * registry, so a cold session 404s with `session_not_found`. That is a property
 * of the LEGACY plane, and it is not a reason to place a session on the way in:
 * opening a view is a read, and this returns the 404 as an error rather than
 * having something restore the session first so that a control can be shown.
 */
export function useInterrupt(transport: LooprigTransport, sessionId: string): UseInterruptResult {
  const store = useMemo(() => new InterruptStore(transport, sessionId), [transport, sessionId]);
  const snapshot = useStore(store);
  const interrupt = useCallback(() => store.interrupt(), [store]);
  return useMemo(() => ({ ...snapshot, interrupt }), [snapshot, interrupt]);
}

/** The interrupt's one control key within a session's command scope. */
const INTERRUPT_COMMAND_KEY = "session.interrupt";

/**
 * The interrupt over the Factory command plane.
 *
 * Private for the same reason `InterruptStore` is — nothing constructs one —
 * but it retains state for a different reason than that store keeps none: the
 * envelope it holds outlives it in the shared session scope, so the class is
 * a view and not the owner.
 */
class FactoryInterruptStore extends SessionCommandStore {
  constructor(commands: FactoryCommands, sessionId: string) {
    super(commands, sessionId);
  }

  interrupt(): Promise<CommandResult> {
    return this.send(INTERRUPT_COMMAND_KEY, () => this.commands.interrupt(this.sessionId));
  }

  retry(): Promise<CommandResult> {
    return this.replay(INTERRUPT_COMMAND_KEY);
  }

  cancel(): void {
    this.discard(INTERRUPT_COMMAND_KEY);
  }
}

export interface UseFactoryInterruptResult {
  /** The retained interrupt envelope, or null when none is outstanding. */
  readonly pending: PendingCommandView | null;
  readonly error: Error | null;
  /** Never rejects. `"refused"` means an interrupt is already outstanding for this session. */
  interrupt: () => Promise<CommandResult>;
  retry: () => Promise<CommandResult>;
  cancel: () => void;
}

/**
 * Cancels the session's in-flight work through a durable, retry-stable command.
 *
 * Unlike `useInterrupt` above this reports no `interrupted` boolean: the
 * legacy route answered synchronously out of a live registry, while
 * `session.interrupt` is admitted and applied durably, so what a caller learns
 * from the reply is whether the command was ACCEPTED. Whether a turn was
 * actually running is then a fact about the session's events, not about the
 * request — and inventing a boolean here would be answering a question the
 * command plane does not.
 */
export function useFactoryInterrupt(sessionId: string): UseFactoryInterruptResult {
  const commands = useFactoryClient().commands;
  const store = useMemo(() => new FactoryInterruptStore(commands, sessionId), [commands, sessionId]);
  useEffect(() => store.attach(), [store]);
  const snapshot = useStore(store);

  const pending = snapshot.pending.get(INTERRUPT_COMMAND_KEY) ?? null;
  const error = snapshot.errors.get(INTERRUPT_COMMAND_KEY) ?? null;

  const interrupt = useCallback(() => store.interrupt(), [store]);
  const retry = useCallback(() => store.retry(), [store]);
  const cancel = useCallback(() => {
    store.cancel();
  }, [store]);

  return useMemo(
    () => ({ pending, error, interrupt, retry, cancel }),
    [pending, error, interrupt, retry, cancel],
  );
}
