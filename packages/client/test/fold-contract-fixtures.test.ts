/**
 * The one part of fold.test.ts that needs the vendored wire fixtures, split
 * out so the other ~20 cases can run before Task 2.11 lands `wui/contract/`.
 *
 * It proves a cold `StatusEvent` (from the real `journal_page.json` fixture)
 * and a live `enduring` `SseFrame` (from the real `enduring_frame.sse`
 * fixture, parsed through the REAL `sse.ts` parser) fold into structurally
 * comparable `StatusEventMarker`s — the "one renderer, two segments" property
 * fold.ts exists to provide. Substituting hand-written fixtures would make it
 * prove nothing, so it waits for the real ones; `vitest.config.ts` excludes
 * this file until then.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emptySessionView, fold, type SessionView } from "../src/fold.js";
import { SseFrameParser, type EnduringSseFrame, type SseFrame } from "../src/sse.js";
import { validateEventJournalPage } from "../src/validate.js";
import type { EventJournalPage } from "../src/types.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixtureBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(fixtureDir + file));
}

function readFixtureJson(file: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + file, "utf8"));
}

/** Parses one fixture's bytes as a single SSE frame and asserts it's the expected `type`. */
function parseOneFrame(bytes: Uint8Array): SseFrame {
  const parser = new SseFrameParser();
  const frames = [...parser.feed(bytes), ...parser.finish()];
  expect(frames).toHaveLength(1);
  return frames[0]!;
}

function expectOk(result: ReturnType<typeof fold>): SessionView {
  if (!result.ok) {
    throw new Error(`expected fold to succeed, got FoldError(${result.error.reason}): ${result.error.message}`);
  }
  return result.view;
}

// --- 3. History and live fold into structurally comparable output -----------

describe("history (cold StatusEvent) and live (SSE enduring frame) fold into the same shape", () => {
  it("the journal_page.json fixture's StatusEvent and the enduring_frame.sse fixture's live frame both fold to a comparable StatusEventMarker", () => {
    // Both fixtures carry the SAME underlying TurnDone event content (byte-for-content
    // identical event object; only journal_seq legitimately differs: 3 in the cold
    // page vs. 42 stamped on the live SSE frame's id: line) — see contract/fixtures/.
    const page = validateEventJournalPage(readFixtureJson("journal_page.json")) as EventJournalPage;
    expect(page.events).toHaveLength(1);
    const statusEvent = page.events[0]!;

    const enduringBytes = readFixtureBytes("enduring_frame.sse");
    const liveFrame = parseOneFrame(enduringBytes);
    expect(liveFrame.type).toBe("enduring");
    const enduringFrame = liveFrame as EnduringSseFrame;

    const historyResult = fold(emptySessionView(), { segment: "history", event: statusEvent });
    const liveResult = fold(emptySessionView(), { segment: "live", frame: enduringFrame });

    const historyView = expectOk(historyResult);
    const liveView = expectOk(liveResult);

    expect(historyView.statusEvents).toHaveLength(1);
    expect(liveView.statusEvents).toHaveLength(1);
    const historyMarker = historyView.statusEvents[0]!;
    const liveMarker = liveView.statusEvents[0]!;

    // Structurally comparable: identical key sets (same SessionView shape
    // regardless of source)...
    expect(Object.keys(historyMarker).sort()).toEqual(Object.keys(liveMarker).sort());

    // ...and, since the two fixtures carry the same underlying event, identical
    // field-for-field EXCEPT journalSeq (which legitimately differs by source).
    const { journalSeq: historyJournalSeq, ...historyRest } = historyMarker;
    const { journalSeq: liveJournalSeq, ...liveRest } = liveMarker;
    expect(historyRest).toEqual(liveRest);
    expect(historyJournalSeq).toBe(3);
    expect(liveJournalSeq).toBe(42);

    // And both correctly surfaced the real event content.
    expect(historyMarker.type).toBe("TurnDone");
    expect(historyMarker.sessionId).toBe("00000000-0000-0000-0000-000000000000");
    expect(historyMarker.createdAt).toBe("2026-07-08T12:00:00Z");
  });
});
