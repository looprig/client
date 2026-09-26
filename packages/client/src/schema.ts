/**
 * Type-level mirrors of harness's vendored wire-contract JSON Schema documents
 * (`contract/schema/*.schema.json`, resolved relative to the repo root via
 * `../../../contract/schema/`).
 *
 * ## Why these are literal `as const` objects instead of JSON imports
 *
 * The obvious design — `import x from "../../../contract/schema/foo.schema.json"
 * with { type: "json" }` — works fine at runtime (Node and Vite both load the
 * real vendored bytes), but TypeScript's JSON-module type inference WIDENS every
 * primitive in the imported value (`"type": "object"` becomes `type: string`,
 * `"const": 1` becomes `version: number`, etc.) exactly the way a plain `let`
 * declaration would. This is not a resolveJsonModule/module-setting question —
 * it reproduces identically whether you use `with { type: "json" }` under
 * `module: NodeNext` or classic `resolveJsonModule` under `module: commonjs`
 * (verified empirically against this repo's pinned TypeScript 6.0.3). Confirmed
 * dead ends: `import type` default-imports a JSON module (JSON default exports
 * aren't a type to import as), and `asConst()`/`as const` cannot re-narrow a
 * variable whose type has already been widened — the literal information is
 * gone by the time the import's type is computed, not merely hidden.
 * `json-schema-to-ts`'s own README confirms this is a known gap ("importing
 * JSONs `as const` is not available yet").
 *
 * `FromSchema<typeof schema>` (see types.ts) needs the LITERAL type (the actual
 * string `"object"`, the actual union `"journal" | "live_sse" | ...`) to derive
 * anything useful, so a widened JSON import cannot feed it.
 *
 * The fix used here: each schema below is written out as a TypeScript object
 * literal with `as const satisfies JSONSchema`, mechanically copied from the
 * corresponding vendored file's parsed JSON (structurally byte-for-content
 * identical — generated once, not hand-typed, to rule out transcription
 * mistakes). This gives `FromSchema` real literal types to work with.
 *
 * This reintroduces exactly the drift risk vendoring was meant to kill (a
 * second copy of the schema that could silently rot), so it is closed the same
 * way harness's own `contract/contract_test.go` closes the harness<->client
 * drift risk: `test/contract.test.ts` parses every file in `contract/schema/`
 * and deep-equals it against the matching literal below. If the vendored
 * contract is refreshed (`make contract`) and this file isn't regenerated to
 * match, that test fails loudly instead of the type silently going stale.
 *
 * Runtime validation (validate.ts) uses these SAME literal objects to compile
 * ajv, rather than a separate JSON import — one canonical in-memory
 * representation per schema, checked against the vendored bytes by the
 * drift-guard test rather than duplicated again for ajv.
 */
import type { JSONSchema as JSONSchemaToTS } from "json-schema-to-ts";

/** json-schema-to-ts's draft-07 surface omits draft-2020-12 `$defs`. */
type JSONSchema = JSONSchemaToTS & { readonly $defs?: Readonly<Record<string, unknown>> };

