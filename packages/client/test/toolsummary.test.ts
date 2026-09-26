/**
 * `toolUseSummary` — the durable, redacted one-line detail a COLD-REPLAYED tool
 * card shows, ported from tui's `internal/presentation/toolsummary.go`.
 *
 * ## Why these expectations are what they are
 *
 * The live card's `summary` is harness's own `ToolCallStarted.Summary`
 * (`pkg/serve/ephemeral.go`'s `toolCallStartedDelta`), which is already
 * redacted. A replayed card has no such field — the ephemeral frame is never
 * persisted — so it has to derive one from the stored `ToolUseBlock.Input`, and
 * the derivation must land in the SAME place: a card that showed a file's whole
 * contents on replay and a path while live would be two different cards for one
 * call. That is why this is a summariser and not a raw-input renderer.
 *
 * ## The Go decoder semantics this replicates, verbatim
 *
 * tui's summariser is `json.Unmarshal` into a small tagged struct per tool, and
 * two of encoding/json's behaviours are load-bearing here rather than
 * incidental:
 *
 *  - **A type mismatch on ANY mapped field fails the whole decode**, and every
 *    summariser returns "" on `err != nil`. So `{"path":"/a","content":7}` is
 *    not "the path with a bad content field", it is no summary at all. Fail
 *    closed: showing less is safe, showing something the input did not say is
 *    not.
 *  - **Field matching is exact-first, then case-insensitive** (encoding/json's
 *    documented fallback), so `{"Command":"ls"}` reaches a `json:"command"`
 *    field. Replicated so a card does not go blank in wui while tui renders it.
 *
 * A non-object input (a string, a number, an array) is an `Unmarshal` error and
 * yields ""; a literal `null` decodes as a no-op into the zero struct, which
 * every summariser then renders as "" as well — the two paths are
 * indistinguishable in the output, which is why one guard covers both.
 *
 * `len()` in `writeSummary` is Go's BYTE length. `"é"` is one UTF-16 code unit
 * and two UTF-8 bytes, so `.length` would disagree with tui on any non-ASCII
 * payload.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FactoryRestReads, type FactoryReads } from "../src/factory-rest.js";
import {
  CoreProtocolError,
  RequestAbortedError,
  ToolCaptureIntegrityError,
  ToolCaptureTooLargeError,
  ToolCaptureUnavailableError,
} from "../src/errors.js";
import { readToolCapturePages } from "../src/tool-capture.js";
import { toolResultCaptures, toolUseSummary, type ToolResultCaptureSummary } from "../src/toolsummary.js";

interface RecordedRequest {
  url: string;
  authorization: string | null;
  range: string | null;
}

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digested = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return Array.from(digested, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface CaptureFixture {
  readonly capture: ToolResultCaptureSummary;
  /** The object's real digest, computed from the bytes the doubles serve. */
  readonly digest: string;
  reads(overrides?: Partial<FactoryReads>): FactoryReads;
  factory(requests: RecordedRequest[]): FactoryRestReads;
}

/**
 * One retained-object fixture over `text`: the capture summary a fold would
 * produce for it, a `FactoryReads` double, and a real `FactoryRestReads` over a
 * `fetch` double that records what it was asked for.
 *
 * The digest is COMPUTED from the same bytes the doubles serve rather than
 * pasted in as a constant. Two hand-computed SHA-256 literals used to sit here;
 * both were correct, which is exactly the problem — a reader cannot check them,
 * and the first payload someone adds with a wrong one fails as a confusing
 * `ToolCaptureIntegrityError` about the code under test. This is an ASYNC
 * factory, not a value plus a `computeDigest()` step, so there is no window in
 * which a fixture exists carrying an empty digest: the digest is filled in
 * before the fixture exists at all. The failure mode that remains is forgetting
 * to `await` the factory, and that is a type error at every use of the result —
 * not the silent half-built fixture a separate initialisation step allows. The NEGATIVE cases deliberately do not derive
 * anything (see the all-zeros digest below): an expected value a failing test
 * computes for itself is no longer an expectation.
 */
