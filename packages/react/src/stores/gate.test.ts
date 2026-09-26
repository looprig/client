import {
  CommandIdentityError,
  CoreGateResolvedError,
  createFactoryCommands,
  GATE_APPROVAL_ACTIONS,
  type PublicGateEntry,
} from "@looprig/client";
import { expect, test } from "vitest";
import { FakeClientLink } from "../testing/fake-link.js";
import { COMPOSER_COMMAND_KEY, FactoryComposerStore } from "./composer.js";
import { FactoryGateStore, gateCommandKey } from "./gate.js";
import type { PendingCommandView } from "./pending.js";

const SID = "6f1d9f4e-6c2a-4c3a-9f2e-1a2b3c4d5e6f";

const GATE_A = "3f4a5b6c-7d8e-4f90-a1b2-c3d4e5f60718";
const GATE_B = "4a5b6c7d-8e9f-4012-b3c4-d5e6f7081920";

// --- FactoryGateStore: one identity per answered gate -------------------------

function gatePlane(): { link: FakeClientLink; store: FactoryGateStore } {
  const link = new FakeClientLink();
  let minted = 0;
  const commands = createFactoryCommands({
    link,
    idGenerator: () => {
      minted += 1;
      return `cmd-${minted}`;
    },
  });
  return { link, store: new FactoryGateStore(commands, SID) };
}

function entry(gateId: string, overrides: Partial<PublicGateEntry> = {}): PublicGateEntry {
  return {
    sessionId: SID,
    gateId,
    kind: "harness.permission",
    prompt: { title: "", body: "", origin: "", controls: [] },
    openedEventId: `event-${gateId}`,
    openedJournalSeq: 7,
    deadline: "",
    answerability: "resident",
    ...overrides,
  };
}

function retainedGate(store: FactoryGateStore, gateId: string): PendingCommandView | null {
  return store.snapshot().pending.get(gateCommandKey(gateId)) ?? null;
}

test("a response carries the action verbatim and the gate's own open event id", async () => {
  const { link, store } = gatePlane();

  await expect(store.respond(entry(GATE_A), GATE_APPROVAL_ACTIONS.deny)).resolves.toMatchObject({
    outcome: "accepted",
    commandId: "cmd-1",
  });

  expect(link.rpcCalls[0]!.method).toBe("gate.respond");
  expect(link.rpcCalls[0]!.request).toStrictEqual({
    version: 1,
    command_id: "cmd-1",
    session_id: SID,
    gate_id: GATE_A,
    action: "Deny",
    values: {},
    expected_open_event_id: `event-${GATE_A}`,
  });
});

test("a gate attested only by position answers by journal sequence", async () => {
  const { link, store } = gatePlane();

  await store.respond(entry(GATE_A, { openedEventId: "", openedJournalSeq: 12 }), "Approve");

  // Core requires EXACTLY one optimistic identity; the fallback is the sequence.
  expect(link.rpcCalls[0]!.request).toMatchObject({ expected_open_journal_seq: 12 });
  expect(link.rpcCalls[0]!.request).not.toHaveProperty("expected_open_event_id");
});

test.each([
  ["a gate whose owner is not up", entry(GATE_A, { answerability: "suspended" })],
  ["a gate Factory has attested nothing about", entry(GATE_A, { answerability: "" })],
  ["a gate with no attested open identity", entry(GATE_A, { openedEventId: "", openedJournalSeq: 0 })],
])("%s is refused before anything is sent", async (_name, gate) => {
  const { link, store } = gatePlane();

  await expect(store.respond(gate, "Approve")).resolves.toStrictEqual({ outcome: "none" });

  expect(link.rpcCalls).toStrictEqual([]);
  expect(retainedGate(store, GATE_A)).toBeNull();
});

