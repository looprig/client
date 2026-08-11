package bff

// errors.go is the JSON error envelope this package's own middleware
// (HostOriginGuard in guard.go, CSRFGuard in csrf.go) writes when IT rejects
// a request — before the request ever reaches a proxied/mounted read source
// or a control host. It mirrors the same nested wire shape harness's
// pkg/serve error envelope uses ({"error":{"code","message","retryable"}},
// see contract/schema/error_response.schema.json) so a client can decode
// every non-2xx response — whether it originated at serve (proxied straight
// through this BFF) or was rejected here, at the BFF's own edge — through
// one envelope shape.
//
// The two codes below are genuinely BFF-local: serve never emits them
// (guard.go/csrf.go never proxy to serve at all when they reject a
// request), so a client that already knows how to decode serve's error
// codes needs to additionally recognize these before it can fully classify
// every error this BFF can produce. See sdk/core/src/errors.ts's
// CSRFRejectedError/OriginNotAllowedError and sdk/core/src/schema.ts's
// bffErrorResponseSchema for the client-side half of this contract.
//
// The two codes are deliberately DISTINCT — never share one code — and
// deliberately carry different `retryable` values: codeCSRFInvalid is
// retryable (a client can clear its cached token, mint a fresh one via
// CSRFGuard.TokenHandler, and retry the exact same request once — see
// csrf.go's Wrap doc), while codeOriginNotAllowed is NOT (this specific
// request's Host/Origin failed a security check that retrying with the
// identical origin can never fix). Conflating the two into one code would
// make client-side retry logic unsafe: retrying an origin rejection forever,
// or never retrying an expired-but-otherwise-legitimate CSRF token.

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

const (
	codeCSRFInvalid      = "csrf_invalid"
	codeOriginNotAllowed = "origin_not_allowed"
)

// bffErrorResponse / bffErrorBody mirror harness's pkg/serve error envelope
// shape exactly (its own errorResponse/errorBody, unexported to that
// package) — duplicated here, not imported, because this package's own
// rejections never reach serve to borrow its encoder, and pkg/serve's types
// are unexported anyway.
type bffErrorResponse struct {
	Error bffErrorBody `json:"error"`
}

// bffErrorBody is the nested error detail: a stable machine-readable Code, a
// generic client-safe Message (NEVER internal cause text — callers of
// writeBFFError below must never pass one), and whether the client may retry
// the identical request.
type bffErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// writeBFFError sets the JSON content type, writes status, and encodes the
// nested error envelope. message MUST be generic and client-safe. An encode
// failure is logged, not surfaced: the status and headers are already
// committed by the time json.Encode could fail.
func writeBFFError(w http.ResponseWriter, status int, code, message string, retryable bool) {
	w.Header().Set("Content-Type", contentTypeJSON)
	w.WriteHeader(status)
	body := bffErrorResponse{Error: bffErrorBody{Code: code, Message: message, Retryable: retryable}}
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Error("bff: encode error response", "code", code, "err", err)
	}
}