async function captureFixture(text: string): Promise<CaptureFixture> {
  const source = encoder.encode(text);
  const digest = `sha256:${await sha256Hex(text)}`;
  const metadataBody = (): Record<string, unknown> => ({
    reference: { object_id: "object-1" },
    size_bytes: source.length,
    media_type: "text/plain",
    digest,
  });
  return {
    capture: {
      toolExecutionId: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
      objectId: "object-1",
      capturedBytes: source.length,
      originalBytes: 21,
      originalBytesLowerBound: undefined,
      // Derived, and equal to `capturedBytes` by construction — the decoder
      // reads no ceiling field. See toolsummary.ts.
      capturedBytesAtCeiling: source.length,
      truncated: true,
      truncationReason: "capture_ceiling",
      encoding: "utf-8",
    },
    digest,
    reads: (overrides: Partial<FactoryReads> = {}): FactoryReads => ({
      listAgents: vi.fn(),
      listRecentSessions: vi.fn(),
      readStatus: vi.fn(),
      readJournal: vi.fn(),
      listGates: vi.fn(),
      readObjectMetadata: vi.fn(async () => metadataBody()),
      readObjectRange: vi.fn(async (_sessionId, _objectId, options) => ({
        bytes: source.slice(options.start, options.end + 1),
        contentRange: `bytes ${options.start}-${options.end}/${source.length}`,
        mediaType: "text/plain",
      })),
      ...overrides,
    } as FactoryReads),
    factory: (requests: RecordedRequest[]): FactoryRestReads => new FactoryRestReads({
      baseUrl: "https://factory.example",
      credentials: { restHeaders: () => ({ Authorization: "Bearer retained-object-token" }) },
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        requests.push({ url, authorization: headers.get("Authorization"), range: headers.get("Range") });
        if (url.endsWith("/metadata")) return new Response(JSON.stringify(metadataBody()), { status: 200 });
        const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("Range") ?? "");
        if (match === null) throw new Error("missing range");
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(source.slice(start, end + 1), {
          status: 206,
          headers: { "Content-Range": `bytes ${start}-${end}/${source.length}`, "Content-Type": "text/plain" },
        });
      },
    }),
  };
}

