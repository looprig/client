package bff

// mux.go assembles the BFF's public HTTP surface: a ReadSource (mounted or
// proxied — see readsource.go), synthesized capabilities (capabilities.go), and
// the security middleware (guard.go, csrf.go) that stand in front of all of it.
//
// Route shape:
//
//   - GET /api/v1/capabilities   — served by handleCapabilities, NEVER forwarded
//     to the mounted ReadSource's own /v1/capabilities route (see capabilities.go
//     for why). This pattern is a literal path match, which net/http's ServeMux
//     resolves as MORE specific than the "/api/" subtree pattern below, so it
//     wins for this one path even though both patterns technically match it.
//   - /api/{...}                 — everything else under /api is forwarded, prefix
//     stripped, to the mounted/proxied ReadSource, whose own internal routing
//     expects paths like /v1/sessions (not /api/v1/sessions). This pattern
//     carries NO method restriction, so every method reaches the ReadSource's own
//     mux and the ReadSource decides 200/404/405 on its own terms — the outer BFF
//     mux never manufactures a 405 of its own for a read-shaped path.
//
// Control routes (input/gates/interrupt/create/restore) do not exist as code yet
// — later tasks build the control host proxy and add them. The `if hostConfigured`
// block below is the ONLY place future control-route registration may happen: it
// is unreachable when hostConfigured is false, so browse-only mode cannot wire in
// a control route by construction, not merely by omission. When those routes are
// added, each state-changing one must be wrapped individually with csrf.Wrap
// (csrf.go) before being handed to mux.Handle — see
// TestNewMuxCSRFCompositionForFutureControlRoutes in mux_test.go, which proves
// that composition is correct today even though no concrete route uses it yet.
//
// Middleware layering: HostOriginGuard wraps the WHOLE returned handler — every
// request, read or (future) control, passes its Host/Origin check first, fail
// secure, reject-fast (guard.go). CSRFGuard is NOT wrapped around the whole mux:
// doing so would make CSRFGuard.Wrap intercept every POST/PUT/PATCH/DELETE BEFORE
// net/http's ServeMux ever gets a chance to resolve routing, turning every such
// request into a blanket 403 — including one aimed at a path with no control
// route registered at all. That would defeat browse-only mode's absence proof:
// requesting a control-shaped path must 404/405 (route not registered — the same
// convention harness's own ReadHandler tests use, see mux_test.go), never 403
// (route registered but request rejected). CSRFGuard therefore applies only
// per-route, at the point a state-changing control route is actually registered.
import "net/http"

// NewMux assembles the BFF's public HTTP surface over read (the mounted or
// proxied ReadSource, see readsource.go), guard (HostOriginGuard, see guard.go),
// and csrf (CSRFGuard, see csrf.go), for future control-route use. hostConfigured
// reports whether a control host is wired: it currently affects only the
// capabilities document (capabilities.go), but ALSO establishes the sole
// insertion point for control-route registration a later task will use — see the
// package doc comment above.
func NewMux(read ReadSource, guard *HostOriginGuard, csrf *CSRFGuard, hostConfigured bool) http.Handler {
	_ = csrf // reserved for a later task's state-changing control routes; see package doc.

	mux := http.NewServeMux()

	mux.Handle("GET /api/v1/capabilities", handleCapabilities(hostConfigured))
	mux.Handle("/api/", http.StripPrefix("/api", read))

	if hostConfigured {
		// A later task registers the control-plane's state-changing routes HERE —
		// input/gates/interrupt/create/restore — each wrapped individually with
		// csrf.Wrap, e.g.:
		//
		//     mux.Handle("POST /api/v1/sessions/{sid}/input", csrf.Wrap(controlHandler))
		//
		// This block is the only place a control route can be registered; it never
		// runs when hostConfigured is false, so browse-only mode cannot wire one in.
	}

	return guard.Wrap(mux)
}
