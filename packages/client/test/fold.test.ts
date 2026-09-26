import { describe, expect, it } from "vitest";
import { emptySessionView } from "../src/fold.js";

describe("emptySessionView", () => {
  it("returns a fresh, fully-empty SessionView", () => {
    expect(emptySessionView()).toStrictEqual({
      statusEvents: [],
      gates: new Map(),
      loops: new Map(),
      rows: [],
      nextOrdinal: 0,
      commandOutcomes: new Map(),
    });
  });

  it("gives every call its OWN rows array, not a shared one", () => {
    // Same hazard as the gate map below: a module-level `[]` would let one
    // session's transcript leak into every other view in the process.
    const first = emptySessionView();
    first.rows.push({ kind: "tombstone", ordinal: 0, loopId: "", turnId: "", journalSeq: undefined, live: false, orphanedLoop: false });
    expect(emptySessionView().rows).toHaveLength(0);
  });

  it("gives every call its OWN gate map, not a shared one", () => {
    // A module-level `new Map()` would be shared by every view in the process:
    // opening a gate in one session would open it in all of them, and this is
    // the only mutable-by-identity field on the view.
    const first = emptySessionView();
    first.gates.set("g", { id: "g" } as never);
    expect(emptySessionView().gates.size).toBe(0);
  });

  it("gives every call its OWN commandOutcomes maps", () => {
    // Command acknowledgement state must not leak between sessions.
    const first = emptySessionView();
    first.commandOutcomes.set("cmd", "started");
    const second = emptySessionView();
    expect(second.commandOutcomes.size).toBe(0);
  });
});
