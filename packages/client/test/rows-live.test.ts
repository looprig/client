/**
 * §3b rule 3: "The in-flight turn is a live segment appended after that loop's
 * last committed row, from ephemeral frames in arrival order — deltas per
 * `loop_id`."
 *
 * The live segment is what makes the missing `step_id` irrelevant.
 * `stampStepID` (harness `internal/loopruntime/header.go`) stamps `StepID` on
 * exactly five event types — PermissionRequested, PermissionDecided,
 * UserInputRequested, ToolCallStarted, ToolCallCompleted — and `TokenDelta` is
 * NOT one of them: `stampLoopHeader` fills a TokenDelta header turn-scoped
 * (`fillTurnScoped`: SessionID + LoopID + TurnID), so a delta carries a loop
 * and a turn and never a step. Grouping content by `step_id` would therefore
 * group ZERO content. A delta instead belongs, by construction, to its loop's
 * CURRENT in-flight step, and the loop's `StepDone` replaces the whole
 * accumulation (test/rows-stepdone.test.ts). Both facts were read out of
 * harness@v0.30.0, this module's pin.
 *
 * ## Why the live row carries a turn id
 *
 * The implementation plan hardcoded `turnId: ""` on the live assistant row.
 * The wire has it: `fillTurnScoped` stamps `TurnID` on every TokenDelta, so
 * dropping it would leave the row that a turn terminal later COMMITS
 * (task 3.19) with an empty turn id that the committing event could no longer
 * supply for the deltas it covers. It is projected and asserted here.
 */
import { describe, expect, it } from "vitest";
import { emptySessionView, fold } from "../src/fold.js";
import {
  LOOP_A,
  LOOP_B,
  TURN_1,
  TURN_2,
  envelope,
  history,
  liveEphemeral,
  loopStarted,
  resetSeq,
  imageDelta,
  refusalDelta,
  textBlockWire,
  textDelta,
  thinkingDelta,
  userMessageWire,
} from "./helpers.js";
import { run } from "./run.js";

