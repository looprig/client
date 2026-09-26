import { useCallback, useEffect, useMemo } from "react";
import {
  COMPOSER_COMMAND_KEY,
  FactoryComposerStore,
  retainedComposerText,
} from "./stores/composer.js";
import type { CommandResult, PendingCommandView } from "./stores/pending.js";
import { useFactoryClient } from "./use-connection.js";
import { useStore } from "./use-store.js";

/**
 * One retained command envelope, plus everything a send button needs to render
 * the three states it can be in: idle, sending, and holding an outcome nobody
 * knows.
 */
export interface UseFactoryComposerResult {
  /** The retained input envelope, or null when this composer holds none. */
  readonly pending: PendingCommandView | null;
  /** The text the retained envelope will replay. `""` when nothing is retained. */
  readonly text: string;
  /** The last failure — retryable while `pending` is non-null, final once it is null. */
  readonly error: Error | null;
  /** Never rejects. `"refused"` means an envelope is already retained; retry or cancel it. */
  submit: (text: string) => Promise<CommandResult>;
  /** Never rejects. Replays the retained envelope under its original identity. */
  retry: () => Promise<CommandResult>;
  cancel: () => void;
  clearError: () => void;
}

/**
 * The composer's write path over the Factory command plane.
 *
 * Takes only a session id: the command plane is the application's, reached
 * through `useFactoryClient`, and no view store is needed because nothing here
 * keeps optimistic rows — see `FactoryComposerStore`.
 *
 * `store` is memoised on the command plane and the session, and the retained
 * envelopes live outside it, so a remount inherits an in-flight submit instead
 * of offering the user a second one.
 */
export function useFactoryComposer(sessionId: string): UseFactoryComposerResult {
  const commands = useFactoryClient().commands;
  const store = useMemo(() => new FactoryComposerStore(commands, sessionId), [commands, sessionId]);
  useEffect(() => store.attach(), [store]);
  const snapshot = useStore(store);

  const pending = snapshot.pending.get(COMPOSER_COMMAND_KEY) ?? null;
  const error = snapshot.errors.get(COMPOSER_COMMAND_KEY) ?? null;
  const text = pending === null ? "" : retainedComposerText(pending.request);

  const submit = useCallback((draft: string) => store.submit(draft), [store]);
  const retry = useCallback(() => store.retry(), [store]);
  const cancel = useCallback(() => {
    store.cancel();
  }, [store]);
  const clearError = useCallback(() => {
    store.clearError();
  }, [store]);

  return useMemo(
    () => ({ pending, text, error, submit, retry, cancel, clearError }),
    [pending, text, error, submit, retry, cancel, clearError],
  );
}
