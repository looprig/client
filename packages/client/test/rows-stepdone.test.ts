/**
 * §3b rule 3: "On that loop's `StepDone`, **snap**: discard the live segment
 * and commit from `StepDone.Messages`."
 *
 * The snap is the load-bearing idea. A delta carries no `step_id` (harness's
 * `stampStepID` stamps five event types and `TokenDelta` is not one of them),
 * so the ephemeral accumulation cannot be matched to the enduring commit by any
 * shared key — and does not have to be, because the commit REPLACES it
 * wholesale. That is also the whole of delta/committed deduplication.
 *
 * It repairs an outage too: ephemeral frames carry no `journal_seq` and are
 * never persisted, so a reconnect replays enduring frames only and the deltas
 * emitted during the gap are simply gone. The following `StepDone` restores the
 * step's prose from the durable record.
 *
 * ## Provenance of the wire strings
 *
 * Every `*_WIRE` constant below is the VERBATIM stdout of `event.MarshalEvent`
 * in `github.com/looprig/harness@v0.30.0` — this module's pin, and the version
 * `contract/VERSION` records — driven by a throwaway main constructing real
 * `event.StepDone` values against `core@v0.6.0` / `inference@v0.12.0` (the
 * versions the pin's module graph resolves; a bare `go mod tidy` picks
 * v0.6.1/v0.12.1, which is NOT the pinned wire). They are parsed with
 * JSON.parse, so these tests consume bytes rather than object literals encoding
 * this author's beliefs about the wire.
 *
 * ## What that marshalling proved about the SHAPE of a step group
 *
 * `validateStepDoneMessages` (`pkg/event/validate.go`) runs at the durable
 * write boundary and rejects, with `event: invalid StepDone: Messages is
 * invalid`, every one of: empty/nil `Messages`; a group whose FIRST message is
 * not an `*content.AIMessage`; and a group whose LATER messages are not all
 * `*content.ToolResultMessage`. All five were attempted against the pinned
 * marshaller and all five errored. So:
 *
 *  - a `StepDone` with empty messages CANNOT exist (enforced, not conventional);
 *  - a `UserMessage` can NEVER appear in a step group, in any position — the
 *    plan's "ignores a UserMessage inside the step group" case is an impossible
 *    wire shape, kept below only as a defensive assertion about splitStepGroup;
 *  - a group can carry only ONE AIMessage.
 *
 * A TRUNCATED step DOES emit a StepDone: a lone AIMessage whose last block is a
 * plain TextBlock carrying `TruncatedResponseNotice` /
 * `InterruptedResponseNotice` (harness `internal/loopruntime/truncation.go`) —
 * with NO distinguishing tag, which is exactly why the turn TERMINAL, not this
 * payload, is what tells a truncated group from a clean one.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView } from "../src/fold.js";
import {
  narrationOf,
  redactedThinkingOf,
  refusalOf,
  splitStepGroup,
  thinkingOf,
  toolResultText,
  toolUsesOf,
} from "../src/rows.js";
import { decodeMessages, type ContentBlock } from "../src/blocks.js";
import type { EventEnvelope } from "../src/types.js";
import {
  LOOP_A,
  LOOP_B,
  TURN_1,
  aiMessageWire,
  envelope,
  history,
  liveEphemeral,
  loopStarted,
  resetSeq,
  textBlockWire,
  textDelta,
  thinkingDelta,
} from "./helpers.js";
import { run } from "./run.js";

const STEP_ID = "55555555-5555-4555-8555-555555555555";

/** Sealed reasoning plus narration — the ordinary completed step. */
const STEP_DONE_PROSE_ONLY_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Signature":"sig","SignatureFormat":"anthropic","Thinking":"half a thought","type":"thinking"},{"Text":"partial answer, finished","type":"text"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** The model declined: a refusal block, byte-identical to a text block but for its tag. */
const STEP_DONE_REFUSAL_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Text":"I won\'t do that","type":"refusal"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** A pure-tool step: one tool_use block and nothing else. */
const STEP_DONE_PURE_TOOL_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"ID":"toolu_9","Input":{},"Name":"Bash","type":"tool_use"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** A truncated step: the safe prefix, then the notice — an ORDINARY text block. */
const STEP_DONE_TRUNCATED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Text":"partial answ","type":"text"},{"Text":"[truncated: the stream failed before this reply completed; the content above may be incomplete]","type":"text"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** Two TextBlocks in one message — the join this projection performs is visible. */
const STEP_DONE_MULTI_TEXT_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Text":"first","type":"text"},{"Text":"second","type":"text"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** REDACTED reasoning: the provider bytes are the whole block; Thinking is "". */
const STEP_DONE_REDACTED_THINKING_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"ProviderState":"opaque","ProviderStateFormat":"anthropic","Signature":"","Thinking":"","type":"thinking"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** A plain EMPTY thinking block: no reasoning, and no provider state either. */
const STEP_DONE_EMPTY_THINKING_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Signature":"","Thinking":"","type":"thinking"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** VISIBLE reasoning and a redacted block in one step — the two coexist. */
const STEP_DONE_VISIBLE_PLUS_REDACTED_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Signature":"sig","SignatureFormat":"anthropic","Thinking":"visible reasoning","type":"thinking"},{"ProviderState":"opaque","ProviderStateFormat":"anthropic","Signature":"","Thinking":"","type":"thinking"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** Redacted reasoning alongside a tool call: the tool row always committed. */
const STEP_DONE_REDACTED_PLUS_TOOL_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"ProviderState":"opaque","ProviderStateFormat":"anthropic","Signature":"","Thinking":"","type":"thinking"},{"ID":"toolu_9","Input":{"path":"/a"},"Name":"Read","type":"tool_use"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** Reasoning, narration and TWO tool calls, whose results arrive in the REVERSE order. */
const STEP_DONE_PROSE_AND_TOOLS_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"Signature":"sig","SignatureFormat":"anthropic","Thinking":"half a thought","type":"thinking"},{"Text":"reading both","type":"text"},{"ID":"toolu_1","Input":{"path":"/a"},"Name":"Read","type":"tool_use"},{"ID":"toolu_2","Input":{"path":"/b"},"Name":"Read","type":"tool_use"}]},{"role":"tool","blocks":[{"Text":"B body","type":"text"}],"tool_use_id":"toolu_2"},{"role":"tool","blocks":[{"Text":"no such file","type":"text"}],"tool_use_id":"toolu_1","is_error":true}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** The tool-use block comes FIRST, the narration after it. */
const STEP_DONE_TOOL_THEN_TEXT_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"ID":"toolu_1","Input":{},"Name":"Read","type":"tool_use"},{"Text":"narration after the call","type":"text"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/**
 * Five tool calls with REAL inputs, one per summariser shape: a path tool, a
 * command tool, a byte-counted write, a scoped search, and a task tool that
 * deliberately has no summary at all.
 */
const STEP_DONE_SUMMARY_TOOLS_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"ID":"toolu_1","Input":{"path":"/etc/hosts"},"Name":"Read","type":"tool_use"},{"ID":"toolu_2","Input":{"command":"ls -la /tmp"},"Name":"Bash","type":"tool_use"},{"ID":"toolu_3","Input":{"path":"/tmp/out.txt","content":"hello"},"Name":"WriteFile","type":"tool_use"},{"ID":"toolu_4","Input":{"pattern":"TODO","path":"src"},"Name":"Grep","type":"tool_use"},{"ID":"toolu_5","Input":{"title":"do it"},"Name":"TaskCreate","type":"tool_use"}]}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