describe("retained tool-result content", () => {
  let main: CaptureFixture;
  /**
   * Deliberately SMALLER than the ceiling every test declares. Every other
   * fixture would have `capturedBytes` and `ceilingBytes` equal, which makes
   * the two bounds indistinguishable: replacing `options.ceilingBytes` with
   * `capture.capturedBytes` in the `pageBytes` guard survives all of them.
   */
  let small: CaptureFixture;
  // Bound here, not at collection time: `captureFixture` is async because the
  // digest is computed from the bytes. Every reader below is a test body, which
  // runs after this hook.
  let capture: ToolResultCaptureSummary;
  let reads: CaptureFixture["reads"];
  beforeAll(async () => {
    main = await captureFixture("abcdefghij");
    small = await captureFixture("abcde");
    ({ capture, reads } = main);
  });

  it("continues exact inclusive ranges through the captured byte count, naming Factory and only Factory", async () => {
    const requests: RecordedRequest[] = [];
    const loaded = await readToolCapturePages(main.factory(requests), "session-1", capture, {
      pageBytes: 4, ceilingBytes: 10,
    });

    expect(requests).toStrictEqual([
      { url: "https://factory.example/v1/sessions/session-1/objects/object-1/metadata", authorization: "Bearer retained-object-token", range: null },
      { url: "https://factory.example/v1/sessions/session-1/objects/object-1", authorization: "Bearer retained-object-token", range: "bytes=0-3" },
      { url: "https://factory.example/v1/sessions/session-1/objects/object-1", authorization: "Bearer retained-object-token", range: "bytes=4-7" },
      { url: "https://factory.example/v1/sessions/session-1/objects/object-1", authorization: "Bearer retained-object-token", range: "bytes=8-9" },
    ]);
    expect(loaded.pages.map(({ start, end }) => [start, end])).toStrictEqual([[0, 3], [4, 7], [8, 9]]);
    expect(new TextDecoder().decode(loaded.bytes)).toBe("abcdefghij");
    expect(loaded.metadata.digest).toBe(main.digest);
  });

  /**
   * `pageBytes` is bounded by the caller's DECLARED CEILING, never by the size
   * this particular capture happens to have — a page size between 5 and 10 is
   * legal here and must read. The whole small space of page sizes either side
   * of both numbers is enumerated rather than one more fixed triple, and it is
   * driven through a real `FactoryRestReads` so the property under test is the
   * `Range` header sequence that actually goes on the wire at EVERY page size,
   * not a page list at the single size some other test happens to pin.
   */
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
    "bounds pageBytes %i by the declared ceiling of 10 rather than the captured 5 bytes",
    async (pageBytes) => {
      const requests: RecordedRequest[] = [];
      const attempt = readToolCapturePages(small.factory(requests), "session-1", small.capture, {
        pageBytes, ceilingBytes: 10,
      });
      if (pageBytes > 10) {
        await expect(attempt).rejects.toBeInstanceOf(RangeError);
        expect(requests).toStrictEqual([]);
        return;
      }
      await expect(attempt, `pageBytes ${pageBytes} is within the declared ceiling and must read`)
        .resolves.toBeDefined();
      const loaded = await attempt;
      const expectedPages: Array<[number, number]> = [];
      for (let start = 0; start < 5; start += pageBytes) expectedPages.push([start, Math.min(4, start + pageBytes - 1)]);
      expect(loaded.pages.map(({ start, end }) => [start, end])).toStrictEqual(expectedPages);
      expect(requests.map(({ range }) => range)).toStrictEqual([
        null,
        ...expectedPages.map(([start, end]) => `bytes=${start}-${end}`),
      ]);
      expect(new TextDecoder().decode(loaded.bytes)).toBe("abcde");
    },
  );

  it("allows a capture exactly at the caller's declared ceiling", async () => {
    const factory = reads();
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 10, ceilingBytes: 10 })).resolves.toMatchObject({
      pages: [{ start: 0, end: 9 }],
    });
  });

  it.each([0, -1, 1.5, 11])("rejects invalid pageBytes %s before Factory I/O", async (pageBytes) => {
    const factory = reads();
    await expect(readToolCapturePages(factory, "session-1", capture, {
      pageBytes, ceilingBytes: 10,
    })).rejects.toBeInstanceOf(RangeError);
    expect(factory.readObjectMetadata).not.toHaveBeenCalled();
    expect(factory.readObjectRange).not.toHaveBeenCalled();
  });

  it("refuses an over-ceiling capture before metadata or object I/O", async () => {
    const factory = reads();
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 4, ceilingBytes: 9 })).rejects.toBeInstanceOf(ToolCaptureTooLargeError);
    expect(factory.readObjectMetadata).not.toHaveBeenCalled();
    expect(factory.readObjectRange).not.toHaveBeenCalled();
  });

  it("cancels before the first object read and forwards mid-read cancellation", async () => {
    const already = new AbortController();
    already.abort();
    const untouched = reads();
    await expect(readToolCapturePages(untouched, "session-1", capture, { pageBytes: 4, ceilingBytes: 10, signal: already.signal })).rejects.toBeInstanceOf(RequestAbortedError);
    expect(untouched.readObjectMetadata).not.toHaveBeenCalled();

    const later = new AbortController();
    const interrupted = new RequestAbortedError("range");
    const factory = reads({ readObjectRange: vi.fn(async (_sid, _oid, options) => {
      expect(options.signal).toBe(later.signal);
      later.abort();
      throw interrupted;
    }) });
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 4, ceilingBytes: 10, signal: later.signal })).rejects.toBe(interrupted);

    const completedPageAbort = new AbortController();
    const ignoringFactory = reads({ readObjectRange: vi.fn(async (_sid, _oid, options) => {
      completedPageAbort.abort();
      return {
        bytes: encoder.encode("abcdefghij").slice(options.start, options.end + 1),
        contentRange: `bytes ${options.start}-${options.end}/10`,
        mediaType: "text/plain",
      };
    }) });
    await expect(readToolCapturePages(ignoringFactory, "session-1", capture, {
      pageBytes: 4, ceilingBytes: 10, signal: completedPageAbort.signal,
    })).rejects.toBeInstanceOf(RequestAbortedError);
    expect(ignoringFactory.readObjectRange).toHaveBeenCalledTimes(1);
  });

  it("rejects a digest mismatch after bounded reads", async () => {
    const factory = reads({ readObjectMetadata: vi.fn(async () => ({
      reference: { object_id: "object-1" }, size_bytes: 10, digest: `sha256:${"0".repeat(64)}`,
    })) });
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 4, ceilingBytes: 10 })).rejects.toBeInstanceOf(ToolCaptureIntegrityError);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "sha256:not-a-digest"],
    ["unsupported", `sha512:${"0".repeat(128)}`],
    // Well-formed hex, but not 64 of them. This is the exact value
    // contract/fixtures/object_metadata.json carries ("sha256:abc"), so a
    // length bound written `{1,64}` instead of `{64}` would let the pinned Core
    // fixture's own digest through to a range read before failing — which is
    // what the `readObjectRange` assertion below exists to forbid.
    ["short but well-formed", "sha256:abc"],
    ["over-long", `sha256:${"0".repeat(65)}`],
    ["upper-case", `sha256:${"A".repeat(64)}`],
  ])("requires a supported sha256 digest before object-range I/O when metadata is %s", async (_name, metadataDigest) => {
    const factory = reads({ readObjectMetadata: vi.fn(async () => ({
      reference: { object_id: "object-1" }, size_bytes: 10, digest: metadataDigest,
    })) });

    await expect(readToolCapturePages(factory, "session-1", capture, {
      pageBytes: 4, ceilingBytes: 10,
    })).rejects.toBeInstanceOf(ToolCaptureIntegrityError);
    expect(factory.readObjectRange).not.toHaveBeenCalled();
  });

  it("rejects metadata whose immutable size disagrees with the capture before range I/O", async () => {
    const factory = reads({ readObjectMetadata: vi.fn(async () => ({
      reference: { object_id: "object-1" }, size_bytes: 11, digest: main.digest,
    })) });
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 4, ceilingBytes: 10 })).rejects.toBeInstanceOf(ToolCaptureIntegrityError);
    expect(factory.readObjectRange).not.toHaveBeenCalled();
  });

  it("rejects metadata bound to a different object before range I/O", async () => {
    const factory = reads({ readObjectMetadata: vi.fn(async () => ({
      reference: { object_id: "object-2" }, size_bytes: 10, digest: main.digest,
    })) });
    await expect(readToolCapturePages(factory, "session-1", capture, {
      pageBytes: 4, ceilingBytes: 10,
    })).rejects.toBeInstanceOf(ToolCaptureIntegrityError);
    expect(factory.readObjectRange).not.toHaveBeenCalled();
  });

  it("rejects a Content-Range that does not exactly bind the requested page", async () => {
    const factory = reads({ readObjectRange: vi.fn(async (_sid, _oid, options) => ({
      bytes: encoder.encode("abcdefghij").slice(options.start, options.end + 1),
      contentRange: `bytes ${options.start}-${options.end}/11`,
      mediaType: "text/plain",
    })) });
    await expect(readToolCapturePages(factory, "session-1", capture, {
      pageBytes: 4, ceilingBytes: 10,
    })).rejects.toBeInstanceOf(ToolCaptureIntegrityError);
  });

  it("rejects a returned page whose byte length differs from its requested range", async () => {
    const factory = reads({ readObjectRange: vi.fn(async (_sid, _oid, options) => ({
      bytes: encoder.encode("abc"),
      contentRange: `bytes ${options.start}-${options.end}/10`,
      mediaType: "text/plain",
    })) });
    await expect(readToolCapturePages(factory, "session-1", capture, {
      pageBytes: 4, ceilingBytes: 10,
    })).rejects.toBeInstanceOf(ToolCaptureIntegrityError);
  });

  /**
   * A capture with no retained object at all — the fold genuinely produces this
   * (see rows-tools.test.ts's `use-b`, whose capture carries no `reference`).
   * Deleting the guard does not stop the read: with `objectId` undefined,
   * `encodeURIComponent` yields the literal "undefined" and a Factory metadata
   * request goes out for a bogus object id before the `reference.object_id`
   * comparison rejects. That later check used to raise the SAME class, which
   * masked the guard's deletion entirely; `ToolCaptureUnavailableError` exists
   * so the absence and the integrity failure are distinguishable by TYPE.
   * The request list is asserted independently: the guard's other job is that
   * no request is issued at all.
   */
  it("refuses a capture with no retained object before any Factory request", async () => {
    const requests: RecordedRequest[] = [];
    await expect(readToolCapturePages(main.factory(requests), "session-1", { ...capture, objectId: undefined }, {
      pageBytes: 4, ceilingBytes: 10,
    })).rejects.toBeInstanceOf(ToolCaptureUnavailableError);
    expect(requests).toStrictEqual([]);
  });

  it("surfaces a missing retained object and never attempts a range", async () => {
    const requests: string[] = [];
    const factory = new FactoryRestReads({
      baseUrl: "https://factory.example",
      fetch: async (url) => {
        requests.push(url);
        return new Response(JSON.stringify({
          error: { code: "not_found", message: "not found", retryable: false },
        }), { status: 404 });
      },
    });
    await expect(readToolCapturePages(factory, "session-1", capture, {
      pageBytes: 4, ceilingBytes: 10,
    })).rejects.toMatchObject({ constructor: CoreProtocolError, code: "not_found" });
    expect(requests).toStrictEqual([
      "https://factory.example/v1/sessions/session-1/objects/object-1/metadata",
    ]);
  });
});

