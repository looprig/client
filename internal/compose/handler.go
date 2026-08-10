package compose

import "net/http"

// Handler composes the client's top-level HTTP surface from mux (built by
// Build) and spa (typically pkg/webui.Handler()): everything under "/api/"
// is routed to mux, and every other path falls through to spa.
//
// This is a plain (unprefixed) mount, not http.StripPrefix: mux's own
// registered patterns already include the full "/api/..." shape (see
// internal/bff/mux.go's package doc — NewBrowseOnlyMux and NewMuxWithHost
// both register patterns like "GET /api/v1/capabilities" and "/api/"
// directly), so stripping the prefix here a second time would make mux see
// paths it was never built to match.
func Handler(mux http.Handler, spa http.Handler) http.Handler {
	top := http.NewServeMux()
	top.Handle("/api/", mux)
	top.Handle("/", spa)
	return top
}
