/**
 * The redacted one-line detail a COLD-REPLAYED tool card shows, derived from
 * the stored `content.ToolUseBlock.Input`.
 *
 * ## Why a summariser and not the raw input
 *
 * A LIVE tool card's `summary` is harness's own `ToolCallStarted.Summary`
 * (`pkg/serve/ephemeral.go`'s `toolCallStartedDelta`), computed server-side and
 * already redacted. The enduring record carries no such field — an ephemeral
 * frame is never persisted — so a card committed from `StepDone.Messages` has
 * to derive one, and it has to land in the same place the live card did. A card
 * that showed `path (12 bytes)` while streaming and the file's entire contents
 * on reload would be two different cards for one call, and the second of them
 * would render an editor's worth of payload into a transcript row.
 *
 * That is also why this exists rather than a `ToolRow.input` field. The input
 * is already on the wire inside `StepDone.Messages`, so carrying it would leak
 * nothing new — but it would grow every row (Phase 5 virtualises the
 * transcript) and it would put the redaction decision in each renderer, where
 * every renderer would have to make it again and one of them would get it
 * wrong.
 *
 * This is a port of tui's `internal/presentation/toolsummary.go`, and it is
 * deliberately a straight one: two transcripts of the same session should not
 * describe the same call differently.
 *
 * ## Tool knowledge, and the boundary it does not cross
 *
 * The table below names tools. That is presentation knowledge — how a call
 * reads to a human — and not the dependency CLAUDE.md rules out: nothing here
 * imports a tool package, executes anything, or makes a policy decision, and an
 * unknown name is not an error, it is a card with no detail line. New tools and
 * MCP tools land in the `default` arm and render their name alone.
 *
 * ## The Go decoder semantics this replicates
 *
 * tui decodes with `json.Unmarshal` into a small tagged struct per tool, and
 * two of encoding/json's behaviours are load-bearing:
 *
 *  - **A type mismatch on any mapped field fails the whole decode**, and every
 *    summariser returns "" on the error. Fail closed: rendering less than the
 *    input said is safe, rendering something it did not say is not.
 *  - **Field matching is exact-first, then case-insensitive**, so `{"Command":
 *    "ls"}` still reaches a `json:"command"` field. Replicated so a card does
 *    not go blank here while tui renders it.
 *
 * A non-object input is an `Unmarshal` error and yields ""; a literal `null`
 * (the wire form of a nil `json.RawMessage`, which `Input` has no `omitempty`
 * to suppress) decodes as a no-op into the zero struct, which every summariser
 * then renders as "" too. One guard covers both because the outputs are
 * identical.
 */

/** The tool names with a summary. Spelling is the registry's, matched exactly. */
const TOOL_READ_FILE = "ReadFile";
const TOOL_READ = "Read";
const TOOL_WRITE_FILE = "WriteFile";
const TOOL_EDIT_FILE = "EditFile";
const TOOL_BASH = "Bash";
const TOOL_FETCH = "Fetch";
const TOOL_WEB_SEARCH = "WebSearch";
const TOOL_GLOB = "Glob";
const TOOL_GREP = "Grep";
const TOOL_TASK_CREATE = "TaskCreate";
const TOOL_TASK_UPDATE = "TaskUpdate";
const TOOL_TASK_GET = "TaskGet";
const TOOL_TASK_LIST = "TaskList";
const TOOL_SKILL = "Skill";

/** UTF-8 byte length — Go's `len(string)`, which `String.length` is not. */
const utf8 = new TextEncoder();

export type ToolResultEncoding = "utf-8" | "binary";
export type ToolResultTruncationReason = "capture_ceiling" | "source_limit";

