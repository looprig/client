import { uuidV4 } from "./uuid.js";
import type { ClientLink } from "./clientlink.js";
import {
  CoreProtocolError,
  errorFromCoreEnvelope,
  MalformedResponseError,
  NetworkError,
  RequestAbortedError,
} from "./errors.js";
import type { FactoryRestCredentials } from "./factory-rest.js";
import type { CommandStatus } from "./types.js";
import { validateCommandStatus, validateCoreErrorEnvelope } from "./validate.js";
import type { FetchLike, RequestOptions } from "./transport.js";

declare const commandIDBrand: unique symbol;
declare const sessionIDBrand: unique symbol;

/** Core's opaque, non-empty UTF-8 command identity (at most 256 bytes). */
export type CommandID = string & { readonly [commandIDBrand]: "CommandID" };
/** Core's opaque, non-empty UTF-8 session identity (at most 256 bytes). */
export type SessionID = string & { readonly [sessionIDBrand]: "SessionID" };

export type FactoryCommandMethod =
  | "session.create"
  | "session.input"
  | "session.interrupt"
  | "session.restore"
  | "gate.respond";

export interface CommandEnvelope {
  readonly version: 1;
  readonly command_id: CommandID;
  readonly session_id: SessionID;
}

export interface CreateCommandRequest extends CommandEnvelope {
  readonly agent_id: string;
  readonly blocks?: readonly Record<string, unknown>[];
  readonly metadata?: MessageMetadata;
}

export interface InputCommandRequest extends CommandEnvelope {
  readonly blocks: readonly Record<string, unknown>[];
  readonly metadata?: MessageMetadata;
}

export type InterruptCommandRequest = CommandEnvelope;
export type RestoreCommandRequest = CommandEnvelope;

export interface ResidentGateResponseRequest extends CommandEnvelope {
  readonly gate_id: string;
  readonly action: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly expected_open_event_id?: string;
  readonly expected_open_journal_seq?: number;
}

export type FactoryCommandRequest =
  | CreateCommandRequest
  | InputCommandRequest
  | InterruptCommandRequest
  | RestoreCommandRequest
  | ResidentGateResponseRequest;

export class CommandIdentityError extends TypeError {
  readonly field: string;

  constructor(field: string) {
    super(`${field} must be a non-empty opaque UTF-8 identity of at most 256 bytes`);
    this.name = "CommandIdentityError";
    this.field = field;
  }
}

export class CommandIdentityMismatchError extends Error {
  readonly expected: CommandID;
  readonly actual: string;

  constructor(expected: CommandID, actual: string) {
    super("command response identity does not match the pending operation");
    this.name = "CommandIdentityMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

const idEncoder = new TextEncoder();

function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function opaqueID(value: string, field: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || !hasOnlyPairedSurrogates(value)
    || idEncoder.encode(value).byteLength > 256) {
    throw new CommandIdentityError(field);
  }
  return value;
}

function commandID(value: string): CommandID {
  return opaqueID(value, "command_id") as CommandID;
}

function sessionID(value: string): SessionID {
  return opaqueID(value, "session_id") as SessionID;
}

function otherID(value: string, field: string): string {
  return opaqueID(value, field);
}

/** Core sessionwire/v1.MessageMetadata: app-defined string fields on create or input. */
export type MessageMetadata = Readonly<Record<string, string>>;
export type MessageMetadataErrorCode = "too_many_fields" | "invalid_key" | "reserved_key" | "value_too_large" | "invalid_value" | "too_large";

export const MAX_METADATA_FIELDS = 16;
export const MAX_METADATA_KEY_BYTES = 64;
export const MAX_METADATA_VALUE_BYTES = 1024;
export const MAX_METADATA_BYTES = 4096;
const METADATA_KEY = /^[a-z][a-z0-9_]{0,63}$/;

export class MessageMetadataError extends TypeError {
  readonly code: MessageMetadataErrorCode;
  readonly key: string;

