/**
 * Durable session projection shared by Factory journal reads and publications.
 * Both paths normalize public bodies into HistoryInput. Factory live text is
 * an independent preview and does not mutate this durable fold.
 */
import type { EventEnvelope, PublicGatePage, StatusEvent } from "./types.js";
import { decodeEnduring, isZeroUUID, principalLabel, turnFailureText, type MessageInput } from "./enduring.js";
import { decodeGateProjection, type Gate, type PublicGateProjection } from "./gate.js";
import { str, type ContentBlock } from "./blocks.js";
import type { LoopInfo, TranscriptRow, TranscriptRowDraft, UserFrame } from "./rows.js";
import { narrationOf, redactedThinkingOf, refusalOf, splitStepGroup, thinkingOf, toolResultText, toolUsesOf } from "./rows.js";
import { toolUseSummary } from "./toolsummary.js";

/** A durable event marker, including unknown event kinds for generic renderers. */
export interface StatusEventMarker {
  type: string;
  journalSeq: number | undefined;
  sessionId: string | undefined;
  loopId: string | undefined;
  turnId: string | undefined;
  stepId: string | undefined;
  eventId: string | undefined;
  createdAt: string | undefined;
  envelope: EventEnvelope;
}

/** Accumulated durable transcript, gates, loop tree, and command outcomes. */
export interface SessionView {
  statusEvents: StatusEventMarker[];
  /** Open durable gates keyed by gate id; Factory attestation lives in PublicGateBoard. */
  gates: Map<string, Gate>;
  /**
   * The session's loop tree, keyed by loop id: who spawned each loop, which
   * tool call anchors it, and whether its `LoopStarted` was actually observed.
   * See rows.ts's `LoopInfo` for the field contract and `anchorOf` for the
   * lookup a renderer nests through.
   *
   * A loop is registered the first time ANY event names it, so a loop
   * whose `LoopStarted` fell off the journal page is present-but-unobserved
   * rather than absent — which is what keeps its rows in the transcript with an
   * "orphaned subagent" marker instead of dropping them (§3b).
   *
   * The session-scoped loop id "" is never registered: it is the id an
   * session-scoped event carries, and it names
   * no loop.
   */
  loops: Map<string, LoopInfo>;
  /** Durable transcript rows in journal order; row objects are copy-on-write. */
  rows: TranscriptRow[];
  /** The next ordinal to allocate. Monotonic; never reused, never reset. */
  nextOrdinal: number;
  /** Durable acknowledgements keyed by command identity, used by pending controllers. */
  commandOutcomes: Map<string, CommandOutcome>;
}

/**
 * What became of one submitted command. `"started"` covers both `TurnStarted`
 * and `TurnFoldedInto`: §3b treats them identically, and from the composer's
 * side both mean "the server took it and the authoritative row is in `rows`
 * now" — a folded input is still the user's input.
 */
export type CommandOutcome = "started" | "rejected" | "cancelled";

export function emptySessionView(): SessionView {
  return {
    statusEvents: [],
    gates: new Map(),
    loops: new Map(),
    rows: [],
    nextOrdinal: 0,
    commandOutcomes: new Map(),
  };
}

// --- Fold input / result -----------------------------------------------------

/** One item from a cold journal page. */
export interface HistoryInput {
  segment: "history";
  event: StatusEvent;
}

export type FoldInput = HistoryInput;

/** Uniform result shape for consumers of the durable projection. */
export type FoldResult = { ok: true; view: SessionView } | { ok: false; error: Error };

// --- Enduring / StatusEvent fold ---------------------------------------------

