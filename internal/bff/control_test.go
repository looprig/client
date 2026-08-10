package bff_test

// These tests exercise NewControlProxy against a REAL httptest.NewTLSServer stub
// standing in for a remote serve control host, following proxied_test.go's
// pattern exactly (real TLS, trusted via WithControlRootCA — never
// InsecureSkipVerify) — adapted to also capture request bodies, since these
// routes (unlike the read plane's GETs) carry real POST bodies this suite must
// prove are relayed correctly.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/looprig/client/internal/bff"
)

const controlConfiguredToken = "server-side-control-token-def456"

// controlRecordedRequest captures what actually reached the upstream control
// stub, including the body — proxied_test.go's recordedRequest has no body field
// because the read plane only ever proxies GETs.
type controlRecordedRequest struct {
	method string
	path   string
	header http.Header
	body   []byte
}

// controlUpstreamStub is a recording HTTP handler standing in for a remote serve
// control host. It records every request it receives (method, path, headers, and
// body) and replies with a configurable status/body.
type controlUpstreamStub struct {
	mu       sync.Mutex
	requests []controlRecordedRequest

	status int // 0 means http.StatusOK
	body   string
}

func (u *controlUpstreamStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	u.mu.Lock()
	u.requests = append(u.requests, controlRecordedRequest{
		method: r.Method,
		path:   r.URL.Path,
		header: r.Header.Clone(),
		body:   body,
	})
	u.mu.Unlock()

	status := u.status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	if u.body != "" {
		_, _ = w.Write([]byte(u.body))
	}
}

func (u *controlUpstreamStub) requestCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.requests)
}

func (u *controlUpstreamStub) last() (controlRecordedRequest, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.requests) == 0 {
		return controlRecordedRequest{}, false
	}
	return u.requests[len(u.requests)-1], true
}

// newTrustingControlProxy starts a TLS upstream stub and builds a *ControlProxy
// pointed at it, trusting the stub's certificate via WithControlRootCA — the
// correct alternative to InsecureSkipVerify.
func newTrustingControlProxy(t *testing.T, stub *controlUpstreamStub, opts ...bff.ControlProxyOption) *bff.ControlProxy {
	t.Helper()

	ts := httptest.NewTLSServer(stub)
	t.Cleanup(ts.Close)

	upstreamURL, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("url.Parse(%q) err = %v", ts.URL, err)
	}

	allOpts := append([]bff.ControlProxyOption{bff.WithControlRootCA(ts.Certificate())}, opts...)
	proxy, err := bff.NewControlProxy(upstreamURL, controlConfiguredToken, allOpts...)
	if err != nil {
		t.Fatalf("NewControlProxy() err = %v", err)
	}
	return proxy
}

