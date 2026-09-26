import { useMemo, useState } from 'react';
import {
  advanceGateBoardCell,
  createPublicEventFolder,
  type FoldedEvents,
  type GateBoardCell,
  type GateBoardView,
  type PublicGateBoard,
  type PublicJournalEvent,
} from '@looprig/client';

/** Incremental fold of the Factory session's merged public events. */
export function useFoldedEvents(events: readonly PublicJournalEvent[]): FoldedEvents {
  const [fold] = useState(createPublicEventFolder);
  return useMemo(() => fold(events), [fold, events]);
}

/** The folded board for one session view, reset on scope or generation change. */
export function useGateBoard(sessionId: string, view: GateBoardView): PublicGateBoard {
  const [cell, setCell] = useState<GateBoardCell | undefined>(undefined);
  const next = advanceGateBoardCell(cell, sessionId, view);
  if (next !== cell) setCell(next);
  return next.state.board;
}