describe("tool-result capture projection against Core fixture authorities", () => {
  it("uses Core's logical reference spelling and never copies private extensions", () => {
    const reference = JSON.parse(readFileSync(new URL("../../../contract/fixtures/object_reference.json", import.meta.url), "utf8"));
    const metadata = JSON.parse(readFileSync(new URL("../../../contract/fixtures/object_metadata.json", import.meta.url), "utf8"));
    const captures = toolResultCaptures([{
      tool_execution_id: "execution-1",
      tool_use_id: "use-1",
      reference: { ...reference, signed_url: "SECRET-url", backend_key: "SECRET-key", credential: "SECRET-credential", raw_bytes: "SECRET-bytes" },
      captured_bytes: metadata.size_bytes,
      original_bytes: null,
      original_bytes_lower_bound: metadata.size_bytes + 1,
      truncated: true,
      truncation_reason: "source_limit",
      encoding: "binary",
    }]);
    expect(captures.get("use-1")).toStrictEqual({
      toolExecutionId: "execution-1",
      objectId: reference.object_id,
      capturedBytes: 42,
      originalBytes: null,
      originalBytesLowerBound: 43,
      capturedBytesAtCeiling: undefined,
      truncated: true,
      truncationReason: "source_limit",
      encoding: "binary",
    });
    expect(JSON.stringify(captures.get("use-1"))).not.toContain("SECRET");
  });
});

