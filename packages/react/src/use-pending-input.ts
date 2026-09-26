import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { textBlock, type FactoryClient } from '@looprig/client';
import { pendingInputKey, PendingController, PendingSlot, submitInput, type PendingStorage, type CommandResolver } from '@looprig/client';

export interface PendingInputHandlers {
  /** Admitted: the input is queued for (or folded into) a turn. */
  onAccepted(commandId: string, text: string): void;
  /** Not admitted after the draft was cleared (recovery rejected it, or the user discarded it): offer the text back. */
  onReturned(text: string): void;
}

/**
 * One thread's composer input as a reload-durable pending command.
 *
 * At most one input is retained per thread (shared by every tab through
 * localStorage); while one is retained the composer sends nothing new. The
 * behaviour lives in `PendingController`; this hook only binds it to React.
 */
export function usePendingInput(
  sessionId: string,
  client: FactoryClient,
  handlers: PendingInputHandlers,
  options: { storage: PendingStorage; namespace: string; resolver: CommandResolver },
) {
  const controller = useMemo(() => new PendingController(
    new PendingSlot(options.storage, pendingInputKey(sessionId, options.namespace), client.link, options.resolver),
    { persistMessage: 'The message could not be saved before sending.' },
  ), [client.link, sessionId, options.storage, options.namespace, options.resolver]);
  // Declared before `start`, so the first recovery already reports through the latest handlers.
  useEffect(() => {
    controller.setHandlers({
      onAccepted: (outcome, text) => handlers.onAccepted(outcome.commandId, text),
      onReturned: (text) => handlers.onReturned(text),
    });
  });
  useEffect(() => controller.start(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const commands = client.commands;
  const submit = useCallback(
    (text: string) => submitInput(controller, text, (trimmed) => commands.input(sessionId, { blocks: [textBlock(trimmed)] })),
    [commands, controller, sessionId],
  );
  return { pending: state.pending, error: state.error, submit, retry: controller.retry, discard: controller.discard };
}
