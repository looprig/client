package bff_test

// These tests exercise NewProxiedReadSource against a REAL httptest.NewTLSServer
// stub standing in for a remote serve read plane. TLS (not plain HTTP) is used for
// the stub deliberately, so the tests can prove the proxy's transport is wired
// with real certificate verification (MinVersion TLS 1.2, no InsecureSkipVerify)
// rather than merely asserting it by reading the source: the stub's certificate is
// trusted via WithRootCA (a proper additive trust-store extension), never by disabling
// verification.

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/looprig/client/internal/bff"
)

const configuredToken = "server-side-token-abc123"

// recordedRequest captures what actually reached the upstream stub, so tests can
// assert on the real outbound request rather than trusting the proxy's intent.
type recordedRequest struct {
	method string
	path   string
	header http.Header
}

// upstreamStub is a recording HTTP handler standing in for a remote serve read
// plane. It records every request it receives and replies with a configurable
// status/body, so tests can both inspect what reached upstream and drive upstream
// error responses.
type upstreamStub struct {
	mu       sync.Mutex
	requests []recordedRequest

	status int // 0 means http.StatusOK
	body   string
}

func (u *upstreamStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	u.mu.Lock()
	u.requests = append(u.requests, recordedRequest{
		method: r.Method,
		path:   r.URL.Path,
		header: r.Header.Clone(),
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

func (u *upstreamStub) requestCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.requests)
}

func (u *upstreamStub) last() (recordedRequest, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.requests) == 0 {
		return recordedRequest{}, false
	}
	return u.requests[len(u.requests)-1], true
}

// newTrustingProxiedSource starts a TLS upstream stub and builds a ReadSource
// pointed at it, trusting the stub's certificate via WithRootCA — the correct
// alternative to InsecureSkipVerify. It returns the source and the stub for
// assertions, and registers cleanup to close the stub.
func newTrustingProxiedSource(t *testing.T, stub *upstreamStub) bff.ReadSource {
	t.Helper()

	ts := httptest.NewTLSServer(stub)
	t.Cleanup(ts.Close)

	upstreamURL, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("url.Parse(%q) err = %v", ts.URL, err)
	}

	src, err := bff.NewProxiedReadSource(upstreamURL, configuredToken, bff.WithRootCA(ts.Certificate()))
	if err != nil {
		t.Fatalf("NewProxiedReadSource() err = %v", err)
	}
	return src
}

