/** Framework-neutral Factory join lifecycle and cursor store. */
import { joinFactorySessionView, type FactoryJoinEvent, type FactoryJoinLink, type FactoryJoinOptions, type FactoryJoinReads } from "./join.js";
import type { EphemeralPublication, FactorySessionStatus, PublicJournalPage } from "./types.js";

export interface FactorySessionViewSnapshot {
  readonly version: number;
  readonly generation: number;
  readonly coveredThrough: number;
  readonly status?: FactorySessionStatus;
  readonly event?: PublicJournalPage["events"][number];
  readonly ephemeral?: EphemeralPublication;
}

export interface FactorySessionViewStoreOptions {
  reads: FactoryJoinReads;
  link: FactoryJoinLink;
  tenantId: string;
  sessionId: string;
  initialCoveredThrough?: number;
  join?: Omit<FactoryJoinOptions, "initialCoveredThrough" | "signal">;
  /** Persist this value atomically; it may cover withheld private records. */
  persistCoveredThrough?: (coveredThrough: number) => void;
}

/** Application lifecycle owner for the Factory join and its durable cursor. */
export class FactorySessionViewStore {
  private readonly listeners = new Set<() => void>();
  private readonly errors = new Set<(error: Error) => void>();
  private controller: AbortController | undefined;
  private generation = 0;
  private lifecycleToken = 0;
  private coveredThrough: number;
  private published: FactorySessionViewSnapshot;

  constructor(private readonly options: FactorySessionViewStoreOptions) {
    this.coveredThrough = options.initialCoveredThrough ?? 0;
    this.published = { version: 0, generation: 0, coveredThrough: this.coveredThrough };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeErrors(listener: (error: Error) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  snapshot(): FactorySessionViewSnapshot { return this.published; }
  isActive(): boolean { return this.controller !== undefined; }

  start(): void {
    if (this.controller !== undefined) return;
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const token = ++this.lifecycleToken;
    const iterator = joinFactorySessionView(
      this.options.reads,
      this.options.link,
      this.options.tenantId,
      this.options.sessionId,
      {
        ...this.options.join,
        initialCoveredThrough: this.coveredThrough,
        signal: controller.signal,
      },
    );
    void this.pump(iterator, generation, token);
  }

  stop(): void {
    if (this.controller === undefined) return;
    this.lifecycleToken += 1;
    this.controller.abort();
    this.controller = undefined;
  }

  private async pump(iterator: AsyncGenerator<FactoryJoinEvent>, generation: number, token: number): Promise<void> {
    try {
      for await (const update of iterator) {
        if (token !== this.lifecycleToken) return;
        const base: FactorySessionViewSnapshot = {
          version: this.published.version + 1,
          generation,
          coveredThrough: update.coveredThrough,
          status: update.status,
        };
        this.published = update.kind === "public"
          ? { ...base, event: update.event }
          : update.kind === "ephemeral"
            ? { ...base, ephemeral: update.publication }
            : base;
        if (update.coveredThrough > this.coveredThrough) {
          this.coveredThrough = update.coveredThrough;
          this.options.persistCoveredThrough?.(update.coveredThrough);
        }
        for (const listener of [...this.listeners]) listener();
      }
    } catch (cause) {
      if (token === this.lifecycleToken) {
        const error = asError(cause);
        for (const listener of [...this.errors]) listener(error);
      }
    } finally {
      if (token === this.lifecycleToken) this.controller = undefined;
    }
  }
}

function asError(cause: unknown): Error { return cause instanceof Error ? cause : new Error(String(cause), { cause }); }
