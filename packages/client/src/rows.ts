/**
 * The transcript row projection (design §3b/§3c).
 *
 * `SessionView.content` and `SessionView.toolCalls` are separate append-only
 * buckets with NO shared ordering key, so "text -> tool call -> text within a
 * turn" cannot be reconstructed from them: the interleaving is lost the moment
 * two updates land in different arrays. `rows` is ONE append-only array with a
 * monotonic ordinal, folded from the SAME inputs, so arrival order survives.
 *
 * ## Rows are copy-on-write
 *
 * Completing a tool call REPLACES the row object; it never mutates it.
 * Mutating in place would leave the row's identity unchanged, so a
 * `useSyncExternalStore` per-row selector comparing with `Object.is` would
 * never re-render the completed card.
 *
 * The OUTER array is a different matter and was carved out deliberately
 * (design §3c): `fold` appends into it in place, because copying it per event
 * made a cold journal replay O(M^2) before first paint. That carve-out covers
 * appends only, and it does NOT extend to the row objects — test/rows.test.ts
 * freezes committed rows so that even a value-preserving write-through throws,
 * and test/fold-immutability.test.ts records the amendment and what still
 * holds either side of it.
 *
 * ## Ordering
 *
 * Rows are partitioned by `loopId` (see `rowsForLoop`) and are NEVER sorted
 * globally by `journalSeq` — that is what makes "a subagent's TurnDone has a lower seq than
 * the parent turn containing it" harmless. Within a loop, committed rows order
 * by the `journalSeq` of the COMMITTING event. `ordinal` is the append order
 * and the stable React key; `journalSeq` is the ordering key within a loop.
 *
 * ## Redacted reasoning
 *
 * A redacted thinking block reaches the wire as
 * `{"ProviderState":"…","ProviderStateFormat":"anthropic","Signature":"",
 * "Thinking":"","type":"thinking"}` and an empty one as
 * `{"Signature":"","Thinking":"","type":"thinking"}` (both verbatim from
 * core@v0.6.0's codec). The two ARE distinguishable on the wire — but the
 * distinction was destroyed one layer below this one, because blocks.ts drops
 * `ProviderState`/`ProviderStateFormat`: provider-private continuation bytes
 * with no reader in a browser. This projection then saw `thinking === ""` and
 * committed NO row for a step whose only content was redacted reasoning, so
 * the turn rendered with a hole in it. (Tool rows always committed, so only
 * pure-redacted steps vanished.)
 *
 * The fix is where it belonged: `ThinkingBlockValue.redacted`, a DERIVED
 * boolean in blocks.ts that forwards no provider bytes. `redactedThinkingOf`
 * projects it and `AssistantRow.redactedThinking` carries it. The bytes still
 * never reach the browser; only the fact that something was withheld does.
 */
import type { ContentBlock, ConversationMessage } from "./blocks.js";
import type { MessagePrincipal } from "./enduring.js";
import type { ToolResultCaptureSummary } from "./toolsummary.js";

export type NoticeLevel = "info" | "warn" | "error";
export type ToolRowStatus = "running" | "ok" | "error" | "cancelled";

export interface TranscriptRowCommon {
  /** Append order. Monotonic across the whole session, never reused; the stable render key. */
  ordinal: number;
  /** The producing loop. "" for a session-scoped row. Rows partition by this. */
  loopId: string;
  turnId: string;
  /**
   * `journal_seq` of the COMMITTING event; undefined for a live (uncommitted)
   * row. Within one loop, committed rows are ordered by this.
   */
  journalSeq: number | undefined;
  /** True while this row is the loop's in-flight live segment. */
  live: boolean;
  /**
   * True when this row's loop never had an observed `LoopStarted`, so it has no
   * parent anchor. Such a loop renders top-level with an "orphaned subagent"
   * marker rather than being dropped.
   *
   * It is cleared retroactively: a `LoopStarted` that arrives AFTER rows this
   * loop already produced un-orphans them (a trimmed page can deliver them in
   * that order). `LoopInfo.observed` is the state this is projected from, and
   * `anchorOf` is what a renderer nests through.
   */
  orphanedLoop: boolean;
}

/** Presenter context around a user's own blocks; the model saw it, the user did not type it. */
export interface UserFrame {
  prefix: ContentBlock[];
  suffix: ContentBlock[];
}