  constructor(code: MessageMetadataErrorCode, key = "") {
    super(key === "" ? `metadata is invalid (${code})` : `metadata field ${JSON.stringify(key)} is invalid (${code})`);
    this.name = "MessageMetadataError";
    this.code = code;
    this.key = key;
  }
}

function validMetadataValue(value: string): boolean {
  if (!hasOnlyPairedSurrogates(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 && unit !== 0x09 && unit !== 0x0a) return false;
  }
  return true;
}

/** Number of bytes Go encoding/json writes for a string, including quotes. */
function goJSONStringBytes(value: string): number {
  let bytes = 2;
  for (const char of value) {
    switch (char) {
      case "<": case ">": case "&": case "\u2028": case "\u2029":
        bytes += 6;
        break;
      case "\"": case "\\": case "\t": case "\n":
        bytes += 2;
        break;
      default:
        bytes += idEncoder.encode(char).byteLength;
    }
  }
  return bytes;
}

function canonicalMetadataBytes(entries: readonly (readonly [string, string])[]): number {
  let bytes = 2 + Math.max(entries.length - 1, 0);
  for (const [key, value] of entries) bytes += goJSONStringBytes(key) + 1 + goJSONStringBytes(value);
  return bytes;
}

/** Validate in Core's sorted-key and field order; return a separate copy for the retry snapshot. */
function metadata(value: MessageMetadata | undefined): MessageMetadata | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new MessageMetadataError("invalid_value");
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  if (entries.length > MAX_METADATA_FIELDS) throw new MessageMetadataError("too_many_fields");
  const sortedEntries = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [key, field] of sortedEntries) {
    if (!METADATA_KEY.test(key) || idEncoder.encode(key).byteLength > MAX_METADATA_KEY_BYTES) {
      throw new MessageMetadataError("invalid_key");
    }
    if (key.startsWith("looprig")) throw new MessageMetadataError("reserved_key", key);
    if (typeof field !== "string") throw new MessageMetadataError("invalid_value", key);
    if (idEncoder.encode(field).byteLength > MAX_METADATA_VALUE_BYTES) throw new MessageMetadataError("value_too_large", key);
    if (!validMetadataValue(field)) throw new MessageMetadataError("invalid_value", key);
  }
  if (canonicalMetadataBytes(sortedEntries) > MAX_METADATA_BYTES) throw new MessageMetadataError("too_large");
  return Object.fromEntries(entries);
}

function blocks(value: readonly Record<string, unknown>[] | undefined, required: boolean): readonly Record<string, unknown>[] | undefined {
  if (value === undefined) {
    if (required) throw new TypeError("blocks must be a non-empty array");
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((block) => typeof block !== "object" || block === null || Array.isArray(block))) {
    throw new TypeError("blocks must be a non-empty array of objects");
  }
  return value;
}

function snapshot<T extends FactoryCommandRequest>(request: T): { bytes: string; read(): T } {
  const bytes = JSON.stringify(request);
  if (bytes === undefined) throw new TypeError("command request is not JSON serializable");
  // The value parsed here is trusted: bytes were produced once from the exact
  // locally constructed V1 envelope above. Parsing afresh prevents callers or
  // a transport implementation from mutating the retained retry snapshot.
  return { bytes, read: () => JSON.parse(bytes) as T };
}

function normalizedBase(baseUrl: string | undefined): string {
  return baseUrl === undefined ? "" : baseUrl.replace(/\/+$/, "");
}

interface CommandResolver {
  resolve(sessionId: SessionID, commandId: CommandID, options?: RequestOptions): Promise<CommandStatus>;
}

class RestCommandResolver implements CommandResolver {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly credentials: FactoryRestCredentials;

  constructor(options: Pick<FactoryCommandsOptions, "fetch" | "baseUrl" | "credentials">) {
    // BOUND. A browser's `fetch` is a Window method: stored bare and called
    // as `this.fetchImpl(...)` it runs with this object as its receiver and
    // throws "Illegal invocation" before any request leaves — which the catch
    // below reports as a NetworkError. Node's fetch does not check its
    // receiver, so only a real browser against a real Factory ever saw it.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = normalizedBase(options.baseUrl);
    this.credentials = options.credentials ?? {};
  }

