import { useEffect } from "react";
import {
  createFactoryClient,
  CoreInvalidRequestError,
  CoreProtocolError,
  DEFAULT_MAX_TAIL_BYTES,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_REPAIR_DELAY_MS,
  MAX_REPAIR_BACKOFF_FACTOR,
} from "@looprig/client";
import type {
  EnduringPublication,
  FactoryClient,
  FactoryClientOptions,
  PublicGatePage,
  PublicJournalPage,
} from "@looprig/client";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { FakeClientLink } from "./testing/fake-link.js";
import { FakeFactoryReads, publicEvent } from "./testing/fake-reads.js";
import { renderStrict } from "./testing/strict.js";
import { FactoryLinkProvider, useFactoryClient } from "./use-connection.js";
import {
  useFactorySessionView,
  type UseFactorySessionViewResult,
} from "./use-session-view.js";

// --- The Factory cold-read + join state machine (U4.2) ------------------------
//
// `useAttachOrRestore` used to be the first thing a session view did: a POST
// that made the session live in a serving process before anything could be
// rendered. Opening a view is not a state change, and these pin that opening a
// COLD session reads the durable plane and subscribes, and sends nothing.

const TENANT = "tenant-1";
const FSID = "session-1";

interface FactoryHarness {
  readonly link: FakeClientLink;
  readonly reads: FakeFactoryReads;
  readonly view: { current: UseFactorySessionViewResult | null };
  readonly client: { current: FactoryClient | null };
  rerender(props?: ViewProps): Promise<void>;
  unmount(): Promise<void>;
}

interface ViewProps {
  tenantId?: string;
  scopeKey?: string;
  sessionId?: string;
  tailLimit?: number;
  coveredThrough?: number;
  repairDelayMs?: number;
  maxRepairAttempts?: number;
  maxTailPages?: number;
  maxTailBytes?: number;
  gateRefreshMs?: number;
}

interface MountOptions {
  props?: ViewProps;
  /**
   * Runs against the link and the read plane BEFORE the tree is rendered.
   * Everything a cold open does — connect, subscribe, three reads — happens in
   * microtasks after the first commit, so a test that staged its fake after
   * `render` resolved would be staging it after the window it means to observe.
   */
  setup?(link: FakeClientLink, reads: FakeFactoryReads): void;
  /** Render under a root-level StrictMode double-mount. */
  strict?: boolean;
  onView?(view: UseFactorySessionViewResult): void;
}

async function mountFactoryView(options: MountOptions = {}): Promise<FactoryHarness> {
  const props = options.props ?? {};
  const link = new FakeClientLink();
  const reads = new FakeFactoryReads();
  options.setup?.(link, reads);
  const view: { current: UseFactorySessionViewResult | null } = { current: null };
  const client: { current: FactoryClient | null } = { current: null };

  function Probe(inner: ViewProps): null {
    client.current = useFactoryClient();
    const value = useFactorySessionView(reads, {
      tenantId: inner.tenantId ?? TENANT,
      sessionId: inner.sessionId ?? FSID,
      ...(inner.tailLimit === undefined ? {} : { tailLimit: inner.tailLimit }),
      ...(inner.coveredThrough === undefined ? {} : { coveredThrough: inner.coveredThrough }),
      ...(inner.repairDelayMs === undefined ? {} : { repairDelayMs: inner.repairDelayMs }),
      ...(inner.maxRepairAttempts === undefined ? {} : { maxRepairAttempts: inner.maxRepairAttempts }),
      ...(inner.maxTailPages === undefined ? {} : { maxTailPages: inner.maxTailPages }),
      ...(inner.maxTailBytes === undefined ? {} : { maxTailBytes: inner.maxTailBytes }),
      ...(inner.gateRefreshMs === undefined ? {} : { gateRefreshMs: inner.gateRefreshMs }),
    });
    useEffect(() => {
      view.current = value;
      options.onView?.(value);
    });
    return null;
  }

  const create = (clientOptions: FactoryClientOptions): FactoryClient =>
    createFactoryClient({ ...clientOptions, clientLinkFactory: () => link });
  const tree = (inner: ViewProps): React.ReactElement => (
    <FactoryLinkProvider key={inner.scopeKey} create={create}>
      <Probe {...inner} />
    </FactoryLinkProvider>
  );

  if (options.strict === true) {
    const rendered = await renderStrict(tree(props));
    return {
      link,
      reads,
      view,
      client,
      rerender: (next?: ViewProps) => rendered.rerender(tree(next ?? props)),
      unmount: () => rendered.unmount(),
    };
  }
  const rendered = await render(tree(props));
  return {
    link,
    reads,
    view,
    client,
    rerender: (next?: ViewProps) => rendered.rerender(tree(next ?? props)),
    unmount: () => rendered.unmount(),
  };
}

function setPage(reads: FakeFactoryReads, tip: number, sequences: number[], sessionId = FSID): void {
  reads.status = { ...reads.status, session_id: sessionId, journal_tip: tip };
  reads.page = { journal_tip: tip, covered_through: tip, events: sequences.map((sequence) => publicEvent(sequence)) };
}

function enduringFor(sequence: number): EnduringPublication {
  return {
    type: "enduring_publication", tenant_id: TENANT, session_id: FSID,
    event_id: `event-${sequence}`, journal_seq: sequence, covered_through: sequence,
    body: publicEvent(sequence).body,
  };
}

async function liveReady(h: FactoryHarness, coverage = 0): Promise<void> {
  await expect.poll(() => h.link.open.length).toBe(1);
  await expect.poll(() => h.view.current?.liveState).toBe("live");
  await expect.poll(() => h.view.current?.coveredThrough).toBe(coverage);
  await expect.poll(() => h.view.current?.state).toBe("ready");
}

test("opening a cold session reads bounded REST state and never sends a restore", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 3, [2, 3]);
  } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.view.current?.status?.residency).toBe("cold");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2, 3]);
  expect(h.reads.calls.map((call) => call.method)).toEqual(["readStatus", "listGates", "readJournal"]);
  expect(h.reads.of("readJournal")[0]?.options).toMatchObject({ tail: 256, limit: 256 });
  expect(h.link.rpcCalls).toEqual([]);
  expect(h.link.subscriptions).toEqual([]);
});

test("cold REST rendering completes while realtime authorization is unavailable", async () => {
  const h = await mountFactoryView({ setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.reads.of("readJournal")).toHaveLength(1);
  h.link.settleConnect();
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  expect(h.link.open).toHaveLength(1);
});

test("refresh reconciles three events committed between cold capture and authorization", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 1, [1]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(1);
  setPage(h.reads, 4, [2, 3, 4]);
  h.link.settleConnect();
  await expect.poll(() => h.view.current?.coveredThrough).toBe(4);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2, 3, 4]);
  expect(h.reads.of("readJournal").every((call) => call.options.tail === 256)).toBe(true);
});

