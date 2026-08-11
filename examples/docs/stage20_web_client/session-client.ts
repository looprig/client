import {
  GATE_APPROVAL_ACTIONS,
  createBFFClient,
  createFetchLiveFrameSource,
  joinSessionView,
  textBlock,
  type GateApprovalAction,
  type FetchLike,
  type LiveFrameSource,
  type LooprigClient,
  type SseFrame,
  type SessionView,
} from "@looprig/client";

export interface SessionListener {
  onView(view: SessionView): void;
  onError(error: Error): void;
}

export type LiveSourceFactory = (sessionId: string, signal: AbortSignal) => LiveFrameSource;

export interface SessionClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  liveSource?: LiveSourceFactory;
}

type InjectedSessionClientOptions = SessionClientOptions & { liveSource: LiveSourceFactory };

/** Core owns protocol behavior; framework bindings consume SessionView. */
export class SessionClient {
  private readonly client: LooprigClient;
  private readonly liveSource: LiveSourceFactory;

  constructor();
  constructor(client: undefined, options?: SessionClientOptions);
  constructor(client: LooprigClient, options: InjectedSessionClientOptions);
  constructor(client?: LooprigClient, options: SessionClientOptions = {}) {
    if (client !== undefined && options.liveSource === undefined) {
      throw new TypeError("SessionClient requires options.liveSource when a custom client is injected");
    }
    this.client = client ?? createBFFClient({ baseUrl: options.baseUrl, fetch: options.fetch });
    this.liveSource =
      options.liveSource ??
      ((id, _signal) =>
        createFetchLiveFrameSource(id, {
          baseUrl: options.baseUrl,
          fetch: options.fetch,
        }));
  }

  connect(sessionId: string, listener: SessionListener): () => void {
    const controller = new AbortController();
    const { source, cancelActive } = cancelableLiveSource(this.liveSource(sessionId, controller.signal));
    const updates = joinSessionView(this.client, sessionId, source, {
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
      cancelActive();
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

function cancelableLiveSource(inner: LiveFrameSource): { source: LiveFrameSource; cancelActive: () => void } {
  let activeIterator: AsyncIterator<SseFrame, void, void> | undefined;

  const source: LiveFrameSource = () => {
    const iterable = inner();
    return {
      [Symbol.asyncIterator](): AsyncIterator<SseFrame, void, void> {
        const iterator = iterable[Symbol.asyncIterator]();
        activeIterator = iterator;
        return iterator;
      },
    };
  };

  const cancelActive = (): void => {
    const iterator = activeIterator;
    activeIterator = undefined;
    const result = iterator?.return?.();
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
  };

  return { source, cancelActive };
}
