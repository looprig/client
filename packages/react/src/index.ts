// Public barrel for @looprig/react — the reference React adapter over
// @looprig/client.
//
// Every hook here is a thin useSyncExternalStore shell. Nothing in this package
// parses a wire shape, folds an event, or decides transcript ordering: that all
// belongs to @looprig/client, and a Vue or Solid author installs that one
// package and writes their own equivalent of this file.
//
// `src/testing/` is deliberately NOT exported. It is fixture code for this
// package's own tests, not a published test-kit.

export { useStore, useStoreSelector, type ReadableStore } from "./use-store.js";

export {
  useSessionList,
  type SessionListQuery,
  type UseSessionListResult,
} from "./use-session-list.js";
export {
  useFactorySessionList,
  type FactorySessionListReads,
  type FactorySessionListSnapshot,
  type UseFactorySessionListResult,
} from "./use-factory-session-list.js";
// Opening a session view is a READ. `useAttachOrRestore` was deleted rather
// than deprecated in U4.2: `@looprig/react` is `private: true`, has never been
// published, and the only consumer in or out of this repository is `app/` —
// there was no external caller a compatibility shim could have been for.
export {
  useFactorySessionView,
  useSessionView,
  type FactoryColdReads,
  type FactorySessionViewOptions,
  type FactorySessionViewState,
  type PublicJournalEvent,
  type SessionViewOptions,
  type UseFactorySessionViewResult,
  type UseSessionViewResult,
} from "./use-session-view.js";
export { useRowCount, useTranscriptRow } from "./use-transcript-row.js";
export { useComposer, type UseComposerResult } from "./use-composer.js";
export { GATE_APPROVAL_ACTIONS, useGate, type OpenGate, type UseGateResult } from "./use-gate.js";
export { useInterrupt, type InterruptSnapshot, type UseInterruptResult } from "./use-interrupt.js";

// The Factory control plane. Every one of these mints exactly one
// `PendingCommand` per user action and retains it until Core reports a durable
// accepted/applied/rejected outcome; a retry replays that same envelope rather
// than minting a second logical command. The identity is scoped to
// `FactoryClient.commands` and to the session, so two sessions never contend
// and a component remount inherits an outstanding action instead of offering
// the user a duplicate. See `stores/pending.ts`.
export { useFactoryComposer, type UseFactoryComposerResult } from "./use-composer.js";
export { useFactoryGate, type FactoryOpenGate, type UseFactoryGateResult } from "./use-gate.js";
export { useFactoryInterrupt, type UseFactoryInterruptResult } from "./use-interrupt.js";
export type { CommandResult, PendingCommandView } from "./stores/pending.js";
// The connection plane. `SessionViewSnapshot` carries neither liveness nor
// errors — they arrive on the store's own two out-of-band channels — so these
// are how a component renders either. See use-connection.ts.
export {
  useConnection,
  useSessionViewErrors,
  type ConnectionState,
  type ConnectionStatus,
} from "./use-connection.js";

// The Factory plane. One client and one ClientLink for the whole application,
// constructed above the route by FactoryLinkProvider; a session view takes a
// binding and a cursor from useSessionBinding and owns nothing else. See
// use-connection.ts for why the link cannot belong to a route.
export {
  FactoryIdentityProvider,
  FactoryLinkProvider,
  useFactoryClient,
  useFactoryLink,
  useFactoryLinkStatus,
  useFactoryTenantId,
  useSessionBinding,
  type FactoryIdentityProviderProps,
  type FactoryLinkProviderProps,
  type FactoryLinkState,
  type FactoryLinkStatus,
  type FactoryScope,
  type SessionBinding,
  type SessionBindingHandle,
  type SessionBindingOptions,
} from "./use-connection.js";

// Exported because app/ constructs these directly in a couple of places (a list
// that outlives a route, a composer under test). Both are framework-neutral —
// nothing in `src/stores/` imports React — and both move to @looprig/client
// when a second framework adapter appears.
export { SessionListStore, type SessionListSnapshot } from "./stores/session-list.js";
export { FactoryLinkStore } from "./stores/connection.js";
export {
  SessionComposerStore,
  type ComposerSnapshot,
  type PendingRow,
} from "./stores/composer.js";

export { usePendingInput, type PendingInputHandlers } from './use-pending-input.js';
export { useFoldedEvents, useGateBoard } from './factory-view.js';
export { useLinkRecovery } from './use-link-recovery.js';