/** A result carrying several blocks, one of which has no display form at all. */
const STEP_DONE_MULTIBLOCK_RESULT_WIRE =
  '{"created_at":"2026-08-27T10:00:00Z","event_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","loop_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","messages":[{"role":"assistant","blocks":[{"ID":"toolu_5","Input":{},"Name":"Bash","type":"tool_use"}]},{"role":"tool","blocks":[{"Text":"line one\\n","type":"text"},{"MediaType":"image/png","Source":{"URL":"","Data":"iVA="},"type":"image"},{"Text":"line two","type":"text"}],"tool_use_id":"toolu_5"}],"session_id":"11111111-1111-4111-8111-111111111111","step_id":"55555555-5555-4555-8555-555555555555","turn_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","type":"StepDone","v":1}';

function wireEnvelope(json: string): EventEnvelope {
  return JSON.parse(json) as EventEnvelope;
}

/** A StepDone built rather than marshalled, for the multi-loop/multi-step orchestration cases. */
function stepDone(loopId: string, blocks: Array<Record<string, unknown>>, seq?: number) {
  return history(
    envelope({
      type: "StepDone",
      loopId,
      turnId: TURN_1,
      stepId: STEP_ID,
      payload: { messages: [aiMessageWire(blocks)] },
    }),
    seq,
  );
}

