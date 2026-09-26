import { useCallback, useEffect, useMemo } from "react";
import type { FactoryCommands } from "@looprig/client";
import {
  SessionCommandStore,
  type CommandResult,
  type PendingCommandView,
} from "./stores/pending.js";
import { useFactoryClient } from "./use-connection.js";
import { useStore } from "./use-store.js";

/** The interrupt's one control key within a session's command scope. */
const INTERRUPT_COMMAND_KEY = "session.interrupt";

/**
 * The interrupt over the Factory command plane.
 *
 * The retained envelope outlives this private store in the shared session
 * scope, so the class is a view and not the owner.
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