/** Mirrors `contract/schema/capabilities.schema.json` (title: "Capabilities"). */
export const capabilitiesSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/capabilities.schema.json",
  "title": "Capabilities",
  "description": "GET /v1/capabilities response: static protocol-discovery document.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "protocol",
    "version",
    "features"
  ],
  "properties": {
    "protocol": {
      "type": "string",
      "const": "looprig.serve"
    },
    "version": {
      "type": "integer",
      "const": 1
    },
    "features": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "journal",
          "live_sse",
          "ephemeral_sse",
          "gate_response"
        ]
      }
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/create_request.schema.json` (title: "CreateRequest"). */
export const createRequestSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/create_request.schema.json",
  "title": "CreateRequest",
  "description": "Optional POST /v1/sessions body. An idle create sends no body or an empty object; a create-with-input sends {\"blocks\":[...]}. Block semantics are validated by the content block codec, not this schema.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "blocks": {
      "type": "array",
      "description": "Tagged content blocks; each carries a \"type\" discriminator decoded by content.UnmarshalBlocks.",
      "items": {
        "type": "object"
      }
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/create_response.schema.json` (title: "CreateResponse"). */
export const createResponseSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/create_response.schema.json",
  "title": "CreateResponse",
  "description": "201 body for POST /v1/sessions. command_id is present only when the create carried input blocks that were submitted; an idle create omits it.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "session_id"
  ],
  "properties": {
    "session_id": {
      "$ref": "uuid.schema.json"
    },
    "command_id": {
      "$ref": "uuid.schema.json"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/enduring_frame.schema.json` (title: "EnduringFrame"). */
export const enduringFrameSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/enduring_frame.schema.json",
  "title": "EnduringFrame",
  "description": "The JSON body carried in the data: field of an `event: enduring` SSE frame. The frame on the wire is `event: enduring\\nid: <journal_seq>\\ndata: <this-object>\\n\\n`; the id: line stamps the durable journal sequence (always present, \"0\" for a would-be zero-seq append). This schema constrains only the data: payload.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "v",
    "event"
  ],
  "properties": {
    "v": {
      "type": "integer",
      "const": 1
    },
    "event": {
      "$ref": "event_envelope.schema.json"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/ephemeral_frame.schema.json` (title: "EphemeralFrame"). */
export const ephemeralFrameSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/ephemeral_frame.schema.json",
  "title": "EphemeralFrame",
  "description": "The JSON body carried in the data: field of an `event: ephemeral` SSE frame. The frame on the wire is `event: ephemeral\\ndata: <this-object>\\n\\n` with NO id: line (Ephemeral events are never sequenced or persisted). kind selects how delta decodes; header is the producing event's identity; delta is absent for input_queued.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "v",
    "kind"
  ],
  "properties": {
    "v": {
      "type": "integer",
      "const": 1
    },
    "kind": {
      "type": "string",
      "enum": [
        "token_delta",
        "tool_call_started",
        "tool_call_completed",
        "input_queued",
        "compaction_started"
      ]
    },
    "header": {
      "$ref": "event_header.schema.json"
    },
    "delta": {
      "type": "object",
      "description": "Kind-specific payload. For token_delta a tagged chunk DTO ({chunk_type, ...}); for tool_call_started/completed the tool-call delta; for compaction_started the attempt id, reason, and basis; absent for input_queued."
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/error_response.schema.json` (title: "ErrorResponse"). */
export const errorResponseSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/error_response.schema.json",
  "title": "ErrorResponse",
  "description": "serve's top-level HTTP error envelope. Deliberately NESTED — a single \"error\" object — so machine-readable fields attach under \"error\" without colliding with a future top-level field. message is generic and client-safe (never internal cause text).",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "error"
  ],
  "properties": {
    "error": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string",
          "description": "Stable machine-readable code a client can switch on.",
          "enum": [
            "internal",
            "unauthorized",
            "invalid_body",
            "invalid_parameter",
            "session_not_found",
            "idempotency_conflict",
            "gate_not_found",
            "gate_action_invalid",
            "gate_kind_mismatch",
            "gate_not_ready",
            "gate_capacity"
          ]
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
} as const satisfies JSONSchema;

/**
 * looprig/client's OWN error envelope schema — NOT vendored from harness (see
 * this file's module comment above for why every OTHER schema here mirrors a
 * `contract/schema/*.schema.json` file; this one deliberately does not, and
 * has no counterpart under `contract/schema/`). It shares the exact wire
 * SHAPE serve's `error_response.schema.json` declares (nested
 * `{"error":{code,message,retryable}}`), but with a WIDER `code` enum: every
 * code the vendored schema lists, PLUS `"csrf_invalid"` and
 * `"origin_not_allowed"` — the two codes `internal/bff/guard.go` and
 * `internal/bff/csrf.go` mint locally when THEY reject a request, before it
 * ever reaches serve (see those two files' doc comments, and errors.go's).
 *
 * HostTransport (transport.ts) is the only client that can ever observe these
 * two codes — ServeTransport talks directly to serve, bypassing the BFF's
 * own middleware entirely — so HostTransport's request plumbing validates
 * every non-2xx body against THIS schema, not the narrower vendored
 * `errorResponseSchema` above. This schema is intentionally excluded from
 * `allSchemas` below: the drift-guard test (`test/contract.test.ts`) asserts
 * `allSchemas`'s keys exactly match `contract/schema/`'s files, and this
 * schema has no vendored file to match (there being nothing on harness's
 * side to drift from — it never emits these codes).
 */
export const bffErrorResponseSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/client/v1/bff_error_response.schema.json",
  "title": "BFFErrorResponse",
  "description": "looprig/client's own superset of serve's error_response.schema.json: same nested {\"error\":{code,message,retryable}} shape, but the code enum additionally covers the BFF-local rejection codes internal/bff/guard.go and internal/bff/csrf.go mint before a request ever reaches serve.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "error"
  ],
  "properties": {
    "error": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "code",
        "message",
        "retryable"
      ],
      "properties": {
        "code": {
          "type": "string",
          "description": "Stable machine-readable code a client can switch on. Every code serve's own error_response.schema.json enumerates, plus the two BFF-local codes csrf_invalid and origin_not_allowed.",
          "enum": [
            "internal",
            "unauthorized",
            "invalid_body",
            "invalid_parameter",
            "session_not_found",
            "idempotency_conflict",
            "gate_not_found",
            "gate_action_invalid",
            "gate_kind_mismatch",
            "gate_not_ready",
            "gate_capacity",
            "csrf_invalid",
            "origin_not_allowed"
          ]
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "type": "boolean"
        }
      }
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/event_envelope.schema.json` (title: "EventEnvelope"). */
export const eventEnvelopeSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/event_envelope.schema.json",
  "title": "EventEnvelope",
  "description": "The durable event wire envelope produced by event.MarshalEvent: a \"type\" discriminator (== the classify name), a \"v\" schema version, the embedded producer Header fields, and the type-specific payload. Only the envelope-invariant keys are constrained here; the per-type payload is open.",
  "type": "object",
  "required": [
    "type",
    "v"
  ],
  "properties": {
    "type": {
      "type": "string"
    },
    "v": {
      "type": "integer",
      "const": 1
    },
    "session_id": {
      "$ref": "uuid.schema.json"
    },
    "loop_id": {
      "$ref": "uuid.schema.json"
    },
    "turn_id": {
      "$ref": "uuid.schema.json"
    },
    "step_id": {
      "$ref": "uuid.schema.json"
    },
    "event_id": {
      "$ref": "uuid.schema.json"
    },
    "created_at": {
      "type": "string",
      "format": "date-time"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/event_header.schema.json` (title: "EventHeader"). */
export const eventHeaderSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/event_header.schema.json",
  "title": "EventHeader",
  "description": "The producer-identity struct (event.Header) stamped on every event, as it appears embedded under an ephemeral frame's header key. It is NOT the durable event_envelope shape (no type/v discriminator) -- Header has no such fields. session_id is always set (every event is at least session-scoped); the rest are present only when the producing event is loop/turn/step scoped or otherwise stamps them.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "session_id"
  ],
  "properties": {
    "session_id": {
      "$ref": "uuid.schema.json"
    },
    "loop_id": {
      "$ref": "uuid.schema.json"
    },
    "turn_id": {
      "$ref": "uuid.schema.json"
    },
    "step_id": {
      "$ref": "uuid.schema.json"
    },
    "agent_name": {
      "type": "string"
    },
    "event_id": {
      "$ref": "uuid.schema.json"
    },
    "created_at": {
      "type": "string",
      "format": "date-time"
    },
    "cause": {
      "type": "object",
      "description": "identity.Cause: the causing command/event's coordinates plus command_id, event_id, tool_execution_id, and agency. All fields are omitzero on the wire.",
      "additionalProperties": false,
      "properties": {
        "session_id": {
          "$ref": "uuid.schema.json"
        },
        "loop_id": {
          "$ref": "uuid.schema.json"
        },
        "turn_id": {
          "$ref": "uuid.schema.json"
        },
        "step_id": {
          "$ref": "uuid.schema.json"
        },
        "command_id": {
          "$ref": "uuid.schema.json"
        },
        "event_id": {
          "$ref": "uuid.schema.json"
        },
        "tool_execution_id": {
          "$ref": "uuid.schema.json"
        },
        "agency": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "visibility": {
      "type": "integer",
      "minimum": 0
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/event_journal_page.schema.json` (title: "EventJournalPage"). */
export const eventJournalPageSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/event_journal_page.schema.json",
  "title": "EventJournalPage",
  "description": "GET /v1/sessions/{sid}/journal response: a page of a session's Enduring events in journal-sequence order plus the resume cursor. next_journal_seq is the sequence to pass as from_journal_seq for the next page; done reports the journal was exhausted. GatePrepared never appears.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "events",
    "next_journal_seq",
    "done"
  ],
  "properties": {
    "events": {
      "type": "array",
      "items": {
        "$ref": "status_event.schema.json"
      }
    },
    "next_journal_seq": {
      "type": "integer",
      "minimum": 0
    },
    "done": {
      "type": "boolean"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/gate_accepted_response.schema.json` (title: "GateAcceptedResponse"). */
export const gateAcceptedResponseSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/gate_accepted_response.schema.json",
  "title": "GateAcceptedResponse",
  "description": "202 body for a durably-accepted gate response. Acceptance is durable, not proven consumption, so the body carries no fields — it is the empty object {}.",
  "type": "object",
  "additionalProperties": false,
  "properties": {}
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/gate_response_request.schema.json` (title: "GateResponseRequest"). */
export const gateResponseRequestSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/gate_response_request.schema.json",
  "title": "GateResponseRequest",
  "description": "POST /v1/sessions/{sid}/gates/{gid} body: a human's answer to an open gate. The server STAMPS user provenance and ignores any client-supplied source. action semantics (which actions a gate kind accepts) are validated by the authoritative session, not this schema.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "action"
  ],
  "properties": {
    "action": {
      "type": "string"
    },
    "values": {
      "type": "object",
      "description": "Action-specific values, e.g. {\"scope\":\"session\"} for an approve or {\"text\":\"blue\"} for an answer."
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/input_response.schema.json` (title: "InputResponse"). */
export const inputResponseSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/input_response.schema.json",
  "title": "InputResponse",
  "description": "200 body for POST /v1/sessions/{sid}/input: the command id Submit minted for the queued input.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "command_id"
  ],
  "properties": {
    "command_id": {
      "$ref": "uuid.schema.json"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/interrupt_response.schema.json` (title: "InterruptResponse"). */
export const interruptResponseSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/interrupt_response.schema.json",
  "title": "InterruptResponse",
  "description": "200 body for POST /v1/sessions/{sid}/interrupt: whether any in-flight turn was actually cancelled.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "interrupted"
  ],
  "properties": {
    "interrupted": {
      "type": "boolean"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/restore_response.schema.json` (title: "RestoreResponse"). */
export const restoreResponseSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/restore_response.schema.json",
  "title": "RestoreResponse",
  "description": "200 body for POST /v1/sessions/{sid}/restore, which is attach-or-restore: the id of the session now live in the registry, and whether the rig actually rebuilt it. restored is true when the session was rebuilt from durable history and false when an already-live session was reused (attach). Both are 200; the field is never omitted, so a client can distinguish them without inspecting server internals.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "session_id",
    "restored"
  ],
  "properties": {
    "session_id": {
      "$ref": "uuid.schema.json"
    },
    "restored": {
      "type": "boolean"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/session_list.schema.json` (title: "SessionList"). */
export const sessionListSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/session_list.schema.json",
  "title": "SessionList",
  "description": "GET /v1/sessions response: a page of summaries plus the paging cursor. next_skip is the skip to pass for the next page (set only when more may remain); done reports the end of the list was reached.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "sessions",
    "skip",
    "limit",
    "next_skip",
    "done"
  ],
  "properties": {
    "sessions": {
      "type": "array",
      "items": {
        "$ref": "session_summary.schema.json"
      }
    },
    "skip": {
      "type": "integer",
      "minimum": 0
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    },
    "next_skip": {
      "type": "integer",
      "minimum": 0
    },
    "done": {
      "type": "boolean"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/session_status.schema.json` (title: "SessionStatus"). */
export const sessionStatusSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/session_status.schema.json",
  "title": "SessionStatus",
  "description": "GET /v1/sessions/{sid}/status response: one session's projected lifecycle status, read from the catalog projection with no journal replay. active_turn_id / waiting_gate_id are omitted unless a turn is running or a gate is open; last_turn / last_step are the codec-safe summaries of the most recent terminal turn and completed step.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "session_id",
    "last_journal_seq"
  ],
  "properties": {
    "session_id": {
      "$ref": "uuid.schema.json"
    },
    "state": {
      "type": "string",
      "enum": [
        "running",
        "waiting_on_gate",
        "idle",
        "failed",
        "interrupted",
        "stopped"
      ]
    },
    "last_journal_seq": {
      "type": "integer",
      "minimum": 0
    },
    "active_turn_id": {
      "$ref": "uuid.schema.json"
    },
    "waiting_gate_id": {
      "$ref": "uuid.schema.json"
    },
    "last_turn": {
      "$ref": "status_event.schema.json"
    },
    "last_step": {
      "$ref": "status_event.schema.json"
    },
    "updated_at": {
      "type": "string",
      "format": "date-time"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/session_summary.schema.json` (title: "SessionSummary"). */
export const sessionSummarySchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/session_summary.schema.json",
  "title": "SessionSummary",
  "description": "One row of a session list: the picker-facing projection of a session's catalog entry.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "session_id"
  ],
  "properties": {
    "session_id": {
      "$ref": "uuid.schema.json"
    },
    "state": {
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "created_at": {
      "type": "string",
      "format": "date-time"
    },
    "last_active_at": {
      "type": "string",
      "format": "date-time"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/status_event.schema.json` (title: "StatusEvent"). */
export const statusEventSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/status_event.schema.json",
  "title": "StatusEvent",
  "description": "A durable journal sequence paired with the event recorded at that sequence. event is the durable wire envelope produced by event.MarshalEvent (type-tagged, versioned), NOT a Go-struct dump.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "journal_seq"
  ],
  "properties": {
    "journal_seq": {
      "type": "integer",
      "minimum": 0
    },
    "event": {
      "$ref": "event_envelope.schema.json"
    }
  }
} as const satisfies JSONSchema;

/** Mirrors `contract/schema/uuid.schema.json` (title: "UUID"). */
export const uuidSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://looprig.dev/serve/v1/uuid.schema.json",
  "title": "UUID",
  "description": "A canonical 8-4-4-4-12 lowercase-or-uppercase hex UUID string.",
  "type": "string",
  "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
} as const satisfies JSONSchema;

/**
 * Every vendored schema in this module, keyed by its filename stem
 * (`contract/schema/<key>.schema.json`). Used to seed the ajv instance in
 * validate.ts, and by the drift-guard test in test/contract.test.ts.
 */
export const allSchemas = {
  "capabilities": capabilitiesSchema,
  "create_request": createRequestSchema,
  "create_response": createResponseSchema,
  "enduring_frame": enduringFrameSchema,
  "ephemeral_frame": ephemeralFrameSchema,
  "error_response": errorResponseSchema,
  "event_envelope": eventEnvelopeSchema,
  "event_header": eventHeaderSchema,
  "event_journal_page": eventJournalPageSchema,
  "gate_accepted_response": gateAcceptedResponseSchema,
  "gate_response_request": gateResponseRequestSchema,
  "input_response": inputResponseSchema,
  "interrupt_response": interruptResponseSchema,
  "restore_response": restoreResponseSchema,
  "session_list": sessionListSchema,
  "session_status": sessionStatusSchema,
  "session_summary": sessionSummarySchema,
  "status_event": statusEventSchema,
  "uuid": uuidSchema,
} as const;

/**
 * Core sessionwire/v1 schemas consumed by the Factory REST and ClientLink
 * boundaries. They stay separate from the Harness-era allSchemas registry
 * until the legacy fold/SSE migration replaces that registry as a whole.
 */
export const factoryAgentCapabilitySummarySchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/agent_capability_summary.schema.json","title":"AgentCapabilitySummary","description":"Forward-compatible public capability summary without launch internals.","type":"object","additionalProperties":true,"required":["agent_id","runtime_compatibility_id"],"properties":{"agent_id":{"$ref":"#/$defs/id"},"runtime_compatibility_id":{"$ref":"#/$defs/id"},"capabilities":{"type":"array","items":{"type":"string"}}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."}}} as const satisfies JSONSchema;

export const factoryDepartmentCapabilitySummarySchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/department_capability_summary.schema.json","title":"DepartmentCapabilitySummary","description":"Forward-compatible public Department capability discovery response.","type":"object","additionalProperties":true,"required":["agents"],"properties":{"agents":{"type":"array","items":{"$ref":"#/$defs/agent"}}},"$defs":{"agent":{"type":"object","additionalProperties":true,"required":["agent_id","runtime_compatibility_id"],"properties":{"agent_id":{"type":"string","minLength":1},"runtime_compatibility_id":{"type":"string","minLength":1},"capabilities":{"type":"array","items":{"type":"string"}}}}}} as const satisfies JSONSchema;

export const factoryRecentSessionPageSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/recent_session_page.schema.json","title":"SessionPage","description":"Bounded recent-first durable page. The Core decoder verifies non-increasing last_active_at order.","type":"object","additionalProperties":true,"required":["sessions"],"properties":{"sessions":{"type":"array","items":{"$ref":"#/$defs/session"}},"next_cursor":{"type":"string"},"previous_cursor":{"type":"string"}},"$defs":{"session":{"type":"object","additionalProperties":true,"required":["session_id","agent_id","state","last_active_at"],"properties":{"session_id":{"type":"string","minLength":1},"agent_id":{"type":"string","minLength":1},"state":{"type":"string","minLength":1},"title":{"type":"string"},"created_at":{"type":"string","format":"date-time"},"last_active_at":{"type":"string","format":"date-time"}}}}} as const satisfies JSONSchema;

export const factorySessionStatusSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/session_status.schema.json","title":"SessionStatus","description":"Forward-compatible durable session state and residency projection.","type":"object","additionalProperties":true,"required":["session_id","agent_id","state","residency","journal_tip"],"properties":{"session_id":{"$ref":"#/$defs/id"},"agent_id":{"$ref":"#/$defs/id"},"state":{"type":"string","minLength":1},"residency":{"type":"string","minLength":1},"journal_tip":{"type":"integer","minimum":0},"waiting_gate_id":{"$ref":"#/$defs/id"},"updated_at":{"type":"string","format":"date-time"}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."}}} as const satisfies JSONSchema;

export const factoryPublicJournalPageSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/public_journal_page.schema.json","title":"JournalPage","description":"Bounded public journal page. covered_through can bridge private records without exposing their kind or bytes.","type":"object","additionalProperties":true,"required":["events","journal_tip","covered_through"],"properties":{"events":{"type":"array","items":{"$ref":"#/$defs/event"}},"journal_tip":{"type":"integer","minimum":0},"covered_through":{"type":"integer","minimum":0},"next_cursor":{"type":"string"},"previous_cursor":{"type":"string"}},"$defs":{"event":{"type":"object","additionalProperties":true,"required":["event_id","journal_seq","body"],"properties":{"event_id":{"type":"string","minLength":1},"journal_seq":{"type":"integer","minimum":1},"body":{"not":{"type":"null"}}}}}} as const satisfies JSONSchema;

export const factoryPublicGatePageSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/public_gate_page.schema.json","title":"GatePage","description":"Bounded public page of open gates captured at journal_tip. Prompts are presentation-safe projections only.","type":"object","additionalProperties":true,"required":["journal_tip","open_gate_count","gates"],"properties":{"journal_tip":{"type":"integer","minimum":0},"open_gate_count":{"type":"integer","minimum":0},"gates":{"type":"array","items":{"$ref":"#/$defs/gate"}},"next_cursor":{"type":"string"},"previous_cursor":{"type":"string"}},"$defs":{"gate":{"type":"object","additionalProperties":true,"required":["gate_id","kind","prompt","opened_event_id","opened_journal_seq","deadline","answerability"],"properties":{"gate_id":{"type":"string","minLength":1},"kind":{"type":"string","minLength":1},"prompt":{"$ref":"#/$defs/prompt"},"opened_event_id":{"type":"string","minLength":1},"opened_journal_seq":{"type":"integer","minimum":1},"deadline":{"type":"string","format":"date-time"},"answerability":{"enum":["resident","suspended","submitted","unavailable","expired"]}}},"prompt":{"type":"object","additionalProperties":true,"properties":{"title":{"type":"string"},"body":{"type":"string"},"origin":{"type":"string","format":"uri"},"schema":{"$ref":"#/$defs/prompt_schema"},"controls":{"type":"array","items":{"type":"object","additionalProperties":true,"required":["action","label"],"properties":{"action":{"type":"string","minLength":1},"label":{"type":"string","minLength":1}}}}}},"prompt_schema":{"type":"object","additionalProperties":true,"properties":{"fields":{"type":"array","items":{"type":"object","additionalProperties":true,"required":["name","label","kind","required"],"properties":{"name":{"type":"string","minLength":1},"label":{"type":"string"},"kind":{"enum":["text","select","multi_select","confirm"]},"required":{"type":"boolean"},"options":{"type":"array"},"default":{}}}}}}}} as const satisfies JSONSchema;

export const factoryObjectMetadataSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/object_metadata.schema.json","title":"ObjectMetadata","description":"Strict redaction boundary for immutable logical object metadata. Signed URLs, secret material, backend paths, and object bytes are not part of this contract.","type":"object","additionalProperties":false,"required":["reference","size_bytes"],"properties":{"reference":{"type":"object","additionalProperties":false,"required":["object_id"],"properties":{"object_id":{"type":"string","minLength":1}}},"size_bytes":{"type":"integer","minimum":0},"media_type":{"type":"string"},"digest":{"type":"string"},"created_at":{"type":"string","format":"date-time"}}} as const satisfies JSONSchema;

export const factoryEnduringPublicationSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/enduring_publication.schema.json","title":"EnduringPublication","description":"Forward-compatible live relay of one committed public journal event. Core enforces journal_seq == covered_through and the raw body fixed-point JSON representation.","type":"object","additionalProperties":true,"required":["type","tenant_id","session_id","event_id","journal_seq","covered_through","body"],"properties":{"type":{"const":"enduring_publication","type":"string","description":"Stable session-channel record name. Every record published on session:{tid}:{sid} names its own kind here."},"tenant_id":{"$ref":"#/$defs/id"},"session_id":{"$ref":"#/$defs/id"},"event_id":{"$ref":"#/$defs/id"},"journal_seq":{"type":"integer","minimum":1},"covered_through":{"type":"integer","minimum":1},"body":{"not":{"type":"null"}}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."}}} as const satisfies JSONSchema;

export const factoryEphemeralPublicationSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/ephemeral_publication.schema.json","title":"EphemeralPublication","description":"Forward-compatible best-effort public delta. It intentionally has no event_id, journal_seq, or covered_through durable promise; Core rejects those members on decode.","type":"object","additionalProperties":true,"required":["type","tenant_id","session_id","body"],"properties":{"type":{"const":"ephemeral_publication","type":"string","description":"Stable session-channel record name. Every record published on session:{tid}:{sid} names its own kind here."},"tenant_id":{"$ref":"#/$defs/id"},"session_id":{"$ref":"#/$defs/id"},"body":{"not":{"type":"null"}}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."}}} as const satisfies JSONSchema;

export const factoryJournalTipSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/journal_tip.schema.json","title":"JournalTip","description":"Forward-compatible repeatable durable-repair hint, not a client acknowledgement or cursor.","type":"object","additionalProperties":true,"required":["type","tenant_id","session_id","journal_tip"],"properties":{"type":{"const":"journal_tip","type":"string","description":"Stable session-channel record name. Every record published on session:{tid}:{sid} names its own kind here."},"tenant_id":{"$ref":"#/$defs/id"},"session_id":{"$ref":"#/$defs/id"},"journal_tip":{"type":"integer","minimum":0}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."}}} as const satisfies JSONSchema;

export const factorySessionResetSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/session_reset.schema.json","title":"SessionReset","description":"Forward-compatible repair control after a durable live-tail gap. Core enforces last_contiguous <= journal_tip.","type":"object","additionalProperties":true,"required":["type","tenant_id","session_id","last_contiguous","journal_tip"],"properties":{"type":{"const":"session.reset","type":"string","description":"Stable session-channel record name. Every record published on session:{tid}:{sid} names its own kind here."},"tenant_id":{"$ref":"#/$defs/id"},"session_id":{"$ref":"#/$defs/id"},"last_contiguous":{"type":"integer","minimum":0},"journal_tip":{"type":"integer","minimum":0}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."}}} as const satisfies JSONSchema;

export const factoryVersionNegotiationRequestSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/version_negotiation_request.schema.json","title":"VersionNegotiationRequest","description":"Strict pre-control offer of nonzero, duplicate-free sessionwire versions.","type":"object","additionalProperties":false,"required":["supported_versions"],"properties":{"supported_versions":{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"integer","minimum":1}}}} as const satisfies JSONSchema;

export const factoryVersionNegotiationResponseSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/version_negotiation_response.schema.json","title":"VersionNegotiationResponse","description":"Forward-compatible selected sessionwire version. hostlink_methods is the optional set of reserved HostLink method names the replying Host serves; it is absent when the Host advertises nothing and its item values are deliberately open so a method added later does not invalidate an older consumer.","type":"object","additionalProperties":true,"required":["version"],"properties":{"version":{"const":1},"hostlink_methods":{"type":"array","uniqueItems":true,"items":{"type":"string","minLength":1,"description":"A reserved HostLink method name such as hostlink.attach; Core enforces the 256-byte identifier limit and tolerates a name it does not know."}}}} as const satisfies JSONSchema;

export const factoryCommandStatusSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/command_status.schema.json","title":"CommandStatus","description":"Forward-compatible durable command lifecycle response. A rejected command has a stable public error detail.","type":"object","additionalProperties":true,"required":["command_id","status"],"properties":{"command_id":{"$ref":"#/$defs/id"},"status":{"enum":["accepted","pending","applied","rejected"]},"accepted_order":{"type":"integer","minimum":1},"error":{"$ref":"#/$defs/error"}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."},"error":{"type":"object","additionalProperties":true,"required":["code","retryable"],"properties":{"code":{"type":"string","minLength":1},"message":{"type":"string"},"retryable":{"type":"boolean"}}}}} as const satisfies JSONSchema;

export const factoryErrorEnvelopeSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/error_envelope.schema.json","title":"ErrorEnvelope","description":"Forward-compatible public error envelope. Error codes are stable while messages remain safe presentation text.","type":"object","additionalProperties":true,"required":["error"],"properties":{"error":{"type":"object","additionalProperties":true,"required":["code","retryable"],"properties":{"code":{"type":"string","minLength":1},"message":{"type":"string"},"retryable":{"type":"boolean"}}}}} as const satisfies JSONSchema;

/** Core v0.12.0 command request and sender schemas, generated from the vendored JSON by the plan's node command. */
export const factoryCreateRequestSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/create_request.schema.json","title":"CreateRequest","description":"Retry-safe durable create command. session_id and command_id are client-generated opaque V1 identities. metadata is optional client-supplied app-defined fields; principal is optional and only ever Factory-stamped.","type":"object","additionalProperties":false,"required":["version","command_id","session_id","agent_id"],"properties":{"version":{"const":1},"command_id":{"$ref":"#/$defs/id"},"session_id":{"$ref":"#/$defs/id"},"agent_id":{"$ref":"#/$defs/id"},"blocks":{"type":"array","minItems":1,"items":{"type":"object"}},"metadata":{"$ref":"#/$defs/metadata"},"principal":{"$ref":"#/$defs/principal"}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."},"metadata":{"type":"object","description":"Client-supplied app-defined string fields. Core also enforces: 1 to 16 fields; keys match ^[a-z][a-z0-9_]{0,63}$ and do not begin with looprig; values are at most 1024 bytes of UTF-8 with no C0 control other than tab and newline; the canonical encoding of the object is at most 4096 bytes.","not":{"const":{}},"additionalProperties":{"type":"string"}},"principal":{"type":"object","description":"The verified sender a Factory stamped after credential verification. Never client-supplied: a Factory refuses a request that carries it.","additionalProperties":false,"required":["tenant","subject","kind"],"properties":{"tenant":{"$ref":"#/$defs/id"},"subject":{"$ref":"#/$defs/id"},"kind":{"enum":["actor","service"]}}}}} as const satisfies JSONSchema;

export const factoryInputRequestSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/input_request.schema.json","title":"InputRequest","description":"Retry-safe durable input command. Block semantics remain transport-neutral and are validated by the receiving runtime. metadata is optional client-supplied app-defined fields; principal is optional and only ever Factory-stamped.","type":"object","additionalProperties":false,"required":["version","command_id","session_id","blocks"],"properties":{"version":{"const":1},"command_id":{"$ref":"#/$defs/id"},"session_id":{"$ref":"#/$defs/id"},"blocks":{"type":"array","minItems":1,"items":{"type":"object"}},"metadata":{"$ref":"#/$defs/metadata"},"principal":{"$ref":"#/$defs/principal"}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."},"metadata":{"type":"object","description":"Client-supplied app-defined string fields. Core also enforces: 1 to 16 fields; keys match ^[a-z][a-z0-9_]{0,63}$ and do not begin with looprig; values are at most 1024 bytes of UTF-8 with no C0 control other than tab and newline; the canonical encoding of the object is at most 4096 bytes.","not":{"const":{}},"additionalProperties":{"type":"string"}},"principal":{"type":"object","description":"The verified sender a Factory stamped after credential verification. Never client-supplied: a Factory refuses a request that carries it.","additionalProperties":false,"required":["tenant","subject","kind"],"properties":{"tenant":{"$ref":"#/$defs/id"},"subject":{"$ref":"#/$defs/id"},"kind":{"enum":["actor","service"]}}}}} as const satisfies JSONSchema;

export const factoryInterruptRequestSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/interrupt_request.schema.json","title":"InterruptRequest","description":"Retry-safe durable interrupt command. principal is optional and only ever Factory-stamped; metadata is never carried.","type":"object","additionalProperties":false,"required":["version","command_id","session_id"],"properties":{"version":{"const":1},"command_id":{"$ref":"#/$defs/id"},"session_id":{"$ref":"#/$defs/id"},"principal":{"$ref":"#/$defs/principal"}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."},"principal":{"type":"object","description":"The verified sender a Factory stamped after credential verification. Never client-supplied: a Factory refuses a request that carries it.","additionalProperties":false,"required":["tenant","subject","kind"],"properties":{"tenant":{"$ref":"#/$defs/id"},"subject":{"$ref":"#/$defs/id"},"kind":{"enum":["actor","service"]}}}}} as const satisfies JSONSchema;

export const factoryRestoreRequestSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/restore_request.schema.json","title":"RestoreRequest","description":"Explicit compatibility restore command; durable reads never imply a restore. principal is optional and only ever Factory-stamped; metadata is never carried.","type":"object","additionalProperties":false,"required":["version","command_id","session_id"],"properties":{"version":{"const":1},"command_id":{"$ref":"#/$defs/id"},"session_id":{"$ref":"#/$defs/id"},"principal":{"$ref":"#/$defs/principal"}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."},"principal":{"type":"object","description":"The verified sender a Factory stamped after credential verification. Never client-supplied: a Factory refuses a request that carries it.","additionalProperties":false,"required":["tenant","subject","kind"],"properties":{"tenant":{"$ref":"#/$defs/id"},"subject":{"$ref":"#/$defs/id"},"kind":{"enum":["actor","service"]}}}}} as const satisfies JSONSchema;

export const factoryGateResponseRequestSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/gate_response_request.schema.json","title":"GateResponseRequest","description":"Retry-safe private gate response. values are opaque JSON values; the request requires exactly one nonzero optimistic open version. principal is optional and only ever Factory-stamped; metadata is never carried.","type":"object","additionalProperties":false,"required":["version","command_id","session_id","gate_id","action","values"],"properties":{"version":{"const":1},"command_id":{"$ref":"#/$defs/id"},"session_id":{"$ref":"#/$defs/id"},"gate_id":{"$ref":"#/$defs/id"},"action":{"type":"string","minLength":1},"values":{"type":"object","additionalProperties":true},"expected_open_event_id":{"$ref":"#/$defs/id"},"expected_open_journal_seq":{"type":"integer","minimum":1},"principal":{"$ref":"#/$defs/principal"}},"oneOf":[{"required":["expected_open_event_id"],"not":{"required":["expected_open_journal_seq"]}},{"required":["expected_open_journal_seq"],"not":{"required":["expected_open_event_id"]}}],"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."},"principal":{"type":"object","description":"The verified sender a Factory stamped after credential verification. Never client-supplied: a Factory refuses a request that carries it.","additionalProperties":false,"required":["tenant","subject","kind"],"properties":{"tenant":{"$ref":"#/$defs/id"},"subject":{"$ref":"#/$defs/id"},"kind":{"enum":["actor","service"]}}}}} as const satisfies JSONSchema;

export const factoryPrincipalSchema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://looprig.dev/sessionwire/v1/principal.schema.json","title":"Principal","description":"The verified sender of a command as a Factory established it. Never client-supplied; holds only verified facts (display names are resolved by the application from subject). Carried by every command request as the optional principal member.","type":"object","additionalProperties":false,"required":["tenant","subject","kind"],"properties":{"tenant":{"$ref":"#/$defs/id"},"subject":{"$ref":"#/$defs/id"},"kind":{"enum":["actor","service"]}},"$defs":{"id":{"type":"string","minLength":1,"description":"Opaque UTF-8 identity; Core enforces the 256-byte limit."}}} as const satisfies JSONSchema;

export const factorySchemas = {
  "create_request": factoryCreateRequestSchema,
  "input_request": factoryInputRequestSchema,
  "interrupt_request": factoryInterruptRequestSchema,
  "restore_request": factoryRestoreRequestSchema,
  "gate_response_request": factoryGateResponseRequestSchema,
  "principal": factoryPrincipalSchema,
  "agent_capability_summary": factoryAgentCapabilitySummarySchema,
  "department_capability_summary": factoryDepartmentCapabilitySummarySchema,
  "recent_session_page": factoryRecentSessionPageSchema,
  "session_status": factorySessionStatusSchema,
  "public_journal_page": factoryPublicJournalPageSchema,
  "public_gate_page": factoryPublicGatePageSchema,
  "object_metadata": factoryObjectMetadataSchema,
  "enduring_publication": factoryEnduringPublicationSchema,
  "ephemeral_publication": factoryEphemeralPublicationSchema,
  "journal_tip": factoryJournalTipSchema,
  "session_reset": factorySessionResetSchema,
  "version_negotiation_request": factoryVersionNegotiationRequestSchema,
  "version_negotiation_response": factoryVersionNegotiationResponseSchema,
  "command_status": factoryCommandStatusSchema,
  "error_envelope": factoryErrorEnvelopeSchema,
} as const;