func TestNewControlProxyConstructorValidation(t *testing.T) {
	t.Parallel()

	validURL, err := url.Parse("https://control.example:8443")
	if err != nil {
		t.Fatalf("url.Parse() err = %v", err)
	}

	tests := []struct {
		name    string
		base    *url.URL
		token   string
		wantErr bool
	}{
		{name: "valid https url and token", base: validURL, token: "tok", wantErr: false},
		{name: "nil url", base: nil, token: "tok", wantErr: true},
		{name: "empty token", base: validURL, token: "", wantErr: true},
		{name: "bad scheme", base: mustParseURL(t, "ftp://control.example"), token: "tok", wantErr: true},
		{name: "no host", base: mustParseURL(t, "https:///path"), token: "tok", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := bff.NewControlProxy(tt.base, tt.token)
			if (err != nil) != tt.wantErr {
				t.Fatalf("NewControlProxy() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// TestControlProxyRoutesReachUpstream covers requirement 1 and requirement 7: all
// five routes reach upstream with the right method/path (including {sid}/{gid}
// wildcards), the server-side token, and — where the request carries one — the
// body relayed byte-for-byte.
func TestControlProxyRoutesReachUpstream(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		reqPath  string
		reqBody  string
		wantPath string
	}{
		{
			name:     "create with input blocks",
			reqPath:  "/v1/sessions",
			reqBody:  `{"blocks":[{"type":"text","text":"hello"}]}`,
			wantPath: "/v1/sessions",
		},
		{
			name:     "create idle (no body)",
			reqPath:  "/v1/sessions",
			reqBody:  "",
			wantPath: "/v1/sessions",
		},
		{
			name:     "restore",
			reqPath:  "/v1/sessions/" + fixedSID + "/restore",
			reqBody:  "",
			wantPath: "/v1/sessions/" + fixedSID + "/restore",
		},
		{
			name:     "input",
			reqPath:  "/v1/sessions/" + fixedSID + "/input",
			reqBody:  `{"blocks":[{"type":"text","text":"go ahead"}]}`,
			wantPath: "/v1/sessions/" + fixedSID + "/input",
		},
		{
			name:     "gate response",
			reqPath:  "/v1/sessions/" + fixedSID + "/gates/g1",
			reqBody:  `{"action":"accept","values":{"answer":"yes"}}`,
			wantPath: "/v1/sessions/" + fixedSID + "/gates/g1",
		},
		{
			name:     "interrupt",
			reqPath:  "/v1/sessions/" + fixedSID + "/interrupt",
			reqBody:  "",
			wantPath: "/v1/sessions/" + fixedSID + "/interrupt",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			stub := &controlUpstreamStub{body: `{"session_id":"` + fixedSID + `"}`}
			proxy := newTrustingControlProxy(t, stub)

			var bodyReader io.Reader
			if tt.reqBody != "" {
				bodyReader = strings.NewReader(tt.reqBody)
			}
			req := httptest.NewRequest(http.MethodPost, tt.reqPath, bodyReader)
			rec := httptest.NewRecorder()
			proxy.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("POST %s status = %d, want %d; body = %s", tt.reqPath, rec.Code, http.StatusOK, rec.Body.String())
			}
			if got := stub.requestCount(); got != 1 {
				t.Fatalf("upstream requestCount = %d, want 1", got)
			}
			last, ok := stub.last()
			if !ok {
				t.Fatalf("upstream recorded no request")
			}
			if last.method != http.MethodPost || last.path != tt.wantPath {
				t.Errorf("upstream recorded method=%s path=%s, want POST %s", last.method, last.path, tt.wantPath)
			}
			if got := last.header.Get("Authorization"); got != "Bearer "+controlConfiguredToken {
				t.Errorf("upstream Authorization = %q, want %q", got, "Bearer "+controlConfiguredToken)
			}
			if string(last.body) != tt.reqBody {
				t.Errorf("upstream body = %q, want %q (byte-for-byte relay)", last.body, tt.reqBody)
			}
		})
	}
}

// TestControlProxyIdempotencyKeyRoutedCorrectly covers requirement 2, per this
// task's own investigation of harness's pkg/serve/handlers_lifecycle.go: ONLY
// handleCreate ever consults Idempotency-Key. handleRestore, handleInput,
// handleGateResponse, and handleInterrupt never reference the header at all, so
// this proxy forwards it on create ONLY and strips it (never forwards it) on the
// other four, even when the inbound request carries one.
func TestControlProxyIdempotencyKeyRoutedCorrectly(t *testing.T) {
	t.Parallel()

	const idemKey = "client-generated-idempotency-key-123"

	tests := []struct {
		name        string
		reqPath     string
		wantForward bool
	}{
		{name: "create forwards the key", reqPath: "/v1/sessions", wantForward: true},
		{name: "restore does not forward the key", reqPath: "/v1/sessions/" + fixedSID + "/restore", wantForward: false},
		{name: "input does not forward the key", reqPath: "/v1/sessions/" + fixedSID + "/input", wantForward: false},
		{name: "gate does not forward the key", reqPath: "/v1/sessions/" + fixedSID + "/gates/g1", wantForward: false},
		{name: "interrupt does not forward the key", reqPath: "/v1/sessions/" + fixedSID + "/interrupt", wantForward: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			stub := &controlUpstreamStub{}
			proxy := newTrustingControlProxy(t, stub)

			req := httptest.NewRequest(http.MethodPost, tt.reqPath, nil)
			req.Header.Set("Idempotency-Key", idemKey)
			rec := httptest.NewRecorder()
			proxy.ServeHTTP(rec, req)

			last, ok := stub.last()
			if !ok {
				t.Fatalf("upstream recorded no request")
			}
			got := last.header.Get("Idempotency-Key")
			if tt.wantForward && got != idemKey {
				t.Errorf("upstream Idempotency-Key = %q, want %q", got, idemKey)
			}
			if !tt.wantForward && got != "" {
				t.Errorf("upstream Idempotency-Key = %q, want empty (this route never consults it upstream)", got)
			}
		})
	}
}

// TestControlProxyStripsInboundAuthorization covers requirement 3: an
// attacker-shaped inbound Authorization header must never reach upstream on any
// of the five routes. Only the server-side configured token may arrive there.
func TestControlProxyStripsInboundAuthorization(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		reqPath string
	}{
		{name: "create", reqPath: "/v1/sessions"},
		{name: "restore", reqPath: "/v1/sessions/" + fixedSID + "/restore"},
		{name: "input", reqPath: "/v1/sessions/" + fixedSID + "/input"},
		{name: "gate", reqPath: "/v1/sessions/" + fixedSID + "/gates/g1"},
		{name: "interrupt", reqPath: "/v1/sessions/" + fixedSID + "/interrupt"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			stub := &controlUpstreamStub{}
			proxy := newTrustingControlProxy(t, stub)

			req := httptest.NewRequest(http.MethodPost, tt.reqPath, nil)
			req.Header.Set("Authorization", "Bearer attacker-token")
			rec := httptest.NewRecorder()
			proxy.ServeHTTP(rec, req)

			last, ok := stub.last()
			if !ok {
				t.Fatalf("upstream recorded no request")
			}
			got := last.header.Values("Authorization")
			if len(got) != 1 || got[0] != "Bearer "+controlConfiguredToken {
				t.Fatalf("upstream Authorization values = %v, want exactly [%q] (attacker-token must never reach upstream)", got, "Bearer "+controlConfiguredToken)
			}
		})
	}
}

