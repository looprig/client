/**
 * `ServeTransport`-only coverage: the bearer-token auth header behavior that
 * has no BFFTransport equivalent (a browser transport carries no credential
 * of its own — see transport.ts's module doc), so it doesn't belong in the
 * shared conformance suite (conformance.test.ts), which is deliberately only
 * the intersection every LooprigTransport implementation must satisfy.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ServeTransport } from "../src/transport.js";

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
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server };
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

describe("ServeTransport authorization", () => {
  it("sends Authorization: Bearer <token> on a read (GET) request when a token is configured", async () => {
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.headers["authorization"]).toBe("Bearer secret-token");
      sendJSON(res, 200, readFixture("session_list.json"));
    });
    activeServer = server;

    const transport = new ServeTransport({ baseUrl, token: "secret-token" });
    await transport.listSessions();
  });

  it("sends Authorization: Bearer <token> on a control (POST) request when a token is configured", async () => {
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.headers["authorization"]).toBe("Bearer secret-token");
      sendJSON(res, 201, readFixture("create_idle.json"));
    });
    activeServer = server;

    const transport = new ServeTransport({ baseUrl, token: "secret-token" });
    await transport.createSession();
  });

  it("sends no Authorization header at all when no token is configured", async () => {
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.headers["authorization"]).toBeUndefined();
      sendJSON(res, 200, readFixture("session_list.json"));
    });
    activeServer = server;

    const transport = new ServeTransport({ baseUrl });
    await transport.listSessions();
  });

  it("sends BOTH Authorization and Idempotency-Key on createSession when both are configured", async () => {
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.headers["authorization"]).toBe("Bearer secret-token");
      expect(req.headers["idempotency-key"]).toBe("my-key");
      sendJSON(res, 201, readFixture("create_idle.json"));
    });
    activeServer = server;

    const transport = new ServeTransport({ baseUrl, token: "secret-token" });
    await transport.createSession(undefined, { idempotencyKey: "my-key" });
  });

  it("resolves paths against baseUrl with NO /api prefix, matching pkg/serve/mux.go's own unprefixed route table", async () => {
    const { baseUrl, server } = await startServer((req, res) => {
      expect(req.url).toBe("/v1/sessions");
      sendJSON(res, 200, readFixture("session_list.json"));
    });
    activeServer = server;

    const transport = new ServeTransport({ baseUrl });
    await transport.listSessions();
  });
});
