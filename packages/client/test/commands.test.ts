import { describe, expect, it, vi } from "vitest";
import {
  CommandIdentityError,
  CommandIdentityMismatchError,
  createFactoryCommands,
  MessageMetadataError,
  type CommandID,
  type MessageMetadata,
  type ResidentGateResponseInput,
  type SessionID,
} from "../src/commands.js";
import type { ClientLink } from "../src/clientlink.js";
import type { CommandStatus } from "../src/types.js";
import {
  CoreRuntimeUnavailableError,
  RealtimeTransportError,
  RequestAbortedError,
} from "../src/errors.js";
import { ContractValidationError, validateFactory } from "../src/validate.js";

const accepted = (command_id: string): CommandStatus => ({
  command_id,
  status: "accepted",
  accepted_order: 1,
});

function fakeLink(calls: Array<{ method: string; request: unknown }>): ClientLink {
  return {
    get state() { return "connected" as const; },
    connect: async () => ({ version: 1 as const }),
    disconnect: () => undefined,
    subscribe: () => { throw new Error("unused"); },
    rpc: async (method, request) => {
      calls.push({ method, request });
      return accepted((request as { command_id: string }).command_id);
    },
  };
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `unexpected-${index}`;
}

describe("Factory retry-stable commands", () => {
  it("creates exact V1 envelopes for create, input, interrupt, restore, and resident gate response", async () => {
    const calls: Array<{ method: string; request: unknown }> = [];
    const commands = createFactoryCommands({
      link: fakeLink(calls),
      idGenerator: ids("cmd-create", "session-create", "cmd-input", "cmd-interrupt", "cmd-restore", "cmd-gate"),
    });

    const pending = [
      commands.create({ agentId: "agent-1", blocks: [{ type: "text", text: "start" }] }),
      commands.input("session-1", { blocks: [{ type: "text", text: "continue" }] }),
      commands.interrupt("session-1"),
      commands.restore("session-1"),
      commands.respondResidentGate("session-1", {
        gateId: "gate-1",
        action: "answer",
        values: { answer: "yes", count: 2 },
        expectedOpenEventId: "event-6",
      }),
    ];

    expect(pending.map(({ method, request }) => ({ method, request }))).toStrictEqual([
      { method: "session.create", request: { version: 1, command_id: "cmd-create", session_id: "session-create", agent_id: "agent-1", blocks: [{ type: "text", text: "start" }] } },
      { method: "session.input", request: { version: 1, command_id: "cmd-input", session_id: "session-1", blocks: [{ type: "text", text: "continue" }] } },
      { method: "session.interrupt", request: { version: 1, command_id: "cmd-interrupt", session_id: "session-1" } },
      { method: "session.restore", request: { version: 1, command_id: "cmd-restore", session_id: "session-1" } },
      { method: "gate.respond", request: { version: 1, command_id: "cmd-gate", session_id: "session-1", gate_id: "gate-1", action: "answer", values: { answer: "yes", count: 2 }, expected_open_event_id: "event-6" } },
    ]);

    for (const operation of pending) {
      await operation.submit();
      await operation.retry();
    }
    expect(calls).toHaveLength(10);
    for (let index = 0; index < pending.length; index += 1) {
      expect(JSON.stringify(calls[index * 2]!.request)).toBe(pending[index]!.bytes);
      expect(JSON.stringify(calls[index * 2 + 1]!.request)).toBe(pending[index]!.bytes);
    }
  });

  it("owns a byte-stable envelope and reuses both create identities on retry", async () => {
    const calls: Array<{ method: string; request: unknown }> = [];
    const blocks = [{ type: "text", text: "original" }];
    const pending = createFactoryCommands({
      link: fakeLink(calls),
      idGenerator: ids("cmd-create", "session-create"),
    }).create({ agentId: "agent-1", blocks });
    const originalBytes = pending.bytes;

    blocks[0]!.text = "mutated by caller";
    const exposed = pending.request.blocks!;
    exposed[0]!.text = "mutated returned copy";
    await pending.submit();
    await pending.retry();

    expect(calls.map(({ request }) => JSON.stringify(request))).toStrictEqual([originalBytes, originalBytes]);
    expect(pending.commandId).toBe("cmd-create");
    expect(pending.sessionId).toBe("session-create");
  });

  it("mints a fresh CommandID only for an explicit new user action", async () => {
    const commands = createFactoryCommands({
      link: fakeLink([]),
      idGenerator: ids("cmd-one", "cmd-two"),
    });
    const first = commands.interrupt("session-1");
    const second = commands.interrupt("session-1");
    expect(first.commandId).toBe("cmd-one");
    expect(second.commandId).toBe("cmd-two");
    await expect(first.retry()).resolves.toMatchObject({ command_id: "cmd-one" });
  });

  it("resolves ambiguity by the same accepted session/command identity without another RPC or remint", async () => {
    const rpcCalls: Array<{ method: string; request: unknown }> = [];
    const fetch = vi.fn(async (input: string) => new Response(JSON.stringify(accepted("Cmd:One/ABC-_09")), { status: 200 }));
    const commands = createFactoryCommands({
      link: fakeLink(rpcCalls),
      fetch,
      baseUrl: "https://factory.example/base/",
      idGenerator: ids("Cmd:One/ABC-_09"),
    });
    const pending = commands.input("Session:/Upper-_", { blocks: [{ type: "text", text: "hello" }] });

    const resolved = await pending.resolve();

    expect(resolved.command_id).toBe("Cmd:One/ABC-_09");
    expect(fetch).toHaveBeenCalledWith(
      "https://factory.example/base/v1/sessions/Session%3A%2FUpper-_/commands/Cmd%3AOne%2FABC-_09",
      expect.objectContaining({ method: "GET" }),
    );
    expect(decodeURIComponent("Cmd%3AOne%2FABC-_09")).toBe(resolved.command_id);
    expect(rpcCalls).toStrictEqual([]);
  });

  it("returns an explicit unknown outcome that retains the same pending operation for resolution", async () => {
    const link = fakeLink([]);
    link.rpc = async () => { throw new RealtimeTransportError("reply lost"); };
    const fetch = vi.fn(async () => new Response(JSON.stringify(accepted("command-1")), { status: 200 }));
    const pending = createFactoryCommands({ link, fetch, idGenerator: ids("command-1") })
      .interrupt("session-1");

    const attempt = await pending.attempt();

    expect(attempt).toMatchObject({ outcome: "unknown", pending });
    await expect(attempt.pending.resolve()).resolves.toStrictEqual(accepted("command-1"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns a definitive Core rejection separately from an unknown transport outcome", async () => {
    const link = fakeLink([]);
    link.rpc = async () => {
      throw new CoreRuntimeUnavailableError({ error: { code: "runtime_unavailable", retryable: false } });
    };
    const pending = createFactoryCommands({ link, idGenerator: ids("command-1") }).interrupt("session-1");
    await expect(pending.attempt()).resolves.toMatchObject({
      outcome: "rejected",
      error: { code: "runtime_unavailable" },
      pending,
    });
  });

  it("rejects a valid response for a different command identity on submit or resolution", async () => {
    const link = fakeLink([]);
    link.rpc = async () => accepted("different-command");
    const fetch = vi.fn(async () => new Response(JSON.stringify(accepted("different-command")), { status: 200 }));
    const pending = createFactoryCommands({ link, fetch, idGenerator: ids("command-1") }).interrupt("session-1");
    await expect(pending.submit()).rejects.toBeInstanceOf(CommandIdentityMismatchError);
    await expect(pending.resolve()).rejects.toBeInstanceOf(CommandIdentityMismatchError);
  });

  it("validates the authoritative command lookup response", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ command_id: "command-1" }), { status: 200 }));
    const pending = createFactoryCommands({ link: fakeLink([]), fetch, idGenerator: ids("command-1") })
      .interrupt("session-1");
    await expect(pending.resolve()).rejects.toBeInstanceOf(ContractValidationError);
  });

  it("supports caller cancellation while resolving an unknown outcome", async () => {
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response(JSON.stringify(accepted("command-1")), { status: 200 });
    });
    const pending = createFactoryCommands({ link: fakeLink([]), fetch, idGenerator: ids("command-1") })
      .restore("session-1");
    const controller = new AbortController();
    controller.abort();

    await expect(pending.resolve({ signal: controller.signal })).rejects.toBeInstanceOf(RequestAbortedError);
  });

  it("exposes generated identities as opaque Core string types", () => {
    const pending = createFactoryCommands({
      link: fakeLink([]),
      idGenerator: ids("command-1", "session-1"),
    }).create({ agentId: "agent-1" });
    const commandId: CommandID = pending.commandId;
    const sessionId: SessionID = pending.sessionId;
    expect([commandId, sessionId]).toStrictEqual(["command-1", "session-1"]);
  });

  it("uses getRandomValues when the command plane has no injected generator", () => {
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000003");
    const pending = createFactoryCommands({ link: fakeLink([]) }).interrupt("session-1");
    expect(pending.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomUUID).not.toHaveBeenCalled();
    randomUUID.mockRestore();
  });

  it.each([
    ["empty", ""],
    ["more than 256 UTF-8 bytes", "😀".repeat(65)],
    ["unpaired UTF-16 surrogate", "command-\uD800"],
  ])("rejects an %s generated identity before transport", (_name, generated) => {
    const commands = createFactoryCommands({ link: fakeLink([]), idGenerator: () => generated });
    expect(() => commands.interrupt("session-1")).toThrow(CommandIdentityError);
  });

  it("rejects an invalid generated create SessionID as well as an invalid CommandID", () => {
    const commands = createFactoryCommands({ link: fakeLink([]), idGenerator: ids("valid-command", "") });
    expect(() => commands.create({ agentId: "agent-1" })).toThrow(CommandIdentityError);
  });

  it("rejects a non-string generator result at the runtime boundary", () => {
    const commands = createFactoryCommands({
      link: fakeLink([]),
      idGenerator: (() => 42) as unknown as () => string,
    });
    expect(() => commands.interrupt("session-1")).toThrow(CommandIdentityError);
  });

  it.each([
    { gateId: "gate-1", action: "answer", values: {} },
    { gateId: "gate-1", action: "answer", values: {}, expectedOpenEventId: "event-1", expectedOpenJournalSeq: 1 },
  ])("rejects a gate response without exactly one optimistic open identity", (input) => {
    const commands = createFactoryCommands({ link: fakeLink([]), idGenerator: ids("command-1") });
    expect(() => commands.respondResidentGate("session-1", input as unknown as ResidentGateResponseInput)).toThrow(
      "exactly one",
    );
  });
});

