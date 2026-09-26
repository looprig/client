import { decodeBlock, textBlock } from "@looprig/client";
import type {
  FactoryCommandRequest,
  FactoryCommands,
  LooprigTransport,
  RequestOptions,
} from "@looprig/client";
import { Publisher, asError } from "./publisher.js";
import { SessionCommandStore, type CommandResult } from "./pending.js";

/**
 * An optimistic row for input the server has accepted but not yet echoed as a
 * turn. It exists because `input_queued` is ephemeral and carries no `delta`,
 * so the only copy of what was typed is in the tab that typed it.
 */
export interface PendingRow {
  readonly kind: "pending";
  readonly commandId: string;
  readonly text: string;
  readonly submittedAt: number;
}

export interface ComposerSnapshot {
  readonly submitting: boolean;
  readonly error: Error | null;
  readonly pending: readonly PendingRow[];
}

const EMPTY: ComposerSnapshot = { submitting: false, error: null, pending: [] };

/**
 * The write half of the chat composer.
 *
 * Holds no draft text: what the user is typing is ordinary component state
 * bound to a textarea, and this store is only the transport-facing path — the
 * same division `client/sdk/svelte/src/interaction.svelte.ts` draws.
 *
 * ## Why the pending rows live here and not in the fold
 *
 * `@looprig/client` has its own optimistic-pending-row mechanism —
 * `addPendingRow(view, commandId, blocks)` appends a real `UserRow`, and
 * `resolveCommand` removes it on `TurnStarted`/`TurnFoldedInto`/`TurnRejected`/
 * `InputCancelled`. It is UNREACHABLE through `SessionViewStore`:
 * `joinSessionView` owns its own `view` local and yields it on every event, and
 * the store assigns `this.current = event.view` unconditionally, so anything a
 * consumer folded into `current` between two frames is discarded by the next
 * one. There is no injection point on either the store or the join generator.
 *
 * So the pending rows are kept here, as per-tab state beside the shared fold,
 * and `reconcile()` retires them from the one signal that IS observable through
 * the store: `SessionViewSnapshot.view.commandOutcomes`. That map is the only
 * place resolution can be seen — `TurnRejected` commits a NOTICE row rather
 * than a user row and `InputCancelled` commits none at all, so scanning `rows`
 * cannot do it.
 *
 * A renderer therefore draws `view.rows` and then these, in that order. They
 * are per-tab either way: a second tab, or the TUI, sees nothing for this
 * submit until `TurnStarted`.
 */
export class SessionComposerStore extends Publisher<ComposerSnapshot> {
  readonly #transport: LooprigTransport;
  readonly #sessionId: string;

  constructor(transport: LooprigTransport, sessionId: string) {
    super(EMPTY);
    this.#transport = transport;
    this.#sessionId = sessionId;
  }

  /**
   * Submits `text` as one text block. Returns `true` on success (the caller
   * clears its input), `false` on a no-op or a failure (the caller leaves the
   * input alone so the user does not lose what they typed).
   *
   * Serialized rather than generation-guarded: unlike a refresh, a second
   * submit is not a supersession of the first — both are real inputs, and
   * harness would queue both. Refusing the second while one is in flight
   * matches a disabled send button, and is what keeps one keystroke-fast double
   * Enter from opening two turns.
   */
  async submit(text: string, options?: RequestOptions): Promise<boolean> {
    const trimmed = text.trim();
    if (trimmed === "" || this.snapshot().submitting) return false;

    this.publish({ submitting: true, error: null });
    try {
      const response = await this.#transport.submit(
        this.#sessionId,
        { blocks: [textBlock(trimmed)] },
        options,
      );
      this.publish({
        submitting: false,
        pending: [
          ...this.snapshot().pending,
          { kind: "pending", commandId: response.command_id, text: trimmed, submittedAt: Date.now() },
        ],
      });
      return true;
    } catch (err) {
      this.publish({ submitting: false, error: asError(err) });
      return false;
    }
  }

  /**
   * Drops every pending row whose command id the server has acknowledged, in
   * any terminal way: `TurnStarted` and `TurnFoldedInto` mean the fold now owns
   * a real user row for it, `TurnRejected` and `InputCancelled` mean it never
   * will and the fold has committed a notice (or nothing) instead.
   *
   * Publishes ONLY when something actually changed. Callers drive this from a
   * subscription to the view store, so it runs on every frame; an
   * unconditional publish would notify React on each one and, with a listener
   * that re-entered, could loop.
   */
  reconcile(acknowledged: ReadonlySet<string> | ReadonlyMap<string, unknown>): void {
    const pending = this.snapshot().pending;
    const kept = pending.filter((row) => !acknowledged.has(row.commandId));
    if (kept.length === pending.length) return;
    this.publish({ pending: kept });
  }

  /** Clears a failed submit's error, e.g. when the user edits the draft again. */
  clearError(): void {
    if (this.snapshot().error === null) return;
    this.publish({ error: null });
  }
}

