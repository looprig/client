package compose

import (
	"net/http"

	"github.com/looprig/client/internal/bff"
)

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
//
// The WHOLE composed handler — spa included, not just the "/api/" subtree —
// is wrapped in guard. mux is already guard-wrapped internally by Build
// (see internal/bff/mux.go), so wrapping it again here is
// redundant-but-harmless for "/api/" requests; it is NOT redundant for "/"
// — without this, a DNS-rebound page could fetch the SPA shell itself (see
// guard.go's DNS-rebinding threat model). Low severity today (the shell
// embeds no secret), but this closes the gap before anything ever gets
// embedded into the served HTML that would turn it into one.
//
// guard must be the SAME *bff.HostOriginGuard instance passed to the Build
// call that produced mux, not a second, independently constructed one:
// HostOriginGuard is pure, stateless configuration — a static allowedHosts
// map fixed for good at construction and never mutated afterward — so
// reusing one instance costs nothing, and it makes the two guards
// impossible to accidentally configure differently once a caller starts
// threading cfg-derived extraAllowedHosts into NewHostOriginGuard (see
// compose.Build's doc for the full rationale).
func Handler(mux http.Handler, spa http.Handler, guard *bff.HostOriginGuard) http.Handler {
	top := http.NewServeMux()
	top.Handle("/api/", mux)
	top.Handle("/", spa)
	return guard.Wrap(top)
}