test("authorized catchup buffers duplicates and publications above the captured tip", async () => {
  const h = await mountFactoryView({ setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  setPage(h.reads, 3, [1, 2, 3]);
  h.reads.hold("readJournal");
  h.link.settleConnect();
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  h.link.open[0]!.deliver(enduringFor(3));
  h.link.open[0]!.deliver(enduringFor(4));
  h.link.open[0]!.deliver(enduringFor(4));
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
  h.reads.settle("readJournal");
  await expect.poll(() => h.view.current?.coveredThrough).toBe(4);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2, 3, 4]);
});

test("replica reconnect repairs from the shared engine's committed coverage", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [1, 2]) });
  await liveReady(h, 2);
  const old = h.link.open[0]!;
  setPage(h.reads, 5, [3, 4, 5]);
  h.link.drop();
  await expect.poll(() => h.view.current?.coveredThrough).toBe(5);
  old.deliver(enduringFor(99));
  await h.rerender();
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2, 3, 4, 5]);
  expect(h.link.maxLiveConnections).toBe(1);
  expect(h.link.rpcCalls).toEqual([]);
});

test("a validated reset lowers coverage and removes truncated events before replacement history", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 3, [1, 2, 3]) });
  await liveReady(h, 3);
  setPage(h.reads, 2, [1, 2]);
  h.link.open[0]!.reset({
    type: "session.reset", tenant_id: TENANT, session_id: FSID,
    journal_tip: 2, last_contiguous: 1,
  });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(2);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2]);
});

test("live repair is observable while the durable snapshot remains ready", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  await expect.poll(() => h.view.current?.liveState).toBe("live");
  h.reads.hold("readJournal");
  h.link.open[0]!.reset({
    type: "session.reset", tenant_id: TENANT, session_id: FSID,
    journal_tip: 2, last_contiguous: 2,
  });
  await expect.poll(() => h.view.current?.liveState).toBe("repairing");
  expect(h.view.current?.state).toBe("ready");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2]);
  h.reads.settle("readJournal");
  await expect.poll(() => h.view.current?.liveState).toBe("live");
});

test("an overflowing prejoin buffer discards uncommitted frames and repairs", async () => {
  const h = await mountFactoryView({ props: { repairDelayMs: 0 }, setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  h.reads.hold("readJournal");
  h.link.settleConnect();
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  const first = h.link.open[0]!;
  for (let sequence = 1; sequence <= 257; sequence++) first.deliver(enduringFor(sequence));
  await expect.poll(() => h.reads.of("readJournal")[1]?.options.signal?.aborted).toBe(true);
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.view.current?.events).toEqual([]);
  setPage(h.reads, 257, [255, 256, 257]);
  h.reads.settle("readJournal");
  await expect.poll(() => h.view.current?.coveredThrough).toBe(257);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([255, 256, 257]);
});

test("a forged channel publication never moves coverage and triggers repair", async () => {
  const h = await mountFactoryView({ props: { repairDelayMs: 0 }, setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  const before = h.reads.of("readJournal").length;
  h.link.open[0]!.deliver({ ...enduringFor(999), tenant_id: "another-tenant" });
  await expect.poll(() => h.reads.of("readJournal").length).toBeGreaterThan(before);
  expect(h.view.current?.coveredThrough).toBe(2);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2]);
});

test("committed publication coverage attests withheld private positions", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  h.link.open[0]!.deliver(enduringFor(5));
  await expect.poll(() => h.view.current?.coveredThrough).toBe(5);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2, 5]);
});

test("ephemeral publications do not enter durable history", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver({
    type: "ephemeral_publication", tenant_id: TENANT, session_id: FSID,
    body: { type: "token_delta", text: "working" },
  });
  await h.rerender();
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
});

const LIVE_LOOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIVE_TURN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function liveText(text: string, loopId = LIVE_LOOP, turnId = LIVE_TURN) {
  return {
    type: "ephemeral_publication" as const, tenant_id: TENANT, session_id: FSID,
    body: { v: 1, type: "TokenDelta", session_id: FSID, loop_id: loopId, turn_id: turnId,
      chunk: { chunk_type: "text", text } },
  };
}

function liveReasoning(thinking: unknown, loopId = LIVE_LOOP, turnId = LIVE_TURN) {
  return {
    ...liveText("", loopId, turnId),
    body: { ...liveText("", loopId, turnId).body, chunk: { chunk_type: "thinking", thinking } },
  };
}

test("reasoning uses the same subscription without changing durable coverage", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveReasoning("one "));
  h.link.open[0]!.deliver(liveText("answer"));
  h.link.open[0]!.deliver(liveReasoning("two"));
  await expect.poll(() => h.view.current?.liveReasoning).toStrictEqual([
    { loopId: LIVE_LOOP, turnId: LIVE_TURN, text: "one two" },
  ]);
  expect(h.view.current?.liveText[0]?.text).toBe("answer");
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.link.subscriptions).toHaveLength(1);
});

test("invalid reasoning suppresses only reasoning until StepDone", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveReasoning("before"));
  await expect.poll(() => h.view.current?.liveReasoning[0]?.text).toBe("before");
  h.link.open[0]!.deliver(liveReasoning("x".repeat(16_385)));
  h.link.open[0]!.deliver(liveReasoning("late"));
  h.link.open[0]!.deliver(liveText("answer"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("answer");
  expect(h.view.current?.liveReasoning[0]?.text).toBe("before");
  h.link.open[0]!.deliver(completed(1, "StepDone"));
  await expect.poll(() => h.view.current?.liveReasoning).toEqual([]);
  h.link.open[0]!.deliver(liveReasoning("next"));
  await expect.poll(() => h.view.current?.liveReasoning[0]?.text).toBe("next");
});

test("invalid text does not suppress reasoning on the same turn", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveText("x".repeat(16_385)));
  h.link.open[0]!.deliver(liveReasoning("still visible"));
  await expect.poll(() => h.view.current?.liveReasoning[0]?.text).toBe("still visible");
  expect(h.view.current?.liveText).toEqual([]);
});

test("wrong-session and malformed reasoning never render", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver({ ...liveReasoning("private"), body: { ...liveReasoning("private").body, session_id: "private" } });
  h.link.open[0]!.deliver(liveReasoning(42));
  h.link.open[0]!.deliver(liveReasoning("late"));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(h.view.current?.liveReasoning).toEqual([]);
});