const TEXT: ContentBlock = { type: "text", text: "narration" };
const THINK: ContentBlock = { type: "thinking", thinking: "reasoning", signature: "sig", redacted: false };
const REFUSE: ContentBlock = { type: "refusal", text: "declined" };
const USE: ContentBlock = { type: "tool_use", id: "toolu_1", name: "Read", input: {} };

describe("rows: the step-group helpers", () => {
  it("splitStepGroup takes the FIRST assistant message and indexes tool results by ToolUseID", () => {
    const messages = decodeMessages([
      { role: "assistant", blocks: [textBlockWire("first")] },
      { role: "tool", tool_use_id: "toolu_1", blocks: [textBlockWire("one")] },
      { role: "tool", tool_use_id: "toolu_2", is_error: true, blocks: [textBlockWire("two")] },
    ]);
    const { assistant, results } = splitStepGroup(messages);
    expect(assistant?.blocks).toStrictEqual([{ type: "text", text: "first" }]);
    expect([...results.keys()]).toStrictEqual(["toolu_1", "toolu_2"]);
    expect(results.get("toolu_2")).toMatchObject({ isError: true });
  });

  it("splitStepGroup ignores a UserMessage and a second AIMessage — neither can reach the wire", () => {
    // validateStepDoneMessages rejects both at MarshalEvent (see the module
    // note): this is defence against a corrupted record, not a real order.
    const messages = decodeMessages([
      { role: "user", blocks: [textBlockWire("folded input")] },
      { role: "assistant", blocks: [textBlockWire("reply")] },
      { role: "assistant", blocks: [textBlockWire("second reply")] },
    ]);
    const { assistant, results } = splitStepGroup(messages);
    expect(assistant?.blocks).toStrictEqual([{ type: "text", text: "reply" }]);
    expect(results.size).toBe(0);
  });

  it("splitStepGroup on an empty group yields no assistant and no results", () => {
    const { assistant, results } = splitStepGroup([]);
    expect(assistant).toBeUndefined();
    expect(results.size).toBe(0);
  });

  it("narrationOf joins ONLY the text blocks, in block order, with a newline", () => {
    expect(narrationOf([THINK, TEXT, USE, { type: "text", text: "more" }, REFUSE])).toBe("narration\nmore");
    expect(narrationOf([THINK, USE, REFUSE])).toBe("");
    expect(narrationOf([])).toBe("");
  });

  it("thinkingOf joins ONLY the thinking blocks, and reads a redacted one as empty", () => {
    expect(thinkingOf([THINK, TEXT, { type: "thinking", thinking: "more", signature: "", redacted: false }])).toBe("reasoning\nmore");
    // A redacted block carries its content in provider-private bytes blocks.ts
    // deliberately drops, so it projects to "" — see rows.ts's module comment.
    expect(thinkingOf([{ type: "thinking", thinking: "", signature: "", redacted: false }])).toBe("");
  });

  it("redactedThinkingOf reports whether ANY thinking block withheld its content", () => {
    const REDACTED: ContentBlock = { type: "thinking", thinking: "", signature: "", redacted: true };
    expect(redactedThinkingOf([REDACTED])).toBe(true);
    // Any, not all: a step that reasoned visibly AND withheld part of it did
    // withhold part of it.
    expect(redactedThinkingOf([THINK, REDACTED])).toBe(true);
    // And within ONE block: core@v0.6.0 marshals a block carrying visible
    // Thinking AND ProviderState (blocks.test.ts pins the bytes), so this is
    // not the same shape as the two-block case above.
    expect(redactedThinkingOf([{ type: "thinking", thinking: "visible", signature: "", redacted: true }])).toBe(
      true,
    );
    expect(redactedThinkingOf([THINK, TEXT, USE])).toBe(false);
    // An empty thinking block is NOT a redacted one — that is the whole
    // distinction the derived flag exists to carry.
    expect(redactedThinkingOf([{ type: "thinking", thinking: "", signature: "", redacted: false }])).toBe(false);
    expect(redactedThinkingOf([])).toBe(false);
  });

  it("refusalOf is separate from narration, so a declined turn is never reported as an answer", () => {
    expect(refusalOf([TEXT, REFUSE])).toBe("declined");
    expect(narrationOf([TEXT, REFUSE])).toBe("narration");
    expect(refusalOf([TEXT])).toBe("");
  });

  it("toolResultText concatenates the result's text blocks with NO separator and skips the rest", () => {
    const [result] = decodeMessages([
      {
        role: "tool",
        tool_use_id: "toolu_5",
        blocks: [textBlockWire("line one\n"), { type: "image", Source: "x" }, textBlockWire("line two")],
      },
    ]);
    expect(toolResultText(result)).toBe("line one\nline two");
    expect(toolResultText(undefined)).toBe("");
  });
});

