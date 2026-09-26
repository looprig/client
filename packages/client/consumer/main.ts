/**
 * A vanilla TypeScript consumer of the PACKED `@looprig/client` tarball.
 *
 * This file is copied into a temporary directory outside the npm workspace,
 * compiled by `tsc` against the installed tarball, and run by `node`. It is the
 * executable half of runbook 06 task U6.1 step 2: join a session, submit a
 * retry-stable command, repair a reset, and page a tool object without
 * importing React.
 *
 * READ THIS ABOUT "WITHOUT IMPORTING REACT". Not importing React is something
 * this file could achieve by simply not typing the word, which would prove
 * nothing at all. `assertFrameworksAreUnresolvable` below therefore asserts the
 * MECHANISM instead: from this consumer's resolution root, `react`,
 * `react-dom`, `svelte`, `@sveltejs/kit`, `@looprig/harness` and
 * `@looprig/react` are not resolvable modules -- an `import` of any of them
 * could not compile or run here even if this file did contain it. Its
 * anti-vacuity half asserts in the same breath that `@looprig/client` IS
 * resolvable, so a run in which every dynamic import happened to fail cannot
 * pass. The two together are the deliverable: a consumer that CANNOT import
 * React, not one that merely does not.
 */
import { createHash } from "node:crypto";
import {
  createFactoryClient,
  FactorySessionViewStore,
  readToolCapturePages,
  toolResultCaptures,
  ToolCaptureTooLargeError,
  type CommandStatus,
  type FactorySessionViewSnapshot,
  type PublicJournalPage,
  type ToolResultCaptureSummary,
} from "@looprig/client";
import { FactoryFake, type JournalScript } from "./fake-factory.js";
import { FakeClientLink } from "./fake-link.js";

const TENANT = "tenant-1";
const SESSION = "session-1";
const OBJECT = "object-1";

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`consumer assertion failed: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  check(left === right, `${message} (got ${left}, want ${right})`);
}

const DEADLINE_MS = 20_000;

/** Polls a real macrotask queue: the join's repair path awaits a real timer. */
async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function rejects<T>(operation: () => Promise<T>, description: string): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${description} to reject`);
}

/**
 * True when `specifier` resolves from this consumer. Only a resolution failure
 * answers `false`; any other error propagates, so a package that exists and
 * throws on import is not silently reported as absent.
 */
async function resolvable(specifier: string): Promise<boolean> {
  try {
    await import(specifier);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return false;
    throw error;
  }
}

async function assertFrameworksAreUnresolvable(): Promise<void> {
  const report: Record<string, boolean> = {};
  // The anti-vacuity control FIRST. If this were false, every assertion below
  // would pass for the wrong reason -- "nothing resolves here" is not "no
  // framework is installed here".
  report["@looprig/client"] = await resolvable("@looprig/client");
  check(report["@looprig/client"], "@looprig/client must resolve from the consumer");
  for (const specifier of ["react", "react-dom", "react/jsx-runtime", "svelte", "@sveltejs/kit", "@looprig/harness", "@looprig/react"]) {
    report[specifier] = await resolvable(specifier);
    check(!report[specifier], `${specifier} must NOT be resolvable from the consumer`);
  }
  // Printed as well as asserted so the driving test can assert on WHAT was
  // checked, not merely that the process exited zero: a consumer that silently
  // stopped checking would still exit zero.
  console.log(`RESOLUTION_REPORT ${JSON.stringify(report)}`);
}

/**
 * Checks the ClientLink double against the behaviours its header claims to
 * mirror.
 *
 * This asserts the FAKE, not the package, and is worth its lines for one
 * reason: three of those behaviours have no reader in the scenario below --
 * that scenario always connects, always authorizes, and never subscribes the
 * same channel twice -- so a double that quietly loosened any of them would
 * leave every assertion in `main` still passing. It is what stops the double
 * drifting looser than the dependency it stands in for. It is NOT evidence
 * about `CentrifugeClientLink`: the justification for each expectation is the
 * source citation in `fake-link.ts`'s header, not this function.
 */
