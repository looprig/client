import { useCallback, useEffect, useMemo } from "react";
import {
  acceptsResidentResponse,
  GATE_APPROVAL_ACTIONS,
  isAnswerableGate,
  publicGates,
  type Gate,
  type GateApprovalAction,
  type LooprigTransport,
  type PublicGateBoard,
  type PublicGateEntry,
  type SessionViewStore,
} from "@looprig/client";
import { FactoryGateStore, gateCommandKey, GateResponseStore } from "./stores/gate.js";
import type { CommandResult, PendingCommandView } from "./stores/pending.js";
import { useFactoryClient } from "./use-connection.js";
import { useStore, useStoreSelector } from "./use-store.js";

export interface OpenGate extends Gate {
  /**
   * False for `harness.ask_user` / `harness.form` / `harness.open_url`, and for
   * any kind a later harness adds: wui implements permission gates only, and
   * everything else renders "answer this in the TUI". Delegated to
   * `@looprig/client`'s `isAnswerableGate` so the rule lives in one place.
   */
  readonly answerable: boolean;
  readonly responding: boolean;
  /** Another client answered first (`gate_action_invalid`). */
  readonly alreadyAnswered: boolean;
  readonly error: Error | undefined;
}

export interface UseGateResult {
  /**
   * Open, unanswered gates in arrival order. Concurrent gates from parallel
   * loops all appear: they come from the fold's gate MAP, keyed by gate id,
   * not from `GET /status`'s single last-writer-wins `waiting_gate_id` slot.
   */
  readonly gates: readonly OpenGate[];
  /** Never rejects. `false` means nothing was sent, the race was lost, or the request failed — see the gate's `alreadyAnswered` / `error`. */
  respond: (gateId: string, action: GateApprovalAction) => Promise<boolean>;
}

/**
 * Re-exported so a gate card never invents a label. harness's
 * `gate.ParseApprovalAction` matches these three strings EXACTLY and rejects
 * anything else with `gate_action_invalid`; deny is the fail-secure default.
 */
export { GATE_APPROVAL_ACTIONS };

/**
 * The open gates for one session, plus this tab's answer path.
 *
 * Takes the session's `SessionViewStore` for the same reason `useComposer`
 * does: gates arrive on SSE and live in the folded view, so a two-argument form
 * would have to open a second connection per hook.
 */
export function useGate(
  transport: LooprigTransport,
  sessionId: string,
  viewStore: SessionViewStore,
): UseGateResult {
  const store = useMemo(() => new GateResponseStore(transport, sessionId), [transport, sessionId]);
  const local = useStore(store);
  // The view snapshot's version, so this recomputes on every notify.
  // `viewStore.snapshot()` is then read IMPERATIVELY rather than selected: the
  // derived array below is a fresh array every time, and returning one from a
  // `useSyncExternalStore` selector makes React throw "The result of
  // getSnapshot should be cached to avoid an infinite loop".
  const version = useStoreSelector(viewStore, (snapshot) => snapshot.version);

  useEffect(() => {
    store.prune(viewStore.snapshot().view.gates);
  }, [store, viewStore, version]);

  const gates = useMemo<readonly OpenGate[]>(() => {
    const open = viewStore.snapshot().view.gates;
    return [...open.values()]
      .filter((gate) => !local.answered.has(gate.id))
      .map((gate) => ({
        ...gate,
        answerable: isAnswerableGate(gate),
        responding: local.responding.has(gate.id),
        alreadyAnswered: local.alreadyAnswered.has(gate.id),
        error: local.errors.get(gate.id),
      }));
    // `version` is the dependency that matters; `viewStore` is read imperatively.
  }, [viewStore, version, local]);

  const respond = useCallback(
    (gateId: string, action: GateApprovalAction) => store.respond(gateId, action),
    [store],
  );

  return useMemo(() => ({ gates, respond }), [gates, respond]);
}

/**
 * One open public gate, with this tab's answer state for it.
 *
 * `answerable` is `acceptsResidentResponse` and nothing wider — a gate whose
 * owner is not up right now cannot be answered, and `FactoryGateStore` refuses
 * to send for one, so a card that offers the form anyway is offering a button
 * that does nothing.
 */
export interface FactoryOpenGate extends PublicGateEntry {
  readonly answerable: boolean;
  /** The retained response envelope for this gate, or null. */
  readonly pending: PendingCommandView | null;
  /** True while an attempt for this gate is in flight. */
  readonly responding: boolean;
  readonly error: Error | null;
}

export interface UseFactoryGateResult {
  /** This session's open gates in the board's stable public order. */
  readonly gates: readonly FactoryOpenGate[];
  /** Never rejects. `"none"` means nothing was sent — an unanswerable gate, or one with no attested open identity. */
  respond: (gate: PublicGateEntry, action: GateApprovalAction) => Promise<CommandResult>;
  /** Never rejects. Replays this gate's retained response under its original identity. */
  retry: (gateId: string) => Promise<CommandResult>;
  cancel: (gateId: string) => void;
}

/**
 * The open gates for one session, plus this tab's answer path over the Factory
 * command plane.
 *
 * Takes the `PublicGateBoard` the caller already folds rather than reading one
 * itself: the board accumulates pages and live gate events together, and a
 * second reader here would be a second, disagreeing copy.
 *
 * `publicGates` sorts on read and therefore returns a FRESH array every call.
 * It is called inside a `useMemo` keyed on the board, never inside a
 * `useStoreSelector` selector: `useSyncExternalStore` compares with
 * `Object.is`, so a selector returning a new array is the documented path to
 * React throwing "The result of getSnapshot should be cached to avoid an
 * infinite loop". `foldPublicGatePage` returns the IDENTICAL board when a page
 * applies nothing, which is what makes the memo key work for a polling caller.
 */
export function useFactoryGate(sessionId: string, board: PublicGateBoard): UseFactoryGateResult {
  const commands = useFactoryClient().commands;
  const store = useMemo(() => new FactoryGateStore(commands, sessionId), [commands, sessionId]);
  useEffect(() => store.attach(), [store]);
  const snapshot = useStore(store);

  const entries = useMemo(
    () => publicGates(board).filter((entry) => entry.sessionId === sessionId),
    [board, sessionId],
  );

  useEffect(() => {
    store.prune(entries.map((entry) => entry.gateId));
  }, [store, entries]);

  const gates = useMemo<readonly FactoryOpenGate[]>(
    () =>
      entries.map((entry) => {
        const key = gateCommandKey(entry.gateId);
        const pending = snapshot.pending.get(key) ?? null;
        return {
          ...entry,
          answerable: acceptsResidentResponse(entry),
          pending,
          responding: pending?.sending === true,
          error: snapshot.errors.get(key) ?? null,
        };
      }),
    [entries, snapshot],
  );

  const respond = useCallback(
    (gate: PublicGateEntry, action: GateApprovalAction) => store.respond(gate, action),
    [store],
  );
  const retry = useCallback((gateId: string) => store.retry(gateId), [store]);
  const cancel = useCallback(
    (gateId: string) => {
      store.cancel(gateId);
    },
    [store],
  );

  return useMemo(() => ({ gates, respond, retry, cancel }), [gates, respond, retry, cancel]);
}
