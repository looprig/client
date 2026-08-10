/**
 * Shared conformance suite for every `LooprigTransport` implementation.
 *
 * `runConformanceSuite` below is written ONCE and invoked twice — once for
 * `BFFTransport` (mounted under `/api/v1`, matching `internal/bff/mux.go`)
 * and once for `ServeTransport` (mounted under `/v1`, matching
 * `pkg/serve/mux.go`'s own unprefixed route table) — against a real
 * `node:http` server, so both implementations are proven to satisfy the
 * EXACT SAME `LooprigTransport` contract rather than two independently
 * hand-written test files that could quietly diverge from each other.
 *
 * This genuinely exercises the URL scheme, not just "does it return the right
 * type": every request assertion below is built from `t.urlPrefix`, so if
 * `ServeTransport` shipped with a subtly wrong prefix (e.g. it forgot to omit
 * "/api", or added a trailing slash BFFTransport doesn't have), the SAME
 * assertion that already passes for BFFTransport would fail for ServeTransport
 * — proving the two are held to one shared standard, not eyeballed
 * independently. (transport.test.ts separately covers `BFFTransport`-only
 * concerns — response validation edge cases, the Idempotency-Key mechanics
 * specific to the BFF's proxy, gate-id opacity — in more depth; this suite is
 * deliberately the intersection every transport must pass, not the union of
 * everything either one is tested for.)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BFFTransport, ServeTransport, type LooprigTransport } from "../src/transport.js";
import {
  GateCapacityError,
  IdempotencyConflictError,
  InternalServerError,
  InvalidBodyError,
  RequestAbortedError,
  SessionNotFoundError,
} from "../src/errors.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + file, "utf8"));
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function startServer(handler: Handler): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

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

interface TransportUnderTest {
  name: string;
  /** The path prefix this transport's own routing convention prepends before "/sessions...". */
  urlPrefix: string;
  create: (host: string) => LooprigTransport;
}

const transportsUnderTest: TransportUnderTest[] = [
  {
    name: "BFFTransport",
    urlPrefix: "/api/v1",
    create: (host) => new BFFTransport({ baseUrl: `${host}/api/v1` }),
  },
  {
    name: "ServeTransport",
    urlPrefix: "/v1",
    create: (host) => new ServeTransport({ baseUrl: `${host}/v1`, token: "test-token" }),
  },
];

const sid = "00000000-0000-0000-0000-000000000000";

