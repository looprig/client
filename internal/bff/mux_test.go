package bff_test

// These tests exercise the assembled BFF HTTP surfaces (mux.go): the two
// constructors — NewBrowseOnlyMux (no control host; the mounted ReadSource
// stripped and mounted under /api, and the BFF-synthesized, never-proxied
// capabilities document) and NewMuxWithHost (control host wired; everything
// NewBrowseOnlyMux provides plus the five control routes and the events
// route) — and the HostOriginGuard/CSRFGuard security middleware wired around
// both. They reuse newMountedSource (mounted_test.go) for a real
// memstore-backed ReadSource and newTrustingControlProxy (control_test.go) for
// a real *ControlProxy backed by a TLS stub, exactly as those files' own
// tests do, plus a local helper (newTrustingEventsProxy) for a real events
// proxy backed by a TLS stub — so every test here exercises the real exported
// constructors and real proxy types, never a hand-composed stand-in for
// either.
//
// TestNewBrowseOnlyMuxControlRoutesAbsent is the concrete absence proof this
// package's Task 27 exists to guarantee: every control-shaped path — the five
// control routes plus the events route — 404s (genuinely unregistered) when
// built via NewBrowseOnlyMux, the same convention harness's own
// TestReadHandlerRoutes proves absence with (see pkg/serve/read_server_test.go
// and ReadHandler's doc in pkg/serve/mux.go).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/looprig/client/internal/bff"
)

// loopbackHost is the Host header every test below uses unless it is
// deliberately testing HostOriginGuard's rejection path — it must pass
// NewHostOriginGuard()'s default loopback allowlist so failures below are never
// accidentally caused by the guard.
const loopbackHost = "127.0.0.1:7777"

// capabilitiesDoc mirrors the wire shape of GET .../capabilities (protocol,
// version, features), the same shape mounted_test.go's own capabilities test
// decodes into.
type capabilitiesDoc struct {
	Protocol string   `json:"protocol"`
	Version  int      `json:"version"`
	Features []string `json:"features"`
}

// getCapabilities issues GET /api/v1/capabilities against mux and decodes the
// response, failing the test on any non-200 or malformed body.
func getCapabilities(t *testing.T, mux http.Handler) capabilitiesDoc {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/capabilities", nil)
	req.Host = loopbackHost
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/capabilities status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var doc capabilitiesDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("json.Unmarshal(capabilities) err = %v; body = %s", err, rec.Body.String())
	}
	return doc
}

// okStub is a trivial upstream handler that answers every request 200 with no
// body. Tests below that need a *ControlProxy or events proxy only to satisfy
// NewMuxWithHost's required parameters — without exercising that proxy's own
// request/response behavior, which is control_test.go's and events_test.go's
// job respectively — point it at okStub.
var okStub = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
})

// newTrustingEventsProxy starts a TLS upstream and builds a real http.Handler
// via NewSSEProxy pointed at it, trusting the stub's certificate via
// WithSSERootCA — the same real-proxy, never-InsecureSkipVerify convention
// newTrustingControlProxy (control_test.go) uses for the control side.
func newTrustingEventsProxy(t *testing.T, upstream http.Handler) http.Handler {
	t.Helper()

	ts := httptest.NewTLSServer(upstream)
	t.Cleanup(ts.Close)

	upstreamURL, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("url.Parse(%q) err = %v", ts.URL, err)
	}

	proxy, err := bff.NewSSEProxy(upstreamURL, "mux-test-sse-token", bff.WithSSERootCA(ts.Certificate()))
	if err != nil {
		t.Fatalf("NewSSEProxy() err = %v", err)
	}
	return proxy
}

// newTestControlHost builds a real *ControlProxy and a real events proxy
// http.Handler, both backed by trivial 200-OK TLS stubs — NewMuxWithHost's two
// required control-host dependencies, for tests that need SOME real instance
// of each but aren't exercising either proxy's own behavior.
func newTestControlHost(t *testing.T) (*bff.ControlProxy, http.Handler) {
	t.Helper()
	controlProxy := newTrustingControlProxy(t, &controlUpstreamStub{})
	eventsProxy := newTrustingEventsProxy(t, okStub)
	return controlProxy, eventsProxy
}