async function assertLinkDoubleHoldsItsContract(): Promise<void> {
  const link = new FakeClientLink();
  const noop = { tenantId: TENANT, sessionId: SESSION, onPublication: () => {}, onReset: () => {} };
  const first = link.subscribe(noop);

  // Before the LINK has negotiated, a subscription reports no version -- the
  // condition `joinFactorySessionView` repairs on.
  equal(first.state, "subscribing", "a fresh subscription is not yet subscribed");
  equal(first.version, undefined, "no version before the link has negotiated");
  await link.connect();
  equal(first.version, undefined, "no version before the SERVER has authorized the subscription");
  const publishedTooEarly = await rejects(
    async () => link.publishEnduring(TENANT, SESSION, {}),
    "a publication before authorization",
  );
  check(publishedTooEarly instanceof Error, "a publication before authorization is refused");

  link.authorize(TENANT, SESSION);
  await first.ready;
  equal(first.state, "subscribed", "an authorized subscription is subscribed");
  equal(first.version, 1, "the negotiated version is visible once authorized");

  const duplicate = await rejects(async () => link.subscribe(noop), "a second subscription on one channel");
  check(duplicate instanceof Error, "one live subscription per channel, as Centrifuge enforces");

  first.unsubscribe();
  equal(link.openChannels, 0, "unsubscribe detaches the channel so it can be taken again");
  const successor = link.subscribe(noop);
  first.unsubscribe(); // idempotent, and must not deregister the successor
  equal(link.openChannels, 1, "a late unsubscribe never detaches a successor on the same channel");
  successor.unsubscribe();
  equal(link.openChannels, 0, "the successor releases its own channel");
}

function journalEvent(seq: number, text: string): PublicJournalPage["events"][number] {
  return { event_id: `event-${seq}`, journal_seq: seq, body: { type: "session.message", text } };
}

