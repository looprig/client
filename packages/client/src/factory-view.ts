import { decodeEnduring } from './enduring.js';
import { emptyPublicGateBoard, emptySessionView, fold, foldPublicGateEvent, foldPublicGatePage, publicGateKey, type PublicGateBoard, type SessionView } from './fold.js';
import type { EventEnvelope, FactorySessionStatus, PublicGatePage, PublicJournalPage, StatusEvent } from './types.js';

export type PublicJournalEvent = PublicJournalPage['events'][number];

/**
 * A projection of a Factory session view.
 *
 * `useFactorySessionView` hands back durable public events (a bounded tail,
 * live publications and repairs merged by `journal_seq`, plus one replaceable
 * earlier page). A transcript, tool rows, turn status and queue tray all
 * read `SessionView`, so the events are folded here.
 */

export type FoldedEvents = { readonly view: SessionView; readonly version: number };

function toStatusEvent(event: PublicJournalEvent): StatusEvent {
  return { journal_seq: event.journal_seq, event: event.body as EventEnvelope } as StatusEvent;
}

/**
 * A stateful folder over successive event lists. When the new list extends
 * the previous one it folds only the tail; any other change (a repair filling
 * a gap, an earlier page, a reset) refolds from scratch, so the result always
 * equals folding the list itself. Returns the identical result for an
 * unchanged list. The fold returns a new `SessionView` object per event
 * but appends into the arrays it shares with the previous view in place, so
 * the view object (or `version`) is a memo key and its arrays (`rows`,
 * `statusEvents`, ...) are not.
 */
export function createPublicEventFolder() {
  let folded: readonly PublicJournalEvent[] = [];
  let result: FoldedEvents = { view: emptySessionView(), version: 0 };
  return (events: readonly PublicJournalEvent[]): FoldedEvents => {
    const extends_ = events.length >= folded.length && folded.every((event, index) =>
      events[index]?.journal_seq === event.journal_seq && events[index]?.event_id === event.event_id);
    if (extends_ && events.length === folded.length) return result;
    let view = extends_ ? result.view : emptySessionView();
    for (const event of events.slice(extends_ ? folded.length : 0)) {
      const next = fold(view, { segment: 'history', event: toStatusEvent(event) });
      // A fold error skips one malformed event, exactly as the legacy join did.
      if (next.ok) view = next.view;
    }
    folded = events;
    result = { view, version: result.version + 1 };
    return result;
  };
}

// ---------------------------------------------------------------------------
// Earlier history. WUI's walk is beginning-first: its first page starts at
// sequence 1 and is merged below the bounded tail, so until the walk reaches
// the tail there is a hole between the page and the tail. The tail's first
// sequence is only observable before the walk starts (`idle`), so it is
// remembered from there.
// ---------------------------------------------------------------------------

export type EarlierState = 'idle' | 'loading' | 'available' | 'complete' | 'failed';

/** The tail's first sequence: read while no earlier page is merged, otherwise the remembered one. */
export function nextTailStart(previous: number | undefined, earlierState: EarlierState, events: readonly Pick<PublicJournalEvent, 'journal_seq'>[]): number | undefined {
  return earlierState === 'idle' ? events[0]?.journal_seq : previous;
}

/**
 * The tail's first sequence when a loaded earlier page stops short of it (a
 * gap of unloaded history lies between them), else undefined. A complete walk
 * reached the journal's end, so it overlaps the tail.
 */
export function historyGapStart(earlierState: EarlierState, events: readonly Pick<PublicJournalEvent, 'journal_seq'>[], tailStart: number | undefined): number | undefined {
  if (tailStart === undefined || earlierState === 'idle' || earlierState === 'complete') return;
  return events.some((event) => event.journal_seq < tailStart) ? tailStart : undefined;
}

/** Where the gap notice goes among the folded rows: before the first row committed in the tail (or live). */
export function historyGapRowIndex(rows: readonly { journalSeq: number | undefined }[], gapStart: number | undefined): number | undefined {
  if (gapStart === undefined) return;
  const index = rows.findIndex((row) => row.journalSeq === undefined || row.journalSeq >= gapStart);
  if (index === 0) return;
  return index === -1 ? (rows.length > 0 ? rows.length : undefined) : index;
}

export interface FactoryLivePreview {
  readonly kind: 'text' | 'reasoning';
  readonly loopId: string;
  readonly turnId: string;
  readonly text: string;
}

/** Place each transient preview after its turn's last visible row, or at the tail. */
export function placeLivePreviews(
  rows: readonly { readonly loopId: string; readonly turnId: string }[],
  start: number,
  end: number,
  liveText: readonly Omit<FactoryLivePreview, 'kind'>[],
  liveReasoning: readonly Omit<FactoryLivePreview, 'kind'>[],
): { readonly afterRow: ReadonlyMap<number, readonly FactoryLivePreview[]>; readonly unplaced: readonly FactoryLivePreview[] } {
  const lastVisibleRow = new Map<string, number>();
  for (let index = start; index < end; index++) {
    const row = rows[index];
    if (row !== undefined) lastVisibleRow.set(`${row.loopId}\0${row.turnId}`, index);
  }
  const afterRow = new Map<number, FactoryLivePreview[]>();
  const unplaced: FactoryLivePreview[] = [];
  for (const [kind, previews] of [['reasoning', liveReasoning], ['text', liveText]] as const) {
    for (const preview of previews) {
      const item = { ...preview, kind };
      const index = lastVisibleRow.get(`${preview.loopId}\0${preview.turnId}`);
      if (index === undefined) unplaced.push(item);
      else afterRow.set(index, [...(afterRow.get(index) ?? []), item]);
    }
  }
  return { afterRow, unplaced };
}