test("text remains visible after reasoning fills its own 64 KiB preview budget", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  for (let i = 0; i < 4; i++) h.link.open[0]!.deliver(liveReasoning("r".repeat(16_384)));
  h.link.open[0]!.deliver(liveText("ok"));
  await expect.poll(() => h.view.current?.liveReasoning[0]?.text.length).toBe(65_536);
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("ok");
  h.link.open[0]!.deliver(liveReasoning("overflow"));
  h.link.open[0]!.deliver(liveReasoning("late"));
  h.link.open[0]!.deliver(liveText("!"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("ok!");
  expect(h.view.current?.liveReasoning[0]?.text).toBe("r".repeat(65_536));
});

test.each(["reasoning", "text"] as const)("%s has its own 16-key preview cap", async (fullKind) => {
  const h = await mountFactoryView();
  await liveReady(h);
  const send = (kind: "reasoning" | "text", n: number, value: string) => {
    const turnId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    h.link.open[0]!.deliver(kind === "reasoning" ? liveReasoning(value, LIVE_LOOP, turnId) : liveText(value, LIVE_LOOP, turnId));
  };
  const otherKind = fullKind === "reasoning" ? "text" : "reasoning";
  for (let n = 1; n <= 16; n++) send(fullKind, n, "full");
  send(fullKind, 17, "excluded");
  send(otherKind, 17, "included");
  await expect.poll(() => fullKind === "reasoning" ? h.view.current?.liveReasoning.length : h.view.current?.liveText.length).toBe(16);
  await expect.poll(() => otherKind === "reasoning" ? h.view.current?.liveReasoning[0]?.text : h.view.current?.liveText[0]?.text).toBe("included");
  const full = fullKind === "reasoning" ? h.view.current!.liveReasoning : h.view.current!.liveText;
  expect(full.some((preview) => preview.text === "excluded")).toBe(false);
  h.link.open[0]!.deliver(completed(1, "TurnDone", LIVE_LOOP, `00000000-0000-4000-8000-${String(1).padStart(12, "0")}`));
  await expect.poll(() => fullKind === "reasoning" ? h.view.current?.liveReasoning.length : h.view.current?.liveText.length).toBe(15);
  send(fullKind, 17, "still suppressed");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const remaining = fullKind === "reasoning" ? h.view.current!.liveReasoning : h.view.current!.liveText;
  expect(remaining.some((preview) => preview.turnId.endsWith("000000000017"))).toBe(false);
});

test("reasoning tombstones evict the oldest rejected key beyond 256", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const turnId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  for (let n = 0; n <= 256; n++) {
    h.link.open[0]!.deliver(liveReasoning(42, LIVE_LOOP, turnId(n)));
    if (n % 16 === 15) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.link.open[0]!.deliver(liveReasoning("oldest reaccepted", LIVE_LOOP, turnId(0)));
  h.link.open[0]!.deliver(liveReasoning("newest suppressed", LIVE_LOOP, turnId(256)));
  await expect.poll(() => h.view.current?.liveReasoning).toEqual([
    { loopId: LIVE_LOOP, turnId: turnId(0), text: "oldest reaccepted" },
  ]);
});

test.each(["StepDone", "TurnDone", "TurnFailed", "TurnInterrupted", "SessionStopped"])(
  "%s clears reasoning with text", async (type) => {
    const h = await mountFactoryView();
    await liveReady(h);
    h.link.open[0]!.deliver(liveReasoning("thought"));
    await expect.poll(() => h.view.current?.liveReasoning[0]?.text).toBe("thought");
    h.link.open[0]!.deliver(completed(1, type));
    await expect.poll(() => h.view.current?.liveReasoning).toEqual([]);
    h.link.open[0]!.deliver(liveReasoning("late"));
    if (type !== "StepDone") {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(h.view.current?.liveReasoning).toEqual([]);
    } else {
      await expect.poll(() => h.view.current?.liveReasoning[0]?.text).toBe("late");
    }
  },
);

test("repair and reset clear reasoning and reject stale callbacks", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  const old = h.link.open[0]!;
  old.deliver(liveReasoning("before"));
  await expect.poll(() => h.view.current?.liveReasoning[0]?.text).toBe("before");
  h.link.drop();
  await expect.poll(() => h.view.current?.liveReasoning).toEqual([]);
  old.deliver(liveReasoning("stale"));
  expect(h.view.current?.liveReasoning).toEqual([]);
  await liveReady(h, 2);
  h.link.open[0]!.deliver(liveReasoning("reset"));
  await expect.poll(() => h.view.current?.liveReasoning[0]?.text).toBe("reset");
  h.link.open[0]!.reset({ type: "session.reset", tenant_id: TENANT, session_id: FSID, journal_tip: 0, last_contiguous: 0 });
  await expect.poll(() => h.view.current?.liveReasoning).toEqual([]);
});

test("reasoning keeps other loops when one loop commits", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  h.link.open[0]!.deliver(liveReasoning("first"));
  h.link.open[0]!.deliver(liveReasoning("other", other));
  await expect.poll(() => h.view.current?.liveReasoning).toHaveLength(2);
  h.link.open[0]!.deliver(completed(1, "StepDone"));
  await expect.poll(() => h.view.current?.liveReasoning).toEqual([
    { loopId: other, turnId: LIVE_TURN, text: "other" },
  ]);
});

test("scope and session identity changes clear reasoning", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveReasoning("old"));
  await expect.poll(() => h.view.current?.liveReasoning[0]?.text).toBe("old");
  await h.rerender({ scopeKey: "other-login" });
  expect(h.view.current?.liveReasoning).toEqual([]);
  const session = await mountFactoryView();
  await liveReady(session);
  session.link.open[0]!.deliver(liveReasoning("old"));
  await expect.poll(() => session.view.current?.liveReasoning[0]?.text).toBe("old");
  await session.rerender({ sessionId: "another-session" });
  expect(session.view.current?.liveReasoning).toEqual([]);
});

test("access revocation clears reasoning", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  h.link.open[0]!.deliver(liveReasoning("private"));
  await expect.poll(() => h.view.current?.liveReasoning[0]?.text).toBe("private");
  h.reads.fail("readJournal", new CoreProtocolError({ error: {
    code: "not_authorized", message: "revoked", retryable: false,
  } }));
  await h.view.current!.browseEarlier();
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.liveReasoning).toEqual([]);
});

test("stop cancels a pending reasoning frame", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveReasoning("pending"));
  await h.rerender({ sessionId: "another-session" });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(h.view.current?.liveReasoning).toEqual([]);
});

test("reasoning deltas in one frame publish once", async () => {
  const published: string[] = [];
  const h = await mountFactoryView({ onView: (view) => {
    if (view.liveReasoning[0] !== undefined) published.push(view.liveReasoning[0].text);
  } });
  await liveReady(h);
  h.link.open[0]!.deliver(liveReasoning("a"));
  h.link.open[0]!.deliver(liveReasoning("b"));
  await expect.poll(() => h.view.current?.liveReasoning[0]?.text).toBe("ab");
  expect(published).toEqual(["ab"]);
});

function completed(sequence: number, type: string, loopId = LIVE_LOOP, turnId = LIVE_TURN): EnduringPublication {
  return {
    ...enduringFor(sequence),
    body: { v: 1, type, session_id: FSID, loop_id: loopId, turn_id: turnId },
  };
}

test("Factory live text uses the existing subscription and never changes durable coverage", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveText("hello "));
  h.link.open[0]!.deliver(liveText("world"));
  await expect.poll(() => h.view.current?.liveText).toStrictEqual([
    { loopId: LIVE_LOOP, turnId: LIVE_TURN, text: "hello world" },
  ]);
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.link.subscriptions).toHaveLength(1);
});