describe("rows: the StepDone snap", () => {
  it("discards the provisional live segment and commits from StepDone.Messages", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      thinkingDelta("half a th", LOOP_A, TURN_1),
      textDelta("partial answ", LOOP_A, TURN_1),
      history(wireEnvelope(STEP_DONE_PROSE_ONLY_WIRE), 11),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "assistant",
        // The live row burned ordinal 0 and was discarded; ordinals are never
        // reused, so the committed row is 1.
        ordinal: 1,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: 11,
        live: false,
        orphanedLoop: false,
        thinking: "half a thought",
        text: "partial answer, finished",
        refusal: "",
        redactedThinking: false,
      },
    ]);
  });

  it("discards the loop's live TOOL rows in the same snap", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      liveEphemeral("tool_call_started", { tool_execution_id: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1", tool_name: "Read" }, LOOP_A, TURN_1),
      textDelta("thinking about it", LOOP_A, TURN_1),
      history(wireEnvelope(STEP_DONE_PROSE_ONLY_WIRE), 12),
    ]);
    expect(view.rows.filter((r) => r.live)).toStrictEqual([]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["assistant"]);
  });

  it("still appends the generic StatusEventMarker alongside the snap", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_PROSE_ONLY_WIRE), 11)]);
    expect(view.statusEvents).toHaveLength(1);
    expect(view.statusEvents[0]).toMatchObject({ type: "StepDone", journalSeq: 11, stepId: STEP_ID });
  });

  it("commits a refusal as its own field, never merged into narration", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      history(wireEnvelope(STEP_DONE_REFUSAL_WIRE), 3),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "assistant",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: 3,
        live: false,
        orphanedLoop: false,
        thinking: "",
        text: "",
        refusal: "I won't do that",
        redactedThinking: false,
      },
    ]);
  });

  it("commits NO assistant row for a pure-tool step", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_PURE_TOOL_WIRE), 4)]);
    expect(view.rows.filter((r) => r.kind === "assistant")).toStrictEqual([]);
  });

  it("commits a truncated step exactly like a clean one — the notice is ordinary narration", () => {
    // There is no tag to read: the notice is a TextBlock. A consumer that must
    // tell the two apart reads the turn TERMINAL (TurnFailed / TurnInterrupted),
    // which tasks 3.20 and 3.21 project.
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("partial answ", LOOP_A, TURN_1),
      history(wireEnvelope(STEP_DONE_TRUNCATED_WIRE), 6),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      kind: "assistant",
      live: false,
      journalSeq: 6,
      text:
        "partial answ\n[truncated: the stream failed before this reply completed; the content above may be incomplete]",
    });
  });

  it("joins several text blocks in block order rather than keeping only one", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_MULTI_TEXT_WIRE), 7)]);
    expect(view.rows[0]).toMatchObject({ text: "first\nsecond" });
  });

  it("commits a row for a step whose ONLY content is redacted reasoning", () => {
    // THE VANISHING-STEP FIX. This test used to pin the opposite. blocks.ts
    // drops ProviderState/ProviderStateFormat (provider-private continuation
    // bytes with no reader in a browser), and that also destroyed the only
    // evidence that the block held anything — so the projection saw
    // thinking === "" and committed nothing, and a step whose only content was
    // redacted reasoning disappeared from the transcript entirely. The derived
    // `redacted` boolean on ThinkingBlockValue restores the fact without the
    // bytes, and the commit condition now reads it.
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      history(wireEnvelope(STEP_DONE_REDACTED_THINKING_WIRE), 8),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "assistant",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: 8,
        live: false,
        orphanedLoop: false,
        thinking: "",
        text: "",
        refusal: "",
        redactedThinking: true,
      },
    ]);
    expect(view.nextOrdinal).toBe(1);
  });

  it("still forwards no provider bytes for the step it now commits", () => {
    // The decision that provider-private replay state never reaches the browser
    // stands; only the FACT of redaction crosses. Serialising the whole view
    // must not contain the payload or its dialect label.
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_REDACTED_THINKING_WIRE), 8)]);
    const serialized = JSON.stringify(view.rows);
    expect(serialized).not.toContain("opaque");
    expect(serialized).not.toContain("ProviderState");
    expect(serialized).not.toContain("anthropic");
  });

  it("commits NOTHING for a plain EMPTY thinking block, which withheld nothing", () => {
    // The other half of the distinction, and the reason the flag had to be
    // derived from ProviderState rather than from an empty Thinking: these two
    // steps are identical in every visible field.
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_EMPTY_THINKING_WIRE), 8)]);
    expect(view.rows).toStrictEqual([]);
    expect(view.nextOrdinal).toBe(0);
  });

  it("keeps the visible reasoning AND marks the redaction when a step has both", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_VISIBLE_PLUS_REDACTED_WIRE), 8)]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      kind: "assistant",
      // The trailing newline is thinkingOf's block-order join meeting the
      // redacted block's "" — pre-existing and unchanged by this fix, asserted
      // rather than papered over.
      thinking: "visible reasoning\n",
      redactedThinking: true,
    });
  });

  it("marks the assistant row a redacted step ALSO has tool calls in", () => {
    // Tool rows always committed, so only PURE-redacted steps ever vanished.
    // The assistant row is committed here too, and it is the one that carries
    // the mark.
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_REDACTED_PLUS_TOOL_WIRE), 8)]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["assistant", "tool"]);
    expect(view.rows[0]).toMatchObject({ thinking: "", text: "", refusal: "", redactedThinking: true });
    expect(view.rows[1]).toMatchObject({ toolUseId: "toolu_9", summary: "/a" });
  });

  it("leaves an ordinary committed row unmarked", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_PROSE_ONLY_WIRE), 8)]);
    expect(view.rows[0]).toMatchObject({ thinking: "half a thought", redactedThinking: false });
  });

  it("snaps only the committing loop, leaving another loop's live segment alone", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("child working", LOOP_B, TURN_1),
      textDelta("parent working", LOOP_A, TURN_1),
      stepDone(LOOP_A, [textBlockWire("parent done")]),
    ]);
    const b = view.rows.find((r) => r.loopId === LOOP_B);
    expect(b).toMatchObject({ live: true, text: "child working" });
    expect(view.rows.filter((r) => r.loopId === LOOP_A)).toStrictEqual([
      expect.objectContaining({ live: false, text: "parent done" }),
    ]);
  });

  it("multi-step turns render as multiple separate assistant rows, never one merged row", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      stepDone(LOOP_A, [textBlockWire("step one")], 1),
      stepDone(LOOP_A, [textBlockWire("step two")], 2),
    ]);
    expect(view.rows.map((r) => (r.kind === "assistant" ? r.text : r.kind))).toStrictEqual([
      "step one",
      "step two",
    ]);
    expect(view.rows.map((r) => r.journalSeq)).toStrictEqual([1, 2]);
  });

  it("leaves already-committed rows' identities alone, which per-row selectors depend on", () => {
    resetSeq();
    const first = run(emptySessionView(), [stepDone(LOOP_A, [textBlockWire("one")], 1)]);
    const committed = first.rows[0];
    const second = run(first, [stepDone(LOOP_A, [textBlockWire("two")], 2)]);
    expect(second.rows[0], "an untouched row was re-created, so every card would re-render").toBe(committed);
  });

  it("commits nothing for a messages-less StepDone, which the durable boundary cannot produce", () => {
    // validateStepDoneMessages rejects an empty Messages at MarshalEvent, so
    // this is unreachable from harness; it must still not throw or half-commit.
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("in flight", LOOP_A, TURN_1),
      history(envelope({ type: "StepDone", loopId: LOOP_A, turnId: TURN_1 }), 9),
    ]);
    // The snap still happens: the live segment belonged to a step that has now
    // ended, and keeping it would dangle it into the next step.
    expect(view.rows).toStrictEqual([]);
  });
});

