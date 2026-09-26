/**
 * The six situations a control has to survive without turning one user action
 * into two logical commands, driven through the HOOKS rather than the stores.
 *
 * The layer matters. A store test can show that a retained envelope is
 * replayed; only a hook test can show that the envelope survives the component
 * that sent it, because the component is the thing that goes away. Every case
 * here is therefore mounted under a real `FactoryLinkProvider`, and every
 * command is counted at `FakeClientLink.rpc` — the single point every
 * `PendingCommand.submit()` passes through, whatever hook called it.
 */
import { useEffect } from "react";
import {
  createFactoryClient,
  GATE_APPROVAL_ACTIONS,
  publicGateKey,
  type FactoryClient,
  type FactoryClientOptions,
  type PublicGateBoard,
  type PublicGateEntry,
} from "@looprig/client";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { FakeClientLink } from "./testing/fake-link.js";
import { FactoryLinkProvider } from "./use-connection.js";
import { useFactoryComposer, type UseFactoryComposerResult } from "./use-composer.js";
import { useFactoryGate, type UseFactoryGateResult } from "./use-gate.js";
import { useFactoryInterrupt, type UseFactoryInterruptResult } from "./use-interrupt.js";
import type { CommandResult, PendingCommandView } from "./stores/pending.js";

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER_SID = "99999999-8888-4777-8666-555555555555";
const GATE = "3f4a5b6c-7d8e-4f90-a1b2-c3d4e5f60718";
/** A second gate on THIS session, so a per-gate claim is not a per-session one. */
const SECOND_GATE = "4a5b6c7d-8e9f-4012-b3c4-d5e6f7081920";
/** Open, on this session, and NOT answerable: no Host owns it right now. */
const COLD_GATE = "5b6c7d8e-9f01-4123-a4b5-c6d7e8f90213";
/** A gate on a DIFFERENT session, which the board carries beside this one's. */
const OTHER_GATE = "6c7d8e9f-0112-4234-b5c6-d7e8f9012345";

/**
 * Ordered by `(sessionId, openedJournalSeq, gateId)`, which is `publicGates`'
 * total order, so `gates[0]` for a session is its lowest-sequence gate.
 */
function gateEntry(
  sessionId: string,
  gateId: string,
  overrides: Partial<PublicGateEntry> = {},
): PublicGateEntry {
  return {
    sessionId,
    gateId,
    kind: "harness.permission",
    prompt: { title: "rm -rf", body: "", origin: "", controls: [] },
    openedEventId: `event-${gateId}`,
    openedJournalSeq: 4,
    deadline: "",
    answerability: "resident",
    ...overrides,
  };
}

function boardOf(...entries: PublicGateEntry[]): PublicGateBoard {
  return {
    entries: new Map(entries.map((e) => [publicGateKey(e.sessionId, e.gateId), e])),
  };
}

const RESIDENT = gateEntry(SID, GATE);
const SECOND = gateEntry(SID, SECOND_GATE, { openedJournalSeq: 5 });
const COLD = gateEntry(SID, COLD_GATE, { openedJournalSeq: 9, answerability: "suspended" });
const FOREIGN = gateEntry(OTHER_SID, OTHER_GATE);

/**
 * ONE board carrying every open gate Factory knows about, which is what a
 * `PublicGateBoard` is: it is keyed `publicGateKey(sessionId, gateId)` and
 * sorted by session first, so it is Factory-wide by construction. A fixture
 * that gave each probe a single-session board would remove the exact dimension
 * `useFactoryGate`'s session filter guards, and the filter would then be
 * untestable by construction.
 */
const FULL_BOARD = boardOf(RESIDENT, SECOND, COLD, FOREIGN);
/** The same board with `SECOND_GATE` resolved away — the input to a prune. */
const BOARD_WITHOUT_SECOND = boardOf(RESIDENT, COLD, FOREIGN);

interface Controls {
  readonly composer: UseFactoryComposerResult;
  readonly interrupt: UseFactoryInterruptResult;
  readonly gate: UseFactoryGateResult;
}

