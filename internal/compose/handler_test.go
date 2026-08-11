package compose_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/looprig/client/internal/bff"
	"github.com/looprig/client/internal/compose"
)

func TestHandler(t *testing.T) {
	t.Parallel()

	apiCalled, spaCalled := false, false
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		apiCalled = true
		w.WriteHeader(http.StatusOK)
	})
	spa := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		spaCalled = true
		w.WriteHeader(http.StatusOK)
	})

	handler := compose.Handler(api, spa, bff.NewHostOriginGuard())

	tests := []struct {
		name        string
		path        string
		wantAPI     bool
		wantSPA     bool
		description string
	}{
		{name: "api path routes to the BFF mux", path: "/api/v1/sessions", wantAPI: true},
		{name: "api root routes to the BFF mux", path: "/api/", wantAPI: true},
		{name: "root path falls through to the SPA", path: "/", wantSPA: true},
		{name: "an arbitrary client route falls through to the SPA", path: "/sessions/abc123", wantSPA: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			apiCalled, spaCalled = false, false
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			// Handler now wraps the whole composed surface in a
			// HostOriginGuard (Fix E) — httptest.NewRequest defaults Host to
			// "example.com" for a path-only target, which the guard would
			// reject, so every case here must present a loopback Host to
			// reach routing at all. TestHandlerHostOriginGuard (below) covers
			// the rejection path this would otherwise mask.
			req.Host = "127.0.0.1:7777"
			handler.ServeHTTP(rec, req)

			if apiCalled != tt.wantAPI {
				t.Errorf("path %q: api handler called = %v, want %v", tt.path, apiCalled, tt.wantAPI)
			}
			if spaCalled != tt.wantSPA {
				t.Errorf("path %q: spa handler called = %v, want %v", tt.path, spaCalled, tt.wantSPA)
			}
		})
	}
}

// TestHandlerHostOriginGuard proves Fix E's actual fix: the SPA route ("/")
// requires the SAME Host/Origin validation as the API route, not just the
// "/api/" subtree — a rebound Host must be rejected on BOTH, and neither the
// api nor the spa handler must ever run for a rejected request.
func TestHandlerHostOriginGuard(t *testing.T) {
	t.Parallel()

	apiCalled, spaCalled := false, false
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		apiCalled = true
		w.WriteHeader(http.StatusOK)
	})
	spa := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		spaCalled = true
		w.WriteHeader(http.StatusOK)
	})
	handler := compose.Handler(api, spa, bff.NewHostOriginGuard())

	tests := []struct {
		name string
		path string
	}{
		{name: "api path rejected on rebound host", path: "/api/v1/sessions"},
		{name: "spa root rejected on rebound host", path: "/"},
		{name: "spa client route rejected on rebound host", path: "/sessions/abc123"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			apiCalled, spaCalled = false, false
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			req.Host = "evil.example:7777"
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusForbidden {
				t.Errorf("path %q with rebound host: status = %d, want %d", tt.path, rec.Code, http.StatusForbidden)
			}
			if apiCalled {
				t.Errorf("path %q: api handler was invoked for a rejected request", tt.path)
			}
			if spaCalled {
				t.Errorf("path %q: spa handler was invoked for a rejected request", tt.path)
			}
		})
	}

	// A legitimate same-origin (loopback) request still reaches the SPA —
	// proving the guard's addition here doesn't break the ordinary case.
	okReq := httptest.NewRequest(http.MethodGet, "/", nil)
	okReq.Host = "127.0.0.1:7777"
	okRec := httptest.NewRecorder()
	spaCalled = false
	handler.ServeHTTP(okRec, okReq)
	if okRec.Code != http.StatusOK {
		t.Fatalf("legitimate loopback request to / status = %d, want %d", okRec.Code, http.StatusOK)
	}
	if !spaCalled {
		t.Error("spa handler was not invoked for a legitimate loopback request")
	}
}
