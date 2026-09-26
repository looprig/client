import {
  CommandIdentityError,
  CoreCommandRejectedError,
  CoreInvalidRequestError,
  CoreSessionNotFoundError,
  createFactoryCommands,
} from "@looprig/client";
import type { FactoryCommands } from "@looprig/client";
import { expect, test } from "vitest";
import { FakeClientLink } from "../testing/fake-link.js";
import {
  COMPOSER_COMMAND_KEY,
  FactoryComposerStore,
  retainedComposerText,
} from "./composer.js";
import type { PendingCommandView } from "./pending.js";

const SID = "6f1d9f4e-6c2a-4c3a-9f2e-1a2b3c4d5e6f";

// --- FactoryComposerStore: one identity per action ----------------------------

function plane(): { link: FakeClientLink; commands: FactoryCommands } {
  const link = new FakeClientLink();
  let minted = 0;
  const commands = createFactoryCommands({
    link,
    idGenerator: () => {
      minted += 1;
      return `cmd-${minted}`;
    },
  });
  return { link, commands };
}

function composer(): { link: FakeClientLink; store: FactoryComposerStore } {
  const { link, commands } = plane();
  return { link, store: new FactoryComposerStore(commands, SID) };
}

function retained(store: FactoryComposerStore): PendingCommandView | null {
  return store.snapshot().pending.get(COMPOSER_COMMAND_KEY) ?? null;
}

test("an accepted submit sends one envelope and retains nothing", async () => {
  const { link, store } = composer();

  const result = await store.submit("  ship it  ");

  expect(result).toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  expect(link.rpcCalls.map((call) => call.method)).toStrictEqual(["session.input"]);
  // Trimmed before it was SENT, with the Go-cased content.TextBlock field.
  expect(link.rpcCalls[0]!.request).toStrictEqual({
    version: 1,
    command_id: "cmd-1",
    session_id: SID,
    blocks: [{ type: "text", Text: "ship it" }],
  });
  expect(retained(store)).toBeNull();
});

test("rapid repeat submits are one logical command, however many clicks land", async () => {
  const { link, store } = composer();
  link.holdRpc = true;

  const inFlight = store.submit("one");
  const repeats = [store.submit("one"), store.submit("one"), store.submit("two")];

  // Read the count BEFORE awaiting: `send` reaches `link.rpc` synchronously, so
  // a repeat that minted its own envelope is visible here — and a store that
  // sent four held commands would never settle the await below, turning an
  // assertion kill into a hang, which is not the same evidence.
  expect(link.rpcCalls).toHaveLength(1);
  // Every repeat names the FIRST command rather than minting its own.
  await expect(Promise.all(repeats)).resolves.toStrictEqual([
    { outcome: "refused", commandId: "cmd-1" },
    { outcome: "refused", commandId: "cmd-1" },
    { outcome: "refused", commandId: "cmd-1" },
  ]);
  expect(link.rpcCalls).toHaveLength(1);
  link.rpcCalls[0]!.settle();
  await expect(inFlight).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
});

test("a reply lost to a disconnect retains the envelope for a retry", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const first = store.submit("one");
  await expect.poll(() => retained(store)?.sending).toBe(true);

  link.drop();

  await expect(first).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });
  expect(retained(store)).toMatchObject({ commandId: "cmd-1", sending: false });
  expect(store.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeInstanceOf(Error);
});

test("a retry replays the identical envelope rather than minting a second command", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const first = store.submit("one");
  link.drop();
  await first;
  link.holdRpc = false;

  await expect(store.retry()).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });

  expect(link.rpcCalls).toHaveLength(2);
  // Byte-identical, not merely same-id: a replay that re-serialised the blocks
  // could send a different turn under an identity that promises it did not.
  expect(link.rpcCalls[1]!.request).toStrictEqual(link.rpcCalls[0]!.request);
  expect(retained(store)).toBeNull();
});

test("the retained text is what a retry will replay, not what was typed after it", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const first = store.submit("one");
  link.drop();
  await first;

  const refused = store.submit("two");
  expect(link.rpcCalls).toHaveLength(1);
  await expect(refused).resolves.toStrictEqual({ outcome: "refused", commandId: "cmd-1" });

  expect(retainedComposerText(retained(store)!.request)).toBe("one");
});

test("a rejected status is definitive, typed, and releases the envelope", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const first = store.submit("one");
  await expect.poll(() => link.outstanding).toHaveLength(1);

  link.rpcCalls[0]!.settle({
    status: "rejected",
    error: { code: "session_not_found", message: "gone", retryable: false },
  });

  const result = await first;
  expect(result.outcome).toBe("rejected");
  expect(store.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeInstanceOf(CoreSessionNotFoundError);
  expect(retained(store)).toBeNull();
});

