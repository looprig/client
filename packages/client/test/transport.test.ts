/**
 * HostTransport coverage against a REAL HTTP round trip: a tiny `node:http`
 * server stands in for the wui-hosted server (`wui/handler.go` mounts serve's
 * own unprefixed `/v1/...` routes, same-origin), so these tests exercise the
 * real `fetch()`/`Response` codepath rather than a hand-rolled fetch mock.
 * Node 22 (this repo's runtime — see packages/client/package.json's pinned
 * `@types/node`) ships both `fetch` and `AbortController` globally, so no
 * extra dependency is needed to drive either side of this.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostTransport, generateIdempotencyKey } from "../src/transport.js";
import { createFactoryClient } from "../src/client.js";
import { FactoryRestReads } from "../src/factory-rest.js";
import {
  CSRFRejectedError,
  GateCapacityError,
  IdempotencyConflictError,
  InternalServerError,
  InvalidBodyError,
  LooprigError,
  MalformedResponseError,
  NetworkError,
  OriginNotAllowedError,
  RequestAbortedError,
  SessionNotFoundError,
} from "../src/errors.js";
import { ContractValidationError } from "../src/validate.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + file, "utf8"));
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Suffix every CSRF token-minting request HostTransport issues ends in,
 * regardless of `baseUrl` (see transport.ts's `CSRF_TOKEN_PATH`).
 */
const CSRF_TOKEN_SUFFIX = "/csrf-token";

/**
 * Wraps handler so ANY GET request ending in CSRF_TOKEN_SUFFIX is answered
 * with a freshly minted token, transparently, before handler ever sees it —
 * so every control-plane (POST) test below doesn't have to know or care
 * that HostTransport now fetches/caches a CSRF token before its first
 * control request (Fix F). Tests that specifically exercise the CSRF
 * mint/retry/concurrency behavior itself (see the "HostTransport CSRF token"
 * describe block) bypass this wrapper and drive the token endpoint directly.
 */
function withCSRFTokenEndpoint(handler: Handler): Handler {
  let mintCount = 0;
  return (req, res) => {
    if (req.method === "GET" && req.url !== undefined && req.url.endsWith(CSRF_TOKEN_SUFFIX)) {
      mintCount += 1;
      sendJSON(res, 200, { csrf_token: `transport-test-csrf-token-${mintCount}` });
      return;
    }
    handler(req, res);
  };
}

/** Starts a throwaway HTTP server on an ephemeral port running `handler`, returning its base URL and a teardown. */
async function startServer(handler: Handler): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(withCSRFTokenEndpoint(handler));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server };
}

/** Same as startServer, but WITHOUT the CSRF token endpoint interception — for tests that drive the token endpoint (or its absence) directly. */
async function startServerRaw(handler: Handler): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server };
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Reads and JSON-parses req's full body (empty string decodes to `undefined`, matching "no body sent"). */
async function readJSONBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? undefined : JSON.parse(raw);
}

let activeServer: Server | undefined;

afterEach(async () => {
  if (activeServer !== undefined) {
    await new Promise<void>((resolve, reject) => activeServer!.close((err) => (err ? reject(err) : resolve())));
    activeServer = undefined;
  }
});