/** Append one durable body and project supported event kinds. */
function foldEnduringEnvelope(view: SessionView, envelope: EventEnvelope, journalSeq: number | undefined): FoldResult {
  const marker: StatusEventMarker = {
    type: envelope.type,
    journalSeq,
    sessionId: envelope.session_id,
    loopId: envelope.loop_id,
    turnId: envelope.turn_id,
    stepId: envelope.step_id,
    eventId: envelope.event_id,
    createdAt: envelope.created_at,
    envelope,
  };
  // Appended IN PLACE (design §3c). This runs on EVERY enduring event including
  // the whole cold journal replay, so spreading the array here was O(M^2)
  // before first paint -- the dominant cost on the "open a session that already
  // ran" path. See appendRow for the full carve-out and what still holds.
  view.statusEvents.push(marker);
  // Register the producing loop next to the marker: a loop first seen through
  // an ordinary event is recorded UNOBSERVED, which is what keeps its rows and
  // tags them rather than dropping them when its LoopStarted never arrives.
  const next: SessionView = ensureLoop({ ...view }, envelope.loop_id ?? "");

  const decoded = decodeEnduring(envelope);
  switch (decoded.payload.kind) {
    // One case for both openers: decodePayload already gives them the same
    // TurnOpenerPayload shape, and §3b treats them identically — TurnFoldedInto
    // is queued input folded into a mandatory tool-continuation, which is still
    // the user's input and still subject to the same cause gate.
    case "TurnStarted":
    case "TurnFoldedInto": {
      // §3b rule 2: a user row ONLY when Header.Cause.LoopID is zero. A
      // NON-ZERO cause loop id is a subagent hand-back — handlers_events.go
      // subscribes LoopScope{All: true}, so a parent loop sees every child's
      // frames, and a hand-back arrives as a turn opener on the PARENT loop
      // whose cause loop id is the CHILD's. Committing a row for it renders a
      // phantom user message on every hand-back.
      //
      // isZeroUUID, never `cause?.loop_id === undefined`: production OMITS a
      // zero id, but harness's fixture normaliser REPLACES ids, so the
      // all-zeros spelling is equally real wire. Both must gate identically.
      //
      // The ACKNOWLEDGEMENT is recorded before that gate, not inside it: the
      // turn started whether or not this event commits a user row, and a
      // pending controller still needs to learn about an opener with no message.
      const resolved = resolveCommand(next, decoded.causeCommandId, "started");
      const message = decoded.payload.message;
      if (!isZeroUUID(decoded.causeLoopId) || message === undefined) {
        return { ok: true, view: resolved };
      }
      const framed = frameOf(message.blocks, decoded.payload.input);
      const principal = decoded.payload.input?.principal;
      return {
        ok: true,
        view: appendRow(resolved, {
          kind: "user",
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(resolved, decoded.loopId),
          blocks: framed.blocks,
          ...(framed.frame === undefined ? {} : { frame: framed.frame }),
          ...(principal === undefined ? {} : { principal }),
        }),
      };
    }
    case "StepDone": {
      const { assistant, results } = splitStepGroup(decoded.payload.messages);
      if (assistant === undefined) return { ok: true, view: next };
      const thinking = thinkingOf(assistant.blocks);
      const text = narrationOf(assistant.blocks);
      const refusal = refusalOf(assistant.blocks);
      const redactedThinking = redactedThinkingOf(assistant.blocks);
      let out = next;
      // A pure-tool step commits NO assistant row: its tool cards stand alone.
      // A truncated step is NOT special here — its notice is an ordinary text
      // block with no distinguishing tag, so it commits as narration and the
      // turn TERMINAL is what tells a truncated group from a clean one.
      //
      // `redactedThinking` is a fourth reason to commit, not a decoration on
      // the other three: a redacted block projects thinking === "" and matched
      // every one of them, so a step whose ONLY content was withheld reasoning
      // used to commit nothing at all and the turn rendered with a hole in it.
      if (thinking !== "" || text !== "" || refusal !== "" || redactedThinking) {
        out = appendRow(out, {
          kind: "assistant",
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(out, decoded.loopId),
          thinking,
          text,
          refusal,
          redactedThinking,
        });
      }
      // Block order, paired by ToolUseID. The step shape is one AIMessage
      // followed by its ToolResultMessages, so the pairing key is the block's ID
      // against ToolResultMessage.ToolUseID, independent of result completion order. The prose row is
      // committed first however late in the block order its text sits: the
      // narration introduces the calls it accompanies.
      for (const use of toolUsesOf(assistant)) {
        const result = results.get(use.id);
        const capture = decoded.payload.captures?.get(use.id);
        out = appendRow(out, {
          kind: "tool",
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(out, decoded.loopId),
          toolUseId: use.id,
          toolExecutionId: "",
          toolName: use.name,
          // Derived, not carried: the enduring record has no Summary field (it
          // is the EPHEMERAL ToolCallStarted that carries one), so a replayed
          // card would otherwise show a name and a result and nothing about
          // what the call was for. tui's storedStepToolCard derives it the same
          // way, from the same input, so the two transcripts agree — and the
          // derivation redacts, which is why this is not ToolRow.input.
          summary: toolUseSummary(use.name, use.input),
          // A missing result is a call whose outcome the group does not carry;
          // "ok" matches tui's storedStepToolCard rather than inventing an error.
          status: result?.isError === true ? "error" : "ok",
          result: toolResultText(result),
          ...(capture === undefined ? {} : { capture }),
          // The child normally announced itself BEFORE this step was finalized —
          // a subagent runs to completion inside the call that spawned it — so
          // the anchor is usually known here. The reverse order (a LoopStarted
          // arriving after the parent's step) is stamped by the LoopStarted case.
          spawnedLoopId: childLoopFor(out, decoded.loopId, use.id),
        });
      }
      return { ok: true, view: out };
    }
    case "TurnDone":
      return { ok: true, view: next };
    case "TurnInterrupted": {
      const committed = next;
      return {
        ok: true,
        view: appendRow(committed, {
          kind: "tombstone",
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(committed, decoded.loopId),
          ...(decoded.payload.principal === undefined ? {} : { principal: decoded.payload.principal }),
        }),
      };
    }
    case "TurnRejected": {
      // A rejected command records its outcome and a visible explanation.
      const resolved = resolveCommand(next, decoded.causeCommandId, "rejected");
      return {
        ok: true,
        view: appendRow(resolved, {
          kind: "notice",
          level: "error",
          text: `input rejected: ${decoded.payload.reasonText}`,
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(resolved, decoded.loopId),
        }),
      };
    }
    case "InputCancelled":
      // A client retract, or a queued input returned after an abnormal turn
      // end. It never entered history, so it commits NO row — but the
      // affordance still has to go, and the outcome still has to be observable,
      // which is the other half of what commandOutcomes is for.
      return { ok: true, view: resolveCommand(next, decoded.causeCommandId, "cancelled") };
    case "TurnFailed": {
      const committed = next;
      // The failure reason IS on the wire. TurnFailed.Err is tagged json:"-",
      // but marshalTurnFailed marshals turnFailedWire, which projects Err
      // through projectError onto {kind,message} — neither key omitempty, and
      // projectError(nil) yields {"unknown",""} rather than nil. Rendering no
      // reason would be this layer discarding what harness took care to keep.
      const reason = turnFailureText(decoded.payload.errorKind, decoded.payload.errorMessage);
      return {
        ok: true,
        view: appendRow(committed, {
          kind: "notice",
          level: "error",
          text: reason,
          loopId: decoded.loopId,
          turnId: decoded.turnId,
          journalSeq,
          live: false,
          orphanedLoop: isOrphanLoop(committed, decoded.loopId),
        }),
      };
    }
    case "LoopStarted": {
      // The durable loop-tree record, and the ONLY place `observed` becomes
      // true. The parent is read from `cause`, never from the promoted
      // `loop_id` (which is the NEW loop) — LoopStarted's identity profile
      // forbids a promoted turn or step for exactly that reason. A zero cause
      // loop id means ROOT, and it is normalised to "" through isZeroUUID
      // rather than compared to undefined: harness's fixture normaliser spells
      // the zero out, and reading "000…0" as a parent would root the tree at a
      // loop that never existed.
      const loops = new Map(next.loops);
      loops.set(decoded.loopId, {
        loopId: decoded.loopId,
        parentLoopId: isZeroUUID(decoded.causeLoopId) ? "" : decoded.causeLoopId,
        parentToolUseId: decoded.payload.parentToolUseId,
        // DisplayName when non-empty, else the header's AgentName — the same
        // fallback tui's loopStartedLabel applies for older journals.
        label: decoded.payload.displayName !== "" ? decoded.payload.displayName : decoded.agentName,
        observed: true,
      });
      const rows = relinkLoop(next.rows, decoded.loopId, {
        parentLoopId: isZeroUUID(decoded.causeLoopId) ? "" : decoded.causeLoopId,
        parentToolUseId: decoded.payload.parentToolUseId,
      });
      return { ok: true, view: { ...next, loops, rows } };
    }
    case "GateOpened": {
      // Copy-on-write, like every other branch here: fold() must never mutate
      // the view it was handed (test/fold-immutability.test.ts pins that, and
      // retained map snapshots must remain unchanged).
      const gates = new Map(view.gates);
      gates.set(decoded.payload.gate.id, decoded.payload.gate);
      return { ok: true, view: { ...next, gates } };
    }
    case "GateResolved": {
      const answeredBy = decoded.payload.principal;
      const withNotice = answeredBy === undefined ? next : appendRow(next, {
        kind: "notice",
        level: "info",
        text: `gate ${decoded.payload.action === "" ? "closed" : decoded.payload.action} by ${principalLabel(answeredBy)}`,
        loopId: decoded.loopId,
        turnId: decoded.turnId,
        journalSeq,
        live: false,
        orphanedLoop: isOrphanLoop(next, decoded.loopId),
        principal: answeredBy,
      });
      // A close for a gate this view never opened (a mid-stream join) removes
      // nothing and copies nothing — it is not an error.
      if (!view.gates.has(decoded.payload.gateId)) return { ok: true, view: withNotice };
      const gates = new Map(view.gates);
      gates.delete(decoded.payload.gateId);
      return { ok: true, view: { ...withNotice, gates } };
    }
    default:
      return { ok: true, view: next };
  }
}

