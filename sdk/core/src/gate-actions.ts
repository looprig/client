/**
 * The three exact user-facing gate approval actions harness's `pkg/gate`
 * defines and the ONLY `action` values a `GateResponseRequest` may carry for
 * a human's answer to a permission-review gate.
 *
 * `gate_response_request.schema.json` types `action` as a bare `string` —
 * its own description says "action semantics (which actions a gate kind
 * accepts) are validated by the authoritative session, not this schema" — so
 * there is no schema-level enum to derive this from. This module is this
 * SDK's own mirror of harness's exact vocabulary instead, copied from
 * `pkg/gate/response.go`'s `ApprovalAction` constants:
 *
 *   const (
 *     ApprovalApprove                ApprovalAction = "Approve"
 *     ApprovalApproveAlwaysWorkspace ApprovalAction = "Approve always for this workspace"
 *     ApprovalDeny                   ApprovalAction = "Deny"
 *   )
 *
 * harness's session performs an EXACT string match against these three
 * (`gate.ParseApprovalAction`) and rejects anything else with
 * `gate_action_invalid` — never invent a different label (e.g. "approve_once"
 * or "yes") for a gate-response UI; use these constants verbatim.
 */
export const GATE_APPROVAL_ACTIONS = {
  approve: "Approve",
  approveAlwaysWorkspace: "Approve always for this workspace",
  deny: "Deny",
} as const;

/** One of the three exact gate approval action strings — see `GATE_APPROVAL_ACTIONS`. */
export type GateApprovalAction = (typeof GATE_APPROVAL_ACTIONS)[keyof typeof GATE_APPROVAL_ACTIONS];
