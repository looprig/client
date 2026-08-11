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
//   - GET /api/v1/csrf-token     — served by CSRFGuard.TokenHandler (csrf.go),
//     registered ONLY by NewMuxWithHost (never NewBrowseOnlyMux): the delivery
//     mechanism for the token CSRFGuard.Wrap then demands on every control
//     POST/PUT/PATCH/DELETE. Same literal-pattern-outranks-catch-all reasoning
//     as capabilities above.
//   - /api/{...}                 — everything else under /api is forwarded, prefix
//     stripped, to the mounted/proxied ReadSource, whose own internal routing
//     expects paths like /v1/sessions (not /api/v1/sessions). This pattern
//     carries NO method restriction, so every method reaches the ReadSource's own
//     mux and the ReadSource decides 200/404/405 on its own terms — the outer BFF
//     mux never manufactures a 405 of its own for a read-shaped path.
//
// Two constructors, two shapes of *BFFMux — NOT one constructor plus an
// independently-threaded boolean:
//
//   - NewBrowseOnlyMux(read, guard) has no parameter through which a
//     *ControlProxy, a *CSRFGuard, or an events handler could ever be supplied.
//     It is therefore structurally impossible — provable by reading this
//     function's signature alone, no runtime check required — for a mux built
//     this way to end up serving a single control-shaped route. The five
//     control routes (create/restore/input/gate/interrupt) and the events route
//     are simply never registered on its underlying *http.ServeMux, so a
//     request to any of them 404s (net/http's ServeMux answering "no such
//     route"), never 403 (a route existing but rejecting the request).
//   - NewMuxWithHost(read, guard, csrf, controlProxy, eventsProxy) requires all
//     five of those routes' dependencies up front and wires every one of them —
//     via the unexported registerControlRoute/registerEventsRoute below —
//     atomically, inside the constructor, before it returns. There is no
//     exported method that adds a control or events route to a *BFFMux after
//     construction, for either constructor: registerControlRoute and
//     registerEventsRoute are unexported, so the ONLY code that can ever call
//     them is code inside this package (in practice, only NewMuxWithHost, via
//     ControlProxy.registerRoutes for the five control routes and directly for
//     the events route).
//
// This closes what would otherwise be a real gap: with a single constructor
// taking an independent hostConfigured bool, nothing stops a caller from
// passing hostConfigured: true and never registering any control routes (the
// capabilities document would then claim gate_response/live_sse over a mux that
// serves none of them), or hostConfigured: false while still registering
// control routes anyway (the document would then hide capabilities the mux
// actually serves). Splitting into two constructors, each of which decides its
// own hostConfigured bool internally and is the only place its own routes get
// registered, makes "what capabilities.go advertises" and "what is actually on
// the mux" the same fact by construction — there is no seam through which they
// could drift apart.
//
// Middleware layering: HostOriginGuard wraps the WHOLE returned handler — every
// request, read or control, passes its Host/Origin check first, fail secure,
// reject-fast (guard.go). CSRFGuard is NOT wrapped around the whole mux: doing
// so would make CSRFGuard.Wrap intercept every POST/PUT/PATCH/DELETE BEFORE
// net/http's ServeMux ever gets a chance to resolve routing, turning every such
// request into a blanket 403 — including one aimed at a path with no control
// route registered at all. That would defeat browse-only mode's absence proof:
// requesting a control-shaped path must 404/405 (route not registered — the same
// convention harness's own ReadHandler tests use, see mux_test.go), never 403
// (route registered but request rejected). CSRFGuard therefore applies only
// per-route, via registerControlRoute, at the point a state-changing control
// route is actually registered.
import "net/http"

// BFFMux is the BFF's assembled public HTTP surface, built by NewBrowseOnlyMux
// or NewMuxWithHost. It embeds the guard-wrapped http.Handler directly, so a
// *BFFMux satisfies http.Handler and can be used anywhere one is expected
// (http.Server.Handler, httptest, etc). It also retains the underlying
// *http.ServeMux and *CSRFGuard as construction state, used only by
// registerControlRoute/registerEventsRoute below — see those methods' doc for
// why neither is exported: a *BFFMux's route set is fixed the instant its
// constructor returns.
type BFFMux struct {
	http.Handler

	mux  *http.ServeMux
	csrf *CSRFGuard
}

// NewBrowseOnlyMux assembles a browse-only BFFMux over read (the mounted or
// proxied ReadSource, see readsource.go) and guard (HostOriginGuard, see
// guard.go): the read plane, GET /api/v1/capabilities advertising "journal"
// alone, and NO control routes of any kind — not registered-then-rejected,
// genuinely absent. See the package doc above for why this is a distinct
// constructor rather than NewMuxWithHost called with nil-able control
// parameters.
func NewBrowseOnlyMux(read ReadSource, guard *HostOriginGuard) *BFFMux {
	mux := http.NewServeMux()

	mux.Handle("GET /api/v1/capabilities", handleCapabilities(false))
	mux.Handle("/api/", http.StripPrefix("/api", read))

	return &BFFMux{
		Handler: guard.Wrap(mux),
		mux:     mux,
		// csrf is deliberately left nil: nothing ever calls
		// registerControlRoute (the only method that reads it) on a *BFFMux
		// built by this constructor, because this constructor never calls it
		// either.
	}
}