  async resolve(sessionId: SessionID, commandId: CommandID, options: RequestOptions = {}): Promise<CommandStatus> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(await this.credentials.restHeaders?.() ?? {})) {
      headers.set(name, value);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "GET", headers, signal: options.signal });
    } catch (cause) {
      if (options.signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) {
        throw new RequestAbortedError(path, { cause });
      }
      throw new NetworkError(path, { cause });
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (cause) {
      throw new MalformedResponseError(path, response.status, { cause });
    }
    if (!response.ok) throw errorFromCoreEnvelope(validateCoreErrorEnvelope(data));
    const status = validateCommandStatus(data);
    if (status.command_id !== commandId) throw new CommandIdentityMismatchError(commandId, status.command_id);
    return status;
  }
}

/** One immutable logical user action. `retry` never generates or accepts replacement identities. */
export class PendingCommand<T extends FactoryCommandRequest = FactoryCommandRequest> {
  readonly method: FactoryCommandMethod;
  readonly commandId: CommandID;
  readonly sessionId: SessionID;
  readonly bytes: string;
  private readonly readSnapshot: () => T;
  private readonly link: ClientLink;
  private readonly resolver: CommandResolver;

  constructor(method: FactoryCommandMethod, request: T, link: ClientLink, resolver: CommandResolver) {
    const owned = snapshot(request);
    this.method = method;
    this.commandId = request.command_id;
    this.sessionId = request.session_id;
    this.bytes = owned.bytes;
    this.readSnapshot = owned.read;
    this.link = link;
    this.resolver = resolver;
  }

  /** A fresh copy of the retained request, safe for inspection or mutation by the caller. */
  get request(): T {
    return this.readSnapshot();
  }

  /** Sends the retained envelope once. The pending object remains reusable if the outcome is unknown. */
  async submit(): Promise<CommandStatus> {
    const status = await this.link.rpc(this.method, this.readSnapshot());
    if (status.command_id !== this.commandId) {
      throw new CommandIdentityMismatchError(this.commandId, status.command_id);
    }
    return status;
  }

  /** Replays the byte-equivalent retained envelope without minting another identity. */
  retry(): Promise<CommandStatus> {
    return this.submit();
  }

  /**
   * Sends once while preserving ambiguity as data. A validated Core rejection is
   * definitive; a transport or malformed-response failure is unknown because
   * admission may already have committed before the reply was lost.
   */
  async attempt(): Promise<CommandAttempt<T>> {
    try {
      return { outcome: "resolved", status: await this.submit(), pending: this };
    } catch (error) {
      return error instanceof CoreProtocolError
        ? { outcome: "rejected", error, pending: this }
        : { outcome: "unknown", error, pending: this };
    }
  }

  /** Authoritatively reads the accepted record by this exact SessionID/CommandID pair. */
  resolve(options?: RequestOptions): Promise<CommandStatus> {
    return this.resolver.resolve(this.sessionId, this.commandId, options);
  }
}

export type CommandAttempt<T extends FactoryCommandRequest = FactoryCommandRequest> =
  | { readonly outcome: "resolved"; readonly status: CommandStatus; readonly pending: PendingCommand<T> }
  | { readonly outcome: "rejected"; readonly error: CoreProtocolError; readonly pending: PendingCommand<T> }
  | { readonly outcome: "unknown"; readonly error: unknown; readonly pending: PendingCommand<T> };

export interface CreateCommandInput {
  agentId: string;
  blocks?: readonly Record<string, unknown>[];
  /** App-defined audit fields; Factory stamps the sender separately. */
  metadata?: MessageMetadata;
}

export interface InputCommandInput {
  blocks: readonly Record<string, unknown>[];
  metadata?: MessageMetadata;
}

