import { acceptsResidentResponse } from "@looprig/client";
import type {
  FactoryCommands,
  GateApprovalAction,
  PublicGateEntry,
  ResidentGateResponseInput,
} from "@looprig/client";
import { SessionCommandStore, type CommandResult } from "./pending.js";

// --- The Factory command plane ------------------------------------------------

/**
 * One slot per gate, not one per session.
 *
 * Parallel loops open gates concurrently, and a user answering the second while
 * the first is still in flight is doing two independent things. Keying the slot
 * by gate id is what keeps "a double-click is one command" from becoming "a
 * session answers one gate at a time".
 */
const GATE_COMMAND_PREFIX = "session.gate.respond:";

export function gateCommandKey(gateId: string): string {
  return `${GATE_COMMAND_PREFIX}${gateId}`;
}

/**
 * The optimistic open identity a resident gate response must carry.
 *
 * Core requires EXACTLY one of `expected_open_event_id` and
 * `expected_open_journal_seq`, and a board entry may attest either, both or —
 * for a gate seen only through a durable `GateOpened` that a page has not
 * described — neither. The event id is preferred because it names the exact
 * durable record; the sequence is the fallback; nothing is a refusal, because
 * a response with no optimistic identity would be answering whichever gate
 * happens to be open when it lands.
 */
type OpenIdentity =
  | { readonly expectedOpenEventId: string }
  | { readonly expectedOpenJournalSeq: number };

function openIdentity(gate: PublicGateEntry): OpenIdentity | null {
  if (gate.openedEventId !== "") return { expectedOpenEventId: gate.openedEventId };
  if (Number.isSafeInteger(gate.openedJournalSeq) && gate.openedJournalSeq >= 1) {
    return { expectedOpenJournalSeq: gate.openedJournalSeq };
  }
  return null;
}

/**
 * This tab's answer path for one session's gates, over the Factory command
 * plane.
 *
 * A gate Factory has not attested as `resident` is never sent — the
 * owner able to apply the answer is not up, so the request could only be
 * rejected, and offering it invites a user to believe they resolved something
 * they did not. A gate with no attested open identity is likewise refused
 * rather than answered positionally. Both refusals are `"none"`: nothing was
 * sent and nothing is retained.
 */
export class FactoryGateStore extends SessionCommandStore {
  constructor(commands: FactoryCommands, sessionId: string) {
    super(commands, sessionId);
  }

  /**
   * Answers one gate. `action` is submitted VERBATIM — harness's
   * `gate.ParseApprovalAction` matches the three `GATE_APPROVAL_ACTIONS`
   * strings exactly and rejects anything else.
   *
   * `values` is always the empty object, and is deliberately not a parameter.
   * Core requires the field; wui implements permission gates only (see
   * `isAnswerableGate`), and for those the whole answer IS the action. A
   * parameter no caller can reach — `UseFactoryGateResult.respond` has none —
   * would be untested by construction, and the task that renders
   * `prompt.controls` for a form gate is the one that should add it, together
   * with the reader for it.
   */
  respond(gate: PublicGateEntry, action: GateApprovalAction): Promise<CommandResult> {
    if (!acceptsResidentResponse(gate)) return Promise.resolve({ outcome: "none" });
    const expected = openIdentity(gate);
    if (expected === null) return Promise.resolve({ outcome: "none" });
    const values: Readonly<Record<string, unknown>> = {};
    const input: ResidentGateResponseInput =
      "expectedOpenEventId" in expected
        ? { gateId: gate.gateId, action, values, expectedOpenEventId: expected.expectedOpenEventId }
        : { gateId: gate.gateId, action, values, expectedOpenJournalSeq: expected.expectedOpenJournalSeq };
    return this.send(gateCommandKey(gate.gateId), () =>
      this.commands.respondResidentGate(this.sessionId, input),
    );
  }

  /** Replays the retained answer to `gateId` — the same command id, the same bytes. */
  retry(gateId: string): Promise<CommandResult> {
    return this.replay(gateCommandKey(gateId));
  }

  /** Withdraws the retained answer to `gateId`. The next respond is a new logical command. */
  cancel(gateId: string): void {
    this.discard(gateCommandKey(gateId));
  }

  /**
   * Forgets failures for gates the board no longer lists. Retained envelopes
   * survive: a page merge never removes, so "absent" is not "closed", and an
   * outstanding answer must not be forgotten by a projection that is behind.
   */
  prune(open: Iterable<string>): void {
    const keys = new Set<string>();
    for (const gateId of open) keys.add(gateCommandKey(gateId));
    // Prefix-scoped: the session's command scope is shared with the composer
    // and the interrupt, and a gate board going empty says nothing about
    // either of them.
    this.forgetErrorsWhere((key) => key.startsWith(GATE_COMMAND_PREFIX) && !keys.has(key));
  }
}