// TestControlProxyRefusesDisallowedRequests covers requirement 4: a
// non-control-shaped or wrong-method request is refused by the proxy itself
// BEFORE any network call reaches upstream. Zero upstream requests is the
// load-bearing assertion, not just a 4xx from the proxy.
func TestControlProxyRefusesDisallowedRequests(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		method string
		path   string
	}{
		{name: "GET on create route", method: http.MethodGet, path: "/v1/sessions"},
		{name: "GET on restore route", method: http.MethodGet, path: "/v1/sessions/" + fixedSID + "/restore"},
		{name: "PUT on input route", method: http.MethodPut, path: "/v1/sessions/" + fixedSID + "/input"},
		{name: "DELETE on interrupt route", method: http.MethodDelete, path: "/v1/sessions/" + fixedSID + "/interrupt"},
		{name: "read-plane route not in this allowlist", method: http.MethodGet, path: "/v1/sessions/" + fixedSID + "/status"},
		{name: "events route not in this allowlist", method: http.MethodGet, path: "/v1/sessions/" + fixedSID + "/events"},
		{name: "completely unknown path", method: http.MethodPost, path: "/v1/unknown"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			stub := &controlUpstreamStub{}
			proxy := newTrustingControlProxy(t, stub)

			req := httptest.NewRequest(tt.method, tt.path, nil)
			rec := httptest.NewRecorder()
			proxy.ServeHTTP(rec, req)

			if rec.Code < 400 || rec.Code >= 500 {
				t.Errorf("%s %s status = %d, want a 4xx refusal; body = %s", tt.method, tt.path, rec.Code, rec.Body.String())
			}
			if got := stub.requestCount(); got != 0 {
				t.Errorf("%s %s: upstream requestCount = %d, want 0 (must be refused before any network call)", tt.method, tt.path, got)
			}
		})
	}
}