/**
 * Registers `loopId` in the loop tree if it is not there yet, as UNOBSERVED —
 * "this loop exists and we have no LoopStarted for it". Called before anything
 * that could append a row for a loop, so `isOrphanLoop` below has an entry to
 * read and an orphan's rows are kept and TAGGED rather than dropped.
 *
 * A ZERO loop id is never registered — neither the absent spelling "" nor the
 * all-zeros one harness's fixture normaliser produces. Both mean "no loop": ""
 * is what a session-scoped event carries, and
 * registering "000…0" would invent a loop that never ran. isZeroUUID, not
 * `=== ""`, for the same reason §3b's cause gate uses it.
 *
 * Copy-on-write, and a loop already known returns the very same view, so this
 * costs one Map copy per loop for the whole session.
 */
function ensureLoop(view: SessionView, loopId: string): SessionView {
  if (isZeroUUID(loopId) || view.loops.has(loopId)) return view;
  const loops = new Map(view.loops);
  loops.set(loopId, { loopId, parentLoopId: "", parentToolUseId: "", label: "", observed: false });
  return { ...view, loops };
}

/**
 * True when `loopId` names a loop whose `LoopStarted` has not been seen — the
 * value every row appended for that loop carries as `orphanedLoop`. "" (a
 * session-scoped row) is never orphaned: it belongs to no loop, so there is no
 * missing record.
 */
