package bff_test

// TestHostOriginGuard exercises the security-critical Host/Origin allowlist that
// stands between a rebindable DNS name and the BFF's routes (see guard.go's package
// doc for the DNS-rebinding threat model). Every case runs against a real
// http.Handler chain built with NewHostOriginGuard(...).Wrap(next), asserting on the
// recorded status code exactly as a real client would observe it.

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/looprig/client/internal/bff"
)

// okHandler is the "business logic" the guard wraps: if the guard lets a request
// through, this always answers 200, so a non-200 result in these tests can only be
// the guard rejecting — never anything downstream.
var okHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
})

func TestHostOriginGuard(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		host   string
		origin string // "" means no Origin header at all
		want   int
	}{
		// --- minimum coverage table from the plan ---
		{name: "loopback v4", host: "127.0.0.1:7777", origin: "", want: http.StatusOK},
		{name: "localhost", host: "localhost:7777", origin: "", want: http.StatusOK},
		{name: "loopback v6", host: "[::1]:7777", origin: "", want: http.StatusOK},
		{name: "rebound dns name", host: "evil.example:7777", origin: "", want: http.StatusForbidden},
		{name: "bare ip not loopback", host: "10.0.0.5:7777", origin: "", want: http.StatusForbidden},
		{name: "cross origin", host: "127.0.0.1:7777", origin: "https://evil.example", want: http.StatusForbidden},
		{name: "same origin", host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777", want: http.StatusOK},
		{name: "empty host", host: "", origin: "", want: http.StatusForbidden},

		// --- additional edge cases ---
		{name: "loopback v4 no port", host: "127.0.0.1", origin: "", want: http.StatusOK},
		{name: "localhost no port", host: "localhost", origin: "", want: http.StatusOK},
		{name: "loopback v6 no port", host: "[::1]", origin: "", want: http.StatusOK},
		{name: "loopback v6 bare, no brackets, no port", host: "::1", origin: "", want: http.StatusForbidden},
		{name: "host malformed too many colons", host: "one:two:three", origin: "", want: http.StatusForbidden},
		{name: "origin null literal", host: "127.0.0.1:7777", origin: "null", want: http.StatusForbidden},
		{name: "origin same host different port", host: "127.0.0.1:7777", origin: "http://127.0.0.1:9999", want: http.StatusOK},
		{name: "origin same host different scheme", host: "127.0.0.1:7777", origin: "https://127.0.0.1:7777", want: http.StatusOK},
		{name: "origin loopback v6", host: "[::1]:7777", origin: "http://[::1]:7777", want: http.StatusOK},
		{name: "origin malformed", host: "127.0.0.1:7777", origin: "http://%zz", want: http.StatusForbidden},
		{name: "origin empty scheme host only path", host: "127.0.0.1:7777", origin: "evil.example", want: http.StatusForbidden},
		{name: "loopback with attacker subdomain host", host: "127.0.0.1.evil.example:7777", origin: "", want: http.StatusForbidden},
	}

	guard := bff.NewHostOriginGuard()
	handler := guard.Wrap(okHandler)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
			req.Host = tt.host
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tt.want {
				t.Errorf("Host=%q Origin=%q status = %d, want %d", tt.host, tt.origin, rec.Code, tt.want)
			}
		})
	}
}

// TestHostOriginGuardRunsBeforeNext proves the guard rejects WITHOUT ever invoking
// the wrapped handler — the "reject-fast at the edge, before any auth or business
// logic" requirement isn't just about the status code, it's about next never
// running at all for a rejected request.
func TestHostOriginGuardRunsBeforeNext(t *testing.T) {
	t.Parallel()

	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	guard := bff.NewHostOriginGuard()
	handler := guard.Wrap(next)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req.Host = "evil.example:7777"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if called {
		t.Error("wrapped handler was invoked for a rejected request; guard must reject before next runs")
	}
}

// TestHostOriginGuardAdditionalAllowedHost covers the "public bind is opt-in" case:
// a caller-configured additional host is accepted ON TOP OF (not instead of) the
// three loopback forms, and a guard built without that extra host still rejects it.
func TestHostOriginGuardAdditionalAllowedHost(t *testing.T) {
	t.Parallel()

	withExtra := bff.NewHostOriginGuard("client.internal.example")
	handler := withExtra.Wrap(okHandler)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req.Host = "client.internal.example:8080"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("configured extra host status = %d, want %d", rec.Code, http.StatusOK)
	}

	// Loopback forms remain allowed alongside the extra host.
	req2 := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req2.Host = "127.0.0.1:7777"
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Errorf("loopback status with extra host configured = %d, want %d", rec2.Code, http.StatusOK)
	}

	// A guard built WITHOUT the extra host rejects it.
	withoutExtra := bff.NewHostOriginGuard()
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req3.Host = "client.internal.example:8080"
	withoutExtra.Wrap(okHandler).ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusForbidden {
		t.Errorf("unconfigured guard on extra host status = %d, want %d", rec3.Code, http.StatusForbidden)
	}
}