async function main(): Promise<void> {
  await assertFrameworksAreUnresolvable();
  await assertLinkDoubleHoldsItsContract();

  const objectBytes = new TextEncoder().encode("0123456789");
  const objectDigest = `sha256:${createHash("sha256").update(objectBytes).digest("hex")}`;

  // Commands are minted with a generator that produces every awkward character
  // U1.2's golden vector names -- `:`, `/`, uppercase and base64url -- so the
  // REST resolve below round-trips the LOGICAL id through a URL path segment.
  let minted = 0;
  const idGenerator = (): string => {
    minted += 1;
    return `Cmd:${minted}/A+b_c-=`;
  };

  let commandOutcome: (commandId: string) => CommandStatus = (commandId) => ({
    command_id: commandId,
    status: "applied",
    accepted_order: 7,
  });

  const factory = new FactoryFake({
    sessionId: SESSION,
    objectId: OBJECT,
    objectBytes,
    objectDigest,
    gates: {
      gates: [
        {
          gate_id: "gate-1",
          kind: "harness.ask_user",
          answerability: "resident",
          deadline: "2026-08-29T13:00:00Z",
          opened_event_id: "event-6",
          opened_journal_seq: 6,
          prompt: { title: "Continue?", body: "Choose a public option." },
        },
      ],
      journal_tip: 8,
      open_gate_count: 1,
    },
    commandStatus: (commandId) => commandOutcome(commandId),
  });

  // GENERATION 1 pages the captured tail: the opening `tail` read is answered
  // with coverage short of the tip and a continuation cursor, so the consumer
  // exercises the byte-budgeted continuation rather than a single whole page.
  // Sequences 1, 3, 4, 6 and 7 are WITHHELD private records: the only thing
  // that carries the cursor over them is the page's authenticated
  // `covered_through`, and the final page's coverage (7) runs past its last
  // public event (5) precisely so that advance is observable on its own.
  const generationOne: JournalScript = {
    status: { session_id: SESSION, agent_id: "agent-1", state: "resident", residency: "resident", journal_tip: 7 },
    pages: [
      { events: [journalEvent(2, "first public event")], journal_tip: 7, covered_through: 3, next_cursor: "cursor-1" },
      { events: [journalEvent(5, "second public event")], journal_tip: 7, covered_through: 7 },
    ],
  };
  // GENERATION 2 is what a repaired join reads after a `session.reset` whose
  // `last_contiguous` (3) is below the cursor (8). That value is LINK-scoped —
  // what Factory delivered to this link in an unbroken run — so it is not
  // truncation and must not move the cursor: the repair resumes at from_seq=9
  // and delivers only 10, never re-delivering 5 or 8.
  const generationTwo: JournalScript = {
    status: {
      session_id: SESSION,
      agent_id: "agent-1",
      state: "waiting_on_gate",
      residency: "resident",
      journal_tip: 10,
      waiting_gate_id: "gate-1",
    },
    pages: [
      {
        events: [journalEvent(5, "second public event"), journalEvent(8, "live event"), journalEvent(10, "post-reset event")],
        journal_tip: 10,
        covered_through: 10,
      },
    ],
  };
  factory.script([generationOne, generationTwo]);
  await factory.start();

  const link = new FakeClientLink();
  const client = createFactoryClient({
    baseUrl: factory.baseUrl,
    idGenerator,
    // The whole point of the injected constructor: one application-scoped link,
    // supplied by the consumer, with no Centrifuge socket anywhere.
    clientLinkFactory: () => link,
  });

  try {
    // ---- join a session -------------------------------------------------
    const negotiated = await client.link.connect();
    equal(negotiated.version, 1, "negotiated sessionwire version");

    const persisted: number[] = [];
    const snapshots: FactorySessionViewSnapshot[] = [];
    const store = new FactorySessionViewStore({
      reads: client.reads,
      link: client.link,
      tenantId: TENANT,
      sessionId: SESSION,
      persistCoveredThrough: (covered) => persisted.push(covered),
    });
    const errors: Error[] = [];
    store.subscribeErrors((error) => errors.push(error));
    store.subscribe(() => snapshots.push(store.snapshot()));

    store.start();
    await waitUntil(() => link.unauthorizedChannels === 1, "the join to open its subscription");
    await waitUntil(() => link.openChannels === 1, "the subscription to be registered");
    link.authorize(TENANT, SESSION);

    await waitUntil(() => store.snapshot().coveredThrough === 7, "the captured tail to reach its tip");
    // Sliced by POSITION, not filtered by `snapshot.generation`. That field is
    // the STORE's lifecycle generation -- `FactorySessionViewStore.start`
    // increments its own counter and overwrites the join's -- so it stays 1
    // across a repair and cannot separate the two joins. Worth knowing before
    // writing a UI that keys off it.
    const firstGeneration = snapshots.slice();
    equal(
      firstGeneration.map((snapshot) => snapshot.event?.journal_seq ?? null),
      [null, 2, 5, null],
      "generation 1 yields a projection, the two public events of the paged tail, and a coverage-only advance",
    );
    equal(firstGeneration[0]?.status?.state, "resident", "the cold projection carries durable status");
    // 7 is reached with no public event at 6 or 7: the durable cursor moved
    // over withheld private records on the page's attested `covered_through`
    // alone, which is the whole point of step 3 of the U2.1 join algorithm.
    equal(persisted, [2, 5, 7], "the durable cursor advances over the withheld private sequences");

    // ---- a live enduring publication -------------------------------------
    link.publishEnduring(TENANT, SESSION, {
      type: "enduring_publication",
      tenant_id: TENANT,
      session_id: SESSION,
      event_id: "event-8",
      journal_seq: 8,
      covered_through: 8,
      body: { type: "session.message", text: "live event" },
    });
    await waitUntil(() => store.snapshot().coveredThrough === 8, "the live publication to be applied");

    // ---- submit a retry-stable command ------------------------------------
    let attempts = 0;
    link.onRpc((method, request) => {
      check(method === "session.input", `unexpected rpc method ${method}`);
      attempts += 1;
      // The first send is lost AFTER the socket accepted it: an unknown
      // outcome, not a rejection. That is the case retry identity exists for.
      if (attempts === 1) return new Error("socket closed before the reply arrived");
      return { command_id: String(request["command_id"]), status: "accepted", accepted_order: 7 };
    });

    const pending = client.commands.input(SESSION, { blocks: [{ type: "text", text: "hello" }] });
    const unknown = await pending.attempt();
    equal(unknown.outcome, "unknown", "a lost reply is an unknown outcome, never a rejection");
    const accepted = await pending.retry();
    equal(accepted.command_id, pending.commandId, "the retry is accepted under the original identity");
    equal(accepted.status, "accepted", "the retried command is accepted");
    check(link.rpcRequests.length === 2, "the command was sent exactly twice");
    check(
      link.rpcRequests[0]?.bytes === link.rpcRequests[1]?.bytes,
      "the retry replays a BYTE-EQUAL envelope, not merely an equal identity",
    );

    // An explicit new user action is a new logical command, not a retry.
    const second = client.commands.input(SESSION, { blocks: [{ type: "text", text: "hello" }] });
    check(second.commandId !== pending.commandId, "a new user action mints a new CommandID");

    // Resolving the ambiguous outcome reads the accepted record by identity
    // over REST -- through a URL path segment, which must not alter the id.
    const resolved = await pending.resolve();
    equal(resolved.command_id, pending.commandId, "the REST resolve round-trips the opaque CommandID");
    check(pending.commandId.includes(":") && pending.commandId.includes("/"), "the CommandID exercised URL encoding");
    equal(resolved.status, "applied", "the durable record reports the applied command");

    // A definitive Core rejection is NOT an unknown outcome.
    commandOutcome = (commandId) => ({
      command_id: commandId,
      status: "rejected",
      error: { code: "command_rejected", message: "The command cannot be applied.", retryable: false },
    });
    const rejected = await client.commands.interrupt(SESSION).resolve();
    equal(rejected.status, "rejected", "a rejected command reports its durable rejection");

    // ---- repair a reset ---------------------------------------------------
    const journalReadsBeforeReset = factory.requests.filter((entry) => entry.includes("/journal?")).length;
    const snapshotsBeforeReset = snapshots.length;
    factory.advanceJournal();
    link.publishReset(TENANT, SESSION, {
      type: "session.reset",
      tenant_id: TENANT,
      session_id: SESSION,
      last_contiguous: 3,
      journal_tip: 10,
    });
    await waitUntil(() => link.unauthorizedChannels === 1, "the reset to open a new join generation");
    link.authorize(TENANT, SESSION);
    await waitUntil(() => store.snapshot().coveredThrough === 10, "the repaired join to reach the new tip");

    const secondGeneration = snapshots.slice(snapshotsBeforeReset);
    equal(
      secondGeneration.map((snapshot) => snapshot.event?.journal_seq ?? null),
      [null, 10],
      "the repair delivers only what the view lacks: a link-scoped last_contiguous never lowers the cursor",
    );
    equal(secondGeneration[0]?.status?.state, "waiting_on_gate", "the repaired projection carries the new durable status");
    check(
      factory.requests.filter((entry) => entry.includes("/journal?")).length > journalReadsBeforeReset,
      "the repair re-read the journal rather than replaying from memory",
    );
    check(errors.length === 0, `the join reported errors: ${errors.map((error) => error.message).join(", ")}`);
    // U2.1's "no journal?after=0 merely to open a current view", asserted
    // POSITIVELY rather than as the absence of a string the fake would refuse
    // anyway: the view OPENED with a bounded `tail` capture continued by the
    // cursor its page issued, and the repair RESUMED one past the
    // committed cursor (from_seq=9) — the only sequence ever named, so nothing
    // could have replayed from zero.
    const journalReads = factory.requests
      .filter((entry) => entry.includes("/journal?"))
      .map((entry) => entry.slice(entry.indexOf("?") + 1));
    check(journalReads.length === 3, `expected three journal reads, saw ${journalReads.length}`);
    equal(
      journalReads.map((query) => (query.includes("tail=") ? "tail" : query.includes("cursor=") ? "cursor" : query)),
      ["tail", "cursor", "from_seq=9&limit=256"],
      "the view opened with a bounded tail continued only by cursor, and the repair resumed past the lowered cursor",
    );

    // ---- gates come from the durable projection ---------------------------
    const gates = await client.reads.listGates(SESSION);
    equal(gates.gates.map((gate) => gate.gate_id), ["gate-1"], "the public gate page is read over REST");

    // ---- page a tool object -----------------------------------------------
    const captures = toolResultCaptures([
      {
        tool_use_id: "toolu-1",
        tool_execution_id: "exec-1",
        captured_bytes: objectBytes.byteLength,
        original_bytes: 4096,
        encoding: "utf-8",
        truncated: true,
        truncation_reason: "capture_ceiling",
        reference: { object_id: OBJECT },
      },
    ]);
    const capture: ToolResultCaptureSummary | undefined = captures.get("toolu-1");
    check(capture !== undefined, "the wire capture decoded");
    equal(capture.objectId, OBJECT, "the capture names only a logical object id");

    const tooLarge = await rejects(
      () => readToolCapturePages(client.reads, SESSION, capture, { pageBytes: 4, ceilingBytes: 8 }),
      "a capture above the UI ceiling",
    );
    check(tooLarge instanceof ToolCaptureTooLargeError, "a capture above the ceiling is refused before any object I/O");

    const content = await readToolCapturePages(client.reads, SESSION, capture, { pageBytes: 4, ceilingBytes: 64 });
    equal(
      content.pages.map((page) => [page.start, page.end]),
      [[0, 3], [4, 7], [8, 9]],
      "the object was fetched as three bounded ranges",
    );
    equal(new TextDecoder().decode(content.bytes), "0123456789", "the assembled object verifies against its digest");
    equal(content.metadata.size_bytes, objectBytes.byteLength, "the metadata descriptor was read before the ranges");
    check(
      !JSON.stringify(content.metadata).includes("http"),
      "no signed backend URL reached the consumer's page state",
    );

    store.stop();
    await waitUntil(() => link.openChannels === 0, "the store to release its subscription on stop");
  } finally {
    await factory.stop();
  }
  console.log("vanilla consumer: OK");
}

await main();