describe("toolUseSummary: the path tools", () => {
  it("summarises Read, ReadFile and EditFile as their trimmed path", () => {
    expect(toolUseSummary("Read", { path: "/etc/hosts" })).toBe("/etc/hosts");
    expect(toolUseSummary("ReadFile", { path: "  /etc/hosts  " })).toBe("/etc/hosts");
    expect(toolUseSummary("EditFile", { path: "/tmp/x.ts" })).toBe("/tmp/x.ts");
  });

  it("renders no path at all rather than an edit's substrings", () => {
    // EditFile's input carries old_string/new_string. Neither is read: the
    // summary is the redacted detail, and a diff fragment is not redacted.
    expect(toolUseSummary("EditFile", { path: "/tmp/x.ts", old_string: "secret", new_string: "s" })).toBe(
      "/tmp/x.ts",
    );
  });

  it("yields no summary when the path key is absent or empty", () => {
    expect(toolUseSummary("Read", {})).toBe("");
    expect(toolUseSummary("Read", { path: "" })).toBe("");
    expect(toolUseSummary("Read", { path: "   " })).toBe("");
  });
});

describe("toolUseSummary: WriteFile counts bytes and never shows them", () => {
  it("renders the path and the content's BYTE length", () => {
    expect(toolUseSummary("WriteFile", { path: "/tmp/out.txt", content: "hello" })).toBe(
      "/tmp/out.txt (5 bytes)",
    );
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // "é" is 1 in JS `.length` and 2 in Go `len()`. "𝄞" is 2 code units and 4
    // bytes. A `.length` implementation returns "(3 bytes)" here.
    expect(toolUseSummary("WriteFile", { path: "/a", content: "é𝄞" })).toBe("/a (6 bytes)");
  });

  it("renders (0 bytes) for an empty write, which is a real operation", () => {
    expect(toolUseSummary("WriteFile", { path: "/a", content: "" })).toBe("/a (0 bytes)");
  });

  it("yields no summary at all when the path is missing — never a bare byte count", () => {
    expect(toolUseSummary("WriteFile", { content: "hello" })).toBe("");
    expect(toolUseSummary("WriteFile", { path: "  ", content: "hello" })).toBe("");
  });

  it("never renders the content itself", () => {
    const summary = toolUseSummary("WriteFile", { path: "/a", content: "SECRET-TOKEN" });
    expect(summary).not.toContain("SECRET");
  });
});