test("StepDone clears its loop while a later step in the same turn starts new text", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveText("first"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("first");
  h.link.open[0]!.deliver(completed(1, "StepDone"));
  await expect.poll(() => h.view.current?.liveText).toEqual([]);
  h.link.open[0]!.deliver(liveText("second"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("second");
});

test.each(["TurnDone", "TurnFailed", "TurnInterrupted", "SessionStopped"])(
  "%s clears preview and refuses later deltas for the ended turn or session", async (type) => {
    const h = await mountFactoryView();
    await liveReady(h);
    h.link.open[0]!.deliver(liveText("before"));
    await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("before");
    h.link.open[0]!.deliver(completed(1, type));
    await expect.poll(() => h.view.current?.liveText).toEqual([]);
    h.link.open[0]!.deliver(liveText("late"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(h.view.current?.liveText).toEqual([]);
  },
);

test("malformed and oversized live bodies never render", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver({ ...liveText("x"), body: { ...liveText("x").body, session_id: "private" } });
  h.link.open[0]!.deliver(liveText("x".repeat(16_385)));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(h.view.current?.liveText).toEqual([]);
});

test("an oversized correlated delta suppresses further text for its key until StepDone", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveText("before"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("before");
  h.link.open[0]!.deliver(liveText("x".repeat(16_385)));
  h.link.open[0]!.deliver(liveText("after"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.view.current?.liveText[0]?.text).toBe("before");
  h.link.open[0]!.deliver(completed(1, "StepDone"));
  await expect.poll(() => h.view.current?.liveText).toEqual([]);
  h.link.open[0]!.deliver(liveText("next"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("next");
});

test("the 64 KiB budget freezes the growing key at its last visible text", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  for (let i = 0; i < 4; i++) h.link.open[0]!.deliver(liveText("x".repeat(16_000)));
  await expect.poll(() => h.view.current?.liveText[0]?.text.length).toBe(64_000);
  h.link.open[0]!.deliver(liveText("y".repeat(2_000)));
  h.link.open[0]!.deliver(liveText("later"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.view.current?.liveText[0]?.text).toBe("x".repeat(64_000));
});

test("a turn terminal preserves other loops' previews", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  h.link.open[0]!.deliver(liveText("first"));
  h.link.open[0]!.deliver(liveText("other", other));
  await expect.poll(() => h.view.current?.liveText).toHaveLength(2);
  h.link.open[0]!.deliver(completed(1, "TurnDone"));
  await expect.poll(() => h.view.current?.liveText).toEqual([{ loopId: other, turnId: LIVE_TURN, text: "other" }]);
});

test("several deltas in one frame publish one preview", async () => {
  const published: string[] = [];
  const h = await mountFactoryView({ onView: (view) => {
    if (view.liveText[0] !== undefined) published.push(view.liveText[0].text);
  } });
  await liveReady(h);
  h.link.open[0]!.deliver(liveText("a"));
  h.link.open[0]!.deliver(liveText("b"));
  h.link.open[0]!.deliver(liveText("c"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("abc");
  expect(published).toEqual(["abc"]);
});

test("live text uses a timer when requestAnimationFrame is absent", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  vi.stubGlobal("requestAnimationFrame", undefined);
  try {
    h.link.open[0]!.deliver(liveText("timer"));
    await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("timer");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("StrictMode double-mount publishes live text once", async () => {
  const h = await mountFactoryView({ strict: true });
  await liveReady(h);
  h.link.open[0]!.deliver(liveText("once"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("once");
  expect(h.link.open).toHaveLength(1);
});

test("access revocation clears the preview", async () => {
  const failedViews: UseFactorySessionViewResult[] = [];
  const h = await mountFactoryView({
    setup: (_link, reads) => setPage(reads, 2, [2]),
    onView: (view) => { if (view.state === "failed") failedViews.push(view); },
  });
  await liveReady(h, 2);
  h.link.open[0]!.deliver(liveText("private"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("private");
  h.reads.fail("readJournal", new CoreProtocolError({ error: {
    code: "not_authorized", message: "revoked", retryable: false,
  } }));
  await h.view.current!.browseEarlier();
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(failedViews.map((view) => view.liveText)).toEqual([[]]);
});

test("preview is bounded across keys and one key cannot grow forever", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  h.link.open[0]!.deliver(liveText("x".repeat(16_000)));
  h.link.open[0]!.deliver(liveText("y".repeat(16_000), other));
  for (let i = 0; i < 5; i++) h.link.open[0]!.deliver(liveText("z".repeat(16_000)));
  await expect.poll(() => h.view.current?.liveText.length).toBeGreaterThan(0);
  expect(h.view.current!.liveText.reduce((sum, item) => sum + new TextEncoder().encode(item.text).byteLength, 0))
    .toBeLessThanOrEqual(65_536);
});

test("reconnect clears the old preview before a new generation is live", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const old = h.link.open[0]!;
  old.deliver(liveText("old"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("old");
  h.link.drop();
  await expect.poll(() => h.view.current?.liveText).toEqual([]);
  await expect.poll(() => h.link.open.length).toBe(1);
  old.deliver(liveText("stale"));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(h.view.current?.liveText).toEqual([]);
});

test("scope and session identity changes clear the preview", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveText("old"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("old");
  await h.rerender({ sessionId: "another-session" });
  expect(h.view.current?.liveText).toEqual([]);
});

test("StepDone removes only its loop, including a delta still waiting for a frame", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  h.link.open[0]!.deliver(liveText("other", other));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("other");
  h.link.open[0]!.deliver(liveText("uncommitted"));
  h.link.open[0]!.deliver(completed(1, "StepDone"));
  await expect.poll(() => h.view.current?.coveredThrough).toBe(1);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(h.view.current?.liveText).toEqual([{ loopId: other, turnId: LIVE_TURN, text: "other" }]);
});

test("a validated reset projection clears the old generation preview", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveText("old"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("old");
  h.link.open[0]!.reset({
    type: "session.reset", tenant_id: TENANT, session_id: FSID,
    journal_tip: 0, last_contiguous: 0,
  });
  await expect.poll(() => h.view.current?.liveText).toEqual([]);
});

test("changing link scope clears the old preview and stale callbacks", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const old = h.link.open[0]!;
  old.deliver(liveText("old"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("old");
  await h.rerender({ scopeKey: "other-login" });
  expect(h.view.current?.liveText).toEqual([]);
  old.deliver(liveText("stale"));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(h.view.current?.liveText).toEqual([]);
});

test("failed realtime recovery drops its preview while retaining durable history", async () => {
  const h = await mountFactoryView({ props: { maxRepairAttempts: 1, repairDelayMs: 0 } });
  await liveReady(h);
  h.link.open[0]!.deliver(liveText("transient"));
  await expect.poll(() => h.view.current?.liveText[0]?.text).toBe("transient");
  h.link.denied.add(FSID);
  h.link.drop();
  await expect.poll(() => h.view.current?.liveState).toBe("failed");
  expect(h.view.current?.liveText).toEqual([]);
  expect(h.view.current?.state).toBe("ready");
});

test("stop cancels a pending preview frame before a different session mounts", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  h.link.open[0]!.deliver(liveText("old"));
  await h.rerender({ sessionId: "another-session" });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(h.view.current?.liveText).toEqual([]);
});

test("cold capture follows an opaque continuation without a new tail or sequence-zero read", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 5 };
    reads.queue("readJournal", { journal_tip: 5, covered_through: 2, events: [publicEvent(2)], next_cursor: "cursor-1" });
    reads.queue("readJournal", { journal_tip: 5, covered_through: 5, events: [publicEvent(5)] });
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(5);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2, 5]);
  expect(h.reads.of("readJournal").map((call) => call.options)).toMatchObject([
    { tail: 256, limit: 256 }, { cursor: "cursor-1", limit: 256 },
  ]);
  expect(h.reads.of("readJournal")[1]?.options.tail).toBeUndefined();
  expect(h.reads.of("readStatus")).toHaveLength(1);
});

test("empty continuation coverage reaches the immutable captured tip", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 6 };
    reads.queue("readJournal", { journal_tip: 6, covered_through: 1, events: [], next_cursor: "cursor-1" });
    reads.queue("readJournal", { journal_tip: 6, covered_through: 3, events: [], next_cursor: "cursor-2" });
    reads.queue("readJournal", { journal_tip: 6, covered_through: 6, events: [publicEvent(6)] });
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(6);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([6]);
  expect(h.reads.of("readJournal")).toHaveLength(3);
});

test("earlier history is never read automatically and starts only on an explicit action", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [8, 9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  expect(h.reads.of("readJournal").map((call) => call.options)).toMatchObject([
    { tail: 256, limit: 256 },
  ]);

  h.reads.queue("readJournal", {
    journal_tip: 9,
    covered_through: 2,
    events: [publicEvent(1), publicEvent(2)],
    next_cursor: "older-cursor-1",
  });
  await h.view.current!.browseEarlier();

  expect(h.reads.of("readJournal")[1]?.options).toMatchObject({ limit: 256 });
  expect(h.reads.of("readJournal")[1]?.options.cursor).toBeUndefined();
  expect(h.reads.of("readJournal")[1]?.options.tail).toBeUndefined();
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2, 8, 9]);
  expect(h.view.current?.earlierState).toBe("available");
});

test("each earlier-history action follows one opaque cursor, including across an empty page", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 2, events: [], next_cursor: "older-cursor-2",
  });
  await h.view.current!.browseEarlier();
  expect(h.view.current?.earlierState).toBe("available");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([9]);

  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 5, events: [publicEvent(5)],
  });
  await h.view.current!.browseEarlier();
  expect(h.reads.of("readJournal")[2]?.options).toMatchObject({ cursor: "older-cursor-2", limit: 256 });
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([5, 9]);
  expect(h.view.current?.earlierState).toBe("complete");
});

