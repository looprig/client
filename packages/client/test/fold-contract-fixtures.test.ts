/** Both Core durable carriers feed their untouched bodies through the same fold. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createPublicEventFolder } from "../src/factory-view.js";
import { emptySessionView, fold } from "../src/fold.js";
import type { EventEnvelope } from "../src/types.js";
import { validateFactory } from "../src/validate.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../contract/fixtures/${name}.json`, import.meta.url), "utf8"));
}

it("projects actual Core public journal bodies through the shared durable fold", () => {
  const page = validateFactory("public_journal_page", fixture("public_journal_page"));
  const projected = createPublicEventFolder()(page.events).view;
  expect(projected.statusEvents.map((event) => [event.journalSeq, event.envelope])).toEqual(
    page.events.map((event) => [event.journal_seq, event.body]),
  );
  expect(projected.statusEvents.map((event) => event.type)).toEqual(["session.message", "session.message"]);
  expect(projected.rows).toEqual([]);
});

it("projects the actual Core enduring publication body identically to a journal item", () => {
  const publication = validateFactory("enduring_publication", fixture("enduring_publication"));
  const event = { body: publication.body, event_id: publication.event_id, journal_seq: publication.journal_seq };
  const projected = createPublicEventFolder()([event]).view;
  const folded = fold(emptySessionView(), { segment: "history", event: {
    journal_seq: publication.journal_seq, event: publication.body as EventEnvelope,
  } });
  if (!folded.ok) throw folded.error;
  expect(projected).toEqual(folded.view);
  expect(projected.statusEvents[0]).toMatchObject({ type: "turn.completed", journalSeq: 5, envelope: publication.body });
});