function isOrphanLoop(view: SessionView, loopId: string): boolean {
  return view.loops.get(loopId)?.observed === false;
}

/**
 * The child loop `toolUseId` spawned from `parentLoopId`, or "" if none is
 * known yet. Read at StepDone-commit time so a tool row lands with its
 * `spawnedLoopId` already set — the ordinary order, because a subagent runs to
 * completion (and so announces itself) before the parent step containing its
 * call is finalized. The reverse order is handled by the LoopStarted case,
 * which stamps the anchor onto an already-committed row.
 */
function childLoopFor(view: SessionView, parentLoopId: string, toolUseId: string): string {
  if (toolUseId === "") return "";
  for (const info of view.loops.values()) {
    if (info.observed && info.parentLoopId === parentLoopId && info.parentToolUseId === toolUseId) {
      return info.loopId;
    }
  }
  return "";
}

/**
 * Applies a newly-observed `LoopStarted` to rows that were already committed
 * before it arrived — the trimmed-page order, where the child's work is on the
 * page but the record naming its parent is not.
 *
 * Two edits, one pass:
 *  - every row of `loopId` loses its `orphanedLoop` marker, because the loop is
 *    no longer missing a record;
 *  - the parent's tool row carrying `parentToolUseId` gains `spawnedLoopId`, so
 *    a renderer can nest the child's block under the card that spawned it.
 *
 * Rows that need neither are carried over BY REFERENCE and the array itself is
 * handed straight back when nothing changed, so a per-row `Object.is` selector
 * does not re-render the whole transcript on every loop announcement.
 */
