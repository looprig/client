import { describe, expect, it } from 'vitest';
import { advanceGateBoardCell, createPublicEventFolder, emptyGateBoardState, foldGateBoard, historyGapStart, historyGapRowIndex, liveToolRows, livePreviewKey, nextTailStart, placeLivePreviews, statusRunning, type FactoryLiveToolStep, type PublicGatePage, type PublicJournalEvent } from '../src/index.js';

const SID = '11111111-1111-4111-8111-111111111111';
const LOOP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function turnStarted(seq: number, text: string): PublicJournalEvent {
  return {
    event_id: uuid(seq), journal_seq: seq,
    body: {
      type: 'TurnStarted', session_id: SID, loop_id: LOOP, turn_id: uuid(1_000 + seq), event_id: uuid(seq),
      created_at: `2026-09-26T12:00:${String(seq).padStart(2, '0')}Z`,
      cause: { command_id: uuid(2_000 + seq), agency: 'user' },
      message: { role: 'user', blocks: [{ type: 'text', text }] },
    },
  };
}
function turnDone(seq: number, turnSeq: number): PublicJournalEvent {
  return {
    event_id: uuid(seq), journal_seq: seq,
    body: { type: 'TurnDone', session_id: SID, loop_id: LOOP, turn_id: uuid(1_000 + turnSeq), event_id: uuid(seq), created_at: `2026-09-26T12:00:${String(seq).padStart(2, '0')}Z` },
  };
}
function gateOpened(seq: number, gateId: string): PublicJournalEvent {
  return {
    event_id: uuid(seq), journal_seq: seq,
    body: {
      type: 'GateOpened', v: 1, session_id: SID, event_id: uuid(seq), loop_id: LOOP, created_at: '2026-09-26T12:00:00Z',
      gate: { id: gateId, kind: 'harness.permission', resolver: 'loop', prompt: { title: 'Allow write?', body: 'notes/A.md', controls: [{ action: 'approve', label: 'Approve' }] } },
    },
  };
}
function gateResolved(seq: number, gateId: string): PublicJournalEvent {
  return {
    event_id: uuid(seq), journal_seq: seq,
    body: { type: 'GateResolved', v: 1, session_id: SID, event_id: uuid(seq), loop_id: LOOP, gate_id: gateId, action: 'Approve', reason: 'answered', resolver: 'loop', source: { kind: 'user' }, created_at: '2026-09-26T12:00:01Z' },
  };
}
function gatePage(gateId: string, seq: number): PublicGatePage {
  return {
    journal_tip: seq, open_gate_count: 1,
    gates: [{ gate_id: gateId, kind: 'harness.permission', opened_event_id: uuid(seq), opened_journal_seq: seq, deadline: '2026-09-26T13:00:00Z', answerability: 'resident', prompt: { title: 'Allow write?', body: 'notes/A.md' } }],
  } as unknown as PublicGatePage;
}

const JOURNAL = [turnStarted(1, 'First'), turnDone(2, 1), turnStarted(3, 'Second'), turnDone(4, 3), turnStarted(5, 'Third'), turnDone(6, 5)];

function durableRows(events: readonly PublicJournalEvent[]) {
  const folded = createPublicEventFolder()(events);
  return folded.view.rows.map((row) => ({ kind: row.kind, turnId: row.turnId, journalSeq: row.journalSeq, ordinal: row.ordinal }));
}