test("many explicit earlier-history pages retain only the current older window", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);

  for (let sequence = 1; sequence <= 4; sequence++) {
    h.reads.queue("readJournal", {
      journal_tip: 9,
      covered_through: sequence,
      events: [publicEvent(sequence)],
      ...(sequence < 4 ? { next_cursor: `older-cursor-${sequence}` } : {}),
    });
    await h.view.current!.browseEarlier();
  }

  expect(h.reads.of("readJournal")).toHaveLength(5);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([4, 9]);
  expect(h.view.current?.coveredThrough).toBe(9);
  expect(h.view.current?.liveState).toBe("joining");
  expect(h.view.current?.earlierState).toBe("complete");
});

test("an oversized earlier page is refused without replacing the current view", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.queue("readJournal", {
    journal_tip: 9,
    covered_through: 1,
    events: [publicEvent(1, "x".repeat(DEFAULT_MAX_TAIL_BYTES))],
    next_cursor: "older",
  });

  await h.view.current!.browseEarlier();

  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([9]);
  expect(h.view.current?.coveredThrough).toBe(9);
  expect(h.view.current?.earlierState).toBe("failed");
  expect(h.view.current?.error?.message).toContain("earlier history byte budget");
});

test("an earlier page byte budget counts multibyte UTF-8 rather than UTF-16 code units", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.queue("readJournal", {
    journal_tip: 9,
    covered_through: 1,
    events: [publicEvent(1, "é".repeat(600_000))],
    next_cursor: "older",
  });

  await h.view.current!.browseEarlier();

  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([9]);
  expect(h.view.current?.earlierState).toBe("failed");
  expect(h.view.current?.error?.message).toContain("earlier history byte budget");
});

test("a current event wins an earlier-history duplicate at the same sequence", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 9 };
    reads.page = {
      journal_tip: 9, covered_through: 9,
      events: [publicEvent(9, "current event")],
    };
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 9,
    events: [publicEvent(9, "stale earlier duplicate")],
  });

  await h.view.current!.browseEarlier();

  expect(h.view.current?.events).toHaveLength(1);
  expect(h.view.current?.events[0]?.body).toMatchObject({ text: "current event" });
});

test("a refused earlier page preserves the prior window and cursor across a live rerender", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 9, [9]) });
  await liveReady(h, 9);
  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 1,
    events: [publicEvent(1)], next_cursor: "older-1",
  });
  await h.view.current!.browseEarlier();

  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 2,
    events: [publicEvent(2, "x".repeat(DEFAULT_MAX_TAIL_BYTES))], next_cursor: "older-2",
  });
  await h.view.current!.browseEarlier();
  h.link.open[0]!.deliver(enduringFor(10));
  await expect.poll(() => h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 9, 10]);

  h.reads.queue("readJournal", {
    journal_tip: 10, covered_through: 3, events: [publicEvent(3)],
  });
  await h.view.current!.browseEarlier();

  expect(h.reads.of("readJournal").at(-1)?.options.cursor).toBe("older-1");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([3, 9, 10]);
});

test("an earlier page exceeding its requested row limit is refused", async () => {
  const h = await mountFactoryView({ props: { tailLimit: 1 }, setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.queue("readJournal", {
    journal_tip: 9,
    covered_through: 2,
    events: [publicEvent(1), publicEvent(2)],
  });

  await h.view.current!.browseEarlier();

  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([9]);
  expect(h.view.current?.earlierState).toBe("failed");
  expect(h.view.current?.error?.message).toContain("earlier history event budget");
});

test("a lowered live reset clears the earlier window without retaining truncated history", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 9, [9]) });
  await liveReady(h, 9);
  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 1, events: [publicEvent(1)], next_cursor: "older",
  });
  await h.view.current!.browseEarlier();
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 9]);

  setPage(h.reads, 2, [2]);
  h.link.open[0]!.reset({
    type: "session.reset", tenant_id: TENANT, session_id: FSID,
    journal_tip: 2, last_contiguous: 1,
  });

  await expect.poll(() => h.view.current?.coveredThrough).toBe(2);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2]);
  expect(h.view.current?.earlierState).toBe("idle");
});