// TestNewMuxWithHostCapabilitiesAndReadPlane covers a control-host-configured
// mux: capabilities advertises the full feature set in the canonical order,
// and the mounted ReadSource is reachable end-to-end through the /api prefix
// strip (not just capabilities — the seeded session itself).
func TestNewMuxWithHostCapabilitiesAndReadPlane(t *testing.T) {
	t.Parallel()

	read, sid := newMountedSource(t)
	controlProxy, eventsProxy := newTestControlHost(t)
	mux := bff.NewMuxWithHost(read, bff.NewHostOriginGuard(), bff.NewCSRFGuard(time.Hour), controlProxy, eventsProxy)

	doc := getCapabilities(t, mux)
	want := []string{"journal", "live_sse", "ephemeral_sse", "gate_response"}
	if !reflect.DeepEqual(doc.Features, want) {
		t.Errorf("features = %v, want %v (exact order matters, it is part of the wire contract)", doc.Features, want)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	req.Host = loopbackHost
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/sessions status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), sid.String()) {
		t.Errorf("GET /api/v1/sessions body = %s, want it to contain seeded session id %s", rec.Body.String(), sid)
	}
}

// TestNewBrowseOnlyMuxCapabilitiesAndReadPlane covers a browse-only mux:
// capabilities advertises journal only, and the read plane still works — it
// is independent of any control host, and NewBrowseOnlyMux never even accepts
// one.
func TestNewBrowseOnlyMuxCapabilitiesAndReadPlane(t *testing.T) {
	t.Parallel()

	read, sid := newMountedSource(t)
	mux := bff.NewBrowseOnlyMux(read, bff.NewHostOriginGuard())

	doc := getCapabilities(t, mux)
	want := []string{"journal"}
	if !reflect.DeepEqual(doc.Features, want) {
		t.Errorf("features = %v, want %v (browse-only mode must never claim live_sse/ephemeral_sse/gate_response)", doc.Features, want)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	req.Host = loopbackHost
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/sessions status = %d, want %d; body = %s (read plane must work with no control host)", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), sid.String()) {
		t.Errorf("GET /api/v1/sessions body = %s, want it to contain seeded session id %s", rec.Body.String(), sid)
	}
}

// TestNewBrowseOnlyMuxControlRoutesAbsent is the Task 27 absence proof: every
// control-shaped path — the five control routes plus the events route — 404s
// (genuinely unregistered) when built via NewBrowseOnlyMux, never 403 (which
// would mean a route exists and rejected the request). 404 or 405 are the two
// codes net/http's ServeMux itself can produce for an unregistered route or a
// registered path hit with the wrong method — the same convention harness's
// own TestReadHandlerRoutes proves absence with.
func TestNewBrowseOnlyMuxControlRoutesAbsent(t *testing.T) {
	t.Parallel()

	read, _ := newMountedSource(t)
	mux := bff.NewBrowseOnlyMux(read, bff.NewHostOriginGuard())

	tests := []struct {
		name   string
		method string
		path   string
	}{
		{name: "create", method: http.MethodPost, path: "/api/v1/sessions"},
		{name: "restore", method: http.MethodPost, path: "/api/v1/sessions/abc/restore"},
		{name: "input", method: http.MethodPost, path: "/api/v1/sessions/abc/input"},
		{name: "gate response", method: http.MethodPost, path: "/api/v1/sessions/abc/gates/g1"},
		{name: "interrupt", method: http.MethodPost, path: "/api/v1/sessions/abc/interrupt"},
		{name: "events", method: http.MethodGet, path: "/api/v1/sessions/abc/events"},
		// csrf-token is itself a control-plane concern (delivering the token
		// CSRFGuard.Wrap demands elsewhere): a browse-only deployment has no
		// control routes to protect, so this route must be genuinely absent
		// too, not registered-then-something-else. Same absence-proof
		// convention as every other row in this table.
		{name: "csrf token", method: http.MethodGet, path: "/api/v1/csrf-token"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(tt.method, tt.path, nil)
			req.Host = loopbackHost
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s %s status = %d, want 404 or 405 (route must be genuinely absent, not registered-then-rejected); body = %s", tt.method, tt.path, rec.Code, rec.Body.String())
			}
		})
	}
}

// countingReadSource is a minimal ReadSource stub that records how many times
// ServeHTTP was invoked, so TestNewMuxAppliesHostOriginGuardBeforeReadSource can
// prove the read source was never reached for a rejected request — the same
// "next never runs" proof guard_test.go's TestHostOriginGuardRunsBeforeNext uses
// for a generic http.Handler.
type countingReadSource struct {
	calls int
}