/**
 * `current` is CLEARED on unmount, and `mounts` counts commits of a fresh
 * probe. Without both, a remount test reads the controls the unmounted
 * component left behind and passes whether or not anything was inherited —
 * a negative assertion made after the state-destroying action it is about.
 */
type Sink = { current: Controls | null; mounts: number };

function sink(): Sink {
  return { current: null, mounts: 0 };
}

function Probe({
  sessionId,
  sink,
  board,
}: {
  sessionId: string;
  sink: Sink;
  board: PublicGateBoard;
}): null {
  const composer = useFactoryComposer(sessionId);
  const interrupt = useFactoryInterrupt(sessionId);
  const gate = useFactoryGate(sessionId, board);
  useEffect(() => {
    sink.current = { composer, interrupt, gate };
  });
  useEffect(() => {
    sink.mounts += 1;
    return () => {
      sink.current = null;
    };
  }, [sink]);
  return null;
}

// The board is passed down from the test rather than built in the component, so
// a re-render never hands the gate hook a fresh object: `publicGates` sorts into
// a new array on every call, and a board whose identity changed per render would
// rebuild the memo forever. Swapping it deliberately is how a page merge is
// modelled.

interface Harness {
  readonly link: FakeClientLink;
  readonly sink: Sink;
  readonly other: Sink;
  /**
   * Mounts or unmounts each probe independently, and optionally swaps the
   * board, without disturbing the provider above them.
   */
  show(mounted: boolean, second?: boolean, board?: PublicGateBoard): Promise<void>;
  unmount(): void;
}

async function mount(options: { second?: "other-session" | "same-session" } = {}): Promise<Harness> {
  const link = new FakeClientLink();
  let minted = 0;
  const create = (clientOptions: FactoryClientOptions): FactoryClient =>
    createFactoryClient({
      ...clientOptions,
      clientLinkFactory: () => link,
      idGenerator: () => {
        minted += 1;
        return `cmd-${minted}`;
      },
    });
  const probe = sink();
  const otherSink = sink();
  const tree = (mounted: boolean, second: boolean, board: PublicGateBoard): React.ReactElement => (
    <FactoryLinkProvider create={create}>
      {mounted ? <Probe sessionId={SID} sink={probe} board={board} /> : null}
      {second && options.second !== undefined ? (
        <Probe
          sessionId={options.second === "same-session" ? SID : OTHER_SID}
          sink={otherSink}
          board={board}
        />
      ) : null}
    </FactoryLinkProvider>
  );
  const rendered = await render(tree(true, true, FULL_BOARD));
  return {
    link,
    sink: probe,
    other: otherSink,
    show: async (mounted: boolean, second: boolean = mounted, board: PublicGateBoard = FULL_BOARD) => {
      await rendered.rerender(tree(mounted, second, board));
    },
    unmount: () => rendered.unmount(),
  };
}

function controls(from: Sink): Controls {
  const current = from.current;
  if (current === null) throw new Error("the probe has not committed");
  return current;
}

/**
 * The space this task's "for all" claim is derived from: every control that
 * sends a command, exercised through the hook a card or a button actually
 * calls. It is closed by construction — `FactoryCommands` declares five
 * methods, `session.create` belongs to the session list rather than to a
 * session's controls, and `session.restore` is the implicit restore U4.2
 * deleted, which leaves exactly these three.
 */