function relinkLoop(
  rows: TranscriptRow[],
  loopId: string,
  parent: { parentLoopId: string; parentToolUseId: string },
): TranscriptRow[] {
  const unOrphans = (row: TranscriptRow): boolean => row.loopId === loopId && row.orphanedLoop;
  const anchors = (row: TranscriptRow): boolean =>
    row.kind === "tool" &&
    parent.parentToolUseId !== "" &&
    row.loopId === parent.parentLoopId &&
    row.toolUseId === parent.parentToolUseId &&
    row.spawnedLoopId !== loopId;
  if (!rows.some((row) => unOrphans(row) || anchors(row))) return rows;
  return rows.map((row): TranscriptRow => {
    // An anchor row belongs to the PARENT loop and an un-orphaned row to the
    // child, so the two never describe the same row; they are still applied in
    // one pass so a row is rebuilt at most once.
    if (row.kind === "tool" && anchors(row)) return { ...row, spawnedLoopId: loopId };
    if (unOrphans(row)) return { ...row, orphanedLoop: false };
    return row;
  });
}

/**
 * Append to the outer rows array in place for amortized constant-time replay.
 * Row objects, map entries, and scalar counters remain copy-on-write.
 */
function appendRow(view: SessionView, draft: TranscriptRowDraft): SessionView {
  const committed = { ...draft, ordinal: view.nextOrdinal };
  view.rows.push(committed);
  return { ...view, nextOrdinal: view.nextOrdinal + 1 };
}

/** Preserve all user content if a corrupt record's presenter counts cannot fit. */
function frameOf(blocks: ContentBlock[], input: MessageInput | undefined): { blocks: ContentBlock[]; frame?: UserFrame } {
  if (input === undefined || (input.prefix === 0 && input.suffix === 0)) return { blocks };
  if (input.prefix + input.suffix > blocks.length) return { blocks };
  return {
    blocks: blocks.slice(input.prefix, blocks.length - input.suffix),
    frame: { prefix: blocks.slice(0, input.prefix), suffix: blocks.slice(blocks.length - input.suffix) },
  };
}

/** Record a durable command outcome without mutating a prior map snapshot. */
function resolveCommand(view: SessionView, commandId: string, outcome: CommandOutcome): SessionView {
  if (commandId === "") return view;
  const commandOutcomes = new Map(view.commandOutcomes);
  commandOutcomes.set(commandId, outcome);
  return { ...view, commandOutcomes };
}

function foldStatusEvent(view: SessionView, event: StatusEvent): FoldResult {
  if (event.event === undefined) {
    // An absent event body carries no durable state to project.
    return { ok: true, view };
  }
  return foldEnduringEnvelope(view, event.event, event.journal_seq);
}

// --- Top-level fold -----------------------------------------------------------

/** Fold one durable event body from a Factory journal page or publication. */
export function fold(view: SessionView, input: FoldInput): FoldResult {
  return foldStatusEvent(view, input.event);
}

// --- The public gate board ---------------------------------------------------