test("two gates in one session are answered concurrently, not one at a time", async () => {
  const { link, store } = gatePlane();
  link.holdRpc = true;

  const first = store.respond(entry(GATE_A), "Approve");
  const second = store.respond(entry(GATE_B), "Deny");

  // Parallel loops open gates concurrently; a per-session latch would make the
  // second answer wait on the first, which is the serialization the runbook
  // forbids expressed inside one session.
  expect(link.rpcCalls.map((call) => call.commandId)).toStrictEqual(["cmd-1", "cmd-2"]);
  expect(retainedGate(store, GATE_A)?.sending).toBe(true);
  expect(retainedGate(store, GATE_B)?.sending).toBe(true);
  link.rpcCalls[0]!.settle();
  link.rpcCalls[1]!.settle();
  await expect(first).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  await expect(second).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-2" });
});

test("a repeat click on one gate is refused while its own answer is outstanding", async () => {
  const { link, store } = gatePlane();
  link.holdRpc = true;
  const first = store.respond(entry(GATE_A), "Approve");

  const refused = store.respond(entry(GATE_A), "Deny");
  expect(link.rpcCalls).toHaveLength(1);
  await expect(refused).resolves.toStrictEqual({ outcome: "refused", commandId: "cmd-1" });

  link.rpcCalls[0]!.settle();
  await first;
});

test("a lost gate answer is retried under its original identity", async () => {
  const { link, store } = gatePlane();
  link.holdRpc = true;
  const first = store.respond(entry(GATE_A), "Approve");
  link.drop();
  await expect(first).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });
  link.holdRpc = false;

  await expect(store.retry(GATE_A)).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });

  expect(link.rpcCalls[1]!.request).toStrictEqual(link.rpcCalls[0]!.request);
});

test("a losing race is a definitive typed rejection that releases the gate", async () => {
  const { link, store } = gatePlane();
  link.holdRpc = true;
  const first = store.respond(entry(GATE_A), "Approve");
  await expect.poll(() => link.outstanding).toHaveLength(1);

  link.rpcCalls[0]!.settle({
    status: "rejected",
    error: { code: "gate_resolved", message: "another client answered", retryable: false },
  });

  await expect(first).resolves.toMatchObject({ outcome: "rejected" });
  expect(store.snapshot().errors.get(gateCommandKey(GATE_A))).toBeInstanceOf(CoreGateResolvedError);
  expect(retainedGate(store, GATE_A)).toBeNull();
});

test("cancel withdraws one gate's answer and leaves the other's alone", async () => {
  const { link, store } = gatePlane();
  link.holdRpc = true;
  const first = store.respond(entry(GATE_A), "Approve");
  const second = store.respond(entry(GATE_B), "Deny");

  store.cancel(GATE_A);

  expect(retainedGate(store, GATE_A)).toBeNull();
  expect(retainedGate(store, GATE_B)).toMatchObject({ commandId: "cmd-2", sending: true });
  link.rpcCalls[0]!.settle();
  link.rpcCalls[1]!.settle();
  await expect(first).resolves.toStrictEqual({ outcome: "cancelled", commandId: "cmd-1" });
  await expect(second).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-2" });
});

test("prune forgets errors for gates no longer listed but never an outstanding answer", async () => {
  const { link, store } = gatePlane();
  link.holdRpc = true;
  const failing = store.respond(entry(GATE_A), "Approve");
  link.drop();
  await failing;
  const outstanding = store.respond(entry(GATE_B), "Deny");
  await expect.poll(() => retainedGate(store, GATE_B)).not.toBeNull();

  // Neither gate is on the board any more. A page merge never removes, so
  // "absent" is not "closed": the error goes, the user's outstanding action stays.
  store.prune([]);

  expect(store.snapshot().errors.size).toBe(0);
  expect(retainedGate(store, GATE_A)).toMatchObject({ commandId: "cmd-1" });
  expect(retainedGate(store, GATE_B)).toMatchObject({ commandId: "cmd-2" });
  link.rpcCalls[1]!.settle();
  await outstanding;
});