const CONTROLS = [
  {
    name: "composer",
    method: "session.input",
    fire: (c: Controls): Promise<CommandResult> => c.composer.submit("ship it"),
    again: (c: Controls): Promise<CommandResult> => c.composer.submit("ship it again"),
    retry: (c: Controls): Promise<CommandResult> => c.composer.retry(),
    cancel: (c: Controls): void => {
      c.composer.cancel();
    },
    pending: (c: Controls): PendingCommandView | null => c.composer.pending,
    error: (c: Controls): Error | null => c.composer.error,
  },
  {
    name: "interrupt",
    method: "session.interrupt",
    fire: (c: Controls): Promise<CommandResult> => c.interrupt.interrupt(),
    again: (c: Controls): Promise<CommandResult> => c.interrupt.interrupt(),
    retry: (c: Controls): Promise<CommandResult> => c.interrupt.retry(),
    cancel: (c: Controls): void => {
      c.interrupt.cancel();
    },
    pending: (c: Controls): PendingCommandView | null => c.interrupt.pending,
    error: (c: Controls): Error | null => c.interrupt.error,
  },
  {
    name: "gate",
    method: "gate.respond",
    fire: (c: Controls): Promise<CommandResult> =>
      c.gate.respond(c.gate.gates[0]!, GATE_APPROVAL_ACTIONS.approve),
    again: (c: Controls): Promise<CommandResult> =>
      c.gate.respond(c.gate.gates[0]!, GATE_APPROVAL_ACTIONS.deny),
    retry: (c: Controls): Promise<CommandResult> => c.gate.retry(GATE),
    cancel: (c: Controls): void => {
      c.gate.cancel(GATE);
    },
    pending: (c: Controls): PendingCommandView | null => c.gate.gates[0]?.pending ?? null,
    error: (c: Controls): Error | null => c.gate.gates[0]?.error ?? null,
  },
] as const;

test.each(CONTROLS)("$name: rapid repeat clicks are one logical command", async (control) => {
  const h = await mount();
  h.link.holdRpc = true;

  // Four clicks inside one frame — the keystroke-fast double Enter, and then
  // some. Fired from the SAME committed controls value, which is what a
  // double-click on a button that has not re-rendered yet does.
  const first = control.fire(controls(h.sink));
  const repeats = [
    control.again(controls(h.sink)),
    control.again(controls(h.sink)),
    control.fire(controls(h.sink)),
  ];

  // Read the count BEFORE awaiting: every send reaches `link.rpc`
  // synchronously, so a repeat that minted its own envelope shows up here as a
  // failed assertion rather than as a test that never finishes.
  expect(h.link.rpcCalls).toHaveLength(1);
  expect(h.link.rpcCalls[0]!.method).toBe(control.method);
  await expect(Promise.all(repeats)).resolves.toStrictEqual([
    { outcome: "refused", commandId: "cmd-1" },
    { outcome: "refused", commandId: "cmd-1" },
    { outcome: "refused", commandId: "cmd-1" },
  ]);
  h.link.rpcCalls[0]!.settle();
  await expect(first).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  h.unmount();
});

test.each(CONTROLS)("$name: a retry after a disconnect replays one identity", async (control) => {
  const h = await mount();
  h.link.holdRpc = true;
  const first = control.fire(controls(h.sink));

  h.link.drop();
  await expect(first).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });
  await expect.poll(() => control.pending(controls(h.sink))).toMatchObject({
    commandId: "cmd-1",
    sending: false,
  });
  expect(control.error(controls(h.sink))).toBeInstanceOf(Error);

  h.link.holdRpc = false;
  await expect(control.retry(controls(h.sink))).resolves.toMatchObject({
    outcome: "accepted",
    commandId: "cmd-1",
  });

  // Two attempts, one logical command: the second is byte-identical to the
  // first, which is the only shape a server can deduplicate.
  expect(h.link.rpcCalls.map((call) => call.commandId)).toStrictEqual(["cmd-1", "cmd-1"]);
  expect(h.link.rpcCalls[1]!.request).toStrictEqual(h.link.rpcCalls[0]!.request);
  h.unmount();
});

test.each(CONTROLS)("$name: a response lost after admission is not resent as a new command", async (control) => {
  const h = await mount();
  h.link.holdRpc = true;
  const first = control.fire(controls(h.sink));
  await expect.poll(() => h.link.rpcCalls).toHaveLength(1);

  // The command REACHED Factory — it is in `rpcCalls` — and then the reply was
  // lost. Admission may already have committed, so the one thing that must not
  // happen is a second identity for the same action.
  h.link.rpcCalls[0]!.fail(new Error("reply lost"));
  await expect(first).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });

  const refused = control.again(controls(h.sink));
  expect(h.link.rpcCalls).toHaveLength(1);
  await expect(refused).resolves.toStrictEqual({ outcome: "refused", commandId: "cmd-1" });
  h.unmount();
});