describe("toolUseSummary: Bash", () => {
  it("prefers `command` and falls back to the legacy `cmd`", () => {
    expect(toolUseSummary("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(toolUseSummary("Bash", { cmd: "ls -la" })).toBe("ls -la");
    expect(toolUseSummary("Bash", { command: "new", cmd: "old" })).toBe("new");
  });

  it("does NOT trim the command, matching tui", () => {
    // pathSummary trims and bashSummary does not. A command's leading
    // whitespace is part of what was run, and tui shows it; normalising here
    // would make the two renderers disagree about the same call.
    expect(toolUseSummary("Bash", { command: "  ls  " })).toBe("  ls  ");
  });

  it("yields no summary when neither key is present", () => {
    expect(toolUseSummary("Bash", {})).toBe("");
  });
});

describe("toolUseSummary: Fetch, WebSearch and Skill", () => {
  it("renders Fetch as an upper-cased method and its url", () => {
    expect(toolUseSummary("Fetch", { method: "get", url: "https://x/y" })).toBe("GET https://x/y");
    expect(toolUseSummary("Fetch", { method: "  post  ", url: "  https://x/y  " })).toBe("POST https://x/y");
  });

  it("renders a Fetch with no method as the bare url, and no url as nothing", () => {
    expect(toolUseSummary("Fetch", { url: "https://x/y" })).toBe("https://x/y");
    expect(toolUseSummary("Fetch", { method: "GET" })).toBe("");
    expect(toolUseSummary("Fetch", { method: "GET", url: "   " })).toBe("");
  });

  it("never renders a Fetch's headers or body", () => {
    const summary = toolUseSummary("Fetch", {
      method: "POST",
      url: "https://x/y",
      headers: { Authorization: "Bearer SECRET" },
      body: "SECRET-BODY",
    });
    expect(summary).toBe("POST https://x/y");
  });

  it("renders WebSearch as its trimmed query and Skill as its trimmed name", () => {
    expect(toolUseSummary("WebSearch", { query: "  go generics  " })).toBe("go generics");
    expect(toolUseSummary("WebSearch", {})).toBe("");
    expect(toolUseSummary("Skill", { name: "  brainstorming  " })).toBe("brainstorming");
    expect(toolUseSummary("Skill", {})).toBe("");
  });
});

describe("toolUseSummary: Glob and Grep", () => {
  it("renders a Glob pattern, scoped by its root when there is one", () => {
    expect(toolUseSummary("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolUseSummary("Glob", { pattern: "**/*.ts", root: "src" })).toBe("**/*.ts in src");
    expect(toolUseSummary("Glob", { pattern: "  **/*.ts  ", root: "  src  " })).toBe("**/*.ts in src");
  });

  it("renders a Grep pattern, scoped by its path, with the legacy `q` fallback", () => {
    expect(toolUseSummary("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(toolUseSummary("Grep", { pattern: "TODO", path: "src" })).toBe("TODO in src");
    expect(toolUseSummary("Grep", { q: "TODO", path: "src" })).toBe("TODO in src");
    expect(toolUseSummary("Grep", { pattern: "new", q: "old" })).toBe("new");
  });

  it("yields no summary when the pattern is blank, so `in src` never stands alone", () => {
    expect(toolUseSummary("Glob", { root: "src" })).toBe("");
    expect(toolUseSummary("Glob", { pattern: "   ", root: "src" })).toBe("");
    expect(toolUseSummary("Grep", { path: "src" })).toBe("");
    expect(toolUseSummary("Grep", { pattern: "   ", path: "src" })).toBe("");
  });
});

describe("toolUseSummary: the tools with deliberately no summary", () => {
  it("renders nothing for the task tools, whose arguments are the task text", () => {
    // The input deliberately carries a key every OTHER summariser reads, so
    // wiring a task tool to any of them fails here. Falling through to the
    // `default` arm is NOT caught, and cannot be: the explicit arms and the
    // default both return "", so deleting them is an equivalent mutation. They
    // are written out for the same reason tui writes them out — the silence is
    // a decision about these tools, not an omission.
    const everySummarisersKey = {
      title: "ship it",
      description: "the whole plan",
      path: "/tmp/notes",
      command: "rm -rf /",
      content: "body",
      query: "how",
      pattern: "TODO",
      root: "src",
      name: "brainstorming",
      method: "post",
      url: "https://x/y",
    };
    for (const name of ["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"]) {
      expect(toolUseSummary(name, everySummarisersKey), name).toBe("");
    }
  });

  it("renders nothing for a tool the catalogue does not know", () => {
    expect(toolUseSummary("SomeMcpTool", { path: "/etc/hosts", command: "ls" })).toBe("");
    expect(toolUseSummary("", { path: "/etc/hosts" })).toBe("");
  });

  it("is case-SENSITIVE on the tool name, which is a durable identifier", () => {
    // The name is content.ToolUseBlock.Name, matched against the registry's
    // exact spelling; "read" is a different tool, not a spelling of "Read".
    expect(toolUseSummary("read", { path: "/a" })).toBe("");
    expect(toolUseSummary("BASH", { command: "ls" })).toBe("");
  });
});

describe("toolUseSummary: the decoder's own semantics", () => {
  it("yields no summary for an input that is not a JSON object", () => {
    // Every one of these is an `Unmarshal` error in tui, or (for null) a no-op
    // decode into the zero struct. Both render "".
    expect(toolUseSummary("Read", null)).toBe("");
    expect(toolUseSummary("Read", undefined)).toBe("");
    expect(toolUseSummary("Read", "/etc/hosts")).toBe("");
    expect(toolUseSummary("Read", ["/etc/hosts"])).toBe("");
    expect(toolUseSummary("Read", 7)).toBe("");
    expect(toolUseSummary("Bash", true)).toBe("");
  });

  it("fails the WHOLE decode when any mapped field has the wrong type", () => {
    // encoding/json sets an error and every summariser returns "" on it, so a
    // sibling field's bad type takes the good one down with it.
    expect(toolUseSummary("Read", { path: 7 })).toBe("");
    expect(toolUseSummary("WriteFile", { path: "/a", content: 7 })).toBe("");
    expect(toolUseSummary("Bash", { command: "ls", cmd: 7 })).toBe("");
    expect(toolUseSummary("Grep", { pattern: "TODO", path: null })).toBe("");
    expect(toolUseSummary("Fetch", { method: "GET", url: ["https://x"] })).toBe("");
  });

  it("ignores unmapped keys entirely, whatever their type", () => {
    expect(toolUseSummary("Read", { path: "/a", limit: 20, offset: null, extra: { deep: [] } })).toBe("/a");
  });

  it("matches a field name case-insensitively, exact spelling first", () => {
    // encoding/json's documented fallback. Without it a `{"Command":"ls"}`
    // input renders in tui and goes blank in wui.
    expect(toolUseSummary("Bash", { Command: "ls" })).toBe("ls");
    expect(toolUseSummary("Read", { PATH: "/a" })).toBe("/a");
    expect(toolUseSummary("Read", { Path: "/exact-loses", path: "/exact-wins" })).toBe("/exact-wins");
  });
});