describe('Factory conversation view', () => {
  it('places live reasoning and text after the last visible row for their loop and turn', () => {
    const rows = [
      { loopId: LOOP, turnId: uuid(1), journalSeq: 1 },
      { loopId: LOOP, turnId: uuid(1), journalSeq: 2 },
      { loopId: uuid(9), turnId: uuid(1), journalSeq: 3 },
    ];
    const text = { loopId: LOOP, turnId: uuid(1), text: 'answer' };
    const reasoning = { loopId: LOOP, turnId: uuid(1), text: 'thinking' };
    const outside = { loopId: uuid(9), turnId: uuid(1), text: 'other' };
    const placed = placeLivePreviews(rows, 0, 2, [text, outside], [reasoning]);
    expect(placed.afterRow.get(1)).toEqual([
      { ...reasoning, kind: 'reasoning' },
      { ...text, kind: 'text' },
    ]);
    expect(placed.unplaced).toEqual([{ ...outside, kind: 'text' }]);
  });

  it('identifies a live preview by kind, loop and turn', () => {
    const preview = { kind: 'text' as const, loopId: LOOP, turnId: uuid(1), text: 'answer' };
    expect(livePreviewKey({ ...preview, text: 'updated' })).toBe(livePreviewKey(preview));
    expect(livePreviewKey({ ...preview, kind: 'reasoning' })).not.toBe(livePreviewKey(preview));
    expect(livePreviewKey({ ...preview, loopId: uuid(2) })).not.toBe(livePreviewKey(preview));
    expect(livePreviewKey({ ...preview, turnId: uuid(2) })).not.toBe(livePreviewKey(preview));
  });

  it('places live tool steps after reasoning and text within their turn, in the order given', () => {
    const turn = { loopId: LOOP, turnId: uuid(1) };
    const step = (n: number, phase: 'started' | 'completed'): FactoryLiveToolStep => ({
      phase, ...turn, stepId: uuid(3), toolExecutionId: uuid(10 + n), toolUseId: `toolu_${n}`, toolName: 'Bash',
      summary: `cmd ${n}`, isError: false, resultPreview: phase === 'completed' ? 'ok' : '',
    });
    const [first, second] = liveToolRows([step(1, 'completed'), step(2, 'started')]);
    const rows = [{ ...turn }, { loopId: uuid(9), turnId: uuid(1) }];
    const placed = placeLivePreviews(rows, 0, 2, [{ ...turn, text: 'answer' }], [{ ...turn, text: 'thought' }], [first!, second!]);
    expect(placed.afterRow.get(0)?.map((preview) => preview.kind)).toEqual(['reasoning', 'text', 'tool', 'tool']);
    expect(placed.afterRow.get(0)?.slice(2)).toEqual([
      { kind: 'tool', ...turn, row: first },
      { kind: 'tool', ...turn, row: second },
    ]);
    const unplaced = placeLivePreviews([], 0, 0, [{ ...turn, text: 'answer' }], [], [second!]);
    expect(unplaced.unplaced.map((preview) => preview.kind)).toEqual(['text', 'tool']);
    // The default keeps the 0.2.0 five-argument call working.
    expect(placeLivePreviews(rows, 0, 2, [], []).afterRow.size).toBe(0);
  });

  it('identifies a live tool preview by its execution id', () => {
    const [row] = liveToolRows([{
      phase: 'started', loopId: LOOP, turnId: uuid(1), stepId: '', toolExecutionId: uuid(7), toolUseId: '',
      toolName: 'Read', summary: '', isError: false, resultPreview: '',
    }]);
    const preview = { kind: 'tool' as const, loopId: LOOP, turnId: uuid(1), row: row! };
    expect(livePreviewKey(preview)).toBe(`tool:${uuid(7)}`);
    expect(livePreviewKey({ ...preview, row: { ...row!, status: 'ok', result: 'done' } })).toBe(livePreviewKey(preview));
    expect(livePreviewKey({ ...preview, row: { ...row!, toolExecutionId: uuid(8) } })).not.toBe(livePreviewKey(preview));
  });

  it('groups unplaced previews by turn in first-seen order with reasoning before text', () => {
    const first = { loopId: LOOP, turnId: uuid(1) };
    const second = { loopId: LOOP, turnId: uuid(2) };
    const third = { loopId: uuid(9), turnId: uuid(1) };
    const placed = placeLivePreviews([], 0, 0,
      [{ ...second, text: 'second answer' }, { ...first, text: 'first answer' }, { ...third, text: 'third answer' }],
      [{ ...first, text: 'first thought' }, { ...second, text: 'second thought' }]);
    expect(placed.unplaced).toEqual([
      { ...first, kind: 'reasoning', text: 'first thought' },
      { ...first, kind: 'text', text: 'first answer' },
      { ...second, kind: 'reasoning', text: 'second thought' },
      { ...second, kind: 'text', text: 'second answer' },
      { ...third, kind: 'text', text: 'third answer' },
    ]);
  });

  it('leaves reasoning and text unplaced when their row is before the visible start', () => {
    const hidden = { loopId: LOOP, turnId: uuid(1) };
    const visible = { loopId: LOOP, turnId: uuid(2) };
    const rows = [hidden, visible, visible];
    const placed = placeLivePreviews(rows, 1, 3,
      [{ ...hidden, text: 'answer' }, { ...visible, text: 'visible answer' }],
      [{ ...hidden, text: 'thought' }, { ...visible, text: 'visible thought' }]);
    expect(placed.afterRow.get(0)).toBeUndefined();
    expect(placed.afterRow.get(2)).toEqual([
      { ...visible, kind: 'reasoning', text: 'visible thought' },
      { ...visible, kind: 'text', text: 'visible answer' },
    ]);
    expect(placed.unplaced).toEqual([
      { ...hidden, kind: 'reasoning', text: 'thought' },
      { ...hidden, kind: 'text', text: 'answer' },
    ]);
  });

  it('folds live publications incrementally into the same rows as the durable journal', () => {
    const folder = createPublicEventFolder();
    const first = folder(JOURNAL.slice(0, 3));
    const again = folder(JOURNAL.slice(0, 3));
    expect(again.version).toBe(first.version);
    const live = folder(JOURNAL);
    expect(live.version).toBeGreaterThan(first.version);
    expect(live.view.rows.map((row) => ({ kind: row.kind, turnId: row.turnId, journalSeq: row.journalSeq, ordinal: row.ordinal }))).toEqual(durableRows(JOURNAL));
    expect(live.view.commandOutcomes.get(uuid(2_005))).toBe('started');
  });

  it('after a dropped link, the repaired event set renders exactly the durable journal', () => {
    const folder = createPublicEventFolder();
    // The link dropped after #2; #5 arrived live on the new connection before
    // the repair read filled #3 and #4 in (WUI merges events by journal_seq).
    folder([JOURNAL[0]!, JOURNAL[1]!, JOURNAL[4]!]);
    const repaired = folder(JOURNAL);
    expect(repaired.view.rows.map((row) => ({ kind: row.kind, turnId: row.turnId, journalSeq: row.journalSeq, ordinal: row.ordinal }))).toEqual(durableRows(JOURNAL));
    expect(repaired.view.rows.filter((row) => row.kind === 'user')).toHaveLength(3);
  });

  it('refolds when an earlier history page replaces the retained prefix', () => {
    const folder = createPublicEventFolder();
    folder(JOURNAL.slice(2));
    const withEarlier = folder(JOURNAL);
    expect(withEarlier.view.rows[0]?.journalSeq).toBe(1);
    expect(withEarlier.view.rows.map((row) => row.journalSeq)).toEqual(durableRows(JOURNAL).map((row) => row.journalSeq));
  });

  it('never resurrects a gate from a page read before its live resolve', () => {
    const gateId = '9e2f0000-0000-4000-8000-000000000001';
    let state = emptyGateBoardState();
    state = foldGateBoard(state, { generation: 0, sessionId: SID, page: gatePage(gateId, 7), events: [gateOpened(7, gateId)] });
    expect(state.board.entries.size).toBe(1);
    state = foldGateBoard(state, { generation: 0, sessionId: SID, page: gatePage(gateId, 7), events: [gateOpened(7, gateId), gateResolved(8, gateId)] });
    expect(state.board.entries.size).toBe(0);
    const unchanged = foldGateBoard(state, { generation: 0, sessionId: SID, page: gatePage(gateId, 7), events: [gateOpened(7, gateId), gateResolved(8, gateId)] });
    expect(unchanged).toBe(state);
  });

  it('derives running from the Factory status only until the journal says otherwise', () => {
    expect(statusRunning({ state: 'running' } as never)).toBe(true);
    expect(statusRunning({ state: 'waiting_on_gate' } as never)).toBe(true);
    expect(statusRunning({ state: 'idle' } as never)).toBe(false);
    expect(statusRunning(null)).toBe(false);
  });
});