// --- The Factory command plane ------------------------------------------------

/**
 * The one control key a session's composer owns.
 *
 * A constant rather than a per-draft key, and that is the whole mechanism
 * behind "a double Enter is one logical command": two clicks name the same
 * slot, so the second finds the first retained and mints nothing. A key
 * derived from the draft text would make two identical clicks collide and two
 * different drafts race, which is the opposite of what a send button means.
 */
export const COMPOSER_COMMAND_KEY = "session.input";

/**
 * Recovers the text a retained input envelope will replay.
 *
 * Decoded through `@looprig/client`'s `decodeBlock` rather than by reading
 * the wire field here: the Go-cased `Text` member is a property of
 * `content.TextBlock`, and a second transcription of it in this package would
 * be free to drift from `textBlock`, silently, in the direction that submits
 * an empty block. Anything that is not a text block reads as `""`.
 */
export function retainedComposerText(request: FactoryCommandRequest): string {
  if (!("blocks" in request) || request.blocks === undefined) return "";
  const first = request.blocks[0];
  if (first === undefined) return "";
  const block = decodeBlock(first);
  return block.type === "text" ? block.text : "";
}

/**
 * The composer's write path over the Factory command plane.
 *
 * The difference from `SessionComposerStore` above is not the transport: it is
 * that a submit here mints ONE `PendingCommand` and keeps it. The legacy store
 * learns a `command_id` from the RESPONSE, so a submit whose reply is lost has
 * no identity at all and its only recovery is to send again — a second logical
 * input, and a second turn. Here the identity exists before the request does,
 * so the recovery is a replay of the same bytes.
 *
 * There are no optimistic pending rows: what is retained IS the pending row's
 * content (`retainedComposerText`), and the Factory view plane retires it by
 * observing the accepted command's own events rather than by a per-tab map.
 */
export class FactoryComposerStore extends SessionCommandStore {
  constructor(commands: FactoryCommands, sessionId: string) {
    super(commands, sessionId);
  }

  /**
   * Submits `text` as one text block, unless this composer already holds an
   * envelope — in which case nothing is sent and the retained id comes back.
   * Trimmed before it is SENT, not merely before it is displayed.
   */
  submit(text: string): Promise<CommandResult> {
    const trimmed = text.trim();
    if (trimmed === "") return Promise.resolve({ outcome: "none" });
    return this.send(COMPOSER_COMMAND_KEY, () =>
      this.commands.input(this.sessionId, { blocks: [textBlock(trimmed)] }),
    );
  }

  /** Replays the retained envelope — the same command id, the same bytes, the same turn. */
  retry(): Promise<CommandResult> {
    return this.replay(COMPOSER_COMMAND_KEY);
  }

  /** Withdraws the retained envelope. The next submit is a new logical input. */
  cancel(): void {
    this.discard(COMPOSER_COMMAND_KEY);
  }

  clearError(): void {
    this.forgetError(COMPOSER_COMMAND_KEY);
  }
}