describe("rows: the live segment", () => {
  it("appends one live assistant row per loop and accumulates deltas into it", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      textDelta("Hel", LOOP_A, TURN_1),
      textDelta("lo", LOOP_A, TURN_1),
      thinkingDelta("planning", LOOP_A, TURN_1),
    ]);
    // toStrictEqual, not toMatchObject: every projected field is pinned, and
    // `journalSeq: undefined` under toMatchObject would pass against a row that
    // carries no such key at all.
    expect(view.rows).toStrictEqual([
      {
        kind: "assistant",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: undefined,
        live: true,
        orphanedLoop: false,
        thinking: "planning",
        text: "Hello",
        refusal: "",
        // Never true on a live row: harness's ephemeral thinkingChunkDTO is
        // {chunk_type, thinking}, so provider state is not on the streaming
        // wire and redaction is only ever learned at the enduring commit.
        redactedThinking: false,
      },
    ]);
    expect(view.nextOrdinal).toBe(1);
  });

  it("keeps the live row's ordinal stable across deltas, so its React key never changes", () => {
    resetSeq();
    let view = run(emptySessionView(), [textDelta("a", LOOP_A)]);
    const first = view.rows[0]?.ordinal;
    view = run(view, [textDelta("b", LOOP_A), thinkingDelta("c", LOOP_A)]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.ordinal).toBe(first);
  });

  it("keeps a separate live segment per loop_id", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("parent", LOOP_A),
      textDelta("child", LOOP_B),
      textDelta(" more", LOOP_A),
    ]);
    const live = view.rows.filter((r) => r.live);
    // The length assertion is the mutation guard: merging two loops' deltas
    // into one segment yields a single row and must fail here, not just on the
    // text comparison below.
    expect(live).toHaveLength(2);
    const byLoop = new Map(live.map((r) => [r.loopId, r]));
    expect(byLoop.get(LOOP_A)).toMatchObject({ text: "parent more" });
    expect(byLoop.get(LOOP_B)).toMatchObject({ text: "child" });
  });

  it("REPLACES the live row object on every delta (copy-on-write), never mutates it", () => {
    resetSeq();
    let view = run(emptySessionView(), [textDelta("a", LOOP_A)]);
    const first = view.rows.find((r) => r.live);
    view = run(view, [textDelta("b", LOOP_A)]);
    const second = view.rows.find((r) => r.live);
    expect(second).not.toBe(first);
    expect(first).toMatchObject({ text: "a" });
    expect(second).toMatchObject({ text: "ab" });
  });

  it("never writes THROUGH a live row, even a write that preserves its value", () => {
    // Object.freeze in the test, never in production: a write through a frozen
    // object throws in module (strict) code, so this catches an in-place update
    // that a deep comparison cannot see because it wrote an EQUAL value.
    resetSeq();
    const first = run(emptySessionView(), [textDelta("a", LOOP_A)]);
    first.rows.forEach((row) => Object.freeze(row));
    const second = run(first, [textDelta("", LOOP_A)]);
    expect(second.rows[0]).not.toBe(first.rows[0]);
    expect(first.rows[0]).toMatchObject({ text: "a" });
  });

  it("places the live segment AFTER that loop's last committed row", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      history(
        envelope({
          type: "TurnStarted",
          loopId: LOOP_A,
          turnId: TURN_1,
          payload: { message: userMessageWire([textBlockWire("go")]) },
        }),
      ),
      textDelta("working", LOOP_A, TURN_1),
    ]);
    expect(view.rows.map((r) => r.kind)).toStrictEqual(["user", "assistant"]);
    expect(view.rows[1]?.live).toBe(true);
    expect(view.rows[1]?.turnId).toBe(TURN_1);
  });

  it("attributes a delta with no header loop id to the session-scoped bucket", () => {
    resetSeq();
    const view = run(emptySessionView(), [textDelta("orphan")]);
    const live = view.rows.filter((r) => r.live);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ loopId: "", turnId: "" });
  });

  it("keeps the turn id the segment opened with when a later delta carries another", () => {
    // A turn boundary always passes through a StepDone or a terminal, both of
    // which end the segment, so this is a defensive rule rather than a real
    // order: the segment reports the turn it belongs to, not the last frame's.
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("a", LOOP_A, TURN_1),
      textDelta("b", LOOP_A, TURN_2),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ turnId: TURN_1, text: "ab" });
  });

  it("opens NO live row for a tool_use chunk, and never extends one with it", () => {
    // A tool_use chunk is the model's in-progress tool-call CONSTRUCTION
    // (index/id/name/partial JSON, per harness's toolUseChunkDTO), not an
    // execution: it has no committable display form, and the tool card is
    // driven by tool_call_started/completed instead.
    resetSeq();
    const alone = run(emptySessionView(), [
      liveEphemeral(
        "token_delta",
        { chunk_type: "tool_use", index: 0, id: "toolu_1", name: "Read", input_json: '{"pa' },
        LOOP_A,
      ),
    ]);
    expect(alone.rows).toStrictEqual([]);
    // The chunk still reaches the legacy content bucket, and burns no ordinal.
    expect(alone.content).toHaveLength(1);
    expect(alone.nextOrdinal).toBe(0);

    const after = run(alone, [
      textDelta("hi", LOOP_A),
      liveEphemeral(
        "token_delta",
        { chunk_type: "tool_use", index: 0, id: "toolu_1", name: "Read", input_json: 'th"}' },
        LOOP_A,
      ),
    ]);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({ text: "hi" });
  });

  it("never marks a live row redacted, whatever the streamed thinking chunk carries", () => {
    // Not a placeholder. harness's ephemeral thinkingChunkDTO is
    // {chunk_type, thinking} — ProviderState is not on the streaming wire at
    // all, so a live row has nothing to learn redaction FROM, and the StepDone
    // snap replaces the row with one committed from the durable blocks anyway.
    // A delta that smuggles the key in must not change that.
    resetSeq();
    const view = run(emptySessionView(), [
      thinkingDelta("planning", LOOP_A, TURN_1),
      liveEphemeral(
        "token_delta",
        { chunk_type: "thinking", thinking: "", ProviderState: "opaque", ProviderStateFormat: "anthropic" },
        LOOP_A,
        TURN_1,
      ),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ live: true, redactedThinking: false });
    expect(JSON.stringify(view.rows)).not.toContain("opaque");
  });

  it("still appends every folded chunk to the legacy content bucket", () => {
    resetSeq();
    const view = run(emptySessionView(), [textDelta("a", LOOP_A), thinkingDelta("b", LOOP_A)]);
    expect(view.content).toStrictEqual([
      { chunkType: "text", text: "a", header: view.content[0]?.header },
      { chunkType: "thinking", thinking: "b", header: view.content[1]?.header },
    ]);
  });

  it("streams a refusal into the live segment's refusal field", () => {
    // THE GAP THIS FILE USED TO PIN. harness emits a refusal as its OWN chunk
    // type — pkg/serve/ephemeral.go's refusalChunkDTO, whose delta marshals to
    // {"chunk_type":"refusal","text":"I can't"} — and the inherited
    // parseTokenDeltaChunk (copied from client/sdk/core) knew only
    // text/thinking/tool_use, so a streamed refusal came back as an
    // unknown_chunk_type FOLD ERROR and its text appeared only later, via the
    // StepDone snap. A user watching a refusal stream saw an error, then text.
    //
    // It lands in `refusal`, never `text`: a RefusalBlock's payload is
    // byte-identical to a TextBlock's and the tag is the only thing that keeps
    // a declined request from rendering as the model answering it. The same
    // reason harness gave the chunk its own chunk_type rather than mapping it
    // onto "text".
    resetSeq();
    const view = run(emptySessionView(), [
      loopStarted(LOOP_A),
      refusalDelta("I ca", LOOP_A, TURN_1),
      refusalDelta("n't", LOOP_A, TURN_1),
    ]);
    expect(view.rows).toStrictEqual([
      {
        kind: "assistant",
        ordinal: 0,
        loopId: LOOP_A,
        turnId: TURN_1,
        journalSeq: undefined,
        live: true,
        orphanedLoop: false,
        thinking: "",
        text: "",
        refusal: "I can't",
        redactedThinking: false,
      },
    ]);
  });

  it("accumulates a refusal into the SAME segment text and thinking opened", () => {
    // One segment per loop, whatever the chunk mix: a model that narrates and
    // then declines is one assistant turn, not two rows.
    resetSeq();
    const view = run(emptySessionView(), [
      textDelta("let me see", LOOP_A, TURN_1),
      thinkingDelta("hmm", LOOP_A, TURN_1),
      refusalDelta("no", LOOP_A, TURN_1),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ text: "let me see", thinking: "hmm", refusal: "no", ordinal: 0 });
  });

  it("REPLACES the live row on a refusal chunk rather than mutating it", () => {
    resetSeq();
    let view = run(emptySessionView(), [refusalDelta("I ", LOOP_A, TURN_1)]);
    const before = view.rows[0];
    Object.freeze(before);
    view = run(view, [refusalDelta("won't", LOOP_A, TURN_1)]);
    expect(view.rows[0]).not.toBe(before);
    expect(before).toMatchObject({ refusal: "I " });
    expect(view.rows[0]).toMatchObject({ refusal: "I won't" });
  });

  it("still appends a refusal chunk to the legacy content bucket", () => {
    resetSeq();
    const view = run(emptySessionView(), [refusalDelta("no", LOOP_A)]);
    expect(view.content).toStrictEqual([
      { chunkType: "refusal", text: "no", header: view.content[0]?.header },
    ]);
  });

  it("rejects a refusal chunk with no string text as malformed, not unknown", () => {
    const result = fold(emptySessionView(), liveEphemeral("token_delta", { chunk_type: "refusal" }, LOOP_A));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("malformed_delta");
  });
});