test.each(CONTROLS)("$name: cancel withdraws the action and the next one is new", async (control) => {
  const h = await mount();
  h.link.holdRpc = true;
  const first = control.fire(controls(h.sink));
  await expect.poll(() => control.pending(controls(h.sink))?.sending).toBe(true);

  control.cancel(controls(h.sink));
  h.link.rpcCalls[0]!.settle();

  await expect(first).resolves.toStrictEqual({ outcome: "cancelled", commandId: "cmd-1" });
  await expect.poll(() => control.pending(controls(h.sink))).toBeNull();
  h.link.holdRpc = false;
  await expect(control.fire(controls(h.sink))).resolves.toMatchObject({
    outcome: "accepted",
    commandId: "cmd-2",
  });
  h.unmount();
});

test.each(CONTROLS)("$name: a remount inherits the outstanding action", async (control) => {
  const h = await mount();
  h.link.holdRpc = true;
  const first = control.fire(controls(h.sink));
  await expect.poll(() => control.pending(controls(h.sink))?.sending).toBe(true);

  await h.show(false);
  expect(h.sink.current).toBeNull();
  await h.show(true);
  await expect.poll(() => h.sink.mounts).toBe(2);

  // The component that sent the command is gone. The command is not.
  await expect.poll(() => control.pending(controls(h.sink))).toMatchObject({
    commandId: "cmd-1",
    sending: true,
  });
  const refused = control.again(controls(h.sink));
  expect(h.link.rpcCalls).toHaveLength(1);
  await expect(refused).resolves.toStrictEqual({ outcome: "refused", commandId: "cmd-1" });
  h.link.rpcCalls[0]!.settle();
  await expect(first).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  h.unmount();
});

test.each(CONTROLS)("$name: a definitive typed rejection ends the action", async (control) => {
  const h = await mount();
  h.link.holdRpc = true;
  const first = control.fire(controls(h.sink));
  await expect.poll(() => h.link.rpcCalls).toHaveLength(1);

  h.link.rpcCalls[0]!.settle({
    status: "rejected",
    error: { code: "gate_resolved", message: "already answered", retryable: false },
  });

  const result = await first;
  expect(result).toMatchObject({ outcome: "rejected", commandId: "cmd-1" });
  // Typed off `code`, never off the message: the renderer branches on the class.
  expect(result.outcome === "rejected" && result.error.code).toBe("gate_resolved");
  await expect.poll(() => control.pending(controls(h.sink))).toBeNull();
  await expect.poll(() => control.error(controls(h.sink))?.message).toBe("already answered");
  // A rejection is durable, so the next action is a NEW logical command.
  h.link.holdRpc = false;
  await expect(control.fire(controls(h.sink))).resolves.toMatchObject({
    outcome: "accepted",
    commandId: "cmd-2",
  });
  h.unmount();
});

test("a retry after a remount replays the original identity rather than minting one", async () => {
  const h = await mount();
  h.link.holdRpc = true;
  const first = h.sink.current!.composer.submit("ship it");
  h.link.drop();
  await expect(first).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });

  await h.show(false);
  expect(h.sink.current).toBeNull();
  await h.show(true);
  await expect.poll(() => h.sink.mounts).toBe(2);
  h.link.holdRpc = false;

  // The draft is recovered from the retained envelope, not from component
  // state that the unmount destroyed.
  await expect.poll(() => controls(h.sink).composer.text).toBe("ship it");
  await expect(controls(h.sink).composer.retry()).resolves.toMatchObject({
    outcome: "accepted",
    commandId: "cmd-1",
  });
  expect(h.link.rpcCalls.map((call) => call.commandId)).toStrictEqual(["cmd-1", "cmd-1"]);
  h.unmount();
});