func TestNewProxiedReadSourceConstructorValidation(t *testing.T) {
	t.Parallel()

	validURL, err := url.Parse("https://serve.example:8443")
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
		{name: "bad scheme", base: mustParseURL(t, "ftp://serve.example"), token: "tok", wantErr: true},
		{name: "no host", base: mustParseURL(t, "https:///path"), token: "tok", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := bff.NewProxiedReadSource(tt.base, tt.token)
			if (err != nil) != tt.wantErr {
				t.Fatalf("NewProxiedReadSource() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q) err = %v", raw, err)
	}
	return u
}

// TestProxiedReadSourceAllowlistedPathReachesUpstream covers requirement 1: an
// allowlisted GET reaches upstream carrying the server-side token.
func TestProxiedReadSourceAllowlistedPathReachesUpstream(t *testing.T) {
	t.Parallel()

	stub := &upstreamStub{body: `{"sessions":[]}`}
	src := newTrustingProxiedSource(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	rec := httptest.NewRecorder()
	src.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/sessions status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := stub.requestCount(); got != 1 {
		t.Fatalf("upstream requestCount = %d, want 1", got)
	}
	last, ok := stub.last()
	if !ok {
		t.Fatalf("upstream recorded no request")
	}
	if last.method != http.MethodGet || last.path != "/v1/sessions" {
		t.Errorf("upstream recorded method=%s path=%s, want GET /v1/sessions", last.method, last.path)
	}
	if got := last.header.Get("Authorization"); got != "Bearer "+configuredToken {
		t.Errorf("upstream Authorization = %q, want %q", got, "Bearer "+configuredToken)
	}
}

// TestProxiedReadSourceCapabilitiesReachesUpstream proves the /v1/capabilities
// route — otherwise only exercised on its rejection side (wrong method) — is
// actually wired to the allowlist mux and reaches upstream, with the response
// flowing back to the caller correctly. Same pattern as
// TestProxiedReadSourceAllowlistedPathReachesUpstream.
func TestProxiedReadSourceCapabilitiesReachesUpstream(t *testing.T) {
	t.Parallel()

	stub := &upstreamStub{body: `{"readOnly":false}`}
	src := newTrustingProxiedSource(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
	rec := httptest.NewRecorder()
	src.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/capabilities status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got, want := rec.Body.String(), `{"readOnly":false}`; got != want {
		t.Errorf("GET /v1/capabilities body = %q, want %q", got, want)
	}
	if got := stub.requestCount(); got != 1 {
		t.Fatalf("upstream requestCount = %d, want 1", got)
	}
	last, ok := stub.last()
	if !ok {
		t.Fatalf("upstream recorded no request")
	}
	if last.method != http.MethodGet || last.path != "/v1/capabilities" {
		t.Errorf("upstream recorded method=%s path=%s, want GET /v1/capabilities", last.method, last.path)
	}
	if got := last.header.Get("Authorization"); got != "Bearer "+configuredToken {
		t.Errorf("upstream Authorization = %q, want %q", got, "Bearer "+configuredToken)
	}
}

// TestProxiedReadSourceJournalReachesUpstream proves the
// /v1/sessions/{sid}/journal route — otherwise only exercised on its
// rejection side — is actually wired to the allowlist mux and reaches
// upstream, with the {sid} wildcard segment forwarded intact and the response
// flowing back to the caller correctly. Same pattern as
// TestProxiedReadSourceAllowlistedPathReachesUpstream.
func TestProxiedReadSourceJournalReachesUpstream(t *testing.T) {
	t.Parallel()

	stub := &upstreamStub{body: `{"events":[]}`}
	src := newTrustingProxiedSource(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions/"+fixedSID+"/journal", nil)
	rec := httptest.NewRecorder()
	src.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/sessions/%s/journal status = %d, want %d; body = %s", fixedSID, rec.Code, http.StatusOK, rec.Body.String())
	}
	if got, want := rec.Body.String(), `{"events":[]}`; got != want {
		t.Errorf("GET /v1/sessions/%s/journal body = %q, want %q", fixedSID, got, want)
	}
	if got := stub.requestCount(); got != 1 {
		t.Fatalf("upstream requestCount = %d, want 1", got)
	}
	last, ok := stub.last()
	if !ok {
		t.Fatalf("upstream recorded no request")
	}
	wantPath := "/v1/sessions/" + fixedSID + "/journal"
	if last.method != http.MethodGet || last.path != wantPath {
		t.Errorf("upstream recorded method=%s path=%s, want GET %s", last.method, last.path, wantPath)
	}
	if got := last.header.Get("Authorization"); got != "Bearer "+configuredToken {
		t.Errorf("upstream Authorization = %q, want %q", got, "Bearer "+configuredToken)
	}
}

// TestProxiedReadSourceRefusesDisallowedRequests covers requirement 1's
// security-relevant property: a disallowed method or path is refused by the proxy
// itself, BEFORE any network call reaches upstream. Zero upstream requests is the
// load-bearing assertion, not just a 4xx from the proxy.
func TestProxiedReadSourceRefusesDisallowedRequests(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		method string
		path   string
	}{
		{name: "POST to list route", method: http.MethodPost, path: "/v1/sessions"},
		{name: "events route not in allowlist", method: http.MethodGet, path: "/v1/sessions/" + fixedSID + "/events"},
		{name: "unknown control route", method: http.MethodPost, path: "/v1/sessions/" + fixedSID + "/interrupt"},
		{name: "gate route", method: http.MethodPost, path: "/v1/sessions/" + fixedSID + "/gates/g1"},
		{name: "create session", method: http.MethodPost, path: "/v1/sessions"},
		{name: "restore route", method: http.MethodPost, path: "/v1/sessions/" + fixedSID + "/restore"},
		{name: "completely unknown path", method: http.MethodGet, path: "/v1/unknown"},
		{name: "wrong method on capabilities", method: http.MethodPost, path: "/v1/capabilities"},
		{name: "wrong method on status", method: http.MethodDelete, path: "/v1/sessions/" + fixedSID + "/status"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			stub := &upstreamStub{}
			src := newTrustingProxiedSource(t, stub)

			req := httptest.NewRequest(tt.method, tt.path, nil)
			rec := httptest.NewRecorder()
			src.ServeHTTP(rec, req)

			if rec.Code < 400 || rec.Code >= 500 {
				t.Errorf("%s %s status = %d, want a 4xx refusal; body = %s", tt.method, tt.path, rec.Code, rec.Body.String())
			}
			if got := stub.requestCount(); got != 0 {
				t.Errorf("%s %s: upstream requestCount = %d, want 0 (must be refused before any network call)", tt.method, tt.path, got)
			}
		})
	}
}

const fixedSID = "01234567-89ab-cdef-0123-456789abcdef"

// TestProxiedReadSourceStripsInboundAuthorization covers requirement 3: an
// attacker-shaped inbound Authorization header must never reach upstream. Only the
// server-side configured token may arrive there.
func TestProxiedReadSourceStripsInboundAuthorization(t *testing.T) {
	t.Parallel()

	stub := &upstreamStub{}
	src := newTrustingProxiedSource(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req.Header.Set("Authorization", "Bearer attacker-token")
	rec := httptest.NewRecorder()
	src.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/sessions status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	last, ok := stub.last()
	if !ok {
		t.Fatalf("upstream recorded no request")
	}
	got := last.header.Values("Authorization")
	if len(got) != 1 || got[0] != "Bearer "+configuredToken {
		t.Fatalf("upstream Authorization values = %v, want exactly [%q] (attacker-token must never reach upstream)", got, "Bearer "+configuredToken)
	}
}

// TestProxiedReadSourceUpstreamNon200 covers requirement 4's first half: a
// non-200 upstream response (e.g. an unknown session) is relayed, not swallowed
// or turned into a panic.
func TestProxiedReadSourceUpstreamNon200(t *testing.T) {
	t.Parallel()

	stub := &upstreamStub{status: http.StatusNotFound, body: `{"error":"not found"}`}
	src := newTrustingProxiedSource(t, stub)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions/"+fixedSID+"/status", nil)
	rec := httptest.NewRecorder()
	src.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d; body = %s", rec.Code, http.StatusNotFound, rec.Body.String())
	}
	if got := stub.requestCount(); got != 1 {
		t.Errorf("upstream requestCount = %d, want 1", got)
	}
}

// TestProxiedReadSourceUpstreamUnreachable covers requirement 4's second half: an
// upstream that isn't listening at all must not hang or panic the proxy. It binds
// a loopback listener, closes it immediately (freeing the port with nothing
// listening), and points the proxy at that address.
func TestProxiedReadSourceUpstreamUnreachable(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() err = %v", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatalf("Listener.Close() err = %v", err)
	}

	upstreamURL, err := url.Parse("http://" + addr)
	if err != nil {
		t.Fatalf("url.Parse() err = %v", err)
	}

	src, err := bff.NewProxiedReadSource(upstreamURL, configuredToken)
	if err != nil {
		t.Fatalf("NewProxiedReadSource() err = %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		defer close(done)
		src.ServeHTTP(rec, req)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ServeHTTP did not return for an unreachable upstream within 5s (hung)")
	}

	if rec.Code < 500 || rec.Code >= 600 {
		t.Errorf("status = %d, want a 5xx (upstream unreachable); body = %s", rec.Code, rec.Body.String())
	}
}