describe("rows: image chunks", () => {
  /**
   * harness's imageChunkDTO, verbatim from `pkg/serve/ephemeral.go`
   * (harness@v0.30.0):
   *
   *     ChunkType string            `json:"chunk_type"`
   *     Index     int               `json:"index"`
   *     MediaType content.MediaType `json:"media_type,omitempty"`
   *     URL       string            `json:"url,omitempty"`
   *     Data      []byte            `json:"data,omitempty"`
   *
   * Marshalling a real `content.ImageChunk` through it yields
   * `{"chunk_type":"image","index":3,"media_type":"image/png","data":"iVA="}`
   * for a byte delta and `{"chunk_type":"image","index":0}` for a zero chunk —
   * so `index` is ALWAYS present (no omitempty) and the other three are not.
   *
   * ## Why an image chunk commits no row
   *
   * It is a per-image FRAGMENT: `Data` appends in arrival order and `URL`
   * arrives whole, and core's own doc records that splicing one image's bytes
   * onto another's yields a file no decoder can recover. Reassembly is real
   * work, and there is nothing at the far end of it — no row variant carries an
   * image, and the enduring `StepDone` commits the finished ImageBlock anyway
   * (blocks.ts decodes it as the opaque `other` variant, which no row projects).
   * So the honest handling is the one `tool_use` chunks already get: parse it,
   * append it to `content`, burn no ordinal, and above all do not fail the
   * fold. A frame the transport legitimately emits must never surface as an
   * error notice.
   */
  it("folds an image chunk without error and commits no row", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      imageDelta({ index: 3, media_type: "image/png", data: "iVA=" }, LOOP_A, TURN_1),
    ]);
    expect(view.rows).toStrictEqual([]);
    expect(view.nextOrdinal).toBe(0);
  });

  it("appends the image chunk to the legacy content bucket, fields intact", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      imageDelta({ index: 3, media_type: "image/png", data: "iVA=" }, LOOP_A),
    ]);
    expect(view.content).toStrictEqual([
      {
        chunkType: "image",
        index: 3,
        mediaType: "image/png",
        url: "",
        data: "iVA=",
        header: view.content[0]?.header,
      },
    ]);
  });

  it("folds the omitempty-stripped zero chunk the wire really carries", () => {
    // `{"chunk_type":"image","index":0}` — media_type, url and data are all
    // omitempty, so a chunk can legitimately carry none of them.
    resetSeq();
    const view = run(emptySessionView(), [imageDelta({ index: 0 }, LOOP_A)]);
    expect(view.content).toStrictEqual([
      { chunkType: "image", index: 0, mediaType: "", url: "", data: "", header: view.content[0]?.header },
    ]);
  });

  it("carries a url-sourced image chunk", () => {
    resetSeq();
    const view = run(emptySessionView(), [
      imageDelta({ index: 0, media_type: "image/png", url: "https://x/y.png" }, LOOP_A),
    ]);
    expect(view.content[0]).toMatchObject({ url: "https://x/y.png", data: "" });
  });

  it("does not open a live segment, so an image-only step commits nothing", () => {
    // The whole point of committing no row: a step whose only ephemeral content
    // was an image must not leave a blank assistant bubble behind either.
    resetSeq();
    const view = run(emptySessionView(), [
      imageDelta({ index: 0, data: "iVA=" }, LOOP_A, TURN_1),
      textDelta("after", LOOP_A, TURN_1),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ ordinal: 0, text: "after", thinking: "", refusal: "" });
  });

  it("rejects an image chunk with no numeric index as malformed", () => {
    // `index` has no omitempty and is load-bearing: it identifies WHICH image
    // of the response a fragment belongs to, and core records that splicing
    // fragments across images produces an undetectably corrupt file.
    const result = fold(emptySessionView(), liveEphemeral("token_delta", { chunk_type: "image", data: "iVA=" }, LOOP_A));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("malformed_delta");
  });

  it("still reports a genuinely unrecognized chunk_type as unknown_chunk_type", () => {
    // The reason exists to tell "the wire sent something never-before-seen"
    // apart from "a known kind with a broken payload", and adding two known
    // kinds must not blunt it.
    const result = fold(emptySessionView(), liveEphemeral("token_delta", { chunk_type: "hologram" }, LOOP_A));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("unknown_chunk_type");
  });
});