/** Browser-safe metadata for one retained tool result. */
export interface ToolResultCaptureSummary {
  toolExecutionId: string;
  objectId: string | undefined;
  capturedBytes: number;
  originalBytes: number | null;
  originalBytesLowerBound: number | undefined;
  /**
   * `capturedBytes`, surfaced under a second name when — and only when — the
   * wire said `truncated` with `truncation_reason === "capture_ceiling"`. It
   * is DERIVED, not declared: no field on the wire carries a ceiling and this
   * decoder reads none, so it is equal to `capturedBytes` by construction and
   * is a LOWER BOUND on whatever ceiling a producer actually applied, never
   * *known* to be the ceiling — no better than a lower bound. A producer that
   * stops at its ceiling and then trims back to a whole UTF-8 rune (`encoding`
   * is `"utf-8"` as often as `"binary"`) emits strictly fewer bytes than its
   * ceiling.
   */
  capturedBytesAtCeiling: number | undefined;
  truncated: boolean;
  truncationReason: ToolResultTruncationReason | undefined;
  encoding: ToolResultEncoding;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Decodes `StepDone.captures`, keyed by durable provider tool-use id. Every
 * value is reconstructed from named safe fields; the reference is never
 * spread, so URLs, backend keys, credentials, and bytes cannot reach a row.
 */
export function toolResultCaptures(raw: unknown): Map<string, ToolResultCaptureSummary> {
  const out = new Map<string, ToolResultCaptureSummary>();
  if (!Array.isArray(raw)) return out;
  for (const candidate of raw) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const capture = candidate as Record<string, unknown>;
    const toolUseId = typeof capture["tool_use_id"] === "string" ? capture["tool_use_id"] : "";
    const toolExecutionId = typeof capture["tool_execution_id"] === "string" ? capture["tool_execution_id"] : "";
    const capturedBytes = nonnegativeInteger(capture["captured_bytes"]);
    const encoding = capture["encoding"];
    if (toolUseId === "" || toolExecutionId === "" || capturedBytes === undefined || (encoding !== "utf-8" && encoding !== "binary")) continue;

    const reference = capture["reference"];
    const objectId = typeof reference === "object" && reference !== null && !Array.isArray(reference)
      && typeof (reference as Record<string, unknown>)["object_id"] === "string"
      && (reference as Record<string, unknown>)["object_id"] !== ""
      ? (reference as Record<string, unknown>)["object_id"] as string
      : undefined;
    const originalRaw = capture["original_bytes"];
    const originalBytes = originalRaw === null ? null : nonnegativeInteger(originalRaw);
    if (originalBytes === undefined) continue;
    const lowerBound = nonnegativeInteger(capture["original_bytes_lower_bound"]);
    const truncated = capture["truncated"] === true;
    const reasonRaw = capture["truncation_reason"];
    const truncationReason = reasonRaw === "capture_ceiling" || reasonRaw === "source_limit" ? reasonRaw : undefined;

    out.set(toolUseId, {
      toolExecutionId,
      objectId,
      capturedBytes,
      originalBytes,
      originalBytesLowerBound: lowerBound,
      capturedBytesAtCeiling: truncated && truncationReason === "capture_ceiling" ? capturedBytes : undefined,
      truncated,
      truncationReason,
      encoding,
    });
  }
  return out;
}

/**
 * The decoded string fields of one summariser's argument struct, or `undefined`
 * when the decode FAILED — a non-object input, or a mapped key whose value is
 * not a string. Absent keys are simply "" (Go's zero value), which is not a
 * failure.
 */
type Args = Record<string, string>;

function decodeArgs(input: unknown, keys: readonly string[]): Args | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const out: Args = {};
  for (const key of keys) {
    const value = lookup(record, key);
    if (value === undefined) {
      out[key] = "";
      continue;
    }
    // encoding/json records an UnmarshalTypeError and the caller returns "".
    if (typeof value !== "string") return undefined;
    out[key] = value;
  }
  return out;
}

/**
 * encoding/json's field lookup: the exact tag name wins, and only if no key
 * matches exactly does a case-insensitive match apply.
 */
function lookup(record: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(record, key)) return record[key];
  const folded = key.toLowerCase();
  for (const candidate of Object.keys(record)) {
    if (candidate.toLowerCase() === folded) return record[candidate];
  }
  return undefined;
}

