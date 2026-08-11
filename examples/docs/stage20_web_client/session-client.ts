import {
  GATE_APPROVAL_ACTIONS,
  createBFFClient,
  createFetchLiveFrameSource,
  joinSessionView,
  textBlock,
  type GateApprovalAction,
  type LooprigClient,
  type SessionView,
} from "@looprig/client";

export interface SessionListener {
  onView(view: SessionView): void;
  onError(error: Error): void;
}

/** Core owns protocol behavior; framework bindings consume SessionView. */
export class SessionClient {
  constructor(private readonly client: LooprigClient = createBFFClient()) {}

  connect(sessionId: string, listener: SessionListener): () => void {
    const controller = new AbortController();
    const updates = joinSessionView(this.client, sessionId, createFetchLiveFrameSource(sessionId), {
      autoReconnect: true,
      signal: controller.signal,
    });
    void (async () => {
      try {
        for await (const update of updates) {
          if (update.ok) listener.onView(update.view);
          else listener.onError(update.error);
        }
      } catch (cause) {
        if (!controller.signal.aborted) listener.onError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    })();
    return () => {
      controller.abort();
      void updates.return(undefined);
    };
  }

  async submitText(sessionId: string, text: string): Promise<void> {
    const value = text.trim();
    if (value !== "") await this.client.submit(sessionId, { blocks: [textBlock(value)] });
  }

  async respondToGate(sessionId: string, gateId: string, action: GateApprovalAction): Promise<void> {
    await this.client.respondGate(sessionId, gateId, { action });
  }

  async approveGate(sessionId: string, gateId: string): Promise<void> {
    await this.respondToGate(sessionId, gateId, GATE_APPROVAL_ACTIONS.approve);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.interrupt(sessionId);
  }
}
