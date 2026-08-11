import { describe, expect, it } from "vitest";
import type { EventJournalPage, LiveFrameSource, LooprigClient, SseFrame } from "@looprig/client";
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

function fakeClient(): LooprigClient {
  const page: EventJournalPage = { events: [], next_journal_seq: 0, done: true };
  return { readHistory: async () => page } as unknown as LooprigClient;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("stage 20 SessionClient", () => {
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
});
