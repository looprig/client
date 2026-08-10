/**
 * BFFTransport coverage against a REAL HTTP round trip: a tiny `node:http`
 * server stands in for the BFF (`internal/bff/mux.go` forwards `/api/*`,
 * prefix-stripped, to serve's own read plane), so these tests exercise the
 * real `fetch()`/`Response` codepath rather than a hand-rolled fetch mock.
 * Node 22 (this repo's runtime — see sdk/core/package.json's pinned
 * `@types/node`) ships both `fetch` and `AbortController` globally, so no
 * extra dependency is needed to drive either side of this.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BFFTransport } from "../src/transport.js";
import {
  GateCapacityError,
  IdempotencyConflictError,
  InternalServerError,
  InvalidBodyError,
  NetworkError,
  RequestAbortedError,
  SessionNotFoundError,
} from "../src/errors.js";
import { ContractValidationError } from "../src/validate.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + file, "utf8"));
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Starts a throwaway HTTP server on an ephemeral port running `handler`, returning its base URL and a teardown. */
async function startServer(handler: Handler): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/api/v1`, server };
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

let activeServer: Server | undefined;

afterEach(async () => {
  if (activeServer !== undefined) {
    await new Promise<void>((resolve, reject) => activeServer!.close((err) => (err ? reject(err) : resolve())));
    activeServer = undefined;
  }
});

describe("BFFTransport.listSessions", () => {
  it("parses and returns a valid session list", async () => {
    const fixture = readFixture("session_list.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/api/v1/sessions");
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new BFFTransport({ baseUrl });
    const result = await transport.listSessions();

    expect(result).toEqual(fixture);
  });

  it("sends skip/limit as query parameters", async () => {
    const fixture = readFixture("session_list.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.url).toBe("/api/v1/sessions?skip=10&limit=25");
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new BFFTransport({ baseUrl });
    await transport.listSessions({ skip: 10, limit: 25 });
  });

  it("rejects with ContractValidationError when the response body fails schema validation, never passing unvalidated data through", async () => {
    const { baseUrl, server } = await startServer((_req, res) => {
      // Missing every required field of session_list.schema.json.
      sendJSON(res, 200, { unexpected: true });
    });
    activeServer = server;

    const transport = new BFFTransport({ baseUrl });

    await expect(transport.listSessions()).rejects.toBeInstanceOf(ContractValidationError);
  });
});

describe("BFFTransport.readStatus", () => {
  it("parses and returns a valid session status", async () => {
    const fixture = readFixture("status_running.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.url).toBe("/api/v1/sessions/00000000-0000-0000-0000-000000000000/status");
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new BFFTransport({ baseUrl });
    const result = await transport.readStatus("00000000-0000-0000-0000-000000000000");

    expect(result).toEqual(fixture);
  });
});

describe("BFFTransport.readHistory", () => {
  it("parses and returns a valid journal page", async () => {
    const fixture = readFixture("journal_page.json");
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.url).toBe(
        "/api/v1/sessions/00000000-0000-0000-0000-000000000000/journal?from_journal_seq=4&limit=50",
      );
      sendJSON(res, 200, fixture);
    });
    activeServer = server;

    const transport = new BFFTransport({ baseUrl });
    const result = await transport.readHistory("00000000-0000-0000-0000-000000000000", {
      fromJournalSeq: 4,
      limit: 50,
    });

    expect(result).toEqual(fixture);
  });
});

describe("BFFTransport error envelope mapping (real HTTP round trip)", () => {
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

      const transport = new BFFTransport({ baseUrl });

      const rejection = transport.listSessions();
      await expect(rejection).rejects.toBeInstanceOf(ctor);
      await rejection.catch((err: InstanceType<typeof ctor>) => {
        expect(err.code).toBe(code);
        expect(err.status).toBe(status);
      });
    });
  }
});

describe("BFFTransport abort handling", () => {
  it("rejects with RequestAbortedError, not a generic network error, when the signal is already aborted", async () => {
    const { baseUrl, server } = await startServer((_req, res) => {
      sendJSON(res, 200, readFixture("session_list.json"));
    });
    activeServer = server;

    const transport = new BFFTransport({ baseUrl });
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

    const transport = new BFFTransport({ baseUrl });
    const controller = new AbortController();

    const started = Date.now();
    const rejection = transport.listSessions({ signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    await expect(rejection).rejects.toBeInstanceOf(RequestAbortedError);
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe("BFFTransport network failure", () => {
  it("rejects with NetworkError (not RequestAbortedError) when the server is unreachable", async () => {
    // Nothing listens on this port: connection refused, no abort involved.
    const transport = new BFFTransport({ baseUrl: "http://127.0.0.1:1/api/v1" });

    const rejection = transport.listSessions();
    await expect(rejection).rejects.toBeInstanceOf(NetworkError);
    await expect(rejection).rejects.not.toBeInstanceOf(RequestAbortedError);
  });
});
