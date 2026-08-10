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
// — later tasks build the control host proxy and add them, via
// BFFMux.RegisterControlRoute (below), the ONLY sanctioned way to add a
// state-changing route to a *BFFMux. RegisterControlRoute always wraps the
// handler it's given with CSRFGuard.Wrap, so a control route registered through
// it can never ship unprotected.
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
// per-route, via RegisterControlRoute, at the point a state-changing control
// route is actually registered.
import "net/http"

// BFFMux is the BFF's assembled public HTTP surface, built by NewMux. It embeds
// the guard-wrapped http.Handler directly, so a *BFFMux satisfies http.Handler
// and can be used anywhere one is expected (http.Server.Handler, httptest, etc).
// It also retains the underlying *http.ServeMux and *CSRFGuard as construction
// state, exposed only through RegisterControlRoute — see that method's doc for
// why direct access to either isn't exported.
type BFFMux struct {
	http.Handler

	mux  *http.ServeMux
	csrf *CSRFGuard
}

// NewMux assembles the BFF's public HTTP surface over read (the mounted or
// proxied ReadSource, see readsource.go), guard (HostOriginGuard, see guard.go),
// and csrf (CSRFGuard, see csrf.go). hostConfigured reports whether a control
// host is wired: it currently affects only the capabilities document
// (capabilities.go). csrf is retained on the returned *BFFMux for
// RegisterControlRoute (below) — a later task's only sanctioned way to add a
// control route to this mux.
func NewMux(read ReadSource, guard *HostOriginGuard, csrf *CSRFGuard, hostConfigured bool) *BFFMux {
	mux := http.NewServeMux()

	mux.Handle("GET /api/v1/capabilities", handleCapabilities(hostConfigured))
	mux.Handle("/api/", http.StripPrefix("/api", read))

	return &BFFMux{
		Handler: guard.Wrap(mux),
		mux:     mux,
		csrf:    csrf,
	}
}

// RegisterControlRoute adds a state-changing route to the mux, always wrapped by
// the CSRF guard. This is the ONLY sanctioned way to add a control route — a
// future task that registers a POST/PUT/PATCH/DELETE handler directly on the
// underlying mux, bypassing this method, would ship an unprotected route. There
// are no control routes yet (a later task adds the first); this method exists
// now so CSRF protection is part of the mux's own construction contract, not
// something a later task has to remember.
//
// pattern follows net/http.ServeMux's Go 1.22+ pattern syntax (e.g.
// "POST /api/v1/sessions/{sid}/input"), same as the capabilities and read-plane
// routes NewMux itself registers. Because RegisterControlRoute mutates the same
// *http.ServeMux the returned *BFFMux already serves through, a newly registered
// route is reachable immediately — there is no separate "build" step.
func (m *BFFMux) RegisterControlRoute(pattern string, handler http.Handler) {
	m.mux.Handle(pattern, m.csrf.Wrap(handler))
}

// RegisterEventsRoute adds a read-shaped route (opening a live SSE stream, e.g.
// via NewSSEProxy — see events.go) directly to the mux, WITHOUT wrapping it in the
// CSRF guard. This is deliberate, not an oversight: CSRFGuard.Wrap only ever
// demands a token for POST/PUT/PATCH/DELETE (see csrf.go's doc) and passes every
// other method — including the GET an EventSource issues to open a stream —
// through untouched regardless of which wrapper it goes through. Opening an SSE
// stream is a read (no state changes on the server), the same category as the
// read-plane routes NewMux registers directly on mux with no CSRF wrapping at
// all; routing it through RegisterControlRoute instead would be misleading (it
// would silently no-op the CSRF check on a route that was never state-changing)
// and would misclassify it in RegisterControlRoute's "state-changing route" doc
// contract. HostOriginGuard (guard.Wrap, wrapping the whole *BFFMux) still
// protects this route exactly as it protects every other one.
//
// pattern follows the same net/http.ServeMux Go 1.22+ syntax as
// RegisterControlRoute and NewMux's own routes (e.g.
// "GET /api/v1/sessions/{sid}/events"). No composition root wires a route through
// this method yet — the control/session host that would supply NewSSEProxy's
// upstream URL doesn't exist as a construction-time parameter of NewMux — so this
// is the sanctioned seam a later task uses, not something exercised by NewMux
// itself today.
func (m *BFFMux) RegisterEventsRoute(pattern string, handler http.Handler) {
	m.mux.Handle(pattern, handler)
}