/**
 * Reconstructs the redacted one-line display detail for a stored tool-use
 * block. It never renders file contents, edit substrings, request headers,
 * request bodies, or task text — the same guarantee tui's own doc comment
 * makes, and the reason the summary is safe to show where the input is not.
 *
 * An unknown tool yields "", which renders as a card with a name and no detail.
 */
export function toolUseSummary(name: string, input: unknown): string {
  switch (name) {
    case TOOL_READ_FILE:
    case TOOL_READ:
    case TOOL_EDIT_FILE:
      return pathSummary(input);
    case TOOL_WRITE_FILE:
      return writeSummary(input);
    case TOOL_BASH:
      return bashSummary(input);
    case TOOL_FETCH:
      return fetchSummary(input);
    case TOOL_WEB_SEARCH:
      return querySummary(input);
    case TOOL_GLOB:
      return globSummary(input);
    case TOOL_GREP:
      return grepSummary(input);
    case TOOL_TASK_CREATE:
    case TOOL_TASK_UPDATE:
    case TOOL_TASK_GET:
    case TOOL_TASK_LIST:
      // The task tools' arguments ARE the task text. There is no fragment of
      // them that is a summary rather than a quotation.
      return "";
    case TOOL_SKILL:
      return skillSummary(input);
    default:
      return "";
  }
}

function pathSummary(input: unknown): string {
  const args = decodeArgs(input, ["path"]);
  if (args === undefined) return "";
  return args["path"]!.trim();
}

/**
 * The path and the payload's SIZE. The content is counted and discarded: a
 * write's body is exactly the kind of thing a transcript row must not carry.
 * A write with no path yields nothing at all rather than a bare byte count.
 */
function writeSummary(input: unknown): string {
  const args = decodeArgs(input, ["path", "content"]);
  if (args === undefined) return "";
  const path = args["path"]!.trim();
  if (path === "") return "";
  return `${path} (${utf8.encode(args["content"]!).length} bytes)`;
}

/**
 * The command, UNTRIMMED — leading whitespace is part of what was run, and tui
 * shows it. `cmd` is the legacy spelling, read only when `command` is absent.
 */
function bashSummary(input: unknown): string {
  const args = decodeArgs(input, ["command", "cmd"]);
  if (args === undefined) return "";
  if (args["command"] !== "") return args["command"]!;
  return args["cmd"]!;
}

function fetchSummary(input: unknown): string {
  const args = decodeArgs(input, ["method", "url"]);
  if (args === undefined) return "";
  const method = args["method"]!.trim().toUpperCase();
  const url = args["url"]!.trim();
  if (url === "") return "";
  return method === "" ? url : `${method} ${url}`;
}

function querySummary(input: unknown): string {
  const args = decodeArgs(input, ["query"]);
  if (args === undefined) return "";
  return args["query"]!.trim();
}

function globSummary(input: unknown): string {
  const args = decodeArgs(input, ["pattern", "root"]);
  if (args === undefined || args["pattern"]!.trim() === "") return "";
  return summaryInPath(args["pattern"]!, args["root"]!);
}

/** `q` is the legacy spelling of `pattern`, read only when `pattern` is empty. */
function grepSummary(input: unknown): string {
  const args = decodeArgs(input, ["pattern", "q", "path"]);
  if (args === undefined) return "";
  const pattern = args["pattern"] !== "" ? args["pattern"]! : args["q"]!;
  if (pattern.trim() === "") return "";
  return summaryInPath(pattern, args["path"]!);
}

/** "<value> in <path>", or just the value when the search was unscoped. */
function summaryInPath(value: string, path: string): string {
  const trimmedValue = value.trim();
  const trimmedPath = path.trim();
  return trimmedPath === "" ? trimmedValue : `${trimmedValue} in ${trimmedPath}`;
}

function skillSummary(input: unknown): string {
  const args = decodeArgs(input, ["name"]);
  if (args === undefined) return "";
  return args["name"]!.trim();
}
