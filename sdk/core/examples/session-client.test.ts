import { describe, expect, it } from "vitest";
import type {
  CreateRequest,
  EventJournalPage,
  GateAcceptedResponse,
  GateResponseRequest,
  InputResponse,
  InterruptResponse,
  LiveFrameSource,
  LooprigClient,
  SseFrame,
  SessionView,
} from "../src/index.js";
import { GATE_APPROVAL_ACTIONS, textBlock } from "../src/index.js";
import { SessionClient } from "./session-client.js";

const sessionId = "11111111-1111-1111-1111-111111111111";

function compileBoundaryCheck(): void {
  // A custom client is only valid when its matching live source is supplied.
  // @ts-expect-error SessionClient must reject the split custom-client form.
  new SessionClient(fakeClient());
}

class PendingLiveConnection implements AsyncIterable<SseFrame> {
  returnCalls = 0;
  private first = true;
  private resolvePending: ((result: IteratorResult<SseFrame, void>) => void) | undefined;

  [Symbol.asyncIterator](): AsyncIterator<SseFrame, void, void> {
    return {
      next: () => {
        if (this.first) {
          this.first = false;
          return Promise.resolve({ value: { type: "heartbeat" }, done: false });
        }
        return new Promise<IteratorResult<SseFrame, void>>((resolve) => {
          this.resolvePending = resolve;
        });
      },
      return: () => {
        this.returnCalls += 1;
        this.resolvePending?.({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

class ControlledLiveConnection implements AsyncIterable<SseFrame> {
  returnCalls = 0;
  private ended = false;
  private readonly buffered: SseFrame[] = [];
  private readonly waiters: Array<(result: IteratorResult<SseFrame, void>) => void> = [];

  push(frame: SseFrame): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: frame, done: false });
    else this.buffered.push(frame);
  }

  [Symbol.asyncIterator](): AsyncIterator<SseFrame, void, void> {
    return {
      next: () => {
        const frame = this.buffered.shift();
        if (frame !== undefined) return Promise.resolve({ value: frame, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<SseFrame, void>>((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.returnCalls += 1;
        this.ended = true;
        for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function fakeClient(): LooprigClient {
  const page: EventJournalPage = { events: [], next_journal_seq: 0, done: true };
  return {
    readHistory: async () => page,
  } as unknown as LooprigClient;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("framework-neutral SessionClient", () => {
  it("uses the injected live source with the injected transport and disposes it", async () => {
    const connection = new PendingLiveConnection();
    let sourceSessionId: string | undefined;
    const liveSource = (id: string): LiveFrameSource => {
      sourceSessionId = id;
      return () => connection;
    };
    const client = new SessionClient(fakeClient(), { liveSource });
    const disconnect = client.connect(sessionId, { onView: () => {}, onError: () => {} });

    await flush();

    expect(sourceSessionId).toBe(sessionId);
    disconnect();
    await flush();
    expect(connection.returnCalls).toBeGreaterThanOrEqual(1);
  });

  it("rejects an injected client when no matching live source is supplied", () => {
    const Constructor = SessionClient as unknown as new (client: LooprigClient) => SessionClient;

    expect(() => new Constructor(fakeClient())).toThrow(/liveSource/);
  });

  it("proves history/live folding, actions, and cleanup with deterministic local doubles", async () => {
    const connection = new ControlledLiveConnection();
    const calls: {
      submit?: { sessionId: string; request: CreateRequest };
      gate?: { sessionId: string; gateId: string; request: GateResponseRequest };
      interrupt?: string;
    } = {};
    const client = {
      readHistory: async (): Promise<EventJournalPage> => ({
        events: [{ journal_seq: 0, event: { type: "HistoryEvent", v: 1 } }],
        next_journal_seq: 1,
        done: true,
      }),
      submit: async (id: string, request: CreateRequest): Promise<InputResponse> => {
        calls.submit = { sessionId: id, request };
        return { command_id: "22222222-2222-2222-2222-222222222222" };
      },
      respondGate: async (
        id: string,
        gateId: string,
        request: GateResponseRequest,
      ): Promise<GateAcceptedResponse> => {
        calls.gate = { sessionId: id, gateId, request };
        return {};
      },
      interrupt: async (id: string): Promise<InterruptResponse> => {
        calls.interrupt = id;
        return { interrupted: true };
      },
    } as unknown as LooprigClient;
    const views: SessionView[] = [];
    const session = new SessionClient(client, { liveSource: () => () => connection });
    const disconnect = session.connect(sessionId, {
      onView: (view) => views.push(view),
      onError: (error) => { throw error; },
    });

    await flush();
    expect(views.some((view) => view.statusEvents.length === 1)).toBe(true);

    connection.push({
      type: "ephemeral",
      data: {
        v: 1,
        kind: "token_delta",
        header: { session_id: sessionId },
        delta: { chunk_type: "text", text: "live" },
      },
    } as SseFrame);
    await flush();

    expect(views.at(-1)?.content).toEqual([
      expect.objectContaining({ chunkType: "text", text: "live" }),
    ]);
    await session.submitText(sessionId, "  hello  ");
    await session.approveGate(sessionId, "gate-1");
    await session.interrupt(sessionId);
    expect(calls.submit).toEqual({ sessionId, request: { blocks: [textBlock("hello")] } });
    expect(calls.gate).toEqual({
      sessionId,
      gateId: "gate-1",
      request: { action: GATE_APPROVAL_ACTIONS.approve },
    });
    expect(calls.interrupt).toBe(sessionId);

    disconnect();
    await flush();
    expect(connection.returnCalls).toBeGreaterThanOrEqual(1);
  });

});
