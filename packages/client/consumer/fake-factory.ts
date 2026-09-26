/**
 * A fake Factory REST endpoint, spoken over a real `node:http` server.
 *
 * WHY A REAL SERVER, NOT A FAKE `FactoryReads`. The runbook asks for a "fake
 * Factory REST/ClientLink pair", and the weakest way to build one is an object
 * literal shaped like `FactoryReads`: a double whose shape was chosen by the
 * test rather than by the type it stands in for. Such a double would let the
 * consumer exercise `join` while `FactoryRestReads` -- the URL grammar, the
 * `tail`/`cursor` mutual exclusion, the 206/Content-Range/Content-Length
 * checks, the bounded BYOB body reader, the ajv validation of every response --
 * never ran at all. Serving BYTES instead means the whole REST client under
 * test is the installed tarball's, and the fake supplies only what a server
 * supplies.
 *
 * FIDELITY IN BOTH DIRECTIONS. A fake looser than the dependency it stands in
 * for proves nothing, so this one is constrained on both sides:
 *
 *  - what it EMITS is validated with the package's own exported validators
 *    before it reaches the socket (`assertValid` below). The fake therefore
 *    cannot hand the client a document the real contract would reject and call
 *    the resulting pass a success. That is the direction a hand-written fixture
 *    normally drifts.
 *  - what it ACCEPTS is constrained the way a real Factory constrains a caller:
 *    unknown routes are 404 with a Core error envelope, `tail` combined with
 *    `cursor` is refused, a range read without a well-formed `Range` header is
 *    416, and a cursor the fake never issued is refused. A fake that answers
 *    anything cannot fail for a client that asks for the wrong thing.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  validateCommandStatus,
  validateFactorySessionStatus,
  validateObjectMetadata,
  validatePublicGatePage,
  validatePublicJournalPage,
  type CommandStatus,
  type FactorySessionStatus,
  type ObjectMetadata,
  type PublicGatePage,
  type PublicJournalPage,
} from "@looprig/client";

/** One journal generation: the tail read plus its continuation pages, in order. */
export interface JournalScript {
  readonly status: FactorySessionStatus;
  /** Page 0 answers the `tail` read; each later page answers the cursor the previous one issued. */
  readonly pages: readonly PublicJournalPage[];
}

export interface FactoryFakeOptions {
  readonly sessionId: string;
  readonly objectId: string;
  readonly objectBytes: Uint8Array;
  readonly objectDigest: string;
  readonly gates: PublicGatePage;
  readonly commandStatus: (commandId: string) => CommandStatus;
}

/**
 * Validates one outgoing document with the package's own validator. Any
 * throw here is a defect in this fake, never in the client, and it is
 * deliberately fatal rather than a 500: a fake that quietly serves an
 * off-contract document turns a client bug into a green run.
 */
function assertValid<T>(validator: (value: unknown) => T, value: unknown, what: string): T {
  try {
    return validator(JSON.parse(JSON.stringify(value)));
  } catch (cause) {
    throw new Error(`fake factory tried to serve an off-contract ${what}`, { cause });
  }
}

export class FactoryFake {
  #server: Server | undefined;
  #baseUrl = "";
  /** Journal generations, consumed one per join generation. The last one repeats. */
  #scripts: JournalScript[] = [];
  #generation = 0;
  /** Cursors this fake has issued and not yet answered, so a forged cursor is refused. */
  #issuedCursors = new Set<string>();
  readonly requests: string[] = [];

  constructor(private readonly options: FactoryFakeOptions) {}

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** The journal generation the next join generation will read. */
  get journalGeneration(): number {
    return this.#generation;
  }

  script(scripts: readonly JournalScript[]): void {
    if (scripts.length === 0) throw new Error("a journal script needs at least one generation");
    for (const generation of scripts) {
      if (generation.pages.length === 0) throw new Error("a journal generation needs at least one page");
      assertValid(validateFactorySessionStatus, generation.status, "session status");
      for (const page of generation.pages) assertValid(validatePublicJournalPage, page, "journal page");
      for (const page of generation.pages.slice(0, -1)) {
        if (page.next_cursor === undefined) {
          throw new Error("every journal page but the last must issue a continuation cursor");
        }
      }
      if (generation.pages[generation.pages.length - 1]?.next_cursor !== undefined) {
        throw new Error("the last journal page of a generation must not issue a cursor");
      }
    }
    this.#scripts = [...scripts];
    this.#generation = 0;
  }

