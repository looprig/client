package bff_test

// TestNewMux exercises the assembled BFF HTTP surface (mux.go): the mounted
// ReadSource stripped and mounted under /api, the BFF-synthesized (never
// proxied) capabilities document, and the HostOriginGuard/CSRFGuard security
// middleware wired around it. It reuses newMountedSource (mounted_test.go) for a
// real memstore-backed ReadSource, exactly as that file's own tests do.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

// TestNewMuxHostConfiguredCapabilitiesAndReadPlane covers requirement 1: with a
// control host wired, capabilities advertises the full feature set in the
// canonical order, and the mounted ReadSource is reachable end-to-end through the
// /api prefix strip (not just capabilities — the seeded session itself).
func TestNewMuxHostConfiguredCapabilitiesAndReadPlane(t *testing.T) {
	t.Parallel()

	read, sid := newMountedSource(t)
	mux := bff.NewMux(read, bff.NewHostOriginGuard(), bff.NewCSRFGuard(time.Hour), true)

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

// TestNewMuxBrowseOnlyCapabilitiesReadPlaneAndControlAbsence covers requirement
// 2: with no control host wired, capabilities advertises journal only, the read
// plane still works (it is independent of the control host), and a
// control-shaped path is absent from the mux entirely — proven the same way
// harness's own TestReadHandlerRoutes proves absence (see
// pkg/serve/read_server_test.go): 404 or 405, the two codes net/http's ServeMux
// itself can produce for an unregistered route, and specifically NOT 403, which
// would mean a route exists but rejected the request.
func TestNewMuxBrowseOnlyCapabilitiesReadPlaneAndControlAbsence(t *testing.T) {
	t.Parallel()

	read, sid := newMountedSource(t)
	mux := bff.NewMux(read, bff.NewHostOriginGuard(), bff.NewCSRFGuard(time.Hour), false)

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

	controlReq := httptest.NewRequest(http.MethodPost, "/api/v1/sessions", nil)
	controlReq.Host = loopbackHost
	controlRec := httptest.NewRecorder()
	mux.ServeHTTP(controlRec, controlReq)
	if controlRec.Code != http.StatusNotFound && controlRec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/v1/sessions status = %d, want 404 or 405 (route must not be registered); body = %s", controlRec.Code, controlRec.Body.String())
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

// TestNewMuxAppliesHostOriginGuardBeforeReadSource covers requirement 3's guard
// half: a rebound Host header hitting GET /api/v1/sessions is rejected 403 by
// HostOriginGuard before the mounted ReadSource ever runs, and the same guard
// also protects the BFF's own synthesized capabilities route.
func TestNewMuxAppliesHostOriginGuardBeforeReadSource(t *testing.T) {
	t.Parallel()

	read := &countingReadSource{}
	mux := bff.NewMux(read, bff.NewHostOriginGuard(), bff.NewCSRFGuard(time.Hour), true)

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

// mustMint mints a CSRF token or fails the test.
func mustMint(t *testing.T, csrf *bff.CSRFGuard) string {
	t.Helper()
	token, err := csrf.Mint()
	if err != nil {
		t.Fatalf("Mint() err = %v", err)
	}
	return token
}

// TestNewMuxRegisterControlRouteAppliesCSRF covers requirement 4, through the
// real exported API rather than a hand-composed handler chain outside it.
//
// Control routes (input/gates/interrupt/create/restore) don't exist as code yet
// — a later task builds the control host proxy and registers them. What this
// test proves in the meantime: BFFMux.RegisterControlRoute — the ONLY sanctioned
// way to add a state-changing route (see mux.go's doc comment) — always applies
// the same *CSRFGuard NewMux was constructed with, and HostOriginGuard still
// runs first (guard.Wrap wraps the whole *BFFMux). This exercises the production
// code path directly: NewMux -> RegisterControlRoute -> mux.ServeHTTP, not a
// composition assembled by the test itself.
func TestNewMuxRegisterControlRouteAppliesCSRF(t *testing.T) {
	t.Parallel()

	read, _ := newMountedSource(t)
	csrf := bff.NewCSRFGuard(time.Hour)
	validToken := mustMint(t, csrf)

	tests := []struct {
		name       string
		host       string
		token      string // "" means no X-CSRF-Token header at all
		want       int
		wantCalled bool
	}{
		{name: "good host, no csrf token: csrf rejects", host: loopbackHost, token: "", want: http.StatusForbidden, wantCalled: false},
		{name: "bad host, valid csrf token: guard rejects first", host: "evil.example:7777", token: validToken, want: http.StatusForbidden, wantCalled: false},
		{name: "good host, valid csrf token: reaches handler", host: loopbackHost, token: validToken, want: http.StatusOK, wantCalled: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			// Fresh *BFFMux per case: RegisterControlRoute mutates shared mux state,
			// and subtests run in parallel with each other.
			mux := bff.NewMux(read, bff.NewHostOriginGuard(), csrf, true)

			called := false
			controlHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusOK)
			})
			mux.RegisterControlRoute("POST /api/v1/sessions/{sid}/input", controlHandler)

			req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/abc/input", nil)
			req.Host = tt.host
			if tt.token != "" {
				req.Header.Set(bff.CSRFHeaderName, tt.token)
			}
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != tt.want {
				t.Errorf("status = %d, want %d", rec.Code, tt.want)
			}
			if called != tt.wantCalled {
				t.Errorf("handler called = %v, want %v", called, tt.wantCalled)
			}
		})
	}
}

// TestNewMuxRegisterEventsRouteIsReachableWithNoCSRFToken proves
// RegisterEventsRoute (mux.go) wires a handler directly onto the mux — reachable
// through HostOriginGuard exactly like every other route, but with NO CSRF token
// required at all, even though no token was minted or presented. This is the
// intended difference from RegisterControlRoute: an SSE proxy route is a GET
// (read), never state-changing, so it must never depend on the SPA having
// already obtained a CSRF token (a chicken-and-egg problem for the very first
// request opening a live stream).
func TestNewMuxRegisterEventsRouteIsReachableWithNoCSRFToken(t *testing.T) {
	t.Parallel()

	read, _ := newMountedSource(t)
	mux := bff.NewMux(read, bff.NewHostOriginGuard(), bff.NewCSRFGuard(time.Hour), true)

	called := false
	eventsHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	mux.RegisterEventsRoute("GET /api/v1/sessions/{sid}/events", eventsHandler)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/abc/events", nil)
	req.Host = loopbackHost
	// Deliberately no X-CSRF-Token header.
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET events route status = %d, want %d (no CSRF token should ever be required for a GET)", rec.Code, http.StatusOK)
	}
	if !called {
		t.Error("events handler was never called")
	}

	// HostOriginGuard still applies: a rebound Host must still be rejected.
	badHostReq := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/abc/events", nil)
	badHostReq.Host = "evil.example:7777"
	badHostRec := httptest.NewRecorder()
	called = false
	mux.ServeHTTP(badHostRec, badHostReq)
	if badHostRec.Code != http.StatusForbidden {
		t.Errorf("GET events route with rebound host status = %d, want %d", badHostRec.Code, http.StatusForbidden)
	}
	if called {
		t.Error("events handler was reached despite a rebound Host header; HostOriginGuard must reject first")
	}
}