test("a rejected status with no detail is still typed, from Core's own vocabulary", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const first = store.submit("one");
  await expect.poll(() => link.outstanding).toHaveLength(1);

  link.rpcCalls[0]!.settle({ status: "rejected" });

  await expect(first).resolves.toMatchObject({ outcome: "rejected" });
  expect(store.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeInstanceOf(CoreCommandRejectedError);
});

test("a rejection raised by the link itself is equally definitive", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const first = store.submit("one");
  await expect.poll(() => link.outstanding).toHaveLength(1);

  link.rpcCalls[0]!.fail(
    new CoreInvalidRequestError({ error: { code: "invalid_request", retryable: false } }),
  );

  await expect(first).resolves.toMatchObject({ outcome: "rejected", commandId: "cmd-1" });
  expect(retained(store)).toBeNull();
});

test.each(["accepted", "applied"] as const)("%s is durable and releases the envelope", async (status) => {
  const { link, store } = composer();
  link.holdRpc = true;
  const first = store.submit("one");
  await expect.poll(() => link.outstanding).toHaveLength(1);

  link.rpcCalls[0]!.settle({ status, accepted_order: 3 });

  const result = await first;
  expect(result).toMatchObject({ outcome: "accepted" });
  // The durable record itself is carried through, not just the verdict: a
  // caller that wants the admitted order has it without a second read.
  expect(result.outcome === "accepted" && result.status).toStrictEqual({
    command_id: "cmd-1",
    status,
    accepted_order: 3,
  });
  expect(retained(store)).toBeNull();
});

test("a pending status is not durable and keeps the envelope retryable", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const first = store.submit("one");
  await expect.poll(() => link.outstanding).toHaveLength(1);

  link.rpcCalls[0]!.settle({ status: "pending" });

  const result = await first;
  expect(result).toMatchObject({ outcome: "pending", commandId: "cmd-1" });
  expect(result.outcome === "pending" && result.status.status).toBe("pending");
  expect(retained(store)).toMatchObject({ commandId: "cmd-1", sending: false });
  expect(store.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeUndefined();
});

test("cancel withdraws the envelope and discards the reply that lands after it", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const first = store.submit("one");
  await expect.poll(() => retained(store)?.sending).toBe(true);

  store.cancel();
  link.rpcCalls[0]!.settle();

  await expect(first).resolves.toStrictEqual({ outcome: "cancelled", commandId: "cmd-1" });
  expect(retained(store)).toBeNull();
  // The next action is a NEW logical command: the user withdrew the first one.
  link.holdRpc = false;
  await expect(store.submit("two")).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-2" });
});

test("an empty draft and a retry with nothing retained both send nothing", async () => {
  const { link, store } = composer();

  await expect(store.submit("   ")).resolves.toStrictEqual({ outcome: "none" });
  await expect(store.retry()).resolves.toStrictEqual({ outcome: "none" });

  expect(link.rpcCalls).toStrictEqual([]);
});

test("clearError forgets a settled failure without publishing twice", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const first = store.submit("one");
  await expect.poll(() => link.outstanding).toHaveLength(1);
  link.rpcCalls[0]!.settle({ status: "rejected" });
  await first;
  let notifies = 0;
  store.subscribe(() => {
    notifies += 1;
  });

  store.clearError();
  store.clearError();

  expect(store.snapshot().errors.size).toBe(0);
  expect(notifies).toBe(1);
});

test("two sessions on one command plane hold commands in flight at the same time", async () => {
  const { link, commands } = plane();
  link.holdRpc = true;
  const one = new FactoryComposerStore(commands, "session-one");
  const two = new FactoryComposerStore(commands, "session-two");

  const first = one.submit("one");
  const second = two.submit("two");

  // The negative in the runbook — "do not globally serialize unrelated
  // sessions" — read as a positive: BOTH are outstanding simultaneously, with
  // distinct identities, and neither refused the other.
  expect(link.rpcCalls.map((call) => call.commandId)).toStrictEqual(["cmd-1", "cmd-2"]);
  expect(retained(one)?.sending).toBe(true);
  expect(retained(two)?.sending).toBe(true);
  link.rpcCalls[0]!.settle();
  link.rpcCalls[1]!.settle();
  await expect(first).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  await expect(second).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-2" });
});