// TestControlProxyBodyTooLarge covers requirement 5's cap: a body over the
// configured maxBodyBytes is rejected 413 by the proxy's own edge (via
// http.MaxBytesReader), consistent with harness's own body-cap posture rather
// than an arbitrary re-invented number (see control.go's package doc).
func TestControlProxyBodyTooLarge(t *testing.T) {
	t.Parallel()

	stub := &controlUpstreamStub{}
	proxy := newTrustingControlProxy(t, stub, bff.WithControlMaxBodyBytes(16))

	oversized := strings.Repeat("a", 64)
	req := httptest.NewRequest(http.MethodPost, "/v1/sessions/"+fixedSID+"/input", strings.NewReader(`{"blocks":[{"type":"text","text":"`+oversized+`"}]}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d; body = %s", rec.Code, http.StatusRequestEntityTooLarge, rec.Body.String())
	}
}

// TestControlProxyUpstreamNon200 proves a non-2xx upstream response (e.g. a
// session-not-found on interrupt) is relayed, not swallowed or turned into a
// panic — the same property proxied_test.go's TestProxiedReadSourceUpstreamNon200
// proves for the read plane.
func TestControlProxyUpstreamNon200(t *testing.T) {
	t.Parallel()

	stub := &controlUpstreamStub{status: http.StatusNotFound, body: `{"error":{"code":"session_not_found"}}`}
	proxy := newTrustingControlProxy(t, stub)

	req := httptest.NewRequest(http.MethodPost, "/v1/sessions/"+fixedSID+"/interrupt", nil)
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d; body = %s", rec.Code, http.StatusNotFound, rec.Body.String())
	}
	if got := stub.requestCount(); got != 1 {
		t.Errorf("upstream requestCount = %d, want 1", got)
	}
}

// TestControlProxyRegisterRoutesAppliesCSRFThroughRealBFFMux covers requirement 6
// (self-review item: CSRF must genuinely apply through the real BFFMux, not just
// in isolation like Task 12's own test). It exercises the production wiring path
// directly: NewControlProxy -> RegisterRoutes -> BFFMux.ServeHTTP, proving all
// five routes are CSRF-protected and that a valid token lets a request all the
// way through to the real upstream stub.
func TestControlProxyRegisterRoutesAppliesCSRFThroughRealBFFMux(t *testing.T) {
	t.Parallel()

	read, _ := newMountedSource(t)
	csrf := bff.NewCSRFGuard(time.Hour)
	validToken := mustMint(t, csrf)

	stub := &controlUpstreamStub{body: `{"session_id":"` + fixedSID + `"}`}
	controlProxy := newTrustingControlProxy(t, stub)

	tests := []struct {
		name       string
		reqPath    string
		host       string
		csrfToken  string // "" means no X-CSRF-Token header at all
		wantStatus int
		wantReach  bool
	}{
		{
			name:       "create without csrf token is rejected",
			reqPath:    "/api/v1/sessions",
			host:       loopbackHost,
			csrfToken:  "",
			wantStatus: http.StatusForbidden,
			wantReach:  false,
		},
		{
			name:       "create with valid csrf token reaches upstream",
			reqPath:    "/api/v1/sessions",
			host:       loopbackHost,
			csrfToken:  validToken,
			wantStatus: http.StatusOK,
			wantReach:  true,
		},
		{
			name:       "gate response without csrf token is rejected",
			reqPath:    "/api/v1/sessions/" + fixedSID + "/gates/g1",
			host:       loopbackHost,
			csrfToken:  "",
			wantStatus: http.StatusForbidden,
			wantReach:  false,
		},
		{
			name:       "interrupt with rebound host is rejected before csrf even runs",
			reqPath:    "/api/v1/sessions/" + fixedSID + "/interrupt",
			host:       "evil.example:7777",
			csrfToken:  validToken,
			wantStatus: http.StatusForbidden,
			wantReach:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Fresh *BFFMux per case (RegisterRoutes mutates shared mux
			// state), but the same stub across cases so requestCount is
			// checked as a delta.
			before := stub.requestCount()

			mux := bff.NewMux(read, bff.NewHostOriginGuard(), csrf, true)
			controlProxy.RegisterRoutes(mux)

			req := httptest.NewRequest(http.MethodPost, tt.reqPath, nil)
			req.Host = tt.host
			if tt.csrfToken != "" {
				req.Header.Set(bff.CSRFHeaderName, tt.csrfToken)
			}
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			reached := stub.requestCount() > before
			if reached != tt.wantReach {
				t.Errorf("upstream reached = %v, want %v", reached, tt.wantReach)
			}
		})
	}
}