/**
 * ## Why this is not `SessionView.gates`
 *
 * `SessionView.gates` is the per-session LIVE fold: it exists only where a
 * journal replay or publication stream exists, and it holds the full runtime
 * `gate.Gate` envelope. The board below answers a different question — what
 * gates are open, across sessions, for a client that has just loaded and has
 * no Host, no live subscription and no journal at all. Its only required source
 * is `GET /v1/sessions/{sid}/gates`, which spec §7 makes a pure durable read.
 *
 * Two consequences follow, and both are why this is a separate structure
 * rather than a second map on `SessionView`:
 *
 *  - it is keyed by `(SessionID, GateID)`, because it spans sessions and a
 *    GateID is only unique within one;
 *  - it holds the REDACTED `PublicGateProjection`, not `Gate`, because the cold
 *    source is `additionalProperties: true` at every level and the only safe
 *    thing to keep is a named allowlist (see gate.ts's
 *    `GATE_PROJECTION_WIRE_FIELDS`).
 *
 * ## Merge rules
 *
 * An entry has three parts, each with its own writer:
 *
 *  - IDENTITY AND OPEN POSITION (`sessionId`, `gateId`, `openedEventId`,
 *    `openedJournalSeq`) are written ONCE, on first observation, and never
 *    rewritten. They are facts about one durable `GateOpened`. Writing them
 *    once is also what makes the public order stable under a duplicate.
 *  - ATTESTED STATE (`deadline`, `answerability`) is written ONLY by a gate
 *    page, last page wins. A live journal event never writes it: an open event
 *    proves presentation and never answerability, so a gate seen only live is
 *    unattested and `acceptsResidentResponse` refuses it.
 *  - PRESENTATION (`kind`, `prompt`) is written by a page, and by a live open
 *    only when the entry is new.
 *
 * A live `GateResolved` removes its own key. A page merge never removes: a gate
 * that resolved while this client was offline stays until its `GateResolved` is
 * folded or the board is rebuilt from `emptyPublicGateBoard()`. That is a
 * stated limitation, pinned by test, not an oversight — a page can be one
 * cursor page of several, so "absent from this page" does not mean "closed".
 */
export interface PublicGateEntry extends PublicGateProjection {
  sessionId: string;
}

/**
 * The open public gates, keyed by `publicGateKey(sessionId, gateId)`.
 *
 * There is deliberately no stored order. `publicGates` sorts on read, so the
 * presentation order is a pure function of the entries and cannot drift from
 * them the way a maintained index can.
 */
export interface PublicGateBoard {
  entries: ReadonlyMap<string, PublicGateEntry>;
}

/**
 * The board key: `(SessionID, GateID)`.
 *
 * LENGTH-PREFIXED, not joined with a separator. Both ids are opaque wire
 * strings (`minLength: 1` and nothing else), so `${sessionId}:${gateId}` maps
 * `("a:b","c")` and `("a","b:c")` to one key — and a collision here silently
 * drops a gate a human still has to answer, which is precisely the failure the
 * pair key exists to prevent.
 */
export function publicGateKey(sessionId: string, gateId: string): string {
  return `${sessionId.length}:${sessionId}:${gateId}`;
}

export function emptyPublicGateBoard(): PublicGateBoard {
  return { entries: new Map() };
}

/**
 * Merges one `GET /v1/sessions/{sid}/gates` page into the board.
 *
 * `sessionId` is a parameter because the page does not carry one: it is
 * addressed by URL, so only the caller knows which session it read. An empty
 * one is a caller error and throws — folding two sessions' pages under `""`
 * would merge them, which is the exact confusion the pair key exists to stop.
 * (A gate EVENT, by contrast, names its own session, so `foldPublicGateEvent`
 * reads it from the envelope and never takes it from a caller.)
 *
 * RETURNS THE IDENTICAL BOARD when the page applies nothing — every record
 * already present and equal, or every record unkeyable, or no records at all.
 * This is not a micro-optimisation, and the sentence is here because it is
 * asserted with `toBe`, not because it reads well. The page path is the one a
 * cold client POLLS, and `packages/react`'s `useStore` requires a selector to
 * return something already in the snapshot, so a consumer derives its list as
 * `useMemo(() => publicGates(board), [board])`. A board rebuilt on every
 * unchanged poll produces a fresh array and re-renders every gate card
 * forever. The live duplicate has the same guarantee for the same reason.
 *
 * ### The in-flight page race, which is NOT handled here
 *
 * A page merge never removes (see `PublicGateBoard`), and the inverse race is
 * real too: a page fetched BEFORE a `GateResolved` but merged AFTER it
 * RESURRECTS the resolved gate, complete with whatever `answerability` the
 * page attested — so `acceptsResidentResponse` can report a closed gate as
 * answerable, and only another `GateResolved` (which will never arrive) or a
 * rebuild removes it. This module cannot fix it: it sees no fetch time and no
 * tip ordering. The poll loop above it must choose — a tombstone keyed by
 * `(SessionID, GateID)` that suppresses a page record older than the observed
 * resolve, or a rebuild from `emptyPublicGateBoard()` per page set. The
 * behaviour is pinned by test so the choice is made deliberately at cutover
 * rather than discovered as a stuck card.
 */