function runConformanceSuite(t: TransportUnderTest): void {
  describe(`${t.name} conformance (LooprigTransport contract)`, () => {
    it("listSessions: GET {prefix}/sessions, parses a valid session list", async () => {
      const fixture = readFixture("session_list.json");
      const { baseUrl, server } = await startServer((req, res) => {
        expect(req.method).toBe("GET");
        expect(req.url).toBe(`${t.urlPrefix}/sessions`);
        sendJSON(res, 200, fixture);
      });
      activeServer = server;

      const result = await t.create(baseUrl).listSessions();
      expect(result).toEqual(fixture);
    });

    it("readStatus: GET {prefix}/sessions/{sid}/status, parses a valid status", async () => {
      const fixture = readFixture("status_running.json");
      const { baseUrl, server } = await startServer((req, res) => {
        expect(req.method).toBe("GET");
        expect(req.url).toBe(`${t.urlPrefix}/sessions/${sid}/status`);
        sendJSON(res, 200, fixture);
      });
      activeServer = server;

      const result = await t.create(baseUrl).readStatus(sid);
      expect(result).toEqual(fixture);
    });

    it("readHistory: GET {prefix}/sessions/{sid}/journal, parses a valid journal page", async () => {
      const fixture = readFixture("journal_page.json");
      const { baseUrl, server } = await startServer((req, res) => {
        expect(req.method).toBe("GET");
        expect(req.url).toBe(`${t.urlPrefix}/sessions/${sid}/journal`);
        sendJSON(res, 200, fixture);
      });
      activeServer = server;

      const result = await t.create(baseUrl).readHistory(sid);
      expect(result).toEqual(fixture);
    });

    it("createSession: POST {prefix}/sessions, sends the body, parses the response", async () => {
      const fixture = readFixture("create_with_command.json");
      const { baseUrl, server } = await startServer(async (req, res) => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe(`${t.urlPrefix}/sessions`);
        const body = await readJSONBody(req);
        expect(body).toEqual({ blocks: [{ type: "text", text: "hi" }] });
        sendJSON(res, 201, fixture);
      });
      activeServer = server;

      const result = await t.create(baseUrl).createSession({ blocks: [{ type: "text", text: "hi" }] });
      expect(result).toEqual(fixture);
    });

    it("restoreSession: POST {prefix}/sessions/{sid}/restore, parses the response", async () => {
      const fixture = readFixture("restore.json");
      const { baseUrl, server } = await startServer((req, res) => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe(`${t.urlPrefix}/sessions/${sid}/restore`);
        sendJSON(res, 200, fixture);
      });
      activeServer = server;

      const result = await t.create(baseUrl).restoreSession(sid);
      expect(result).toEqual(fixture);
    });

    it("submit: POST {prefix}/sessions/{sid}/input, sends the body, parses the response", async () => {
      const fixture = readFixture("input.json");
      const { baseUrl, server } = await startServer(async (req, res) => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe(`${t.urlPrefix}/sessions/${sid}/input`);
        const body = await readJSONBody(req);
        expect(body).toEqual({ blocks: [{ type: "text", text: "hello" }] });
        sendJSON(res, 200, fixture);
      });
      activeServer = server;

      const result = await t.create(baseUrl).submit(sid, { blocks: [{ type: "text", text: "hello" }] });
      expect(result).toEqual(fixture);
    });

    it("respondGate: POST {prefix}/sessions/{sid}/gates/{gid}, sends the body, parses the response", async () => {
      const fixture = readFixture("gate_accepted.json");
      const { baseUrl, server } = await startServer(async (req, res) => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe(`${t.urlPrefix}/sessions/${sid}/gates/gate-1`);
        const body = await readJSONBody(req);
        expect(body).toEqual({ action: "approve" });
        sendJSON(res, 202, fixture);
      });
      activeServer = server;

      const result = await t.create(baseUrl).respondGate(sid, "gate-1", { action: "approve" });
      expect(result).toEqual(fixture);
    });

    it("interrupt: POST {prefix}/sessions/{sid}/interrupt, parses the response", async () => {
      const fixture = readFixture("interrupt.json");
      const { baseUrl, server } = await startServer((req, res) => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe(`${t.urlPrefix}/sessions/${sid}/interrupt`);
        sendJSON(res, 200, fixture);
      });
      activeServer = server;

      const result = await t.create(baseUrl).interrupt(sid);
      expect(result).toEqual(fixture);
    });

    describe("error envelope mapping", () => {
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

          const rejection = t.create(baseUrl).listSessions();
          await expect(rejection).rejects.toBeInstanceOf(ctor);
          await rejection.catch((err: InstanceType<typeof ctor>) => {
            expect(err.code).toBe(code);
            expect(err.status).toBe(status);
          });
        });

        it(`HTTP ${status} (${file}) rejects createSession() with ${ctor.name}`, async () => {
          const fixture = readFixture(file);
          const { baseUrl, server } = await startServer((_req, res) => {
            sendJSON(res, status, fixture);
          });
          activeServer = server;

          const rejection = t.create(baseUrl).createSession();
          await expect(rejection).rejects.toBeInstanceOf(ctor);
          await rejection.catch((err: InstanceType<typeof ctor>) => {
            expect(err.code).toBe(code);
            expect(err.status).toBe(status);
          });
        });
      }
    });

    describe("abort handling", () => {
      it("listSessions rejects with RequestAbortedError when the signal is already aborted", async () => {
        const { baseUrl, server } = await startServer((_req, res) => {
          sendJSON(res, 200, readFixture("session_list.json"));
        });
        activeServer = server;

        const controller = new AbortController();
        controller.abort();

        const rejection = t.create(baseUrl).listSessions({ signal: controller.signal });
        await expect(rejection).rejects.toBeInstanceOf(RequestAbortedError);
      });

      it("createSession rejects with RequestAbortedError when the signal is already aborted", async () => {
        const { baseUrl, server } = await startServer((_req, res) => {
          sendJSON(res, 201, readFixture("create_idle.json"));
        });
        activeServer = server;

        const controller = new AbortController();
        controller.abort();

        const rejection = t.create(baseUrl).createSession(undefined, { signal: controller.signal });
        await expect(rejection).rejects.toBeInstanceOf(RequestAbortedError);
      });
    });
  });
}

for (const t of transportsUnderTest) {
  runConformanceSuite(t);
}