func (c *countingReadSource) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.calls++
	w.WriteHeader(http.StatusOK)
}

// TestNewMuxAppliesHostOriginGuardBeforeReadSource covers the guard half of
// both constructors: a rebound Host header hitting GET /api/v1/sessions is
// rejected 403 by HostOriginGuard before the mounted ReadSource ever runs,
// and the same guard also protects the BFF's own synthesized capabilities
// route. Built via NewBrowseOnlyMux — HostOriginGuard's placement (wrapping
// the whole returned handler) is identical for NewMuxWithHost, which needs no
// separate proof of the same property.
func TestNewMuxAppliesHostOriginGuardBeforeReadSource(t *testing.T) {
	t.Parallel()

	read := &countingReadSource{}
	mux := bff.NewBrowseOnlyMux(read, bff.NewHostOriginGuard())

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	req.Host = "evil.example:7777"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("GET /api/v1/sessions with rebound host status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if read.calls != 0 {
		t.Errorf("read source was reached %d times; HostOriginGuard must reject before the mounted read source ever runs", read.calls)
	}

	capReq := httptest.NewRequest(http.MethodGet, "/api/v1/capabilities", nil)
	capReq.Host = "evil.example:7777"
	capRec := httptest.NewRecorder()
	mux.ServeHTTP(capRec, capReq)
	if capRec.Code != http.StatusForbidden {
		t.Errorf("GET /api/v1/capabilities with rebound host status = %d, want %d (guard must cover the synthesized route too)", capRec.Code, http.StatusForbidden)
	}
}

// tokenWire decodes GET /api/v1/csrf-token's response body.
type tokenWire struct {
	CSRFToken string `json:"csrf_token"`
}

// TestNewMuxWithHostServesCSRFToken proves NewMuxWithHost genuinely wires
// GET /api/v1/csrf-token (Fix C's delivery mechanism) end to end through the
// real production composition — not just CSRFGuard.TokenHandler in
// isolation (csrf_test.go's TestCSRFGuardTokenHandler already covers that):
// the route is reachable through the real *BFFMux, and the token it mints is
// immediately usable on a real control route served by the SAME mux.
func TestNewMuxWithHostServesCSRFToken(t *testing.T) {
	t.Parallel()

	read, _ := newMountedSource(t)
	csrf := bff.NewCSRFGuard(time.Hour)
	controlProxy, eventsProxy := newTestControlHost(t)
	mux := bff.NewMuxWithHost(read, bff.NewHostOriginGuard(), csrf, controlProxy, eventsProxy)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/csrf-token", nil)
	req.Host = loopbackHost
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/csrf-token status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want %q", got, "no-store")
	}

	var wire tokenWire
	if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
		t.Fatalf("json.Unmarshal() err = %v; body = %s", err, rec.Body.String())
	}
	if wire.CSRFToken == "" {
		t.Fatal("csrf_token is empty")
	}

	// The minted token must reach and pass the SAME mux's CSRF-protected
	// control route.
	postReq := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/abc/input", nil)
	postReq.Host = loopbackHost
	postReq.Header.Set(bff.CSRFHeaderName, wire.CSRFToken)
	postRec := httptest.NewRecorder()
	mux.ServeHTTP(postRec, postReq)
	if postRec.Code != http.StatusOK {
		t.Errorf("POST .../input with mux-minted token status = %d, want %d; body = %s", postRec.Code, http.StatusOK, postRec.Body.String())
	}

	// A rebound Host must be rejected before the token is ever minted — the
	// route is behind HostOriginGuard exactly like every other route on this
	// mux.
	badHostReq := httptest.NewRequest(http.MethodGet, "/api/v1/csrf-token", nil)
	badHostReq.Host = "evil.example:7777"
	badHostRec := httptest.NewRecorder()
	mux.ServeHTTP(badHostRec, badHostReq)
	if badHostRec.Code != http.StatusForbidden {
		t.Errorf("GET /api/v1/csrf-token with rebound host status = %d, want %d", badHostRec.Code, http.StatusForbidden)
	}
}

// mustMint mints a CSRF token or fails the test.
func mustMint(t *testing.T, csrf *bff.CSRFGuard) string {
	t.Helper()
	token, err := csrf.Mint()
	if err != nil {
		t.Fatalf("Mint() err = %v", err)
	}
	return token
}