export function foldPublicGatePage(
  board: PublicGateBoard,
  page: PublicGatePage,
  sessionId: string,
): PublicGateBoard {
  if (sessionId === "") {
    throw new RangeError("a public gate page must be folded under the session id it was read for");
  }
  const records: unknown = (page as unknown as Record<string, unknown>)["gates"];
  if (!Array.isArray(records) || records.length === 0) return board;
  const entries = new Map(board.entries);
  let changed = false;
  for (const record of records) {
    const projection = decodeGateProjection(record);
    // Unkeyable. `gate_id` has minLength 1, so this is not real wire; keying it
    // under "" would make two such records overwrite each other.
    if (projection.gateId === "") continue;
    const key = publicGateKey(sessionId, projection.gateId);
    const prior = entries.get(key);
    const entry: PublicGateEntry =
      prior === undefined
        ? { sessionId, ...projection }
        : {
            ...projection,
            sessionId,
            // Identity and open position are written once. Both records
            // describe the same durable GateOpened, so a disagreement is a
            // Factory bug rather than a move; keeping the first keeps the
            // public order stable across a reload.
            openedEventId: prior.openedEventId,
            openedJournalSeq: prior.openedJournalSeq,
          };
    if (prior !== undefined && samePublicGateEntry(prior, entry)) continue;
    changed = true;
    entries.set(key, entry);
  }
  return changed ? { entries } : board;
}

/**
 * Whether a re-merged record would change anything a consumer can observe.
 *
 * Field-by-field rather than a structural walk, because it must be exactly the
 * fields `PublicGateEntry` HAS: a comparator that silently ignored a field
 * added later would make `foldPublicGatePage` swallow a real update, which is
 * the worse direction of the identity guarantee. test/fold-gates.test.ts
 * enumerates every projected leaf name from `GATE_PROJECTION_WIRE_FIELDS` and
 * partitions it into the ones that must change the board and the ones that
 * must not, so this list cannot fall behind the projection.
 *
 * FOUR of the twelve comparisons are UNREACHABLE at the one call site, for two
 * different reasons, and all four are named because declaring SOME dead
 * comparisons implies the rest are live — a partial list is a claim, not a
 * courtesy. Each is an equivalent mutant: removing it survives the suite, and
 * that is the expected result rather than a gap. The other eight are live and
 * each dies on the leaf-partition case.
 *
 *  - `sessionId` and `gateId` are established by the KEY. `prior` is read from
 *    `publicGateKey(sessionId, gateId)`, which is injective, and `b` is built
 *    from those same two values, so two entries under one key agree on both.
 *    They stay because their disagreement is exactly the "entries from
 *    different keys were compared" confusion the pair key exists to stop.
 *  - `openedEventId` and `openedJournalSeq` are established by ASSIGNMENT, more
 *    directly still: in the `prior !== undefined` branch the candidate is
 *    literally built with `openedEventId: prior.openedEventId` and
 *    `openedJournalSeq: prior.openedJournalSeq`, so it cannot differ. They
 *    become LIVE the moment the write-once rule above is dropped, which is
 *    precisely why they should stay — they are the comparator's half of that
 *    rule. test/fold-gates.test.ts's `immutable` partition asserts the FOLD
 *    behaves this way; it cannot reach the comparator, and nothing here
 *    pretends otherwise.
 */