describe("the command resolver's default fetch", () => {
  it("is called with the global receiver, as a browser's Window.fetch requires", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = function strictFetch(this: unknown): Promise<Response> {
      if (this !== globalThis && this !== undefined) {
        return Promise.reject(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"));
      }
      return Promise.resolve(new Response(JSON.stringify(accepted("command-1")), { status: 200 }));
    } as typeof fetch;
    try {
      const commands = createFactoryCommands({ link: fakeLink([]), idGenerator: ids("command-1") });
      await expect(commands.interrupt("session-1").resolve()).resolves.toStrictEqual(accepted("command-1"));
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("message metadata on create and input", () => {
  it("sends optional metadata after blocks while absent metadata keeps the old bytes", () => {
    const commands = createFactoryCommands({ link: fakeLink([]), idGenerator: ids("c1", "s1", "c2", "c3") });
    const metadata: MessageMetadata = { space: "family", client: "oxy-ios" };
    const create = commands.create({ agentId: "agent-1", blocks: [{ type: "text", Text: "hi" }], metadata });
    const input = commands.input("s1", { blocks: [{ type: "text", Text: "more" }], metadata });
    const bare = commands.input("s1", { blocks: [{ type: "text", Text: "plain" }] });
    expect(create.request.metadata).toStrictEqual(metadata);
    expect(input.bytes).toBe('{"version":1,"command_id":"c2","session_id":"s1","blocks":[{"type":"text","Text":"more"}],"metadata":{"space":"family","client":"oxy-ios"}}');
    expect(bare.bytes).toBe('{"version":1,"command_id":"c3","session_id":"s1","blocks":[{"type":"text","Text":"plain"}]}');
    expect(() => validateFactory("create_request", create.request)).not.toThrow();
    expect(() => validateFactory("input_request", input.request)).not.toThrow();
    expect(() => validateFactory("input_request", bare.request)).not.toThrow();
  });

  it("never sends a caller-supplied principal", () => {
    const commands = createFactoryCommands({ link: fakeLink([]), idGenerator: ids("c1", "s1", "c2") });
    const principal = { tenant: "acme", subject: "someone-else", kind: "actor" };
    const create = commands.create({ agentId: "agent-1", principal } as never);
    const input = commands.input("s1", { blocks: [{ type: "text", Text: "x" }], principal } as never);
    expect(create.request).not.toHaveProperty("principal");
    expect(input.request).not.toHaveProperty("principal");
  });

  it("rejects Core-invalid metadata before minting an identity", () => {
    const generate = vi.fn(() => "id");
    const commands = createFactoryCommands({ link: fakeLink([]), idGenerator: generate });
    const cases: Array<[MessageMetadata, string]> = [
      [Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])), "too_many_fields"],
      [{ Space: "x" }, "invalid_key"],
      [{ ["k".repeat(65)]: "x" }, "invalid_key"],
      [{ looprig_x: "x" }, "reserved_key"],
      [{ note: "x".repeat(1025) }, "value_too_large"],
      [{ note: "a\u0000b" }, "invalid_value"],
      [{ note: "a\u0007b" }, "invalid_value"],
      [{ note: "\ud800" }, "invalid_value"],
      [Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, "<".repeat(170)])), "too_large"],
    ];
    for (const [fields, code] of cases) {
      expect(() => commands.input("s1", { blocks: [{ type: "text", Text: "x" }], metadata: fields }))
        .toThrowError(MessageMetadataError);
      try {
        commands.input("s1", { blocks: [{ type: "text", Text: "x" }], metadata: fields });
      } catch (error) {
        expect((error as MessageMetadataError).code).toBe(code);
      }
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it("retains the metadata values it validated when a caller getter changes", () => {
    let reads = 0;
    const fields = Object.defineProperty({}, "note", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "safe" : "bad\u0000value";
      },
    }) as MessageMetadata;
    const commands = createFactoryCommands({ link: fakeLink([]), idGenerator: ids("c1") });

    const pending = commands.input("s1", { blocks: [{ type: "text", Text: "x" }], metadata: fields });

    expect(reads).toBe(1);
    expect(pending.request.metadata).toStrictEqual({ note: "safe" });
    expect(() => validateFactory("input_request", pending.request)).not.toThrow();
  });

  it("accepts Core boundaries and omits an empty metadata object", () => {
    const commands = createFactoryCommands({ link: fakeLink([]), idGenerator: ids("c1", "c2") });
    const edge: MessageMetadata = {
      ["a".repeat(64)]: "x".repeat(1024),
      tabbed: "one\ttwo\nthree",
      k2: "é中",
    };
    const ok = commands.input("s1", { blocks: [{ type: "text", Text: "x" }], metadata: edge });
    expect(() => validateFactory("input_request", ok.request)).not.toThrow();
    const empty = commands.input("s1", { blocks: [{ type: "text", Text: "x" }], metadata: {} });
    expect(empty.request).not.toHaveProperty("metadata");
  });
});
