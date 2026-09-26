/**
 * Shared fakes for the `SessionViewStore` suites.
 *
 * The store's whole point is that it schedules work — one notify per animation
 * frame, a ~33 ms timer while the tab is hidden — so every test needs a
 * scheduler it can step deterministically instead of a real `requestAnimation
 * Frame`. `manualScheduler` is that seam: nothing it schedules runs until a
 * test calls `flush()`, and `setHidden()` fires the visibility listeners the
 * store registers, so the "a frame scheduled just before the tab hides never
 * fires" hang is reproducible without a browser.
 *
 * `controllableLive` is the matching seam for the live plane: a
 * `LiveFrameSource` that stays open (parked in `next()`, exactly like a real
 * idle SSE connection) until the test pushes a frame or closes it, and that
 * counts `.return()` calls so a test can prove `stop()` actually cancelled the
 * connection rather than merely detaching from it.
 */
import type { FrameScheduler } from "../src/store.js";
import type { SseFrame } from "../src/sse.js";
import type { EventEnvelope, EventJournalPage } from "../src/types.js";

export interface ManualScheduler extends FrameScheduler {
  /**
   * Runs the callbacks scheduled since the last flush that are still eligible.
   * A callback scheduled under a DIFFERENT visibility state than the current
   * one is stranded and never runs — see `setHidden`.
   */
  flush(): void;
  /** How many scheduled callbacks are still live (cancelled ones do not count). */
  pendingCount(): number;
  /**
   * Flips `isHidden()` and fires every visibility listener, like the DOM event.
   *
   * Crossing this boundary STRANDS every callback scheduled under the previous
   * state: a `requestAnimationFrame` scheduled just before a tab hides never
   * fires and never falls through, and a `setTimeout` scheduled while hidden is
   * not what a visible tab should be publishing on. Modelling that is what
   * makes the store's cancel-and-reschedule testable at all — without it,
   * `flush()` would run the stranded callback and the test would pass against a
   * store that does nothing on `visibilitychange`.
   */
  setHidden(hidden: boolean): void;
  visibilityListenerCount(): number;
}

interface ScheduledFrame {
  callback: () => void;
  /** The visibility state this frame was scheduled under. */
  hidden: boolean;
}

export function manualScheduler(): ManualScheduler {
  let pending: Array<ScheduledFrame | undefined> = [];
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    schedule(callback) {
      pending.push({ callback, hidden });
      return pending.length; // 1-based, so 0 is never a valid handle
    },
    cancel(handle) {
      pending[handle - 1] = undefined;
    },
    isHidden: () => hidden,
    onVisibilityChange(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    flush() {
      const run = pending;
      pending = [];
      for (const frame of run) {
        if (frame !== undefined && frame.hidden === hidden) frame.callback();
      }
    },
    pendingCount: () => pending.filter((frame) => frame !== undefined).length,
    setHidden(next) {
      hidden = next;
      for (const listener of [...listeners]) listener();
    },
    visibilityListenerCount: () => listeners.size,
  };
}

export const emptyPage = { events: [], next_journal_seq: 0, done: true } as unknown as EventJournalPage;

export function pageOf(events: unknown[], done = true): EventJournalPage {
  return { events, next_journal_seq: events.length, done } as unknown as EventJournalPage;
}

/** Yields the macrotask queue, which drains every pending microtask chain with it. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Drains the MICROTASK queue only, so a test can run under `vi.useFakeTimers()`
 * without its own `tick()` deadlocking on a timer nobody is advancing. Every
 * await in the join/store chain (a resolved `readHistory`, a queue handoff, an
 * async generator's yield) is a microtask, so a bounded number of turns is
 * enough to settle it.
 */
export const microtasks = async (turns = 100): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

/** A live source that stays open until the test pushes or closes it. */
export function controllableLive() {
  let push: (frame: SseFrame) => void = () => {};
  let close: () => void = () => {};
  let returned = 0;
  let opens = 0;
  const source = () => {
    opens += 1;
    const queue: SseFrame[] = [];
    let waiter: ((result: IteratorResult<SseFrame>) => void) | undefined;
    let closed = false;
    push = (frame) => {
      if (waiter) {
        waiter({ value: frame, done: false });
        waiter = undefined;
      } else queue.push(frame);
    };
    close = () => {
      closed = true;
      if (waiter) {
        waiter({ value: undefined as never, done: true });
        waiter = undefined;
      }
    };
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<SseFrame>>((resolve) => {
            const item = queue.shift();
            if (item !== undefined) resolve({ value: item, done: false });
            else if (closed) resolve({ value: undefined as never, done: true });
            else waiter = resolve;
          }),
        return: async () => {
          returned += 1;
          close();
          return { value: undefined as never, done: true as const };
        },
      }),
    };
  };
  return {
    source,
    push: (frame: SseFrame) => {
      push(frame);
    },
    close: () => {
      close();
    },
    returns: () => returned,
    opens: () => opens,
  };
}

export function textFrame(text: string, loopId: string): SseFrame {
  return {
    type: "ephemeral",
    data: {
      kind: "token_delta",
      delta: { chunk_type: "text", text },
      header: { session_id: "s", loop_id: loopId },
    },
  } as unknown as SseFrame;
}

/** A `token_delta` whose `chunk_type` no decoder knows: fold yields `unknown_chunk_type`. */
export function badFrame(loopId: string): SseFrame {
  return {
    type: "ephemeral",
    data: {
      kind: "token_delta",
      delta: { chunk_type: "nonesuch" },
      header: { session_id: "s", loop_id: loopId },
    },
  } as unknown as SseFrame;
}

export function heartbeatFrame(): SseFrame {
  return { type: "heartbeat" } as unknown as SseFrame;
}

export function enduringFrame(journalSeq: number, event: EventEnvelope): SseFrame {
  return { type: "enduring", journalSeq, data: { event } } as unknown as SseFrame;
}

export function errorFrame(message: string): SseFrame {
  return { type: "error", error: new Error(message) } as unknown as SseFrame;
}
