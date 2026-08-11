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
import type { JSONSchema } from "json-schema-to-ts";

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
 * BFFTransport (transport.ts) is the only client that can ever observe these
 * two codes — ServeTransport talks directly to serve, bypassing the BFF's
 * own middleware entirely — so BFFTransport's request plumbing validates
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
  "description": "200 body for POST /v1/sessions/{sid}/restore: the id of the rebuilt-and-reattached session.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "session_id"
  ],
  "properties": {
    "session_id": {
      "$ref": "uuid.schema.json"
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
