import { decodeBlock, textBlock } from "@looprig/client";
import type {
  FactoryCommandRequest,
  FactoryCommands,
} from "@looprig/client";
import { SessionCommandStore, type CommandResult } from "./pending.js";

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
 * A submit mints one `PendingCommand` and keeps it. The identity exists before
 * the request, so recovery replays the same bytes.
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