describe("rows: StepDone tool expansion", () => {
  it("toolUsesOf returns the tool-use blocks in BLOCK order and nothing else", () => {
    const [message] = decodeMessages([
      {
        role: "assistant",
        blocks: [
          textBlockWire("narration"),
          { type: "tool_use", ID: "toolu_1", Name: "Read", Input: {} },
          { type: "thinking", Thinking: "t", Signature: "" },
          { type: "tool_use", ID: "toolu_2", Name: "Bash", Input: {} },
        ],
      },
    ]);
    expect(toolUsesOf(message).map((b) => b.id)).toStrictEqual(["toolu_1", "toolu_2"]);
    expect(toolUsesOf(undefined)).toStrictEqual([]);
  });

  it("commits one tool row per tool-use block, in block order, paired by ToolUseID", () => {
    // The results arrive REVERSED on the wire (toolu_2 before toolu_1), so a
    // positional pairing produces the right count and the wrong contents.
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      history(wireEnvelope(STEP_DONE_PROSE_AND_TOOLS_WIRE), 20),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["assistant", "tool", "tool"]);
    expect(view.rows[1]).toStrictEqual({
      kind: "tool",
      ordinal: 1,
      loopId: LOOP_A,
      turnId: TURN_1,
      journalSeq: 20,
      live: false,
      orphanedLoop: false,
      toolUseId: "toolu_1",
      // "" on a snapped row: the ephemeral tool_execution_id never reaches the
      // journal, so a cold replay has no value to put here.
      toolExecutionId: "",
      toolName: "Read",
      // Was "" before the cold-replay fix: derived from the stored
      // ToolUseBlock's Input {"path":"/a"} by tui's toolUseSummary.
      summary: "/a",
      status: "error",
      result: "no such file",
      spawnedLoopId: "",
    });
    expect(view.rows[2]).toMatchObject({
      ordinal: 2,
      toolUseId: "toolu_2",
      toolName: "Read",
      summary: "/b",
      status: "ok",
      result: "B body",
      journalSeq: 20,
    });
  });

  it("commits a tool row with status ok and no result when the result message is missing", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_PURE_TOOL_WIRE), 21)]);
    expect(view.rows).toStrictEqual([
      expect.objectContaining({ kind: "tool", toolUseId: "toolu_9", toolName: "Bash", status: "ok", result: "" }),
    ]);
  });

  it("commits the assistant row BEFORE its tool rows, whatever the block order", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_TOOL_THEN_TEXT_WIRE), 22)]);
    expect(view.rows.map((r) => r.ordinal)).toStrictEqual([0, 1]);
    expect(view.rows[0]).toMatchObject({ kind: "assistant", text: "narration after the call" });
    expect(view.rows[1]).toMatchObject({ kind: "tool", toolUseId: "toolu_1" });
  });

  it("flattens a multi-block result into the row's display text", () => {
    resetSeq();
    const view = run(emptySessionView(), [history(wireEnvelope(STEP_DONE_MULTIBLOCK_RESULT_WIRE), 23)]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ kind: "tool", toolUseId: "toolu_5", result: "line one\nline two" });
  });

  it("derives each committed card's summary from the stored tool-use Input", () => {
    // THE COLD-REPLAY FIX. Before it, every row below carried summary: "" and a
    // replayed transcript showed a tool name and a result and nothing about
    // what the call was for. The derivation is tui's `toolUseSummary`, so a
    // card the TUI and the browser both render reads the same in both.
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      history(wireEnvelope(STEP_DONE_SUMMARY_TOOLS_WIRE), 25),
    ]);
    expect(view.rows.map((r) => (r.kind === "tool" ? [r.toolName, r.summary] : r.kind))).toStrictEqual([
      ["Read", "/etc/hosts"],
      ["Bash", "ls -la /tmp"],
      // Counted, never shown: the write's body is not in the row.
      ["WriteFile", "/tmp/out.txt (5 bytes)"],
      ["Grep", "TODO in src"],
      // A task tool has no redacted fragment to show; its card is name-only.
      ["TaskCreate", ""],
    ]);
    expect(JSON.stringify(view.rows)).not.toContain("hello");
  });

  it("replaces the live card with the committed row rather than showing both", () => {
    // The dedup the snap solves with no shared key: the live card is keyed by
    // tool_execution_id, the committed row by ToolUseID, and nothing on the
    // wire relates the two. Discarding the whole live segment is what makes
    // that unnecessary.
    resetSeq();
    const view = run(emptySessionView(), [
      liveEphemeral(
        "tool_call_started",
        { tool_execution_id: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1", tool_name: "Bash", summary: "Bash(ls)" },
        LOOP_A,
        TURN_1,
      ),
      liveEphemeral(
        "tool_call_completed",
        { tool_execution_id: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1", result_preview: "capped preview" },
        LOOP_A,
        TURN_1,
      ),
      history(wireEnvelope(STEP_DONE_PURE_TOOL_WIRE), 24),
    ]);
    const tools = view.rows.filter((r) => r.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ live: false, toolUseId: "toolu_9", toolExecutionId: "", journalSeq: 24 });
  });
});