// NewMuxWithHost assembles a control-host-configured BFFMux over read (the
// mounted or proxied ReadSource, see readsource.go), guard (HostOriginGuard,
// see guard.go), csrf (CSRFGuard, see csrf.go), controlProxy (the five
// allowlisted control routes, see control.go), and eventsProxy (the live SSE
// route, typically built by NewSSEProxy — see events.go). It registers
// everything NewBrowseOnlyMux registers, PLUS all five control routes (via
// controlProxy.registerRoutes, always CSRF-protected) and the events route
// (registerEventsRoute, never CSRF-protected — see that method's doc), and
// advertises the full capabilities feature set. All of this happens inside
// this constructor, atomically, before it returns — see the package doc above
// for why folding registration into construction (rather than a separate
// RegisterControlRoute/RegisterEventsRoute call a caller must remember to make)
// is what keeps capability advertisement from ever drifting out of sync with
// which routes actually exist.
//
// eventsProxy is wrapped in http.StripPrefix("/api", eventsProxy) before being
// registered, mirroring exactly how controlProxy.registerRoutes strips "/api"
// for its own five routes and how this function strips it for the read plane
// below: eventsProxy (typically built by NewSSEProxy) matches its own internal
// allowlist against harness's unprefixed route shape ("/v1/sessions/{sid}/events"),
// not the "/api"-prefixed shape this mux's own outer pattern matches on.
//
// csrf, controlProxy, and eventsProxy must all be non-nil: a caller with no
// control host to wire should call NewBrowseOnlyMux instead. Passing a nil
// dependency here is a broken composition and panics immediately, at
// construction, rather than shipping a mux that advertises the full feature
// set with some of its routes silently missing.
func NewMuxWithHost(read ReadSource, guard *HostOriginGuard, csrf *CSRFGuard, controlProxy *ControlProxy, eventsProxy http.Handler) *BFFMux {
	if csrf == nil {
		panic("bff: NewMuxWithHost: csrf must not be nil")
	}
	if controlProxy == nil {
		panic("bff: NewMuxWithHost: controlProxy must not be nil")
	}
	if eventsProxy == nil {
		panic("bff: NewMuxWithHost: eventsProxy must not be nil")
	}

	mux := http.NewServeMux()

	mux.Handle("GET /api/v1/capabilities", handleCapabilities(true))
	// Literal pattern, same reasoning as GET /api/v1/capabilities above: it
	// outranks the "/api/" catch-all subtree registered below for this one
	// path even though both technically match it. This is the ONLY delivery
	// mechanism for a CSRF token (csrf.go's package doc) — registered only
	// here, never in NewBrowseOnlyMux: a browse-only deployment has no
	// control routes to protect, so the 404 for this route in that mode is
	// itself a truthful absence signal, consistent with every other
	// control-shaped route this package's browse-only mode leaves genuinely
	// unregistered (see this file's own package doc above).
	mux.Handle("GET /api/v1/csrf-token", csrf.TokenHandler())
	mux.Handle("/api/", http.StripPrefix("/api", read))

	m := &BFFMux{mux: mux, csrf: csrf}
	controlProxy.registerRoutes(m)
	m.registerEventsRoute(routeEvents, http.StripPrefix("/api", eventsProxy))
	m.Handler = guard.Wrap(mux)

	return m
}

// routeEvents is the one events route pattern NewMuxWithHost registers
// eventsProxy under, following net/http.ServeMux's Go 1.22+ pattern syntax,
// same as the capabilities and read-plane routes registered above and the
// control route patterns control.go's ControlProxy.registerRoutes uses.
const routeEvents = "GET /api/v1/sessions/{sid}/events"

// registerControlRoute adds a state-changing route to the mux, always wrapped
// by the CSRF guard. Unexported deliberately: the only code that can ever call
// it is code inside this package, and in practice that is exactly one call
// site — ControlProxy.registerRoutes (control.go), itself called only from
// NewMuxWithHost above. There is no way, from outside this package, to add a
// route to a *BFFMux after either constructor has returned it — see the
// package doc for why that is the property this task closes a gap to
// guarantee.
func (m *BFFMux) registerControlRoute(pattern string, handler http.Handler) {
	m.mux.Handle(pattern, m.csrf.Wrap(handler))
}

// registerEventsRoute adds a read-shaped route (opening a live SSE stream, e.g.
// via NewSSEProxy — see events.go) directly to the mux, WITHOUT wrapping it in
// the CSRF guard. This is deliberate, not an oversight: CSRFGuard.Wrap only
// ever demands a token for POST/PUT/PATCH/DELETE (see csrf.go's doc) and passes
// every other method — including the GET an EventSource issues to open a
// stream — through untouched regardless of which wrapper it goes through.
// Opening an SSE stream is a read (no state changes on the server), the same
// category as the read-plane routes registered directly on mux with no CSRF
// wrapping at all; routing it through registerControlRoute instead would be
// misleading (it would silently no-op the CSRF check on a route that was never
// state-changing) and would misclassify it in registerControlRoute's
// "state-changing route" doc contract. HostOriginGuard (guard.Wrap, wrapping
// the whole *BFFMux) still protects this route exactly as it protects every
// other one.
//
// Unexported for the same reason registerControlRoute is: the only call site is
// NewMuxWithHost above, at construction time.
func (m *BFFMux) registerEventsRoute(pattern string, handler http.Handler) {
	m.mux.Handle(pattern, handler)
}