test("a second store on the same session adopts the retained envelope and refuses to duplicate it", async () => {
  const { link, commands } = plane();
  link.holdRpc = true;
  const first = new FactoryComposerStore(commands, SID);
  const started = first.submit("one");
  const detach = first.attach();

  // What a remount does: a new store over the same command plane and session.
  const second = new FactoryComposerStore(commands, SID);

  expect(retained(second)).toMatchObject({ commandId: "cmd-1", sending: true });
  const refused = second.submit("one");
  expect(link.rpcCalls).toHaveLength(1);
  await expect(refused).resolves.toStrictEqual({ outcome: "refused", commandId: "cmd-1" });
  link.rpcCalls[0]!.settle();
  await started;
  detach();
});

test("one transition publishes once, attached or not", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const detach = store.attach();
  let notifies = 0;
  store.subscribe(() => {
    notifies += 1;
  });

  const sent = store.submit("one");
  expect(notifies).toBe(1);
  link.rpcCalls[0]!.settle();
  await sent;

  // An ATTACHED store is reached through the scope's listener list; syncing
  // itself as well would publish a second, equal snapshot for the same
  // transition and notify every subscriber twice.
  expect(notifies).toBe(2);
  detach();
});

test("an envelope Core's identity rules refuse is reported, never thrown", async () => {
  const { link, commands } = plane();
  // The session id is a caller-supplied prop, and `createFactoryCommands`
  // validates it while BUILDING the envelope — before any transport is touched.
  const store = new FactoryComposerStore(commands, "");

  // `submit` promises it never rejects. From an `onClick` a rejected promise is
  // an unhandled rejection, not an error state a card can render.
  await expect(store.submit("hi")).resolves.toStrictEqual({ outcome: "none" });

  expect(store.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeInstanceOf(CommandIdentityError);
  expect(link.rpcCalls).toStrictEqual([]);
  // Nothing was retained, so the control is not wedged: a later action on a
  // usable session mints normally.
  expect(store.snapshot().pending.size).toBe(0);
});

test("a retry is refused while its own attempt is still in flight", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const lost = store.submit("one");
  link.drop();
  await expect(lost).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });

  // Retry is a BUTTON. The rapid-double-click class this task closes applies to
  // it exactly as it applies to send, and it is the more dangerous of the two:
  // two attempts on one slot mean the first to land releases it and the second
  // resolves the user's own retry as "cancelled".
  const first = store.retry();
  const second = store.retry();
  expect(link.rpcCalls).toHaveLength(2);
  await expect(second).resolves.toStrictEqual({ outcome: "refused", commandId: "cmd-1" });

  link.rpcCalls[1]!.settle();
  await expect(first).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
});