test("prune publishes nothing when it changes nothing", async () => {
  const { link, store } = gatePlane();
  link.holdRpc = true;
  const first = store.respond(entry(GATE_A), "Approve");
  let notifies = 0;
  store.subscribe(() => {
    notifies += 1;
  });

  // Driven from a board projection, this runs on every page and every frame.
  store.prune([GATE_A]);
  store.prune([]);

  expect(notifies).toBe(0);
  link.rpcCalls[0]!.settle();
  await first;
});

test("prune never forgets another control's failure in the same session", async () => {
  const link = new FakeClientLink();
  let minted = 0;
  const commands = createFactoryCommands({
    link,
    idGenerator: () => {
      minted += 1;
      return `cmd-${minted}`;
    },
  });
  const gates = new FactoryGateStore(commands, SID);
  const composer = new FactoryComposerStore(commands, SID);
  // ATTACHED, so it re-reads the shared scope when the gate store publishes.
  // An unattached store keeps its last snapshot and would still be holding the
  // error whether or not the prune had swept it away.
  const detach = composer.attach();
  link.holdRpc = true;
  const failing = composer.submit("one");
  link.drop();
  await failing;
  expect(composer.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeInstanceOf(Error);

  // The board holds no gates. That says nothing about the composer, and the
  // two controls share one session scope.
  gates.prune([]);

  expect(composer.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeInstanceOf(Error);
  detach();
});

test("prune keeps the failure of a gate that is still listed", async () => {
  const { link, store } = gatePlane();
  link.holdRpc = true;
  const first = store.respond(entry(GATE_A), "Approve");
  const second = store.respond(entry(GATE_B), "Deny");
  link.drop();
  await first;
  await second;
  expect([...store.snapshot().errors.keys()].sort()).toStrictEqual(
    [gateCommandKey(GATE_A), gateCommandKey(GATE_B)].sort(),
  );

  // The other half of the guard. A board that still lists GATE_A must not lose
  // its "another client answered" notice just because a later gate event
  // rebuilt the board — the card is still on screen and still open.
  store.prune([GATE_A]);

  expect([...store.snapshot().errors.keys()]).toStrictEqual([gateCommandKey(GATE_A)]);
});

test("an envelope Core's identity rules refuse is reported, never thrown", async () => {
  const { link, store } = gatePlane();
  // The gate id and the opened event id come off a board page Factory served,
  // and `respondResidentGate` validates both while building the envelope.
  const malformed = entry(GATE_A, { gateId: "" });

  await expect(store.respond(malformed, "Approve")).resolves.toStrictEqual({ outcome: "none" });

  expect(store.snapshot().errors.get(gateCommandKey(""))).toBeInstanceOf(CommandIdentityError);
  expect(link.rpcCalls).toStrictEqual([]);
});

test("a retry is not blocked by another gate's answer in flight", async () => {
  const { link, store } = gatePlane();
  link.holdRpc = true;
  const lost = store.respond(entry(GATE_A), "Approve");
  link.drop();
  await expect(lost).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });
  const blocking = store.respond(entry(GATE_B), "Deny");
  expect(link.rpcCalls).toHaveLength(2);

  // Same session, different control. Widening `replay`'s refusal to "any slot
  // here is busy" would make one gate's slow answer disable another's retry.
  const retrying = store.retry(GATE_A);

  expect(link.rpcCalls).toHaveLength(3);
  link.rpcCalls[2]!.settle();
  await expect(retrying).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  link.rpcCalls[1]!.settle();
  await blocking;
});

test("cancel takes the gate's failure with its envelope", async () => {
  const { link, store } = gatePlane();
  link.holdRpc = true;
  const lost = store.respond(entry(GATE_A), "Approve");
  link.drop();
  await lost;
  expect(store.snapshot().errors.get(gateCommandKey(GATE_A))).toBeInstanceOf(Error);

  store.cancel(GATE_A);

  expect(store.snapshot().errors.size).toBe(0);
  expect(store.snapshot().pending.size).toBe(0);
});