/** A committed user input. A pre-feature row still carries its whole message in blocks. */
export interface UserRow extends TranscriptRowCommon {
  kind: "user";
  /** The user's own blocks when a frame is present, otherwise the whole message. */
  blocks: ContentBlock[];
  frame?: UserFrame;
  principal?: MessagePrincipal;
}

/** One assistant segment: sealed reasoning, narration, and a refusal if the model declined. */
export interface AssistantRow extends TranscriptRowCommon {
  kind: "assistant";
  thinking: string;
  text: string;
  refusal: string;
  /**
   * True when the step held reasoning the provider withheld — projected from
   * `ThinkingBlockValue.redacted`, which is a derived boolean and NOT the
   * provider bytes (blocks.ts still drops those; see its module comment).
   *
   * It is what makes such a step visible at all. A redacted block projects
   * `thinking === ""`, so before this field a step whose ONLY content was
   * redacted reasoning matched every emptiness test and committed no row: the
   * turn simply had a hole in it. Tool rows always committed, so only
   * pure-redacted steps ever vanished.
   *
   * Independent of `thinking`: a step can carry visible reasoning AND a
   * redacted block, and this then means "some of this was withheld".
   *
   * Always false on a LIVE row. harness's ephemeral `thinkingChunkDTO` is
   * `{chunk_type, thinking}` — provider state is not on the streaming wire at
   * all — so redaction is only ever learned at the enduring commit.
   */
  redactedThinking: boolean;
}

/** One tool call's card, from request through result. */
export interface ToolRow extends TranscriptRowCommon {
  kind: "tool";
  /** `content.ToolUseBlock.ID` — the committed pairing key against a ToolResultMessage. */
  toolUseId: string;
  /** The EPHEMERAL execution id, the live card's key. "" on a snapped row. */
  toolExecutionId: string;
  toolName: string;
  /**
   * The redacted one-line detail: what the call was FOR. Two provenances that
   * must agree, or one call renders as two different cards.
   *
   *  - LIVE: harness's `ToolCallStarted.Summary`, computed server-side.
   *  - COMMITTED: DERIVED at snap time by `toolUseSummary` from the stored
   *    `ToolUseBlock.Input`, because the enduring record carries no summary
   *    field at all — the ephemeral frame that has one is never persisted.
   *    tui's `storedStepToolCard` derives it the same way from the same input.
   *
   * The input itself is deliberately NOT carried on the row. It already
   * crosses to the browser inside `StepDone.Messages`, so this is not about
   * exposure — it is that the summariser REDACTS (no file contents, no edit
   * substrings, no request bodies, no task text), and a row that carried the
   * raw input would push that decision into every renderer. "" is a card with
   * a name and no detail line, which is what an unknown tool gets.
   */
  summary: string;
  status: ToolRowStatus;
  result: string;
  /** Safe durable locator/counts only; object bytes require an explicit Factory read. */
  capture?: ToolResultCaptureSummary;
  /** Set when this tool call spawned a child loop; the child's rows anchor here. */
  spawnedLoopId: string;
}

/** An out-of-band message about the session itself: a failure reason, a rejection, a divider. */
export interface NoticeRow extends TranscriptRowCommon {
  kind: "notice";
  level: NoticeLevel;
  text: string;
  principal?: MessagePrincipal;
}

/** The content-less tombstone for an interrupted turn. */
export interface TombstoneRow extends TranscriptRowCommon {
  kind: "tombstone";
  principal?: MessagePrincipal;
}

/**
 * One transcript row. `kind` is the discriminant every consumer switches on:
 * "user" | "assistant" | "tool" | "notice" | "tombstone".
 */
export type TranscriptRow = UserRow | AssistantRow | ToolRow | NoticeRow | TombstoneRow;

/**
 * `Omit` over a union does NOT distribute: `keyof (A | B)` is the INTERSECTION
 * of their keys, so `Omit<TranscriptRow, "ordinal">` would collapse to the
 * common fields and silently discard `blocks`, `text`, `toolName` and the rest.
 * This distributes first, so a draft keeps its variant's own fields.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A row with everything but its ordinal, which only the committing fold allocates. */
export type TranscriptRowDraft = DistributiveOmit<TranscriptRow, "ordinal">;

/**
 * Splits a `StepDone` group the way tui's `splitStepGroup` does: the step shape
 * is one AIMessage followed by zero or more ToolResultMessages, indexed by
 * `ToolUseID`.
 *
 * `validateStepDoneMessages` enforces exactly that shape at harness's durable
 * write boundary — a group whose first message is not an AIMessage, or whose
 * later messages are not all ToolResultMessages, is REJECTED by MarshalEvent —
 * so a UserMessage in a step group and a second AIMessage are both unreachable
 * from harness. They are still handled: a UserMessage is IGNORED (the
 * transcript commits user input from its own TurnStarted / TurnFoldedInto, or
 * it would render twice) and the FIRST AIMessage wins, so a corrupted record
 * degrades instead of throwing.
 */