test("a lowered reset aborts pending earlier history and its late success cannot revive the window", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 9, [9]) });
  await liveReady(h, 9);
  const originalRead = h.reads.readJournal.bind(h.reads);
  let resolveEarlier!: (page: PublicJournalPage) => void;
  let earlierSignal: AbortSignal | undefined;
  let intercepted = false;
  h.reads.readJournal = (sessionId, options) => {
    if (!intercepted && options?.tail === undefined && options?.cursor === undefined) {
      intercepted = true;
      earlierSignal = options?.signal;
      return new Promise((resolve) => { resolveEarlier = resolve; });
    }
    return originalRead(sessionId, options);
  };

  const pending = h.view.current!.browseEarlier();
  await expect.poll(() => intercepted).toBe(true);
  setPage(h.reads, 2, [2]);
  h.link.open[0]!.reset({
    type: "session.reset", tenant_id: TENANT, session_id: FSID,
    journal_tip: 2, last_contiguous: 1,
  });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(2);
  expect(earlierSignal?.aborted).toBe(true);

  resolveEarlier({ journal_tip: 9, covered_through: 1, events: [publicEvent(1)], next_cursor: "stale" });
  await pending;
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2]);
  expect(h.view.current?.earlierState).toBe("idle");
});

test("a lower first authorized projection clears history browsed from the cold view", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 1, events: [publicEvent(1)], next_cursor: "older",
  });
  await h.view.current!.browseEarlier();
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 9]);

  setPage(h.reads, 2, [2]);
  h.link.settleConnect();

  await expect.poll(() => h.view.current?.coveredThrough).toBe(2);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2]);
  expect(h.view.current?.earlierState).toBe("idle");
});

test("an authoritative earlier-history denial clears the whole scoped view", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 1, events: [publicEvent(1)], next_cursor: "older",
  });
  await h.view.current!.browseEarlier();
  h.reads.fail("readJournal", new CoreProtocolError({ error: {
    code: "not_authorized", retryable: false,
  } }));

  await h.view.current!.browseEarlier();

  expect(h.view.current?.state).toBe("failed");
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.view.current?.earlierState).toBe("idle");
});

test("an authoritative denial resets the earlier cursor before a later explicit browse", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 1, events: [publicEvent(1)], next_cursor: "older-1",
  });
  await h.view.current!.browseEarlier();
  h.reads.fail("readJournal", new CoreProtocolError({ error: {
    code: "not_authorized", retryable: false,
  } }));
  await h.view.current!.browseEarlier();

  h.reads.queue("readJournal", { journal_tip: 9, covered_through: 2, events: [publicEvent(2)] });
  await h.view.current!.browseEarlier();

  expect(h.reads.of("readJournal").at(-1)?.options.cursor).toBeUndefined();
});

test("unmount aborts a pending explicit earlier-history read", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.hold("readJournal");

  void h.view.current!.browseEarlier();
  await expect.poll(() => h.reads.of("readJournal")).toHaveLength(2);
  await h.unmount();

  expect(h.reads.of("readJournal")[1]?.options.signal?.aborted).toBe(true);
});

test("authorized join also follows captured-tail continuations", async () => {
  const h = await mountFactoryView({ setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  h.reads.status = { ...h.reads.status, journal_tip: 6 };
  h.reads.queue("readJournal", { journal_tip: 6, covered_through: 2, events: [], next_cursor: "live-cursor" });
  h.reads.queue("readJournal", { journal_tip: 6, covered_through: 6, events: [publicEvent(6)] });
  h.link.settleConnect();
  await expect.poll(() => h.view.current?.coveredThrough).toBe(6);
  expect(h.reads.of("readJournal")[2]?.options).toMatchObject({ cursor: "live-cursor", limit: 256 });
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([6]);
});

test("cold page budget exhaustion refuses the whole capture", async () => {
  const h = await mountFactoryView({ props: { maxTailPages: 1 }, setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 9 };
    reads.page = { journal_tip: 9, covered_through: 2, events: [publicEvent(2)], next_cursor: "more" };
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.error?.message).toContain("captured tail");
  expect(h.reads.of("readJournal")).toHaveLength(1);
});

test("cold byte budget exhaustion refuses the whole capture", async () => {
  const h = await mountFactoryView({ props: { maxTailBytes: 100 }, setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 2, []);
    reads.page.events = [publicEvent(2, "x".repeat(512))];
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.view.current?.events).toEqual([]);
});

test("cold capture rejects events above the authenticated page coverage", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 2, [5]);
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
});

test("authorization cancels an unfinished initial cold capture", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.hold("readJournal");
  } });
  await expect.poll(() => h.reads.of("readJournal").length).toBe(1);
  h.link.settleConnect();
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  expect(h.reads.of("readJournal")[0]?.options.signal?.aborted).toBe(true);
  h.reads.settle("readJournal");
  await liveReady(h);
});

test("session change cancels an in-flight cold continuation and rejects old callbacks", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 5 };
    reads.hold("readJournal");
    reads.queue("readJournal", { journal_tip: 5, covered_through: 2, events: [], next_cursor: "more" });
  } });
  h.reads.settle("readJournal");
  h.reads.hold("readJournal");
  await expect.poll(() => h.reads.of("readJournal").length).toBe(2);
  setPage(h.reads, 7, [7], "session-2");
  await h.rerender({ sessionId: "session-2" });
  expect(h.reads.of("readJournal")[1]?.options.signal?.aborted).toBe(true);
  h.reads.settle("readJournal");
  await expect.poll(() => h.view.current?.coveredThrough).toBe(7);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([7]);
});

test("tenant change with the same session id creates an isolated journal view", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  const stale = h.link.open[0]!;
  setPage(h.reads, 4, [4]);
  await h.rerender({ tenantId: "tenant-2" });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(4);
  stale.deliver(enduringFor(99));
  await h.rerender({ tenantId: "tenant-2" });
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([4]);
  expect(h.link.open[0]?.options.tenantId).toBe("tenant-2");
});

test("unmount aborts pending reads and makes late completions inert", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.hold("readJournal");
  } });
  await expect.poll(() => h.reads.of("readJournal").length).toBe(1);
  const before = h.view.current;
  await h.unmount();
  expect(h.reads.of("readJournal")[0]?.options.signal?.aborted).toBe(true);
  h.reads.settle("readJournal");
  await Promise.resolve();
  expect(h.view.current).toBe(before);
});

test("StrictMode leaves one active subscription and ignores the discarded mount", async () => {
  const h = await mountFactoryView({ strict: true, setup: (_link, reads) => setPage(reads, 1, [1]) });
  await liveReady(h, 1);
  expect(h.link.open).toHaveLength(1);
  expect(h.link.maxLiveConnections).toBe(1);
  h.link.open[0]!.deliver(enduringFor(2));
  await expect.poll(() => h.view.current?.coveredThrough).toBe(2);
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2]);
  expect(h.link.rpcCalls).toEqual([]);
});

test("REST authorization denial is reported without a restore", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.fail("readStatus", new Error("not authorized"));
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.error?.message).toBe("not authorized");
  expect(h.view.current?.status).toBeNull();
  expect(h.link.rpcCalls).toEqual([]);
});

test("a missing session is reported by its durable read", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.fail("readStatus", new Error("session not found"));
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.error?.message).toBe("session not found");
});

test("a failed cold projection aborts sibling REST requests while realtime is unavailable", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.hold("readJournal");
    reads.fail("readStatus", new Error("projection unavailable"));
  } });
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.reads.of("readJournal")[0]?.options.signal?.aborted).toBe(true);
});