test("two unrelated sessions hold commands in flight at the same time", async () => {
  const h = await mount({ second: "other-session" });
  h.link.holdRpc = true;

  const first = controls(h.sink).composer.submit("one");
  const second = controls(h.other).composer.submit("two");

  // The positive control for "do not globally serialize unrelated sessions":
  // both are outstanding at once, under distinct identities, and neither
  // refused the other.
  expect(h.link.rpcCalls.map((call) => call.commandId)).toStrictEqual(["cmd-1", "cmd-2"]);
  expect(h.link.rpcCalls.map((call) => (call.request as { session_id: string }).session_id))
    .toStrictEqual([SID, OTHER_SID]);
  await expect.poll(() => controls(h.sink).composer.pending?.sending).toBe(true);
  await expect.poll(() => controls(h.other).composer.pending?.sending).toBe(true);
  h.link.rpcCalls[0]!.settle();
  h.link.rpcCalls[1]!.settle();
  await expect(first).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  await expect(second).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-2" });
  h.unmount();
});

test("a session's three controls do not contend with each other either", async () => {
  const h = await mount();
  h.link.holdRpc = true;

  const composing = controls(h.sink).composer.submit("one");
  const interrupting = controls(h.sink).interrupt.interrupt();
  const answering = controls(h.sink).gate.respond(
    controls(h.sink).gate.gates[0]!,
    GATE_APPROVAL_ACTIONS.deny,
  );

  expect(h.link.rpcCalls.map((call) => call.method)).toStrictEqual([
    "session.input",
    "session.interrupt",
    "gate.respond",
  ]);
  for (const call of h.link.rpcCalls) call.settle();
  await expect(composing).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  await expect(interrupting).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-2" });
  await expect(answering).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-3" });
  h.unmount();
});

test("the gate projection reports answerability and its own in-flight state", async () => {
  const h = await mount();
  h.link.holdRpc = true;

  // This session's gates only, in the board's stable public order — the foreign
  // session's gate is on the same board and must not be here.
  expect(controls(h.sink).gate.gates.map((gate) => gate.gateId)).toStrictEqual([
    GATE,
    SECOND_GATE,
    COLD_GATE,
  ]);
  expect(controls(h.sink).gate.gates[0]!.answerable).toBe(true);
  expect(controls(h.sink).gate.gates[0]!.responding).toBe(false);

  const answering = controls(h.sink).gate.respond(
    controls(h.sink).gate.gates[0]!,
    GATE_APPROVAL_ACTIONS.approve,
  );

  await expect.poll(() => controls(h.sink).gate.gates[0]!.responding).toBe(true);
  h.link.rpcCalls[0]!.settle();
  await answering;
  await expect.poll(() => controls(h.sink).gate.gates[0]!.responding).toBe(false);
  h.unmount();
});

test("mounting the controls sends no command at all", async () => {
  const h = await mount({ second: "other-session" });

  await h.show(false);
  await h.show(true);
  await expect.poll(() => h.sink.mounts).toBe(2);

  // The U4.2 property, re-read at the control plane: opening a view is a read.
  // Nothing here places, restores or admits a session on the way in.
  expect(h.link.rpcCalls).toStrictEqual([]);
  h.unmount();
});

test("a settled failure dies with the last unmount; an outstanding action's does not", async () => {
  const h = await mount();
  h.link.holdRpc = true;
  const rejected = controls(h.sink).composer.submit("one");
  await expect.poll(() => h.link.rpcCalls).toHaveLength(1);
  h.link.rpcCalls[0]!.settle({ status: "rejected" });
  await rejected;
  await expect.poll(() => controls(h.sink).composer.error).not.toBeNull();

  await h.show(false);
  await h.show(true);
  await expect.poll(() => h.sink.mounts).toBe(2);

  // Nothing was retained, so the session's scope was discarded with the last
  // watcher: the error was presentation state for a command that is over, and
  // a route the user comes back to should not still be showing it. This is the
  // reader for the disposal that keeps the scope map from growing by one entry
  // per session a tab ever opened.
  expect(controls(h.sink).composer.error).toBeNull();

  // The other half: an OUTSTANDING action's failure survives the same unmount,
  // because the scope cannot be discarded while it holds an envelope.
  const lost = controls(h.sink).composer.submit("two");
  h.link.drop();
  await expect(lost).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-2" });
  await h.show(false);
  await h.show(true);
  await expect.poll(() => h.sink.mounts).toBe(3);
  expect(controls(h.sink).composer.error).toBeInstanceOf(Error);
  expect(controls(h.sink).composer.pending).toMatchObject({ commandId: "cmd-2" });
  h.unmount();
});