export function splitStepGroup(messages: ConversationMessage[]): {
  assistant: ConversationMessage | undefined;
  results: Map<string, ConversationMessage>;
} {
  let assistant: ConversationMessage | undefined;
  const results = new Map<string, ConversationMessage>();
  for (const message of messages) {
    if (message.role === "assistant") {
      if (assistant === undefined) assistant = message;
    } else if (message.role === "tool") {
      results.set(message.toolUseId, message);
    }
  }
  return { assistant, results };
}

/**
 * The AIMessage's tool-use blocks in BLOCK order — the executable children of
 * the assistant message. The pairing key against a result is the block's `ID`
 * (`ToolResultMessage.ToolUseID`), which is the DURABLE key: the ephemeral
 * `tool_execution_id` the live card is keyed by never reaches the journal, so a
 * cold replay could not pair with it.
 */
export function toolUsesOf(
  message: ConversationMessage | undefined,
): Array<Extract<ContentBlock, { type: "tool_use" }>> {
  if (message === undefined) return [];
  return message.blocks.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
  );
}

/**
 * Concatenates ONLY the TextBlocks, in block order, joined by "\n" — tui's
 * `textOnly`. Thinking blocks render as their own rail and tool-use blocks as
 * their own cards, so neither belongs in the narration; a refusal is excluded
 * for a stronger reason (see refusalOf).
 */
export function narrationOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * The message's sealed reasoning, in block order. A REDACTED thinking block
 * projects to "" here: its content is provider-private continuation state that
 * blocks.ts deliberately drops, so this layer never saw it. That a block WAS
 * redacted is a separate question, answered by `redactedThinkingOf`.
 */
export function thinkingOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n");
}

/**
 * True when ANY of the message's thinking blocks withheld its content.
 *
 * "Any", not "all": a step that reasoned visibly and also carried a redacted
 * block did withhold part of its reasoning, and the row says so alongside the
 * part it can show.
 *
 * This reads `ThinkingBlockValue.redacted` — a derived boolean, carrying no
 * provider bytes — so the row projection can commit a row for a step whose only
 * content is redacted reasoning. Without it that step projects `thinking === ""`
 * and matches every emptiness test, and the turn renders with a hole in it.
 */
export function redactedThinkingOf(blocks: ContentBlock[]): boolean {
  return blocks.some((b) => b.type === "thinking" && b.redacted);
}

/**
 * A refusal is never folded into narration: `narrationOf` sees only TextBlocks,
 * so a step whose message is nothing but a refusal would otherwise produce no
 * row at all and the transcript would show a declined turn as a turn with no
 * answer. A RefusalBlock's payload is byte-identical to a TextBlock's — the tag
 * is the only thing that distinguishes them.
 */
export function refusalOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "refusal" }> => b.type === "refusal")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Flattens a ToolResultMessage's TextBlocks into one display string, with NO
 * separator: the loop builds a result carrying a single flattened TextBlock, so
 * a join would insert a newline that was never in the output. Non-text blocks
 * have no display form here and are skipped; an absent message yields "".
 */