describe("HostTransport.listSessions", () => {
  it("parses and returns a valid session list", async () => {
    const fixture = readFixture("session_list.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/v1/sessions");
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.listSessions();

    expect(result).toEqual(fixture);
  });

  it("sends skip/limit as query parameters", async () => {
    const fixture = readFixture("session_list.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.url).toBe("/v1/sessions?skip=10&limit=25");
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    await transport.listSessions({ skip: 10, limit: 25 });
  });

  it("rejects with ContractValidationError when the response body fails schema validation, never passing unvalidated data through", async () => {
    const { baseUrl, server } = await startServer((_req, res) => {
      // Missing every required field of session_list.schema.json.
      sendJSON(res, 200, { unexpected: true });
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });

    await expect(transport.listSessions()).rejects.toBeInstanceOf(ContractValidationError);
  });
});

describe("Factory durable reads", () => {
  it("uses crypto.randomUUID by default for each command and the create SessionID", () => {
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const client = createFactoryClient({
      clientLinkFactory: () => ({
        get state() { return "disconnected" as const; },
        connect: async () => ({ version: 1 as const }),
        disconnect: () => undefined,
        subscribe: () => { throw new Error("unused"); },
        rpc: async () => { throw new Error("unused"); },
      }),
    });

    const pending = client.commands.create({ agentId: "agent-1" });

    expect(pending.commandId).toBe("00000000-0000-4000-8000-000000000001");
    expect(pending.sessionId).toBe("00000000-0000-4000-8000-000000000002");
    expect(randomUUID).toHaveBeenCalledTimes(2);
    randomUUID.mockRestore();
  });

  it("constructs one application ClientLink while status/list/journal/gate reads never open it", async () => {
    const responses = new Map<string, unknown>([
      ["/v1/agents?limit=10", readFixture("department_capability_summary.json")],
      ["/v1/sessions?limit=10", readFixture("recent_session_page.json")],
      ["/v1/sessions/session-1/status", readFixture("session_status.json")],
      ["/v1/sessions/session-1/journal?tail=25", readFixture("public_journal_page.json")],
      ["/v1/sessions/session-1/gates?limit=10", readFixture("public_gate_page.json")],
    ]);
    const urls: string[] = [];
    const authorization: Array<string | null> = [];
    let constructedLinks = 0;
    let connectedLinks = 0;
    const client = createFactoryClient({
      fetch: async (input, init) => {
        urls.push(input);
        authorization.push(new Headers(init?.headers).get("Authorization"));
        const body = responses.get(input);
        if (body === undefined) throw new Error(`unexpected read ${input}`);
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      credentials: { restHeaders: async () => ({ Authorization: "Bearer rotated" }) },
      clientLinkFactory: () => {
        constructedLinks += 1;
        return {
          get state() { return "disconnected" as const; },
          connect: async () => { connectedLinks += 1; return { version: 1 as const }; },
          disconnect: () => undefined,
          subscribe: () => { throw new Error("read opened a subscription"); },
          rpc: async () => { throw new Error("read issued an RPC"); },
        };
      },
      clock: () => 1234,
      idGenerator: () => "id-1",
    });

    await client.reads.listAgents({ limit: 10 });
    await client.reads.listRecentSessions({ limit: 10 });
    await client.reads.readStatus("session-1");
    await client.reads.readJournal("session-1", { tail: 25 });
    await client.reads.listGates("session-1", { limit: 10 });

    expect(urls).toStrictEqual([...responses.keys()]);
    expect(authorization).toStrictEqual(Array.from({ length: responses.size }, () => "Bearer rotated"));
    expect(constructedLinks).toBe(1);
    expect(connectedLinks).toBe(0);
    expect(client.clock()).toBe(1234);
    expect(client.idGenerator()).toBe("id-1");
  });

  it("validates the Department capability envelope before exposing agents", async () => {
    const reads = new FactoryRestReads({
      fetch: async () => new Response(JSON.stringify([readFixture("agent_capability_summary.json")]), { status: 200 }),
    });
    await expect(reads.listAgents()).rejects.toBeInstanceOf(ContractValidationError);
  });

  it("keeps URLs origin-relative by default, supports a headless base URL, and validates every JSON body", async () => {
    const requested: Array<{ input: string; init?: RequestInit }> = [];
    const client = createFactoryClient({
      baseUrl: "https://factory.example/base/",
      fetch: async (input, init) => {
        requested.push({ input, init });
        return new Response(JSON.stringify({ session_id: "session-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      clientLinkFactory: () => ({
        get state() { return "disconnected" as const; },
        connect: async () => ({ version: 1 as const }),
        disconnect: () => undefined,
        subscribe: () => { throw new Error("unused"); },
        rpc: async () => { throw new Error("unused"); },
      }),
    });

    await expect(client.reads.readStatus("session-1")).rejects.toBeInstanceOf(ContractValidationError);
    expect(requested[0]?.input).toBe("https://factory.example/base/v1/sessions/session-1/status");
  });

  it("validates object metadata and returns only the requested authorized byte range", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const metadata = readFixture("object_metadata.json");
    const client = createFactoryClient({
      fetch: async (input, init) => {
        calls.push({ input, init });
        if (input.endsWith("/metadata")) {
          return new Response(JSON.stringify(metadata), { status: 200 });
        }
        return new Response(new Uint8Array([2, 3, 4]), {
          status: 206,
          headers: { "Content-Range": "bytes 2-4/9", "Content-Type": "application/octet-stream" },
        });
      },
      clientLinkFactory: () => ({
        get state() { return "disconnected" as const; },
        connect: async () => ({ version: 1 as const }),
        disconnect: () => undefined,
        subscribe: () => { throw new Error("unused"); },
        rpc: async () => { throw new Error("unused"); },
      }),
    });

    await expect(client.reads.readObjectMetadata("session-1", "object/a")).resolves.toEqual(metadata);
    await expect(client.reads.readObjectRange("session-1", "object/a", { start: 2, end: 4 })).resolves.toEqual({
      bytes: new Uint8Array([2, 3, 4]),
      contentRange: "bytes 2-4/9",
      mediaType: "application/octet-stream",
    });
    expect(calls.map(({ input }) => input)).toStrictEqual([
      "/v1/sessions/session-1/objects/object%2Fa/metadata",
      "/v1/sessions/session-1/objects/object%2Fa",
    ]);
    expect(new Headers(calls[1]?.init?.headers).get("Range")).toBe("bytes=2-4");
  });
});

describe("HostTransport.readStatus", () => {
  it("parses and returns a valid session status", async () => {
    const fixture = readFixture("status_running.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.url).toBe("/v1/sessions/00000000-0000-0000-0000-000000000000/status");
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.readStatus("00000000-0000-0000-0000-000000000000");

    expect(result).toEqual(fixture);
  });
});

describe("HostTransport.readHistory", () => {
  it("parses and returns a valid journal page", async () => {
    const fixture = readFixture("journal_page.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.url).toBe(
        "/v1/sessions/00000000-0000-0000-0000-000000000000/journal?from_journal_seq=4&limit=50",
      );
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.readHistory("00000000-0000-0000-0000-000000000000", {
      fromJournalSeq: 4,
      limit: 50,
    });

    expect(result).toEqual(fixture);
  });
});

describe("HostTransport.createSession", () => {
  it("POSTs to /sessions with the request body and parses the response", async () => {
    const fixture = readFixture("create_with_command.json");
    const { baseUrl, server } = await startServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/sessions");
      expect(req.headers["content-type"]).toBe("application/json");
      const body = await readJSONBody(req);
      expect(body).toEqual({ blocks: [{ type: "text", text: "hi" }] });
      sendJSON(res, 201, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.createSession({ blocks: [{ type: "text", text: "hi" }] });

    expect(result).toEqual(fixture);
  });

  it("sends {} (never no body at all) for an idle create with no request argument", async () => {
    const fixture = readFixture("create_idle.json");
    const { baseUrl, server } = await startServer(async (req, res) => {
      const body = await readJSONBody(req);
      expect(body).toEqual({});
      sendJSON(res, 201, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.createSession();

    expect(result).toEqual(fixture);
  });

  it("sends no Idempotency-Key header when none is supplied", async () => {
    const fixture = readFixture("create_idle.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.headers["idempotency-key"]).toBeUndefined();
      sendJSON(res, 201, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    await transport.createSession();
  });

  it("forwards a caller-supplied Idempotency-Key verbatim", async () => {
    const fixture = readFixture("create_idle.json");
    const key = "caller-chosen-key-123";
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.headers["idempotency-key"]).toBe(key);
      sendJSON(res, 201, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    await transport.createSession(undefined, { idempotencyKey: key });
  });

  it("generateIdempotencyKey() mints a value usable as idempotencyKey, and different calls mint different values", async () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a).not.toBe(b);
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);

    const fixture = readFixture("create_idle.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.headers["idempotency-key"]).toBe(a);
      sendJSON(res, 201, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    await transport.createSession(undefined, { idempotencyKey: a });
  });
});

describe("HostTransport.restoreSession", () => {
  it("POSTs to /sessions/{sid}/restore with no body and parses the response", async () => {
    const fixture = readFixture("restore.json");
    const { baseUrl, server } = await startServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/sessions/00000000-0000-0000-0000-000000000000/restore");
      const body = await readJSONBody(req);
      expect(body).toBeUndefined();
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.restoreSession("00000000-0000-0000-0000-000000000000");

    expect(result).toEqual(fixture);
  });

  it("never sends an Idempotency-Key header — harness's handleRestore never reads one (only handleCreate does)", async () => {
    const fixture = readFixture("restore.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.headers["idempotency-key"]).toBeUndefined();
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    await transport.restoreSession("00000000-0000-0000-0000-000000000000");
  });
});

describe("HostTransport.submit", () => {
  it("POSTs to /sessions/{sid}/input with the request body and parses the response", async () => {
    const fixture = readFixture("input.json");
    const { baseUrl, server } = await startServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/sessions/00000000-0000-0000-0000-000000000000/input");
      const body = await readJSONBody(req);
      expect(body).toEqual({ blocks: [{ type: "text", text: "hello" }] });
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.submit("00000000-0000-0000-0000-000000000000", {
      blocks: [{ type: "text", text: "hello" }],
    });

    expect(result).toEqual(fixture);
  });
});

describe("HostTransport.interrupt", () => {
  it("POSTs to /sessions/{sid}/interrupt with no body and parses the response", async () => {
    const fixture = readFixture("interrupt.json");
    const { baseUrl, server } = await startServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/sessions/00000000-0000-0000-0000-000000000000/interrupt");
      const body = await readJSONBody(req);
      expect(body).toBeUndefined();
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.interrupt("00000000-0000-0000-0000-000000000000");

    expect(result).toEqual(fixture);
  });
});

describe("HostTransport.respondGate", () => {
  it("POSTs to /sessions/{sid}/gates/{gid} with the request body and parses the response", async () => {
    const fixture = readFixture("gate_accepted.json");
    const { baseUrl, server } = await startServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/sessions/00000000-0000-0000-0000-000000000000/gates/gate-1");
      const body = await readJSONBody(req);
      expect(body).toEqual({ action: "approve", values: { scope: "session" } });
      sendJSON(res, 202, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.respondGate("00000000-0000-0000-0000-000000000000", "gate-1", {
      action: "approve",
      values: { scope: "session" },
    });

    expect(result).toEqual(fixture);
  });

  it("treats the gate id as an opaque string — passed through verbatim (percent-encoded for URL-safety only, never parsed/split/format-checked)", async () => {
    // A gate id containing characters that would matter to a naive parser
    // (a slash, a query-string-looking "?", a fragment-looking "#") — if
    // respondGate ever inspected or reformatted it, one of these would be
    // stripped, split on, or otherwise mangled. Round-tripping it through
    // encodeURIComponent/decodeURIComponent (the SAME escaping sessionId
    // already gets) and observing the server sees the exact original string
    // back proves no parsing/transformation happened.
    const weirdGateId = "weird/gate?id#with spaces&stuff=1";
    const fixture = readFixture("gate_accepted.json");
    const { baseUrl, server } = await startServer((req, res) => {
      const urlPath = req.url ?? "";
      const expectedPath = `/v1/sessions/00000000-0000-0000-0000-000000000000/gates/${encodeURIComponent(weirdGateId)}`;
      expect(urlPath).toBe(expectedPath);
      // Decode the path segment the server actually received and confirm it
      // is byte-for-content identical to the original — nothing was dropped,
      // reordered, or reinterpreted along the way.
      const gidSegment = urlPath.split("/gates/")[1];
      expect(gidSegment).toBeDefined();
      expect(decodeURIComponent(gidSegment as string)).toBe(weirdGateId);
      sendJSON(res, 202, fixture);
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.respondGate("00000000-0000-0000-0000-000000000000", weirdGateId, {
      action: "approve",
    });

    expect(result).toEqual(fixture);
  });
});

describe("HostTransport error envelope mapping (real HTTP round trip)", () => {
  const cases = [
    { file: "error_400.json", status: 400, ctor: InvalidBodyError, code: "invalid_body" },
    { file: "error_404.json", status: 404, ctor: SessionNotFoundError, code: "session_not_found" },
    { file: "error_409.json", status: 409, ctor: IdempotencyConflictError, code: "idempotency_conflict" },
    { file: "error_500.json", status: 500, ctor: InternalServerError, code: "internal" },
    { file: "error_503.json", status: 503, ctor: GateCapacityError, code: "gate_capacity" },
  ] as const;

  for (const { file, status, ctor, code } of cases) {
    it(`HTTP ${status} (${file}) rejects listSessions() with ${ctor.name}`, async () => {
      const fixture = readFixture(file);
      const { baseUrl, server } = await startServer((_req, res) => {
        sendJSON(res, status, fixture);
      });
      activeServer = server;

      const transport = new HostTransport({ baseUrl });

      const rejection = transport.listSessions();
      await expect(rejection).rejects.toBeInstanceOf(ctor);
      await rejection.catch((err: InstanceType<typeof ctor>) => {
        expect(err.code).toBe(code);
        expect(err.status).toBe(status);
      });
    });
  }

  // The same 5 codes, reused (Task 16's established pattern) against a POST
  // control route — createSession — to prove the error-envelope mapping is
  // NOT a GET-only codepath. It shares the exact same private sendRequest
  // plumbing as listSessions (see transport.ts's HttpTransport), so this also
  // guards against a future refactor accidentally special-casing GET.
  for (const { file, status, ctor, code } of cases) {
    it(`HTTP ${status} (${file}) rejects createSession() with ${ctor.name}`, async () => {
      const fixture = readFixture(file);
      const { baseUrl, server } = await startServer((_req, res) => {
        sendJSON(res, status, fixture);
      });
      activeServer = server;

      const transport = new HostTransport({ baseUrl });

      const rejection = transport.createSession();
      await expect(rejection).rejects.toBeInstanceOf(ctor);
      await rejection.catch((err: InstanceType<typeof ctor>) => {
        expect(err.code).toBe(code);
        expect(err.status).toBe(status);
      });
    });
  }
});

describe("HostTransport malformed error envelope handling", () => {
  it("falls back to MalformedResponseError (not ContractValidationError, not a LooprigError subclass) when a non-2xx body is valid JSON but doesn't match the error_response schema", async () => {
    const { baseUrl, server } = await startServer((_req, res) => {
      // Well-formed JSON, but not the {error:{code,message,retryable}}
      // envelope — e.g. an infrastructure proxy/load balancer's own error
      // shape for a 502, rather than the server itself ever handling the request.
      sendJSON(res, 502, { message: "Bad Gateway" });
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });

    const rejection = transport.listSessions();
    await expect(rejection).rejects.toBeInstanceOf(MalformedResponseError);
    await expect(rejection).rejects.not.toBeInstanceOf(ContractValidationError);
    await expect(rejection).rejects.not.toBeInstanceOf(LooprigError);
    await rejection.catch((err: MalformedResponseError) => {
      expect(err.status).toBe(502);
    });
  });
});

describe("HostTransport abort handling", () => {
  it("rejects with RequestAbortedError, not a generic network error, when the signal is already aborted", async () => {
    const { baseUrl, server } = await startServer((_req, res) => {
      sendJSON(res, 200, readFixture("session_list.json"));
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const controller = new AbortController();
    controller.abort();

    const rejection = transport.listSessions({ signal: controller.signal });
    await expect(rejection).rejects.toBeInstanceOf(RequestAbortedError);
    await expect(rejection).rejects.not.toBeInstanceOf(NetworkError);
  });

  it("rejects promptly with RequestAbortedError when aborted mid-flight, without waiting for the server", async () => {
    const { baseUrl, server } = await startServer((_req, res) => {
      // Never respond within the test's lifetime — proves the rejection
      // comes from the abort, not from the server eventually answering.
      const neverResolve = setTimeout(() => sendJSON(res, 200, readFixture("session_list.json")), 60_000);
      neverResolve.unref();
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const controller = new AbortController();

    const started = Date.now();
    const rejection = transport.listSessions({ signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    await expect(rejection).rejects.toBeInstanceOf(RequestAbortedError);
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("rejects a control (POST) method with RequestAbortedError when the signal is already aborted — abort handling is not read-only", async () => {
    const { baseUrl, server } = await startServer((_req, res) => {
      sendJSON(res, 201, readFixture("create_idle.json"));
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const controller = new AbortController();
    controller.abort();

    const rejection = transport.createSession(undefined, { signal: controller.signal });
    await expect(rejection).rejects.toBeInstanceOf(RequestAbortedError);
    await expect(rejection).rejects.not.toBeInstanceOf(NetworkError);
  });

  it("rejects a control (POST) method promptly with RequestAbortedError when aborted mid-flight", async () => {
    const { baseUrl, server } = await startServer((_req, res) => {
      const neverResolve = setTimeout(() => sendJSON(res, 201, readFixture("create_idle.json")), 60_000);
      neverResolve.unref();
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const controller = new AbortController();

    const started = Date.now();
    const rejection = transport.createSession(undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    await expect(rejection).rejects.toBeInstanceOf(RequestAbortedError);
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe("HostTransport network failure", () => {
  it("rejects with NetworkError (not RequestAbortedError) when the server is unreachable", async () => {
    // Nothing listens on this port: connection refused, no abort involved.
    const transport = new HostTransport({ baseUrl: "http://127.0.0.1:1/v1" });

    const rejection = transport.listSessions();
    await expect(rejection).rejects.toBeInstanceOf(NetworkError);
    await expect(rejection).rejects.not.toBeInstanceOf(RequestAbortedError);
  });

  it("rejects a control (POST) method with NetworkError when the server is unreachable", async () => {
    const transport = new HostTransport({ baseUrl: "http://127.0.0.1:1/v1" });

    const rejection = transport.createSession();
    await expect(rejection).rejects.toBeInstanceOf(NetworkError);
    await expect(rejection).rejects.not.toBeInstanceOf(RequestAbortedError);
  });
});

// These tests drive the CSRF token endpoint (and its interaction with a
// control request) directly, via startServerRaw — NOT the withCSRFTokenEndpoint
// auto-mint wrapper every OTHER control-plane test above uses — because they
// need to control exactly how many times it's hit, what it returns, and in
// what order relative to the control POST.
describe("HostTransport CSRF token", () => {
  const sid = "00000000-0000-0000-0000-000000000000";

  it("full round trip: mints a token lazily on the first control request, echoes it on X-CSRF-Token, and caches it (no second mint on a later control request)", async () => {
    let tokenRequests = 0;
    let firstPostToken: string | undefined;
    let secondPostToken: string | undefined;
    let postCount = 0;
    const { baseUrl, server } = await startServerRaw((req, res) => {
      if (req.method === "GET" && req.url === "/v1/csrf-token") {
        tokenRequests += 1;
        sendJSON(res, 200, { csrf_token: "the-real-token" });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/sessions") {
        postCount += 1;
        const token = req.headers["x-csrf-token"] as string | undefined;
        if (postCount === 1) {
          firstPostToken = token;
        } else {
          secondPostToken = token;
        }
        sendJSON(res, 201, readFixture("create_idle.json"));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });

    // No mint at construction — see HostTransport's constructor doc.
    expect(tokenRequests).toBe(0);

    const result = await transport.createSession();
    expect(result).toEqual(readFixture("create_idle.json"));
    expect(tokenRequests).toBe(1);
    expect(firstPostToken).toBe("the-real-token");

    // A second control request reuses the cached token — no second mint.
    await transport.createSession();
    expect(tokenRequests).toBe(1);
    expect(secondPostToken).toBe("the-real-token");
  });

  it("retries exactly once after a csrf_invalid rejection, re-mints, and succeeds with the fresh token", async () => {
    let tokenCount = 0;
    let postCount = 0;
    const seenTokens: (string | undefined)[] = [];
    const { baseUrl, server } = await startServerRaw((req, res) => {
      if (req.method === "GET" && req.url === "/v1/csrf-token") {
        tokenCount += 1;
        sendJSON(res, 200, { csrf_token: `token-${tokenCount}` });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/sessions") {
        postCount += 1;
        seenTokens.push(req.headers["x-csrf-token"] as string | undefined);
        if (postCount === 1) {
          sendJSON(res, 403, { error: { code: "csrf_invalid", message: "token expired", retryable: true } });
          return;
        }
        sendJSON(res, 201, readFixture("create_idle.json"));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const result = await transport.createSession();

    expect(result).toEqual(readFixture("create_idle.json"));
    expect(postCount).toBe(2);
    expect(tokenCount).toBe(2); // one mint for the original attempt, one re-mint for the retry
    expect(seenTokens).toEqual(["token-1", "token-2"]); // retry used the FRESH token, not the stale one
  });

  it("caps CSRF retry at exactly one attempt — never loops, even if every attempt is rejected", async () => {
    let postCount = 0;
    let tokenCount = 0;
    const { baseUrl, server } = await startServerRaw((req, res) => {
      if (req.method === "GET" && req.url === "/v1/csrf-token") {
        tokenCount += 1;
        sendJSON(res, 200, { csrf_token: `always-rejected-${tokenCount}` });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/sessions") {
        postCount += 1;
        sendJSON(res, 403, { error: { code: "csrf_invalid", message: "nope", retryable: true } });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const rejection = transport.createSession();
    await expect(rejection).rejects.toBeInstanceOf(CSRFRejectedError);

    // Exactly original + one retry, never a third attempt.
    expect(postCount).toBe(2);
    expect(tokenCount).toBe(2);
  });

  it("does NOT retry on a non-CSRF 403 (origin_not_allowed)", async () => {
    let postCount = 0;
    const { baseUrl, server } = await startServerRaw((req, res) => {
      if (req.method === "GET" && req.url === "/v1/csrf-token") {
        sendJSON(res, 200, { csrf_token: "irrelevant" });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/sessions") {
        postCount += 1;
        sendJSON(res, 403, { error: { code: "origin_not_allowed", message: "host not allowed", retryable: false } });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const rejection = transport.createSession();

    await expect(rejection).rejects.toBeInstanceOf(OriginNotAllowedError);
    await expect(rejection).rejects.not.toBeInstanceOf(CSRFRejectedError);
    expect(postCount).toBe(1); // never retried
  });

  it("shares exactly one in-flight mint across N concurrent control requests", async () => {
    let tokenRequests = 0;
    const { baseUrl, server } = await startServerRaw((req, res) => {
      if (req.method === "GET" && req.url === "/v1/csrf-token") {
        tokenRequests += 1;
        // A small delay so the concurrent callers below genuinely overlap
        // rather than serializing by accident.
        setTimeout(() => sendJSON(res, 200, { csrf_token: "shared-token" }), 20);
        return;
      }
      if (req.method === "POST" && req.url === `/v1/sessions/${sid}/input`) {
        sendJSON(res, 200, readFixture("input.json"));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    const concurrentCallCount = 5;
    await Promise.all(
      Array.from({ length: concurrentCallCount }, () =>
        transport.submit(sid, { blocks: [{ type: "text", text: "hi" }] }),
      ),
    );

    expect(tokenRequests).toBe(1);
  });

  it("createSession's retry generates and reuses ONE Idempotency-Key when the caller supplied none — the rejected original attempt carries no key at all", async () => {
    let postCount = 0;
    let tokenCount = 0;
    const seenKeys: (string | undefined)[] = [];
    const { baseUrl, server } = await startServerRaw((req, res) => {
      if (req.method === "GET" && req.url === "/v1/csrf-token") {
        tokenCount += 1;
        sendJSON(res, 200, { csrf_token: `k-${tokenCount}` });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/sessions") {
        postCount += 1;
        seenKeys.push(req.headers["idempotency-key"] as string | undefined);
        if (postCount === 1) {
          sendJSON(res, 403, { error: { code: "csrf_invalid", message: "expired", retryable: true } });
          return;
        }
        sendJSON(res, 201, readFixture("create_idle.json"));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    await transport.createSession();

    expect(postCount).toBe(2);
    expect(seenKeys[0]).toBeUndefined(); // original attempt: no key — it never reached serve (CSRFGuard rejected it first), so no session was ever at risk
    expect(seenKeys[1]).not.toBeUndefined(); // retry: a key was generated so it can never spawn a second session if retried again
    expect(typeof seenKeys[1]).toBe("string");
  });

  it("createSession's retry reuses a CALLER-SUPPLIED Idempotency-Key verbatim — never replaces it", async () => {
    let postCount = 0;
    let tokenCount = 0;
    const seenKeys: (string | undefined)[] = [];
    const callerKey = "caller-chosen-key-abc";
    const { baseUrl, server } = await startServerRaw((req, res) => {
      if (req.method === "GET" && req.url === "/v1/csrf-token") {
        tokenCount += 1;
        sendJSON(res, 200, { csrf_token: `k-${tokenCount}` });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/sessions") {
        postCount += 1;
        seenKeys.push(req.headers["idempotency-key"] as string | undefined);
        if (postCount === 1) {
          sendJSON(res, 403, { error: { code: "csrf_invalid", message: "expired", retryable: true } });
          return;
        }
        sendJSON(res, 201, readFixture("create_idle.json"));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServer = server;

    const transport = new HostTransport({ baseUrl });
    await transport.createSession(undefined, { idempotencyKey: callerKey });

    expect(postCount).toBe(2);
    expect(seenKeys[0]).toBe(callerKey);
    expect(seenKeys[1]).toBe(callerKey); // retry reused the SAME caller-supplied key, not a freshly generated one
  });

  it("generateIdempotencyKey() mints distinct values (sanity check the generator used for the retry-safety guarantee above is genuinely random per call)", () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a).not.toBe(b);
  });
});