test("a durable cold snapshot remains visible after bounded realtime failure", async () => {
  const h = await mountFactoryView({ props: { maxRepairAttempts: 1, repairDelayMs: 0 }, setup: (link, reads) => {
    link.denied.add(FSID);
    setPage(reads, 1, [1]);
  } });
  await expect.poll(() => h.view.current?.error?.message).toContain("gave up");
  expect(h.view.current?.state).toBe("ready");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1]);
  expect(h.link.subscriptions.length).toBeLessThanOrEqual(2);
});

test.each([
  ["readStatus", "not_authorized"],
  ["listGates", "not_authorized"],
  ["readJournal", "unauthenticated"],
  ["readStatus", "session_not_found"],
] as const)("an authoritative %s %s invalidation clears cached durable state and cancels the binding", async (method, code) => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  h.reads.fail(method, new CoreProtocolError({ error: {
    code, message: "not authorized", retryable: false,
  } }));
  h.link.drop();
  await expect.poll(() => h.view.current?.state).toBe("failed");
  expect(h.view.current?.status).toBeNull();
  expect(h.view.current?.gates).toBeNull();
  expect(h.view.current?.events).toEqual([]);
  expect(h.view.current?.coveredThrough).toBe(0);
  expect(h.view.current?.error).toMatchObject({ code });
  await expect.poll(() => h.link.open.length).toBe(0);
});

test("rekeying the provider for a new authentication generation clears the old view", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  const old = h.link.open[0]!;
  setPage(h.reads, 4, [4]);
  await h.rerender({ scopeKey: "new-auth-generation" });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(4);
  old.deliver(enduringFor(99));
  await h.rerender({ scopeKey: "new-auth-generation" });
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([4]);
  expect(old.unsubscribeCount).toBe(1);
});

test("a transient verifier outage repairs without erasing cached durable state", async () => {
  const h = await mountFactoryView({ setup: (_link, reads) => setPage(reads, 2, [2]) });
  await liveReady(h, 2);
  h.reads.fail("readStatus", new CoreProtocolError({ error: { code: "unavailable", retryable: true } }));
  const before = h.reads.of("readStatus").length;
  h.link.drop();
  await expect.poll(() => h.reads.of("readStatus").length).toBeGreaterThan(before + 1);
  await expect.poll(() => h.view.current?.liveState).toBe("live");
  expect(h.view.current?.state).toBe("ready");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2]);
});

test("a stale aborted generation's denial cannot clear a newer authorized view", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const originalStatus = h.reads.readStatus.bind(h.reads);
  let rejectOld!: (cause: Error) => void;
  let statusCalls = 0;
  h.reads.readStatus = (sessionId, options) => {
    if (++statusCalls === 1) return new Promise((_resolve, reject) => { rejectOld = reject; });
    return originalStatus(sessionId, options);
  };
  const reset = { type: "session.reset" as const, tenant_id: TENANT, session_id: FSID, journal_tip: 0, last_contiguous: 0 };
  h.link.open[0]!.reset(reset);
  await expect.poll(() => statusCalls).toBe(1);
  h.link.open[0]!.reset(reset);
  await expect.poll(() => statusCalls).toBe(2);
  await expect.poll(() => h.view.current?.liveState).toBe("live");
  rejectOld(new CoreProtocolError({ error: { code: "not_authorized", retryable: false } }));
  await h.rerender();
  expect(h.view.current?.state).toBe("ready");
  expect(h.view.current?.error).toBeNull();
});

test("the caller's cursor is retained until an authorized capture can reach it", async () => {
  const h = await mountFactoryView({ props: { coveredThrough: 40 }, setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.view.current?.coveredThrough).toBe(40);
  setPage(h.reads, 0, [], "session-2");
  await h.rerender({ sessionId: "session-2", coveredThrough: 0 });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(0);
});

test("changing construction-only options alone does not restart a working view", async () => {
  const h = await mountFactoryView();
  await liveReady(h);
  const count = h.reads.calls.length;
  const subscriptions = h.link.subscriptions.length;
  await h.rerender({ coveredThrough: 999, maxRepairAttempts: 1 });
  expect(h.reads.calls).toHaveLength(count);
  expect(h.link.subscriptions).toHaveLength(subscriptions);
  expect(h.view.current?.coveredThrough).toBe(0);
});

test("status and public gates use the caller's bounded page size", async () => {
  const h = await mountFactoryView({ props: { tailLimit: 8 }, setup: (link) => { link.holdConnect = true; } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.reads.of("readJournal")[0]?.options).toMatchObject({ tail: 8, limit: 8 });
  expect(h.reads.of("listGates")[0]?.options.limit).toBe(8);
});

test("shared repair defaults remain the protocol defaults", () => {
  expect(DEFAULT_MAX_REPAIR_ATTEMPTS).toBe(32);
  expect(DEFAULT_REPAIR_DELAY_MS).toBe(250);
  expect(MAX_REPAIR_BACKOFF_FACTOR).toBe(8);
});

test("invalid bounds fail before I/O", async () => {
  const cases: [ViewProps, string][] = [
    [{ tailLimit: 0 }, "tailLimit must be a positive safe integer"],
    [{ tailLimit: 1.5 }, "tailLimit must be a positive safe integer"],
    [{ maxRepairAttempts: 0 }, "maxRepairAttempts must be a positive safe integer"],
    [{ repairDelayMs: -1 }, "repairDelayMs must be a non-negative safe integer"],
    [{ repairDelayMs: Number.NaN }, "repairDelayMs must be a non-negative safe integer"],
    [{ coveredThrough: -1 }, "coveredThrough must be a non-negative safe integer"],
  ];
  for (const [props, message] of cases) await expect(mountFactoryView({ props })).rejects.toThrow(message);
});

// --- Released-stack behaviour (factory v0.10.0, host v0.10.1, harness v0.39.1) ---

function rejectedCursor(): CoreInvalidRequestError {
  return new CoreInvalidRequestError({
    version: 1,
    error: {
      code: "invalid_request",
      message: "the cursor is not one this session issued; restart the walk",
      retryable: false,
    },
  });
}

function gatePage(tip: number, answerability: "resident" | "unavailable" | "suspended", gateId = "gate-1"): PublicGatePage {
  return {
    journal_tip: tip,
    open_gate_count: 1,
    gates: [{
      gate_id: gateId, kind: "harness.permission", prompt: { title: "Allow shell?" },
      opened_event_id: `event-${tip}`, opened_journal_seq: tip,
      deadline: "2026-09-23T13:00:00Z", answerability,
    }],
  };
}

test("an earlier-history cursor Factory refuses (400) restarts the walk from the beginning", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    setPage(reads, 9, [8, 9]);
  } });
  await expect.poll(() => h.view.current?.coveredThrough).toBe(9);
  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 3, events: [publicEvent(2), publicEvent(3)], next_cursor: "c2.pre-upgrade",
  });
  await h.view.current!.browseEarlier();
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2, 3, 8, 9]);

  // The Factory was upgraded between clicks: its cursors are `j1.` now.
  h.reads.fail("readJournal", rejectedCursor());
  h.reads.queue("readJournal", { journal_tip: 9, covered_through: 0, events: [] }); // consumed by the refused call
  h.reads.queue("readJournal", {
    journal_tip: 9, covered_through: 2, events: [publicEvent(1), publicEvent(2)], next_cursor: "j1.fresh",
  });
  await h.view.current!.browseEarlier();

  const journal = h.reads.of("readJournal");
  expect(journal[2]?.options.cursor).toBe("c2.pre-upgrade");
  expect(journal[3]?.options.cursor).toBeUndefined();
  expect(journal[3]?.options.tail).toBeUndefined();
  expect(h.view.current?.error).toBeNull();
  expect(h.view.current?.earlierState).toBe("available");
  // The old window was replaced by the restarted walk, not merged with it.
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([1, 2, 8, 9]);

  h.reads.queue("readJournal", { journal_tip: 9, covered_through: 7, events: [publicEvent(5)] });
  await h.view.current!.browseEarlier();
  expect(h.reads.of("readJournal")[4]?.options.cursor).toBe("j1.fresh");
});