test("a sibling view unmounting leaves the surviving one still watching the session", async () => {
  const h = await mount({ second: "same-session" });
  await expect.poll(() => h.other.mounts).toBe(1);

  // The second view of this session goes away while nothing is retained. That
  // is the moment the scope becomes discardable — and it must NOT be discarded,
  // because a view is still watching it. A store left holding a listener on a
  // discarded scope publishes nothing ever again: its snapshot freezes while
  // its commands keep going out.
  await h.show(true, false);
  expect(h.other.current).toBeNull();

  h.link.holdRpc = true;
  const submitted = controls(h.sink).composer.submit("still here");

  await expect.poll(() => controls(h.sink).composer.pending?.sending).toBe(true);
  h.link.rpcCalls[0]!.settle();
  await expect(submitted).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  await expect.poll(() => controls(h.sink).composer.pending).toBeNull();
  h.unmount();
});

test("a reply to a cancelled action never lands on the action that replaced it", async () => {
  const h = await mount();
  h.link.holdRpc = true;
  const cancelled = controls(h.sink).composer.submit("one");
  controls(h.sink).composer.cancel();
  const replacement = controls(h.sink).composer.submit("two");
  expect(h.link.rpcCalls.map((call) => call.commandId)).toStrictEqual(["cmd-1", "cmd-2"]);

  // The withdrawn command answers LAST. Nothing about it may be attributed to
  // the command the user sent in its place — not its outcome, not its release.
  h.link.rpcCalls[0]!.settle();

  await expect(cancelled).resolves.toStrictEqual({ outcome: "cancelled", commandId: "cmd-1" });
  await expect.poll(() => controls(h.sink).composer.pending).toMatchObject({
    commandId: "cmd-2",
    sending: true,
  });
  h.link.rpcCalls[1]!.settle();
  await expect(replacement).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-2" });
  h.unmount();
});

test("a gate awaiting a retry is retained but NOT responding", async () => {
  const h = await mount();
  h.link.holdRpc = true;
  const answering = controls(h.sink).gate.respond(
    controls(h.sink).gate.gates[0]!,
    GATE_APPROVAL_ACTIONS.approve,
  );
  await expect.poll(() => controls(h.sink).gate.gates[0]!.responding).toBe(true);

  h.link.drop();
  await expect(answering).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });

  // The one state in which `responding` and `pending !== null` disagree, and
  // the state this whole feature exists to render: the answer is still the
  // user's, and the card must show a Retry button rather than a spinner.
  await expect.poll(() => controls(h.sink).gate.gates[0]!.pending).toMatchObject({
    commandId: "cmd-1",
    sending: false,
  });
  expect(controls(h.sink).gate.gates[0]!.responding).toBe(false);
  expect(controls(h.sink).gate.gates[0]!.error).toBeInstanceOf(Error);

  h.link.holdRpc = false;
  await expect(controls(h.sink).gate.retry(GATE)).resolves.toMatchObject({
    outcome: "accepted",
    commandId: "cmd-1",
  });
  await expect.poll(() => controls(h.sink).gate.gates[0]!.pending).toBeNull();
  expect(controls(h.sink).gate.gates[0]!.responding).toBe(false);
  h.unmount();
});