// TestNewMuxWithHostControlRoutesRequireCSRF proves NewMuxWithHost's
// internally-registered control routes are CSRF-protected end to end, through
// the real production wiring path (NewMuxWithHost -> BFFMux.ServeHTTP), not a
// composition the test assembles itself. control_test.go's
// TestControlProxyRegisterRoutesAppliesCSRFThroughRealBFFMux already covers
// all five routes and rebound-host interaction in depth; this test's own job
// is narrower and complementary — proving the property from NewMuxWithHost's
// perspective (its own constructor, its own real *ControlProxy), one
// representative control route.
func TestNewMuxWithHostControlRoutesRequireCSRF(t *testing.T) {
	t.Parallel()

	read, _ := newMountedSource(t)
	csrf := bff.NewCSRFGuard(time.Hour)
	validToken := mustMint(t, csrf)
	controlProxy, eventsProxy := newTestControlHost(t)

	tests := []struct {
		name  string
		token string // "" means no X-CSRF-Token header at all
		want  int
	}{
		{name: "no csrf token: rejected", token: "", want: http.StatusForbidden},
		{name: "valid csrf token: reaches upstream", token: validToken, want: http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			mux := bff.NewMuxWithHost(read, bff.NewHostOriginGuard(), csrf, controlProxy, eventsProxy)

			req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/abc/input", nil)
			req.Host = loopbackHost
			if tt.token != "" {
				req.Header.Set(bff.CSRFHeaderName, tt.token)
			}
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != tt.want {
				t.Errorf("status = %d, want %d; body = %s", rec.Code, tt.want, rec.Body.String())
			}
		})
	}
}

// TestNewMuxWithHostEventsRouteReachableWithNoCSRFToken proves NewMuxWithHost
// wires the events route WITHOUT CSRF protection, even though the SAME mux
// requires a CSRF token for control routes — the intended asymmetry (mux.go's
// registerEventsRoute doc): an SSE proxy route is a GET (read), never
// state-changing, so it must never depend on the SPA having already obtained
// a CSRF token (a chicken-and-egg problem for the very first request opening
// a live stream). HostOriginGuard still applies, exactly as it does for every
// other route.
func TestNewMuxWithHostEventsRouteReachableWithNoCSRFToken(t *testing.T) {
	t.Parallel()

	read, _ := newMountedSource(t)
	controlProxy, eventsProxy := newTestControlHost(t)
	mux := bff.NewMuxWithHost(read, bff.NewHostOriginGuard(), bff.NewCSRFGuard(time.Hour), controlProxy, eventsProxy)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/abc/events", nil)
	req.Host = loopbackHost
	// Deliberately no X-CSRF-Token header.
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET events route status = %d, want %d (no CSRF token should ever be required for a GET); body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	badHostReq := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/abc/events", nil)
	badHostReq.Host = "evil.example:7777"
	badHostRec := httptest.NewRecorder()
	mux.ServeHTTP(badHostRec, badHostReq)
	if badHostRec.Code != http.StatusForbidden {
		t.Errorf("GET events route with rebound host status = %d, want %d", badHostRec.Code, http.StatusForbidden)
	}
}

// TestNewMuxWithHostPanicsOnNilDependencies proves the fail-loud-at-construction
// contract NewMuxWithHost's doc promises: a nil csrf, controlProxy, or
// eventsProxy is a broken composition and panics immediately, rather than
// silently shipping a mux that advertises the full feature set with some of
// its routes missing.
func TestNewMuxWithHostPanicsOnNilDependencies(t *testing.T) {
	t.Parallel()

	read, _ := newMountedSource(t)
	guard := bff.NewHostOriginGuard()
	csrf := bff.NewCSRFGuard(time.Hour)
	controlProxy, eventsProxy := newTestControlHost(t)

	tests := []struct {
		name string
		call func()
	}{
		{name: "nil csrf", call: func() { bff.NewMuxWithHost(read, guard, nil, controlProxy, eventsProxy) }},
		{name: "nil controlProxy", call: func() { bff.NewMuxWithHost(read, guard, csrf, nil, eventsProxy) }},
		{name: "nil eventsProxy", call: func() { bff.NewMuxWithHost(read, guard, csrf, controlProxy, nil) }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Errorf("call did not panic, want a panic for %s", tt.name)
				}
			}()
			tt.call()
		})
	}
}