describe('a beginning-first earlier page with a gap before the tail', () => {
  // The tail began at #10; the first earlier page read #1..#2 and stopped
  // (more pages follow). #1 starts a turn whose end is in the unloaded gap.
  const earlierPage = [turnStarted(1, 'Orphan'), { ...turnStarted(2, 'Also early'), journal_seq: 2 }];
  const tail = [turnStarted(10, 'Latest'), turnDone(11, 10)];
  const merged = [...earlierPage, ...tail];

  it('remembers where the tail starts while the walk has not started', () => {
    expect(nextTailStart(undefined, 'idle', tail)).toBe(10);
    expect(nextTailStart(10, 'available', merged)).toBe(10);
    expect(nextTailStart(10, 'loading', merged)).toBe(10);
    expect(nextTailStart(10, 'idle', [])).toBeUndefined();
  });

  it('marks the gap only while a loaded page stops short of the tail', () => {
    expect(historyGapStart('available', merged, 10)).toBe(10);
    expect(historyGapStart('loading', merged, 10)).toBe(10);
    expect(historyGapStart('failed', merged, 10)).toBe(10);
    expect(historyGapStart('complete', merged, 10)).toBeUndefined();
    expect(historyGapStart('idle', tail, 10)).toBeUndefined();
    expect(historyGapStart('failed', tail, 10)).toBeUndefined();
    expect(historyGapStart('available', merged, undefined)).toBeUndefined();
  });

  it('places the gap notice before the first tail row', () => {
    const view = createPublicEventFolder()(merged).view;
    const index = historyGapRowIndex(view.rows, 10);
    expect(index).toBeGreaterThan(0);
    expect(view.rows[index! - 1]?.journalSeq).toBeLessThan(10);
    expect(view.rows[index!]?.journalSeq).toBeGreaterThanOrEqual(10);
    expect(historyGapRowIndex(view.rows, undefined)).toBeUndefined();
    const earlierOnly = createPublicEventFolder()(earlierPage).view;
    expect(historyGapRowIndex(earlierOnly.rows, 10)).toBe(earlierOnly.rows.length);
  });

});
describe('gate board cell (useGateBoard)', () => {
  const gateId = '9e2f0000-0000-4000-8000-000000000002';
  const page = gatePage(gateId, 7);
  const opened = [gateOpened(7, gateId)];

  it('keeps the identical cell for identical inputs, so a render-time update settles', () => {
    const first = advanceGateBoardCell(undefined, SID, { gates: page, events: opened, coveredThrough: 7 });
    expect(first.state.board.entries.size).toBe(1);
    expect(advanceGateBoardCell(first, SID, { gates: page, events: opened, coveredThrough: 7 })).toBe(first);
  });

  it('bumps the generation, dropping board and tombstones, when the page is invalidated', () => {
    const first = advanceGateBoardCell(undefined, SID, { gates: page, events: opened, coveredThrough: 7 });
    const resolved = advanceGateBoardCell(first, SID, { gates: page, events: [...opened, gateResolved(8, gateId)], coveredThrough: 8 });
    expect(resolved.state.board.entries.size).toBe(0);
    expect(resolved.state.resolved.size).toBe(1);
    const invalidated = advanceGateBoardCell(resolved, SID, { gates: null, events: [], coveredThrough: 8 });
    expect(invalidated.state.generation).toBe(resolved.state.generation + 1);
    expect(invalidated.state.board.entries.size).toBe(0);
    expect(invalidated.state.resolved.size).toBe(0);
    // With tombstones dropped, a fresh page may show the gate again.
    const reread = advanceGateBoardCell(invalidated, SID, { gates: page, events: [], coveredThrough: 8 });
    expect(reread.state.board.entries.size).toBe(1);
    expect(reread.state.generation).toBe(invalidated.state.generation);
  });

  it('bumps the generation when coverage falls (a reset), and starts over for another session', () => {
    const first = advanceGateBoardCell(undefined, SID, { gates: page, events: opened, coveredThrough: 9 });
    const rewound = advanceGateBoardCell(first, SID, { gates: page, events: opened, coveredThrough: 3 });
    expect(rewound.state.generation).toBe(first.state.generation + 1);
    const other = advanceGateBoardCell(rewound, 'another-session', { gates: null, events: [], coveredThrough: 0 });
    expect(other.state.generation).toBe(0);
    expect(other.state.board.entries.size).toBe(0);
  });
});