/** Status events at or after `start` (all of them when undefined); live events have no sequence and are kept. */
export function eventsFrom<T extends { journalSeq: number | undefined }>(events: readonly T[], start: number | undefined): readonly T[] {
  if (start === undefined) return events;
  return events.filter((event) => event.journalSeq === undefined || event.journalSeq >= start);
}

/** Factory's durable projection says a turn (or a gate) is in progress. */
export function statusRunning(status: Pick<FactorySessionStatus, 'state'> | null): boolean {
  return status?.state === 'running' || status?.state === 'waiting_on_gate';
}

// ---------------------------------------------------------------------------
// Gate board: a port of WUI v0.4.0's app `factory-gate-board.ts`, which is
// not part of the published packages. A page merge never removes (a bounded
// page's absence is not resolution) and a GateResolved this view observed
// tombstones its gate, so a page read before the resolve cannot resurrect it.
// A new generation (the view was invalidated, or its coverage fell) drops the
// board and every tombstone.
// ---------------------------------------------------------------------------

export interface GateBoardState {
  readonly generation: number;
  readonly board: PublicGateBoard;
  readonly resolved: ReadonlySet<string>;
}

export interface GateBoardInput {
  readonly generation: number;
  readonly sessionId: string;
  readonly page: PublicGatePage | null;
  readonly events: readonly PublicJournalEvent[];
}

const NO_TOMBSTONES: ReadonlySet<string> = new Set();

export function emptyGateBoardState(generation = 0): GateBoardState {
  return { generation, board: emptyPublicGateBoard(), resolved: NO_TOMBSTONES };
}

/** Folds one observation; returns the identical state (and board) when nothing applies. */
export function foldGateBoard(state: GateBoardState, input: GateBoardInput): GateBoardState {
  if (input.generation < state.generation) return state;
  const base = input.generation > state.generation ? emptyGateBoardState(input.generation) : state;
  let board = base.board;
  let resolved = base.resolved;
  for (const event of input.events) {
    const body = event.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) continue;
    const raw = body as Record<string, unknown>;
    if (raw.type !== 'GateOpened' && raw.type !== 'GateResolved') continue;
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
    if (sessionId === '') continue;
    const item = toStatusEvent(event);
    const decoded = decodeEnduring(event.body as EventEnvelope);
    if (decoded.payload.kind === 'GateResolved') {
      if (decoded.payload.gateId === '') continue;
      const key = publicGateKey(sessionId, decoded.payload.gateId);
      if (!resolved.has(key)) resolved = new Set([...resolved, key]);
      board = foldPublicGateEvent(board, { segment: 'history', event: item });
    } else if (decoded.payload.kind === 'GateOpened') {
      if (resolved.has(publicGateKey(sessionId, decoded.payload.gate.id))) continue;
      board = foldPublicGateEvent(board, { segment: 'history', event: item });
    }
  }
  if (input.page !== null) board = foldPublicGatePage(board, suppressResolved(input.page, input.sessionId, resolved), input.sessionId);
  if (board === state.board && resolved === state.resolved && input.generation === state.generation) return state;
  return { generation: input.generation, board, resolved };
}

function suppressResolved(page: PublicGatePage, sessionId: string, resolved: ReadonlySet<string>): PublicGatePage {
  if (resolved.size === 0) return page;
  const records: unknown = (page as unknown as Record<string, unknown>).gates;
  if (!Array.isArray(records)) return page;
  const kept = records.filter((record) => {
    const gateId = typeof record === 'object' && record !== null && typeof (record as Record<string, unknown>).gate_id === 'string'
      ? (record as Record<string, string>).gate_id ?? '' : '';
    return gateId === '' || !resolved.has(publicGateKey(sessionId, gateId));
  });
  return kept.length === records.length ? page : { ...page, gates: kept } as PublicGatePage;
}

export type GateBoardView = { gates: PublicGatePage | null; events: readonly PublicJournalEvent[]; coveredThrough: number };

/** The board plus the observation it was folded from. */
export interface GateBoardCell {
  readonly sessionId: string;
  readonly gates: PublicGatePage | null;
  readonly events: readonly PublicJournalEvent[];
  readonly coveredThrough: number;
  readonly state: GateBoardState;
}

/**
 * Folds one observation of a session view into its board cell. A new
 * generation starts when the gate page was invalidated (it went back to null)
 * or coverage fell (a reset); another session starts over. Returns the
 * identical cell for an identical observation, so it can drive a render-time
 * state update that settles.
 */
export function advanceGateBoardCell(cell: GateBoardCell | undefined, sessionId: string, view: GateBoardView): GateBoardCell {
  const previous = cell?.sessionId === sessionId
    ? cell
    : { sessionId, gates: null, events: [], coveredThrough: view.coveredThrough, state: emptyGateBoardState() };
  if (previous === cell && cell.gates === view.gates && cell.events === view.events && cell.coveredThrough === view.coveredThrough) return cell;
  const invalidated = view.gates === null && previous.gates !== null;
  const rewound = view.coveredThrough < previous.coveredThrough;
  const generation = previous.state.generation + (invalidated || rewound ? 1 : 0);
  const state = foldGateBoard(previous.state, { generation, sessionId, page: view.gates, events: view.events });
  return { sessionId, gates: view.gates, events: view.events, coveredThrough: view.coveredThrough, state };
}