export type ResidentGateResponseInput = {
  gateId: string;
  action: string;
  values: Readonly<Record<string, unknown>>;
} & (
  | { expectedOpenEventId: string; expectedOpenJournalSeq?: never }
  | { expectedOpenEventId?: never; expectedOpenJournalSeq: number }
);

export interface FactoryCommands {
  create(input: CreateCommandInput): PendingCommand<CreateCommandRequest>;
  input(sessionId: string, input: InputCommandInput): PendingCommand<InputCommandRequest>;
  interrupt(sessionId: string): PendingCommand<InterruptCommandRequest>;
  restore(sessionId: string): PendingCommand<RestoreCommandRequest>;
  respondResidentGate(sessionId: string, input: ResidentGateResponseInput): PendingCommand<ResidentGateResponseRequest>;
}

export interface FactoryCommandsOptions {
  link: ClientLink;
  idGenerator?: () => string;
  fetch?: FetchLike;
  baseUrl?: string;
  credentials?: FactoryRestCredentials;
}

/** Constructs the retry-stable command plane over one application-scoped ClientLink. */
export function createFactoryCommands(options: FactoryCommandsOptions): FactoryCommands {
  const generate = options.idGenerator ?? (() => uuidV4());
  const resolver = new RestCommandResolver(options);
  const envelope = (target: string): CommandEnvelope => ({
    version: 1,
    command_id: commandID(generate()),
    session_id: sessionID(target),
  });
  return {
    create(input) {
      const fields = metadata(input.metadata);
      const agent = otherID(input.agentId, "agent_id");
      const body = input.blocks === undefined ? undefined : blocks(input.blocks, false);
      const request: CreateCommandRequest = {
        version: 1,
        command_id: commandID(generate()),
        session_id: sessionID(generate()),
        agent_id: agent,
        ...(body === undefined ? {} : { blocks: body }),
        ...(fields === undefined ? {} : { metadata: fields }),
      };
      return new PendingCommand("session.create", request, options.link, resolver);
    },
    input(target, input) {
      const fields = metadata(input.metadata);
      const body = blocks(input.blocks, true)!;
      const request: InputCommandRequest = {
        ...envelope(target),
        blocks: body,
        ...(fields === undefined ? {} : { metadata: fields }),
      };
      return new PendingCommand("session.input", request, options.link, resolver);
    },
    interrupt(target) {
      return new PendingCommand("session.interrupt", envelope(target), options.link, resolver);
    },
    restore(target) {
      return new PendingCommand("session.restore", envelope(target), options.link, resolver);
    },
    respondResidentGate(target, input) {
      if (input.action.trim() === "") throw new TypeError("action must be non-empty");
      if (typeof input.values !== "object" || input.values === null || Array.isArray(input.values)) {
        throw new TypeError("values must be an object");
      }
      if (input.expectedOpenJournalSeq !== undefined
        && (!Number.isSafeInteger(input.expectedOpenJournalSeq) || input.expectedOpenJournalSeq < 1)) {
        throw new RangeError("expectedOpenJournalSeq must be a positive safe integer");
      }
      if ((input.expectedOpenEventId === undefined) === (input.expectedOpenJournalSeq === undefined)) {
        throw new TypeError("gate response requires exactly one optimistic open identity");
      }
      const request: ResidentGateResponseRequest = {
        ...envelope(target),
        gate_id: otherID(input.gateId, "gate_id"),
        action: input.action,
        values: input.values,
        ...(input.expectedOpenEventId === undefined
          ? { expected_open_journal_seq: input.expectedOpenJournalSeq! }
          : { expected_open_event_id: otherID(input.expectedOpenEventId, "expected_open_event_id") }),
      };
      // Factory's ClientLink method name (`clientlink.MethodGateRespond`). wui
      // <= v0.2.0 sent "session.gate.respond", which no Factory serves.
      return new PendingCommand("gate.respond", request, options.link, resolver);
    },
  };
}