export function toolResultText(message: ConversationMessage | undefined): string {
  if (message === undefined) return "";
  return message.blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * The minimal read surface the row selectors need. Declared here rather than
 * importing `SessionView` so rows.ts stays a leaf: fold.ts imports rows.ts, and
 * naming `SessionView` here would close the cycle.
 */
export interface RowSource {
  rows: TranscriptRow[];
}

/**
 * One loop's rows, ordered by the `journalSeq` of the COMMITTING event, with
 * live rows (which have none) last in append order.
 *
 * There is deliberately NO global sort. `handlers_events.go` subscribes
 * `LoopScope{All: true}`, so a child loop's frames share one stream with its
 * parent's, and a subagent runs to completion INSIDE the parent turn that
 * contains its tool call — its `TurnDone` therefore carries a LOWER
 * `journal_seq` than the parent turn's own terminal. Ordering every row by
 * `journal_seq` would splice the child's whole transcript into the middle of
 * the parent's turn. Partitioning first is what makes that harmless; a child
 * block anchors at the parent's subagent tool card via
 * `LoopStarted.ParentToolUseID` instead (see `anchorOf`).
 *
 * Sorting a COPY, never `source.rows` itself: the view's array is the append
 * order and the ordinal allocation depends on it.
 *
 * The comparator falls back to `ordinal` so that two rows committed by the SAME
 * event — a `StepDone`'s assistant row and its tool rows — keep block order.
 * That tiebreak is currently redundant (rows are only ever appended in ordinal
 * order, so a stable sort already preserves it) and is written anyway: it stops
 * being redundant the moment anything reorders `rows`.
 */
export function rowsForLoop(source: RowSource, loopId: string): TranscriptRow[] {
  return source.rows
    .filter((row) => row.loopId === loopId)
    .sort((a, b) => {
      // A live row has no journal_seq at all; it sorts after every committed
      // row of its loop, which is exactly where the in-flight turn belongs.
      const aSeq = a.journalSeq ?? Number.POSITIVE_INFINITY;
      const bSeq = b.journalSeq ?? Number.POSITIVE_INFINITY;
      if (aSeq !== bSeq) return aSeq - bSeq;
      return a.ordinal - b.ordinal;
    });
}

/**
 * Every loop that has produced a row, in FIRST-APPEARANCE order — the order the
 * loops themselves became visible, which is stable across folds because rows
 * are only ever appended.
 *
 * `""` (a session-scoped or optimistic row) is not special-cased: it is a
 * partition like any other, and dropping it would hide the composer's own
 * pending row from a consumer that enumerates partitions.
 */
export function loopIdsInOrder(source: RowSource): string[] {
  const seen: string[] = [];
  for (const row of source.rows) {
    if (!seen.includes(row.loopId)) seen.push(row.loopId);
  }
  return seen;
}

/**
 * One loop's place in the session's loop tree, learned from its `LoopStarted`.
 *
 * harness emits exactly one `LoopStarted` per loop, at creation, INCLUDING the
 * session's primary loop — its own `findRootLoopStarted` locates the root by
 * "Cause.Coordinates is zero" and restore fails closed without it — so in a
 * full replay every loop here is `observed`.
 */
export interface LoopInfo {
  loopId: string;
  /**
   * The SPAWNING loop, read from `Header.Cause.LoopID`. "" for the root and for
   * a loop whose `LoopStarted` was never observed.
   *
   * Never the promoted `loop_id`, which is the NEW loop: `LoopStarted`'s
   * identity profile forbids a promoted turn or step precisely because the
   * spawning coordinates belong under `cause`.
   */
  parentLoopId: string;
  /**
   * `content.ToolUseBlock.ID` of the agent tool call that spawned this loop —
   * the anchor a child's block hangs from. "" for a root, for an unobserved
   * loop, and for a NON-tool spawn (a foreign or programmatic loop), which has
   * a real parent but no card to nest under.
   */
  parentToolUseId: string;
  /** `DisplayName` when non-empty, else `Header.AgentName` (older journals). */
  label: string;
  /**
   * False when this loop produced rows or frames but no `LoopStarted` for it
   * was ever seen. That is reachable rather than defensive: `GET /journal`
   * defaults to 100 events and caps at 1000, so a consumer that does not replay
   * from `from_journal_seq=0` starts after the record. Such a loop renders
   * top-level with an "orphaned subagent" marker rather than being dropped, and
   * every row it has produced carries `orphanedLoop: true` until the
   * `LoopStarted` turns up.
   */
  observed: boolean;
}

/** The read surface `anchorOf` needs: the rows, plus the loop tree over them. */
export interface LoopSource extends RowSource {
  loops: Map<string, LoopInfo>;
}

/**
 * The parent tool row a child loop's block hangs from, or `undefined` when the
 * loop has none — because it is the root, because its `LoopStarted` was never
 * observed (an orphan), because it was not spawned by a tool call at all, or
 * because the anchoring step has not been committed yet.
 *
 * Every one of those renders top-level; only the orphan gets a marker, and
 * `TranscriptRow.orphanedLoop` is what distinguishes it.
 */
export function anchorOf(source: LoopSource, loopId: string): TranscriptRow | undefined {
  const info = source.loops.get(loopId);
  if (info === undefined || !info.observed || info.parentToolUseId === "") return undefined;
  return source.rows.find(
    (row) =>
      row.kind === "tool" &&
      row.loopId === info.parentLoopId &&
      row.toolUseId === info.parentToolUseId,
  );
}
