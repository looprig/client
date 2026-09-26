/**
 * The CSRF client half, against wui's REAL wire.
 *
 * `wui/csrf.go` + `wui/handler.go` mint a synchronizer token at
 * `GET /v1/csrf-token` and wrap the five state-changing control routes
 * (`POST /v1/sessions`, `.../restore`, `.../input`, `.../interrupt`,
 * `.../gates/{gid}`) in `CSRFGuard.Wrap`, which answers 403
 * `{"error":{"code":"csrf_invalid",...}}` to any of them arriving without a
 * live token in `X-CSRF-Token`. Without the client half below, EVERY control
 * request the SPA makes is a permanent 403 (00-plan.md §6.1).
 *
 * These tests drive `HostTransport`/`createHostTransport` — the browser-facing
 * transport for a wui-hosted server — against a `node:http` server that speaks
 * wui's own unprefixed `/v1/...` route shape and its exact rejection envelope,
 * so they exercise the real `fetch()`/`Response` codepath and the real header
 * name rather than a hand-rolled mock. `ServeTransport` (non-browser, direct to
 * `pkg/serve`, no wui guards in front of it) is deliberately NOT covered here:
 * its "carries no CSRF token" half lives in serve-transport.test.ts.
 *
 * Every assertion is made on a RECORDED request log after the call settles,
 * never with an `expect` inside the server handler — a failed expectation
 * inside a request handler surfaces as a hung or 500'd request, not as the
 * assertion that actually failed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHostTransport } from "../src/client.js";
import { CSRF_TOKEN_HEADER, HostTransport, type FetchLike } from "../src/transport.js";
import { CSRFRejectedError, OriginNotAllowedError } from "../src/errors.js";

const fixtureDir = fileURLToPath(new URL("../../../contract/fixtures/", import.meta.url));

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + file, "utf8"));
}

/** The session id every fixture in contract/fixtures/ is minted for. */
const SID = "00000000-0000-0000-0000-000000000000";