test("a control whose envelope cannot be built reports it instead of rejecting", async () => {
  const h = await mount();
  const seen: string[] = [];
  const capture = (event: PromiseRejectionEvent): void => {
    // Claimed, so a deliberate rejection here is not reported as a failure of
    // the run itself.
    event.preventDefault();
    seen.push((event.reason as Error).message);
  };
  window.addEventListener("unhandledrejection", capture);
  try {
    // A gate whose id the board served empty. `respondResidentGate` validates it
    // while BUILDING the envelope, so the throw happens on the caller's stack
    // inside an `onClick`.
    const malformed = { ...controls(h.sink).gate.gates[0]!, gateId: "" };

    // FLOATED, not awaited: awaiting attaches a handler, and a promise with a
    // handler is never an *unhandled* rejection however badly it rejects — the
    // capture would then be green for a reason that has nothing to do with the
    // guard.
    const floated = controls(h.sink).gate.respond(malformed, GATE_APPROVAL_ACTIONS.deny);
    const control = Promise.reject(new Error("control: a genuinely floating rejection"));

    // A rejection is reported a macrotask later, not on the next microtask, so
    // one tick is not long enough for this capture to fire at all. The control
    // group is what proves this window is real rather than assumed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(seen).toStrictEqual(["control: a genuinely floating rejection"]);

    await expect(floated).resolves.toStrictEqual({ outcome: "none" });
    expect(h.link.rpcCalls).toStrictEqual([]);
    control.catch(() => {});
  } finally {
    window.removeEventListener("unhandledrejection", capture);
    h.unmount();
  }
});

test("each session's gates are its own, off one Factory-wide board", async () => {
  const h = await mount({ second: "other-session" });

  // A `PublicGateBoard` is keyed `(sessionId, gateId)` and sorted by session
  // first: it carries every session's open gates. Without the filter, the other
  // session's gate renders in this list, and answering it would send
  // `respondResidentGate(thisSession, { gateId: <the other session's gate> })`
  // and key the slot in the wrong session's scope.
  expect(controls(h.sink).gate.gates.map((gate) => gate.gateId)).toStrictEqual([
    GATE,
    SECOND_GATE,
    COLD_GATE,
  ]);
  expect(controls(h.other).gate.gates.map((gate) => gate.gateId)).toStrictEqual([OTHER_GATE]);
  expect(controls(h.sink).gate.gates.every((gate) => gate.sessionId === SID)).toBe(true);
  expect(controls(h.other).gate.gates.every((gate) => gate.sessionId === OTHER_SID)).toBe(true);
  h.unmount();
});

test("a gate whose owner is not up is projected unanswerable", async () => {
  const h = await mount();

  const byId = new Map(controls(h.sink).gate.gates.map((gate) => [gate.gateId, gate]));

  // The store refuses to send for one of these; this is the projection that
  // decides whether the card offers the buttons at all. A card that renders
  // Approve for a gate no Host owns is a button that does nothing.
  expect(byId.get(GATE)!.answerable).toBe(true);
  expect(byId.get(SECOND_GATE)!.answerable).toBe(true);
  expect(byId.get(COLD_GATE)!.answerable).toBe(false);
  await expect(controls(h.sink).gate.respond(byId.get(COLD_GATE)!, GATE_APPROVAL_ACTIONS.approve))
    .resolves.toStrictEqual({ outcome: "none" });
  expect(h.link.rpcCalls).toStrictEqual([]);
  h.unmount();
});

test("two views of one session see each other's answers", async () => {
  const h = await mount({ second: "same-session" });
  await expect.poll(() => h.other.mounts).toBe(1);
  h.link.holdRpc = true;

  // The sidebar answers. The main panel is a DIFFERENT store instance over the
  // same session scope, and this is the whole reason `attach` registers a
  // listener: without the fan-out the second view keeps offering Approve, and
  // the click comes back `"refused"` while the card looks untouched.
  const answering = controls(h.sink).gate.respond(
    controls(h.sink).gate.gates[0]!,
    GATE_APPROVAL_ACTIONS.approve,
  );

  await expect.poll(() => controls(h.other).gate.gates[0]!.responding).toBe(true);
  await expect.poll(() => controls(h.other).gate.gates[0]!.pending).toMatchObject({
    commandId: "cmd-1",
    sending: true,
  });
  h.link.rpcCalls[0]!.settle();
  await expect(answering).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  await expect.poll(() => controls(h.other).gate.gates[0]!.pending).toBeNull();
  await expect.poll(() => controls(h.other).gate.gates[0]!.responding).toBe(false);
  h.unmount();
});

