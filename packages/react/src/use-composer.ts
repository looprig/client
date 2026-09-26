import { useCallback, useEffect, useMemo } from "react";
import type { LooprigTransport, SessionViewStore } from "@looprig/client";
import {
  COMPOSER_COMMAND_KEY,
  FactoryComposerStore,
  retainedComposerText,
  SessionComposerStore,
  type ComposerSnapshot,
} from "./stores/composer.js";
import type { CommandResult, PendingCommandView } from "./stores/pending.js";
import { useFactoryClient } from "./use-connection.js";
import { useStore, useStoreSelector } from "./use-store.js";

export interface UseComposerResult extends ComposerSnapshot {
  /** Never rejects. `false` means "nothing was sent" — empty draft, a submit already in flight, or a failure that is now in `error`. */
  submit: (text: string) => Promise<boolean>;
  clearError: () => void;
}

/**
 * The composer's write path plus its per-tab optimistic rows.
 *
 * Takes the session's `SessionViewStore` as a third argument, diverging from
 * the design brief's two-argument form, because the pending rows are retired by
 * SERVER acknowledgement and the only place that is observable is the folded
 * view (`view.commandOutcomes`). A two-argument form would have to open a
 * second SSE connection per session to learn the same thing. `app/` holds one
 * view store per open session and passes it down.
 *
 * Render `pending` AFTER `view.rows`. These rows are local: a second tab, or
 * the TUI, sees nothing until `TurnStarted`.
 */
export function useComposer(
  transport: LooprigTransport,
  sessionId: string,
  viewStore: SessionViewStore,
): UseComposerResult {
  const store = useMemo(() => new SessionComposerStore(transport, sessionId), [transport, sessionId]);
  const snapshot = useStore(store);

  // Keyed on the snapshot VERSION, not on the commandOutcomes map's identity.
  // The version is stamped once per notify and is guaranteed to change, so this
  // stays correct whether or not the fold happened to rebuild that map — and
  // `resolveCommand` hands an unchanged view straight back for an event that
  // records nothing, so the map's identity alone would miss nothing but is a
  // weaker thing to depend on than a documented monotonic counter.
  const version = useStoreSelector(viewStore, (view) => view.version);
  useEffect(() => {
    store.reconcile(viewStore.snapshot().view.commandOutcomes);
  }, [store, viewStore, version]);

  const submit = useCallback((text: string) => store.submit(text), [store]);
  const clearError = useCallback(() => {
    store.clearError();
  }, [store]);

  return useMemo(() => ({ ...snapshot, submit, clearError }), [snapshot, submit, clearError]);
}

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
