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

/**
 * True when Factory reports that a live Host currently owns this gate and can
 * apply a response to it — `answerability === "resident"`, and nothing else.
 *
 * READ THE SCOPE. This is permission to offer the answer form for a gate whose
 * owner is up RIGHT NOW. It is NOT a statement that an answer to a cold gate
 * can resume: that is `suspended`, it depends on a committed continuation
 * pointer plus a `SessionSuspended` transition, and this function deliberately
 * returns false for it. Widening the comparison — or renaming this to something
 * like "answerable" or "resumable" — would promise a continuation nothing here
 * has checked.
 *
 * Everything that is not exactly `"resident"` is false, including the four
 * other declared values, an unrecognized value from a newer Factory, and `""`,
 * which is what a gate observed only through a durable `GateOpened` carries: an
 * open journal event proves presentation, never answerability.
 *
 * It takes the narrowest possible parameter so it can read a
 * `PublicGateProjection`, a board entry, or anything else that carries the
 * attested state, without either module depending on the other.
 */
export function acceptsResidentResponse(gate: { readonly answerability: string }): boolean {
  return gate.answerability === "resident";
}