test.each(CONTROLS)("$name: two views of one session see each other's action", async (control) => {
  const h = await mount({ second: "same-session" });
  await expect.poll(() => h.other.mounts).toBe(1);
  h.link.holdRpc = true;

  const acting = control.fire(controls(h.sink));

  // A different store instance over the same session scope. Without the
  // fan-out the second view never learns, keeps offering the control, and the
  // click comes back "refused" while the card looks untouched.
  await expect.poll(() => control.pending(controls(h.other))).toMatchObject({
    commandId: "cmd-1",
    sending: true,
  });
  const refused = control.again(controls(h.other));
  expect(h.link.rpcCalls).toHaveLength(1);
  await expect(refused).resolves.toStrictEqual({ outcome: "refused", commandId: "cmd-1" });

  h.link.rpcCalls[0]!.settle();
  await expect(acting).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  await expect.poll(() => control.pending(controls(h.other))).toBeNull();
  h.unmount();
});

test("the second view sees the composer's retained draft, not just its identity", async () => {
  const h = await mount({ second: "same-session" });
  await expect.poll(() => h.other.mounts).toBe(1);
  h.link.holdRpc = true;

  const submitted = controls(h.sink).composer.submit("from the main panel");

  await expect.poll(() => controls(h.other).composer.text).toBe("from the main panel");
  h.link.rpcCalls[0]!.settle();
  await submitted;
  await expect.poll(() => controls(h.other).composer.text).toBe("");
  h.unmount();
});

test("a gate that leaves the board takes its failure with it", async () => {
  const h = await mount();
  h.link.holdRpc = true;
  const gates = controls(h.sink).gate.gates;
  const second = gates.find((gate) => gate.gateId === SECOND_GATE)!;
  const answering = controls(h.sink).gate.respond(second, GATE_APPROVAL_ACTIONS.deny);
  h.link.drop();
  await expect(answering).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });
  await expect.poll(
    () => controls(h.sink).gate.gates.find((gate) => gate.gateId === SECOND_GATE)!.error,
  ).toBeInstanceOf(Error);

  // The gate resolves and a page merge rebuilds the board without it; then the
  // in-flight page race puts it back. Without the hook's prune effect the stale
  // failure is still keyed in the session scope and reappears on the restored
  // card — and every gate error a tab ever saw accumulates for its lifetime.
  await h.show(true, true, BOARD_WITHOUT_SECOND);
  await expect
    .poll(() => controls(h.sink).gate.gates.map((gate) => gate.gateId))
    .toStrictEqual([GATE, COLD_GATE]);
  await h.show(true, true, FULL_BOARD);

  await expect
    .poll(() => controls(h.sink).gate.gates.map((gate) => gate.gateId))
    .toStrictEqual([GATE, SECOND_GATE, COLD_GATE]);
  expect(controls(h.sink).gate.gates.find((gate) => gate.gateId === SECOND_GATE)!.error).toBeNull();
  h.unmount();
});

test.each(CONTROLS)("$name: a retry is refused while its own attempt is in flight", async (control) => {
  const h = await mount();
  h.link.holdRpc = true;
  const lost = control.fire(controls(h.sink));
  h.link.drop();
  await expect(lost).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });

  const retrying = control.retry(controls(h.sink));
  const repeat = control.retry(controls(h.sink));
  expect(h.link.rpcCalls).toHaveLength(2);
  await expect(repeat).resolves.toStrictEqual({ outcome: "refused", commandId: "cmd-1" });

  h.link.rpcCalls[1]!.settle();
  await expect(retrying).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  h.unmount();
});