test("a cold continuation cursor Factory refuses (400) recaptures the tail instead of failing the view", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 6 };
    reads.queue("readJournal", { journal_tip: 6, covered_through: 2, events: [publicEvent(2)], next_cursor: "c2.old" });
    reads.page = { journal_tip: 6, covered_through: 6, events: [publicEvent(2), publicEvent(6)] };
    const read = reads.readJournal.bind(reads);
    reads.readJournal = async (sessionId, options = {}) => {
      if (options.cursor === "c2.old") {
        await read(sessionId, options);
        throw rejectedCursor();
      }
      return read(sessionId, options);
    };
  } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([2, 6]);
  expect(h.view.current?.coveredThrough).toBe(6);
  expect(h.reads.of("readJournal").map((call) => call.options.cursor ?? `tail:${call.options.tail}`))
    .toEqual(["tail:256", "c2.old", "tail:256"]);
});

test("a gate that reads unavailable during failover is re-read until its session is resident again", async () => {
  const h = await mountFactoryView({
    props: { gateRefreshMs: 20 },
    setup: (_link, reads) => {
      setPage(reads, 4, [4]);
      reads.gates = gatePage(4, "unavailable");
    },
  });
  await liveReady(h, 4);
  expect(h.view.current?.gates?.gates[0]?.answerability).toBe("unavailable");

  // A successor Host attached; nothing is written to the journal for that.
  h.reads.gates = gatePage(4, "resident");
  await expect.poll(() => h.view.current?.gates?.gates[0]?.answerability).toBe("resident");

  // A resident page needs no re-read: the polling stops.
  const settled = h.reads.of("listGates").length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(h.reads.of("listGates").length).toBe(settled);
  expect(h.link.rpcCalls).toEqual([]);
});

test("a gate opened live, after the page was read, is attested by a re-read", async () => {
  const h = await mountFactoryView({
    props: { gateRefreshMs: 20 },
    setup: (_link, reads) => setPage(reads, 2, [1, 2]),
  });
  await liveReady(h, 2);
  expect(h.view.current?.gates?.gates).toEqual([]);
  const listed = h.reads.of("listGates").length;

  h.reads.gates = gatePage(3, "resident", "gate-live");
  h.link.open[0]!.deliver({
    type: "enduring_publication", tenant_id: TENANT, session_id: FSID,
    event_id: "event-3", journal_seq: 3, covered_through: 3,
    body: { type: "GateOpened", session_id: FSID, gate: { id: "gate-live", kind: "harness.permission" } },
  });
  await expect.poll(() => h.view.current?.gates?.gates[0]?.gate_id).toBe("gate-live");
  expect(h.view.current?.gates?.gates[0]?.answerability).toBe("resident");
  expect(h.reads.of("listGates").length).toBeGreaterThan(listed);
});

test("a slow gate re-read never replaces the newer page a repair already adopted", async () => {
  let parked: ((page: PublicGatePage) => void) | undefined;
  let refreshStarted = false;
  let hang = false;
  const h = await mountFactoryView({
    props: { gateRefreshMs: 20 },
    setup: (_link, reads) => {
      setPage(reads, 4, [4]);
      reads.gates = gatePage(4, "unavailable");
      const list = reads.listGates.bind(reads);
      let calls = 0;
      reads.listGates = async (sessionId, options = {}) => {
        calls += 1;
        // Call 1 is the cold read and call 2 the join's own; call 3 is the
        // first timed refresh, which is parked until the test releases it.
        if (calls === 3) {
          refreshStarted = true;
          return new Promise<PublicGatePage>((resolve) => { parked = resolve; });
        }
        // Once the newer page is in, later reads never answer, so a stale
        // adoption could not be healed by a following refresh.
        if (hang) return new Promise<PublicGatePage>(() => undefined);
        return list(sessionId, options);
      };
    },
  });
  await liveReady(h, 4);
  await expect.poll(() => refreshStarted).toBe(true);

  // A repair generation reads a NEWER page, which says resident.
  h.reads.gates = gatePage(4, "resident");
  h.link.open.at(-1)!.fail(new Error("transport interrupted"));
  await expect.poll(() => h.view.current?.gates?.gates[0]?.answerability).toBe("resident");
  hang = true;

  // The older, parked read now lands with the stale answer: it must lose.
  parked!(gatePage(4, "unavailable"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(h.view.current?.gates?.gates[0]?.answerability).toBe("resident");
});

test("a Host session whose /status tip reads 0 still renders its cold capture", async () => {
  const h = await mountFactoryView({ setup: (link, reads) => {
    link.holdConnect = true;
    reads.status = { ...reads.status, journal_tip: 0 };
    reads.page = { journal_tip: 5, covered_through: 5, events: [publicEvent(3), publicEvent(5)] };
  } });
  await expect.poll(() => h.view.current?.state).toBe("ready");
  expect(h.view.current?.events.map((event) => event.journal_seq)).toEqual([3, 5]);
  expect(h.view.current?.status?.journal_tip).toBe(5);
});

test("an unchanged transient gate is re-read with a doubling backoff, and unmount stops the timer", async () => {
  const h = await mountFactoryView({
    props: { gateRefreshMs: 40 },
    setup: (_link, reads) => {
      setPage(reads, 4, [4]);
      reads.gates = gatePage(4, "unavailable");
    },
  });
  await liveReady(h, 4);
  await expect.poll(() => h.reads.of("listGates").length, { timeout: 5000 }).toBeGreaterThanOrEqual(6);
  const times = h.reads.of("listGates").slice(2).map((call) => call.at);
  const gaps = times.slice(1).map((at, index) => at - times[index]!);
  // 40 → 80 → 160 → 320: each wait at least the one before, and the later
  // ones clearly longer than the base.
  expect(gaps.at(-1)!).toBeGreaterThan(gaps[0]! * 2.5);

  const before = h.reads.of("listGates").length;
  await h.unmount();
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(h.reads.of("listGates").length).toBe(before);
});