  /**
   * Advances to the next scripted journal generation. Called by the consumer
   * when it makes the Factory-side state change (here: a reset) that a fresh
   * join generation is supposed to observe.
   */
  advanceJournal(): void {
    if (this.#generation + 1 < this.#scripts.length) this.#generation += 1;
    this.#issuedCursors.clear();
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((cause: unknown) => {
        // A throw inside the handler is a fake defect. Fail the process rather
        // than answering 500, which the client would report as a Factory error
        // and a careless assertion could mistake for the outcome under test.
        process.nextTick(() => {
          throw cause;
        });
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    this.#server = server;
    this.#baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  #json(response: ServerResponse, status: number, body: unknown): void {
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    response.writeHead(status, { "Content-Type": "application/json", "Content-Length": encoded.byteLength });
    response.end(encoded);
  }

  /** The Core error envelope shape `errorFromCoreEnvelope` is written against. */
  #error(response: ServerResponse, status: number, code: string, message: string): void {
    this.#json(response, status, { error: { code, message, retryable: false } });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    this.requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method !== "GET") {
      this.#error(response, 405, "method_not_allowed", "only GET is served");
      return;
    }
    const session = encodeURIComponent(this.options.sessionId);
    const object = encodeURIComponent(this.options.objectId);
    const base = `/v1/sessions/${session}`;

    if (url.pathname === `${base}/status`) {
      this.#json(response, 200, assertValid(validateFactorySessionStatus, this.#currentScript().status, "session status"));
      return;
    }
    if (url.pathname === `${base}/journal`) {
      this.#journal(url, response);
      return;
    }
    if (url.pathname === `${base}/gates`) {
      this.#json(response, 200, assertValid(validatePublicGatePage, this.options.gates, "gate page"));
      return;
    }
    if (url.pathname === `${base}/objects/${object}/metadata`) {
      const metadata: ObjectMetadata = {
        reference: { object_id: this.options.objectId },
        size_bytes: this.options.objectBytes.byteLength,
        media_type: "application/octet-stream",
        digest: this.options.objectDigest,
      };
      this.#json(response, 200, assertValid(validateObjectMetadata, metadata, "object metadata"));
      return;
    }
    if (url.pathname === `${base}/objects/${object}`) {
      this.#objectRange(request, response);
      return;
    }
    const commandPrefix = `${base}/commands/`;
    if (url.pathname.startsWith(commandPrefix)) {
      const commandId = decodeURIComponent(url.pathname.slice(commandPrefix.length));
      this.#json(response, 200, assertValid(validateCommandStatus, this.options.commandStatus(commandId), "command status"));
      return;
    }
    this.#error(response, 404, "not_found", `no route for ${url.pathname}`);
  }

  #currentScript(): JournalScript {
    const script = this.#scripts[this.#generation];
    if (script === undefined) throw new Error("the fake factory has no journal script");
    return script;
  }

  #journal(url: URL, response: ServerResponse): void {
    const tail = url.searchParams.get("tail");
    const cursor = url.searchParams.get("cursor");
    const fromSeq = url.searchParams.get("from_seq");
    // A real Factory cannot answer two positions at once, and neither does
    // this. The REST client refuses the combination client-side; refusing it
    // here too is what makes that guard's absence observable rather than
    // invisible.
    if ([tail, cursor, fromSeq].filter((value) => value !== null).length > 1) {
      this.#error(response, 400, "invalid_argument", "tail, cursor and from_seq are mutually exclusive");
      return;
    }
    const pages = this.#currentScript().pages;
    let page: PublicJournalPage | undefined;
    if (cursor === null) {
      // An opening read is a bounded tail, or a RESUME one past a committed
      // cursor. Sequence-zero replay is exactly what U2.1 removed: refusing a
      // bare read, and a from_seq at the head, means a regression to
      // `journal?after=0` fails as a Factory refusal.
      if (tail === null && (fromSeq === null || !(Number(fromSeq) > 1))) {
        this.#error(response, 400, "invalid_argument", "an opening journal read must be a bounded tail or a resume");
        return;
      }
      this.#issuedCursors.clear();
      page = pages[0];
    } else {
      if (!this.#issuedCursors.has(cursor)) {
        this.#error(response, 400, "invalid_cursor", `cursor was never issued: ${cursor}`);
        return;
      }
      this.#issuedCursors.delete(cursor);
      page = pages.find((candidate, index) => index > 0 && pages[index - 1]?.next_cursor === cursor);
    }
    if (page === undefined) {
      this.#error(response, 404, "not_found", "no journal page for that cursor");
      return;
    }
    if (page.next_cursor !== undefined) this.#issuedCursors.add(page.next_cursor);
    this.#json(response, 200, assertValid(validatePublicJournalPage, page, "journal page"));
  }

  #objectRange(request: IncomingMessage, response: ServerResponse): void {
    const header = request.headers.range;
    const match = /^bytes=(\d+)-(\d+)$/.exec(typeof header === "string" ? header : "");
    if (match === null) {
      this.#error(response, 416, "range_not_satisfiable", "an object read must carry a closed byte range");
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = this.options.objectBytes.byteLength;
    if (start > end || end >= total) {
      this.#error(response, 416, "range_not_satisfiable", `range ${start}-${end} is outside 0-${total - 1}`);
      return;
    }
    const slice = Buffer.from(this.options.objectBytes.subarray(start, end + 1));
    response.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": slice.byteLength,
    });
    response.end(slice);
  }
}