function samePublicGateEntry(a: PublicGateEntry, b: PublicGateEntry): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.gateId === b.gateId &&
    a.kind === b.kind &&
    a.openedEventId === b.openedEventId &&
    a.openedJournalSeq === b.openedJournalSeq &&
    a.deadline === b.deadline &&
    a.answerability === b.answerability &&
    a.prompt.title === b.prompt.title &&
    a.prompt.body === b.prompt.body &&
    a.prompt.origin === b.prompt.origin &&
    a.prompt.controls.length === b.prompt.controls.length &&
    a.prompt.controls.every(
      (control, index) =>
        control.action === b.prompt.controls[index]?.action &&
        control.label === b.prompt.controls[index]?.label,
    )
  );
}

/**
 * Folds one journal item — cold `history` or live `enduring` — into the board.
 * Anything that is not a public gate event returns the SAME board object.
 *
 * The session id is read from the event's own envelope. An event that names no
 * session is IGNORED rather than keyed under `""`, which would merge every
 * unaddressed gate in the process into one bucket.
 */
export function foldPublicGateEvent(board: PublicGateBoard, input: FoldInput): PublicGateBoard {
  // This decodes the envelope a second time when a caller also runs `fold`
  // (measured at ~3% of a 4 000-envelope replay). That is deliberate, not an
  // oversight to collapse later: the second decode is what gives a board entry
  // its OWN `prompt` object rather than one aliasing `SessionView.gates`. The
  // board is copy-on-write and hands entries to a renderer; sharing the object
  // with the live fold would make the two structures mutate together.
  const item = enduringItemOf(input);
  if (item === undefined) return board;
  const sessionId = str((item.envelope as unknown as Record<string, unknown>)["session_id"]);
  if (sessionId === "") return board;
  const decoded = decodeEnduring(item.envelope);
  if (decoded.payload.kind === "GateOpened") {
    const gate = decoded.payload.gate;
    if (gate.id === "") return board;
    const key = publicGateKey(sessionId, gate.id);
    // A duplicate: identity and open position are already written and the
    // attestation is not this source's to touch, so there is nothing to apply.
    // Returning the identical board keeps a subscriber from re-rendering.
    if (board.entries.has(key)) return board;
    const entries = new Map(board.entries);
    entries.set(key, {
      sessionId,
      gateId: gate.id,
      kind: gate.kind,
      prompt: gate.prompt,
      openedEventId: decoded.eventId,
      openedJournalSeq: item.journalSeq,
      // Unattested. An open journal event proves presentation, never that
      // anyone can apply a response.
      deadline: "",
      answerability: "",
    });
    return { entries };
  }
  if (decoded.payload.kind === "GateResolved") {
    const key = publicGateKey(sessionId, decoded.payload.gateId);
    if (!board.entries.has(key)) return board;
    const entries = new Map(board.entries);
    entries.delete(key);
    return { entries };
  }
  return board;
}

/**
 * The board's entries in STABLE PUBLIC ORDER: ascending over the triple
 * `(sessionId, openedJournalSeq, gateId)`.
 *
 * It is a total order — the first and third components are the map key, so no
 * two entries tie on all three — and it is a pure function of the entry set, so
 * it does not depend on arrival order and cannot be stale.
 *
 * Strings are compared by code unit, deliberately NOT with `localeCompare`: an
 * order that varies with the browser's locale is not a stable public order.
 */
export function publicGates(board: PublicGateBoard): PublicGateEntry[] {
  return [...board.entries.values()].sort(comparePublicGates);
}

function comparePublicGates(a: PublicGateEntry, b: PublicGateEntry): number {
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  if (a.openedJournalSeq !== b.openedJournalSeq) return a.openedJournalSeq - b.openedJournalSeq;
  if (a.gateId !== b.gateId) return a.gateId < b.gateId ? -1 : 1;
  return 0;
}

/** The durable body and journal sequence shared by journal and publication paths. */
function enduringItemOf(input: FoldInput): { envelope: EventEnvelope; journalSeq: number } | undefined {
  const envelope = input.event.event;
  return envelope === undefined ? undefined : { envelope, journalSeq: input.event.journal_seq };
}