/** One observed request: enough to pin method, route and token carriage, and nothing else. */
interface Recorded {
  method: string;
  path: string;
  /** The `X-CSRF-Token` header value, or `undefined` when the request carried none. */
  token: string | undefined;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface Harness {
  baseUrl: string;
  server: Server;
  /** Every request the server saw, in arrival order. */
  log: Recorded[];
  /** How many times `GET /v1/csrf-token` was served. */
  mints: () => number;
}

/**
 * Starts a throwaway server speaking wui's route shape on an ephemeral port.
 * `GET /v1/csrf-token` is answered here (minting `token-1`, `token-2`, … so a
 * re-mint is observable as a DIFFERENT value, not merely a second request);
 * every other request goes to `handler`. Returns a base URL ending in `/v1`,
 * matching what a wui-hosted SPA resolves against.
 */
async function startHost(handler: Handler): Promise<Harness> {
  const log: Recorded[] = [];
  let mints = 0;
  const server = createServer((req, res) => {
    // The LITERAL wire header, deliberately not derived from
    // CSRF_TOKEN_HEADER: a recorder that reads whatever the constant happens
    // to say would follow the client into a drift away from wui/csrf.go's
    // CSRFHeaderName instead of catching it.
    const header = req.headers["x-csrf-token"];
    log.push({
      method: req.method ?? "",
      path: req.url ?? "",
      token: typeof header === "string" ? header : undefined,
    });
    if (req.method === "GET" && req.url === "/v1/csrf-token") {
      mints += 1;
      sendJSON(res, 200, { csrf_token: `token-${mints}` });
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server, log, mints: () => mints };
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** wui's own rejection envelope, byte-shaped like errors.go's writeError: NESTED under "error". */
function sendCSRFRejection(res: ServerResponse): void {
  sendJSON(res, 403, { error: { code: "csrf_invalid", message: "missing or invalid CSRF token", retryable: true } });
}

let activeServer: Server | undefined;

afterEach(async () => {
  if (activeServer !== undefined) {
    await new Promise<void>((resolve, reject) => activeServer!.close((err) => (err ? reject(err) : resolve())));
    activeServer = undefined;
  }
});

describe("HostTransport CSRF against wui's wire", () => {
  it("mints lazily from GET /v1/csrf-token on the first control request and echoes the token back on the POST", async () => {
    const harness = await startHost((_req, res) => sendJSON(res, 201, readFixture("create_idle.json")));
    activeServer = harness.server;

    const result = await createHostTransport({ baseUrl: harness.baseUrl }).createSession();

    expect(result).toStrictEqual(readFixture("create_idle.json"));
    expect(harness.log).toStrictEqual([
      // The mint itself carries no token — it is the request that obtains one.
      { method: "GET", path: "/v1/csrf-token", token: undefined },
      { method: "POST", path: "/v1/sessions", token: "token-1" },
    ]);
  });

  it("sends X-CSRF-Token on every one of the five state-changing control routes", async () => {
    const harness = await startHost((req, res) => {
      const path = req.url ?? "";
      if (path.endsWith("/restore")) return sendJSON(res, 200, readFixture("restore.json"));
      if (path.endsWith("/input")) return sendJSON(res, 202, readFixture("input.json"));
      if (path.endsWith("/interrupt")) return sendJSON(res, 202, readFixture("interrupt.json"));
      if (path.includes("/gates/")) return sendJSON(res, 202, readFixture("gate_accepted.json"));
      return sendJSON(res, 201, readFixture("create_idle.json"));
    });
    activeServer = harness.server;

    const transport = createHostTransport({ baseUrl: harness.baseUrl });
    await transport.createSession();
    await transport.restoreSession(SID);
    await transport.submit(SID, { blocks: [{ type: "text", text: "hi" }] });
    await transport.respondGate(SID, "gate-1", { action: "approve" });
    await transport.interrupt(SID);

    // Every control route wui wraps in CSRFGuard, in the order harness's
    // pkg/serve/mux.go registers them — each one carrying the token.
    expect(harness.log.filter((r) => r.method === "POST")).toStrictEqual([
      { method: "POST", path: "/v1/sessions", token: "token-1" },
      { method: "POST", path: `/v1/sessions/${SID}/restore`, token: "token-1" },
      { method: "POST", path: `/v1/sessions/${SID}/input`, token: "token-1" },
      { method: "POST", path: `/v1/sessions/${SID}/gates/gate-1`, token: "token-1" },
      { method: "POST", path: `/v1/sessions/${SID}/interrupt`, token: "token-1" },
    ]);
  });

  it("caches the token in memory: five control requests mint exactly once", async () => {
    const harness = await startHost((_req, res) => sendJSON(res, 201, readFixture("create_idle.json")));
    activeServer = harness.server;

    const transport = createHostTransport({ baseUrl: harness.baseUrl });
    for (let i = 0; i < 5; i += 1) {
      await transport.createSession();
    }

    expect(harness.mints()).toBe(1);
    expect(harness.log.filter((r) => r.path === "/v1/csrf-token")).toHaveLength(1);
  });

  it("triggers exactly ONE mint for N concurrent first control requests, and all N carry that one token", async () => {
    // The mint is deliberately slow so all five control requests are genuinely
    // in flight, cache empty, before any of them resolves: a per-request fetch
    // (or a cache written only after the first POST completes) mints five times.
    const harness = await startHostSlowMint((_req, res) => sendJSON(res, 201, readFixture("create_idle.json")));
    activeServer = harness.server;

    const transport = createHostTransport({ baseUrl: harness.baseUrl });
    await Promise.all([0, 1, 2, 3, 4].map(() => transport.createSession()));

    expect(harness.mints()).toBe(1);
    expect(harness.log.filter((r) => r.method === "POST").map((r) => r.token)).toStrictEqual([
      "token-1",
      "token-1",
      "token-1",
      "token-1",
      "token-1",
    ]);
  });

  it("never sends X-CSRF-Token on a read, and a read alone never mints a token", async () => {
    // wui's CSRFGuard.Wrap passes GET/HEAD through untouched (csrf.go's
    // isStateChangingMethod), and a browse-only page load must not spend a
    // round trip minting a credential it will never present.
    const harness = await startHost((req, res) => {
      const path = req.url ?? "";
      if (path.endsWith("/status")) return sendJSON(res, 200, readFixture("status_running.json"));
      if (path.includes("/journal")) return sendJSON(res, 200, readFixture("journal_page.json"));
      return sendJSON(res, 200, readFixture("session_list.json"));
    });
    activeServer = harness.server;

    const transport = createHostTransport({ baseUrl: harness.baseUrl });
    await transport.listSessions();
    await transport.readStatus(SID);
    await transport.readHistory(SID);

    expect(harness.mints()).toBe(0);
    expect(harness.log).toStrictEqual([
      { method: "GET", path: "/v1/sessions", token: undefined },
      { method: "GET", path: `/v1/sessions/${SID}/status`, token: undefined },
      { method: "GET", path: `/v1/sessions/${SID}/journal`, token: undefined },
    ]);
  });

  it("recovers from an expired token without a reload: re-mints once and retries the identical request once", async () => {
    // wui's tokens have a TTL and its store is bounded (csrf.go's
    // DefaultCSRFTokenTTL / maxCSRFTokens), so a long-lived tab WILL eventually
    // present a token the server no longer knows. This is the recovery path
    // codeCSRFInvalid's `retryable: true` documents.
    let posts = 0;
    const harness = await startHost((_req, res) => {
      posts += 1;
      if (posts === 1) return sendCSRFRejection(res);
      return sendJSON(res, 202, readFixture("input.json"));
    });
    activeServer = harness.server;

    const result = await createHostTransport({ baseUrl: harness.baseUrl }).submit(SID, {
      blocks: [{ type: "text", text: "hi" }],
    });

    expect(result).toStrictEqual(readFixture("input.json"));
    expect(harness.mints()).toBe(2);
    // The retry presents the FRESH token, not the rejected one — a retry that
    // replayed the stale token would 403 forever against a real wui.
    expect(harness.log.filter((r) => r.method === "POST").map((r) => r.token)).toStrictEqual(["token-1", "token-2"]);
  });

  it("caps the recovery at exactly one retry: a second csrf_invalid rejects, and no third request is ever sent", async () => {
    const harness = await startHost((_req, res) => sendCSRFRejection(res));
    activeServer = harness.server;

    const rejection = createHostTransport({ baseUrl: harness.baseUrl }).interrupt(SID);

    await expect(rejection).rejects.toBeInstanceOf(CSRFRejectedError);
    await expect(rejection).rejects.toMatchObject({ code: "csrf_invalid", status: 403 });
    expect(harness.log.filter((r) => r.method === "POST")).toHaveLength(2);
    expect(harness.mints()).toBe(2);
  });

  it("does NOT retry or re-mint on a non-CSRF 403 (origin_not_allowed is not retryable)", async () => {
    const harness = await startHost((_req, res) =>
      sendJSON(res, 403, { error: { code: "origin_not_allowed", message: "forbidden origin", retryable: false } }),
    );
    activeServer = harness.server;

    const rejection = createHostTransport({ baseUrl: harness.baseUrl }).interrupt(SID);

    await expect(rejection).rejects.toBeInstanceOf(OriginNotAllowedError);
    expect(harness.log.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(harness.mints()).toBe(1);
  });

  it("defaults to the same-origin /v1 prefix wui actually serves — no /api", async () => {
    // A wui-hosted SPA is served BY the process holding the rig: there is no
    // BFF and no "/api" prefix (00-plan.md §Architecture). A default of
    // "/api/v1" would resolve to wui's SPA catch-all and hand back index.html.
    const urls: string[] = [];
    const fetchImpl: FetchLike = (input) => {
      urls.push(input);
      const body = input.endsWith("/csrf-token") ? { csrf_token: "t" } : readFixture("create_idle.json");
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };

    await createHostTransport({ fetch: fetchImpl }).createSession();

    expect(urls).toStrictEqual(["/v1/csrf-token", "/v1/sessions"]);
  });

  it("pins the header name to wui's CSRFHeaderName constant", () => {
    // There is no runtime cross-check between wui/csrf.go's CSRFHeaderName and
    // this constant; a mismatch would make every control request fail
    // verification with no other symptom.
    expect(CSRF_TOKEN_HEADER).toBe("X-CSRF-Token");
  });

  it("is the transport createHostTransport constructs", () => {
    expect(createHostTransport()).toBeInstanceOf(HostTransport);
  });
});

/**
 * Same as `startHost`, but the mint response is delayed ~20ms — long enough
 * that every concurrent caller observes an empty cache before the first mint
 * settles. Separate helper, not a flag, so the fast path above stays fast.
 */
async function startHostSlowMint(handler: Handler): Promise<Harness> {
  const log: Recorded[] = [];
  let mints = 0;
  const server = createServer((req, res) => {
    // The LITERAL wire header, deliberately not derived from
    // CSRF_TOKEN_HEADER: a recorder that reads whatever the constant happens
    // to say would follow the client into a drift away from wui/csrf.go's
    // CSRFHeaderName instead of catching it.
    const header = req.headers["x-csrf-token"];
    log.push({
      method: req.method ?? "",
      path: req.url ?? "",
      token: typeof header === "string" ? header : undefined,
    });
    if (req.method === "GET" && req.url === "/v1/csrf-token") {
      mints += 1;
      const minted = mints;
      setTimeout(() => sendJSON(res, 200, { csrf_token: `token-${minted}` }), 20);
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server, log, mints: () => mints };
}