test("a retry clears the stale failure it is retrying, and success leaves none", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const lost = store.submit("one");
  link.drop();
  await lost;
  expect(store.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeInstanceOf(Error);

  const retrying = store.retry();

  // Cleared as the attempt STARTS, not when it ends: nothing clears an error on
  // a success path, so a stale one left here would survive an accepted retry
  // forever, beside a control with nothing pending.
  expect(store.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeUndefined();
  link.rpcCalls[1]!.settle();
  await expect(retrying).resolves.toMatchObject({ outcome: "accepted" });
  expect(store.snapshot().errors.size).toBe(0);
});

test("a new submit clears the previous submit's rejection", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const rejected = store.submit("one");
  await expect.poll(() => link.outstanding).toHaveLength(1);
  link.rpcCalls[0]!.settle({ status: "rejected" });
  await rejected;
  expect(store.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeInstanceOf(CoreCommandRejectedError);

  const next = store.submit("two");

  // Otherwise the failed command's notice renders beside the one now in flight.
  expect(store.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeUndefined();
  link.rpcCalls[1]!.settle();
  await expect(next).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-2" });
});

test("a published snapshot never changes underneath the caller holding it", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const lost = store.submit("one");
  link.drop();
  await lost;
  const held = store.snapshot();
  expect(held.errors.size).toBe(1);

  store.clearError();

  // `Publisher`'s contract is that a snapshot is stable between publishes. The
  // scope's own error map is mutated in place by every later transition, so the
  // snapshot must hold a copy of it and not an alias.
  expect(held.errors.size).toBe(1);
  expect(store.snapshot().errors.size).toBe(0);
});

test("each view of a retained envelope gets its own request, not a shared one", async () => {
  const { link, commands } = plane();
  link.holdRpc = true;
  const one = new FactoryComposerStore(commands, SID);
  const sending = one.submit("one");
  const two = new FactoryComposerStore(commands, SID);

  const view = retained(one)!;
  // Per READ, not per view: `request` is a getter, so two readers of the SAME
  // view cannot share an object either.
  expect(view.request).not.toBe(view.request);
  (view.request as unknown as { blocks: Record<string, unknown>[] }).blocks[0]!["Text"] = "tampered";

  // Nothing freezes the parsed request, so a shared parse would let one card's
  // careless write reach every other view of the same slot — and the retained
  // draft is exactly what a Retry button renders.
  expect(retainedComposerText(retained(two)!.request)).toBe("one");
  link.rpcCalls[0]!.settle();
  await sending;
});

test("cancel takes the failure with the envelope", async () => {
  const { link, store } = composer();
  link.holdRpc = true;
  const lost = store.submit("one");
  link.drop();
  await lost;
  expect(store.snapshot().errors.get(COMPOSER_COMMAND_KEY)).toBeInstanceOf(Error);

  store.cancel();

  // Otherwise the notice sits beside a control with nothing pending, and only
  // `clearError` removes it — which `FactoryGateStore` does not even expose.
  expect(store.snapshot().errors.size).toBe(0);
  expect(store.snapshot().pending.size).toBe(0);
});

test("cancel with nothing to withdraw publishes nothing", async () => {
  const { link, store } = composer();
  let notifies = 0;
  store.subscribe(() => {
    notifies += 1;
  });
  const before = store.snapshot();

  store.cancel();
  store.cancel();

  // A cancel that changed nothing must not wake React, for the same reason
  // `prune` and `clearError` must not: these run from user handlers and from
  // effects that fire on every projection.
  expect(notifies).toBe(0);
  expect(store.snapshot()).toBe(before);
  expect(link.rpcCalls).toStrictEqual([]);
});

test("a retry is not blocked by another session's command in flight", async () => {
  const { link, commands } = plane();
  link.holdRpc = true;
  const here = new FactoryComposerStore(commands, "session-one");
  const elsewhere = new FactoryComposerStore(commands, "session-two");
  const lost = here.submit("one");
  link.drop();
  await expect(lost).resolves.toMatchObject({ outcome: "unknown", commandId: "cmd-1" });
  const blocking = elsewhere.submit("two");
  expect(link.rpcCalls).toHaveLength(2);

  // `replay`'s refusal is about THIS slot's own attempt. A refusal keyed any
  // wider would let one slow session freeze another's retry button, which is
  // the serialization the send path is already held to.
  const retrying = here.retry();

  expect(link.rpcCalls).toHaveLength(3);
  link.rpcCalls[2]!.settle();
  await expect(retrying).resolves.toMatchObject({ outcome: "accepted", commandId: "cmd-1" });
  link.rpcCalls[1]!.settle();
  await blocking;
});

test("attaching adopts what landed while the store was not watching", async () => {
  const { link, commands } = plane();
  link.holdRpc = true;
  const watching = new FactoryComposerStore(commands, SID);
  const detach = watching.attach();
  // Built during a render that has not committed yet: its effect has not run,
  // so it holds no listener and the scope cannot reach it.
  const arriving = new FactoryComposerStore(commands, SID);
  expect(arriving.snapshot().pending.size).toBe(0);

  const sending = watching.submit("one");
  expect(arriving.snapshot().pending.size).toBe(0);
  const detachArriving = arriving.attach();

  // Constructing is not enough: a change that lands between the render and the
  // effect would otherwise leave the view stale until the NEXT transition, and
  // a control that does not know an envelope is retained will offer to send a
  // second one.
  expect(arriving.snapshot().pending.get(COMPOSER_COMMAND_KEY)).toMatchObject({
    commandId: "cmd-1",
    sending: true,
  });
  link.rpcCalls[0]!.settle();
  await sending;
  detach();
  detachArriving();
});

test("a view that attaches from inside a notify is not synced for that same change", async () => {
  const { link, commands } = plane();
  link.holdRpc = true;
  const watching = new FactoryComposerStore(commands, SID);
  const detach = watching.attach();
  let latecomer: FactoryComposerStore | null = null;
  let detachLatecomer = (): void => {};
  let latecomerNotifies = 0;
  watching.subscribe(() => {
    if (latecomer !== null) return;
    latecomer = new FactoryComposerStore(commands, SID);
    detachLatecomer = latecomer.attach();
    latecomer.subscribe(() => {
      latecomerNotifies += 1;
    });
  });

  const sending = watching.submit("one");

  // The scope's listener set is copied before it is iterated, for the reason
  // `Publisher.publish` gives and `publisher.test.ts` pins: a Set added to
  // during iteration yields the new entry in the SAME loop, so a view attaching
  // from inside a notify would be synced re-entrantly for a change that
  // predates it.
  expect(latecomerNotifies).toBe(0);
  link.rpcCalls[0]!.settle();
  await sending;
  expect(latecomerNotifies).toBe(1);
  detach();
  detachLatecomer();
});
