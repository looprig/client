package bff_test

// These tests exercise NewSSEProxy end-to-end over REAL network connections (a
// front httptest.Server hosting the proxy, and an httptest.NewTLSServer stub
// standing in for the remote session host's SSE endpoint) rather than
// httptest.NewRecorder, because proving incremental delivery (requirement 3) and
// idle-timeout closure (requirement 4) both require a real streaming connection a
// test can read from concurrently with the stub writing to it — a
// ResponseRecorder captures a finished response, it cannot be read while still in
// flight. Security/token/allowlist assertions reuse proxied_test.go's style
// (upstreamStub, WithRootCA-equivalent trust) as closely as this different shape
// of proxy allows.

import (
	"bytes"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/looprig/client/internal/bff"
)

const sseConfiguredToken = "server-side-sse-token-xyz789"

// eventsRequest captures what actually reached the upstream stub for a single
// request, so tests assert on the real outbound request rather than trusting the
// proxy's intent.
type eventsRequest struct {
	method string
	path   string
	header http.Header
}

// recordingHeaderFunc lets a test observe the inbound request the stub received
// before it does anything else (write headers, block, stream frames) — every
// stub handler below starts by recording, then branches into its
// test-specific behavior.
func recordEventsRequest(mu *sync.Mutex, requests *[]eventsRequest, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	*requests = append(*requests, eventsRequest{method: r.Method, path: r.URL.Path, header: r.Header.Clone()})
}

// newFrontedSSEProxy starts a TLS upstream (the stub) and a plain-HTTP front
// server hosting the SSE proxy pointed at it (mirroring how the BFF would host
// this proxy for a real browser EventSource — the browser never sees or trusts
// the upstream's own TLS certificate, only the proxy's). It returns the front
// server's base URL (to issue client requests against) and registers cleanup for
// both servers.
func newFrontedSSEProxy(t *testing.T, upstream http.Handler, opts ...bff.SSEProxyOption) string {
	t.Helper()

	ts := httptest.NewTLSServer(upstream)
	t.Cleanup(ts.Close)

	upstreamURL, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("url.Parse(%q) err = %v", ts.URL, err)
	}

	allOpts := append([]bff.SSEProxyOption{bff.WithSSERootCA(ts.Certificate())}, opts...)
	proxy, err := bff.NewSSEProxy(upstreamURL, sseConfiguredToken, allOpts...)
	if err != nil {
		t.Fatalf("NewSSEProxy() err = %v", err)
	}

	front := httptest.NewServer(proxy)
	t.Cleanup(front.Close)

	return front.URL
}

// streamGet issues a GET against the fronted proxy with optional extra headers
// and returns the live *http.Response for the caller to read incrementally. The
// caller is responsible for closing the response body.
func streamGet(t *testing.T, baseURL, path string, headers map[string]string) *http.Response {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, baseURL+path, nil)
	if err != nil {
		t.Fatalf("http.NewRequest() err = %v", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("client.Do() err = %v", err)
	}
	return resp
}

const eventsFixedSID = "01234567-89ab-cdef-0123-456789abcdef"

func TestNewSSEProxyConstructorValidation(t *testing.T) {
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
		{name: "bad scheme", base: mustParseEventsURL(t, "ftp://serve.example"), token: "tok", wantErr: true},
		{name: "no host", base: mustParseEventsURL(t, "https:///path"), token: "tok", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := bff.NewSSEProxy(tt.base, tt.token)
			if (err != nil) != tt.wantErr {
				t.Fatalf("NewSSEProxy() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func mustParseEventsURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q) err = %v", raw, err)
	}
	return u
}

// TestSSEProxyForwardsLastEventID covers requirement 1: a Last-Event-ID header on
// the incoming (reconnect) request reaches the upstream request unchanged.
func TestSSEProxyForwardsLastEventID(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var requests []eventsRequest
	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recordEventsRequest(&mu, &requests, r)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	})

	base := newFrontedSSEProxy(t, stub)

	resp := streamGet(t, base, "/v1/sessions/"+eventsFixedSID+"/events", map[string]string{
		"Last-Event-ID": "42",
	})
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 1 {
		t.Fatalf("upstream requestCount = %d, want 1", len(requests))
	}
	if got := requests[0].header.Get("Last-Event-ID"); got != "42" {
		t.Errorf("upstream Last-Event-ID = %q, want %q", got, "42")
	}
}

// TestSSEProxyOmitsLastEventIDWhenAbsent proves the proxy doesn't manufacture a
// Last-Event-ID header on a fresh (non-reconnect) connection.
func TestSSEProxyOmitsLastEventIDWhenAbsent(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var requests []eventsRequest
	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recordEventsRequest(&mu, &requests, r)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	})

	base := newFrontedSSEProxy(t, stub)

	resp := streamGet(t, base, "/v1/sessions/"+eventsFixedSID+"/events", nil)
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 1 {
		t.Fatalf("upstream requestCount = %d, want 1", len(requests))
	}
	if got, ok := requests[0].header["Last-Event-Id"]; ok {
		t.Errorf("upstream Last-Event-ID present = %v, want absent", got)
	}
}

// sseFrame1 and sseFrame2 are realistic multi-class SSE frames in harness's exact
// wire format (pkg/serve/ephemeral.go's encodeEnduringFrame/encodeEphemeralFrame):
// an enduring frame with an id: stamp, and an ephemeral frame with none.
const (
	sseFrame1 = "event: enduring\nid: 7\ndata: {\"v\":1,\"event\":{\"type\":\"turn_started\"}}\n\n"
	sseFrame2 = "event: ephemeral\ndata: {\"v\":1,\"kind\":\"token_delta\",\"delta\":{\"chunk_type\":\"text\",\"text\":\"hi\"}}\n\n"
)

// TestSSEProxyRelaysFrameBytesUnchanged covers requirement 2: id: stamps and
// frame bodies in the upstream's SSE body reach the client byte-for-byte, with no
// re-encoding or re-parsing anywhere in the relay.
func TestSSEProxyRelaysFrameBytesUnchanged(t *testing.T) {
	t.Parallel()

	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, sseFrame1)
		flusher.Flush()
		_, _ = io.WriteString(w, sseFrame2)
		flusher.Flush()
	})

	base := newFrontedSSEProxy(t, stub)

	resp := streamGet(t, base, "/v1/sessions/"+eventsFixedSID+"/events", nil)
	defer func() { _ = resp.Body.Close() }()

	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("io.ReadAll() err = %v", err)
	}
	want := sseFrame1 + sseFrame2
	if string(got) != want {
		t.Errorf("proxied body = %q, want %q (byte-for-byte)", got, want)
	}
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Errorf("Content-Type = %q, want %q", got, "text/event-stream")
	}
}

// TestSSEProxyFlushesIncrementally covers requirement 3: the proxy flushes each
// chunk as it arrives rather than buffering to completion. The stub blocks
// between frame1 and frame2 on a channel the test controls; the test asserts it
// received frame1 BEFORE it releases the stub to send frame2, via a
// channel-based synchronization point rather than a sleep-and-hope timing
// assertion (a buffering proxy would deadlock this test until its timeout,
// because the stub can never be released without the client first observing
// frame1).
func TestSSEProxyFlushesIncrementally(t *testing.T) {
	t.Parallel()

	proceed := make(chan struct{})
	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, sseFrame1)
		flusher.Flush()
		<-proceed
		_, _ = io.WriteString(w, sseFrame2)
		flusher.Flush()
	})

	base := newFrontedSSEProxy(t, stub)

	resp := streamGet(t, base, "/v1/sessions/"+eventsFixedSID+"/events", nil)
	defer func() { _ = resp.Body.Close() }()

	gotFrame1 := make(chan struct{})
	readDone := make(chan []byte, 1)
	go func() {
		var buf bytes.Buffer
		chunk := make([]byte, 1)
		for buf.Len() < len(sseFrame1) {
			n, err := resp.Body.Read(chunk)
			if n > 0 {
				buf.Write(chunk[:n])
			}
			if err != nil {
				readDone <- buf.Bytes()
				return
			}
		}
		close(gotFrame1)
		rest, _ := io.ReadAll(resp.Body)
		buf.Write(rest)
		readDone <- buf.Bytes()
	}()

	select {
	case <-gotFrame1:
	case got := <-readDone:
		t.Fatalf("stream ended before frame1 was fully observed; got %q", got)
	case <-time.After(2 * time.Second):
		t.Fatal("did not observe frame1 within 2s: proxy is likely buffering instead of flushing incrementally")
	}

	close(proceed)

	select {
	case got := <-readDone:
		want := sseFrame1 + sseFrame2
		if string(got) != want {
			t.Errorf("final body = %q, want %q", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not complete within 2s after releasing frame2")
	}
}

// TestSSEProxyIdleTimeoutClosesConnection covers requirement 3's flip side: an
// upstream that stops sending anything at all (not even a heartbeat) past the
// configured idle deadline must not hang the proxy forever — the proxy closes
// the connection and the client observes the stream terminate. The test never
// cancels the client's own request, so the only thing that can end the stream is
// the proxy's own idle watchdog, distinguishing this from an ordinary
// client-initiated disconnect.
func TestSSEProxyIdleTimeoutClosesConnection(t *testing.T) {
	t.Parallel()

	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done() // never write again; block until the connection tears down
	})

	const idleTimeout = 150 * time.Millisecond
	base := newFrontedSSEProxy(t, stub, bff.WithIdleTimeout(idleTimeout))

	resp := streamGet(t, base, "/v1/sessions/"+eventsFixedSID+"/events", nil)
	defer func() { _ = resp.Body.Close() }()

	done := make(chan error, 1)
	go func() {
		_, err := io.ReadAll(resp.Body)
		done <- err
	}()

	select {
	case <-done:
		// Stream terminated (EOF or a read error) — the idle watchdog fired.
	case <-time.After(2 * time.Second):
		t.Fatal("response stream did not terminate within 2s of the idle deadline (proxy hung on a dead upstream)")
	}
}

// TestSSEProxyStripsInboundAuthorization covers requirement 4: an attacker-shaped
// inbound Authorization header must never reach upstream, and the configured
// server-side token must be the one that does.
func TestSSEProxyStripsInboundAuthorization(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var requests []eventsRequest
	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recordEventsRequest(&mu, &requests, r)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	})

	base := newFrontedSSEProxy(t, stub)

	resp := streamGet(t, base, "/v1/sessions/"+eventsFixedSID+"/events", map[string]string{
		"Authorization": "Bearer attacker-token",
	})
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 1 {
		t.Fatalf("upstream requestCount = %d, want 1", len(requests))
	}
	got := requests[0].header.Values("Authorization")
	if len(got) != 1 || got[0] != "Bearer "+sseConfiguredToken {
		t.Fatalf("upstream Authorization values = %v, want exactly [%q] (attacker-token must never reach upstream)", got, "Bearer "+sseConfiguredToken)
	}
}

// TestSSEProxyDoesNotForwardArbitraryInboundHeaders proves the proxy forwards
// only what upstream's protocol needs (Last-Event-ID, plus the server-injected
// Authorization) rather than blindly relaying every inbound header the way a
// generic reverse proxy would — least privilege on the outbound leg.
func TestSSEProxyDoesNotForwardArbitraryInboundHeaders(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var requests []eventsRequest
	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recordEventsRequest(&mu, &requests, r)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	})

	base := newFrontedSSEProxy(t, stub)

	resp := streamGet(t, base, "/v1/sessions/"+eventsFixedSID+"/events", map[string]string{
		"Cookie": "session=browser-cookie-should-not-leak",
	})
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 1 {
		t.Fatalf("upstream requestCount = %d, want 1", len(requests))
	}
	if got, ok := requests[0].header["Cookie"]; ok {
		t.Errorf("upstream Cookie present = %v, want absent (this proxy forwards only the headers upstream's protocol needs)", got)
	}
}

// TestSSEProxyRefusesDisallowedRequests covers requirement 4's allowlist half: a
// disallowed method or path is refused by the proxy itself, BEFORE any network
// call reaches upstream — zero upstream requests is the load-bearing assertion.
func TestSSEProxyRefusesDisallowedRequests(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		method string
		path   string
	}{
		{name: "POST to events route", method: http.MethodPost, path: "/v1/sessions/" + eventsFixedSID + "/events"},
		{name: "journal route not in allowlist", method: http.MethodGet, path: "/v1/sessions/" + eventsFixedSID + "/journal"},
		{name: "sessions list route not in allowlist", method: http.MethodGet, path: "/v1/sessions"},
		{name: "completely unknown path", method: http.MethodGet, path: "/v1/unknown"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var mu sync.Mutex
			var requests []eventsRequest
			stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				recordEventsRequest(&mu, &requests, r)
				w.WriteHeader(http.StatusOK)
			})

			base := newFrontedSSEProxy(t, stub)

			req, err := http.NewRequest(tt.method, base+tt.path, nil)
			if err != nil {
				t.Fatalf("http.NewRequest() err = %v", err)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("client.Do() err = %v", err)
			}
			defer func() { _ = resp.Body.Close() }()

			if resp.StatusCode < 400 || resp.StatusCode >= 500 {
				t.Errorf("%s %s status = %d, want a 4xx refusal", tt.method, tt.path, resp.StatusCode)
			}

			mu.Lock()
			count := len(requests)
			mu.Unlock()
			if count != 0 {
				t.Errorf("%s %s: upstream requestCount = %d, want 0 (must be refused before any network call)", tt.method, tt.path, count)
			}
		})
	}
}

// TestSSEProxyUpstreamUnreachable proves an upstream that isn't listening at all
// yields a 5xx rather than hanging or panicking the proxy.
func TestSSEProxyUpstreamUnreachable(t *testing.T) {
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

	proxy, err := bff.NewSSEProxy(upstreamURL, sseConfiguredToken)
	if err != nil {
		t.Fatalf("NewSSEProxy() err = %v", err)
	}
	front := httptest.NewServer(proxy)
	t.Cleanup(front.Close)

	resp := streamGet(t, front.URL, "/v1/sessions/"+eventsFixedSID+"/events", nil)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 500 || resp.StatusCode >= 600 {
		t.Errorf("status = %d, want a 5xx (upstream unreachable)", resp.StatusCode)
	}
}

// TestSSEProxyRejectsInvalidUpstreamTLS proves the outbound transport really
// verifies the upstream certificate (TLS MinVersion 1.2, no InsecureSkipVerify):
// pointing the proxy at a TLS stub WITHOUT trusting its certificate (no
// WithSSERootCA) must fail the connection, not silently accept it.
func TestSSEProxyRejectsInvalidUpstreamTLS(t *testing.T) {
	t.Parallel()

	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)

	upstreamURL, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("url.Parse() err = %v", err)
	}

	// Deliberately no WithSSERootCA: the stub's self-signed certificate is
	// untrusted, so the outbound TLS handshake must fail.
	proxy, err := bff.NewSSEProxy(upstreamURL, sseConfiguredToken)
	if err != nil {
		t.Fatalf("NewSSEProxy() err = %v", err)
	}
	front := httptest.NewServer(proxy)
	t.Cleanup(front.Close)

	resp := streamGet(t, front.URL, "/v1/sessions/"+eventsFixedSID+"/events", nil)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 500 || resp.StatusCode >= 600 {
		t.Errorf("status = %d, want a 5xx (upstream TLS certificate must not be trusted without WithSSERootCA)", resp.StatusCode)
	}
}

// TestSSEProxyRejectsLowUpstreamTLSVersion proves MinVersion TLS 1.2 is actually
// enforced on the outbound leg: an upstream stub configured to only speak TLS 1.1
// must fail the handshake, not be silently accepted.
func TestSSEProxyRejectsLowUpstreamTLSVersion(t *testing.T) {
	t.Parallel()

	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	}))
	ts.TLS = &tls.Config{MaxVersion: tls.VersionTLS11}
	ts.StartTLS()
	t.Cleanup(ts.Close)

	upstreamURL, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("url.Parse() err = %v", err)
	}

	proxy, err := bff.NewSSEProxy(upstreamURL, sseConfiguredToken, bff.WithSSERootCA(ts.Certificate()))
	if err != nil {
		t.Fatalf("NewSSEProxy() err = %v", err)
	}
	front := httptest.NewServer(proxy)
	t.Cleanup(front.Close)

	resp := streamGet(t, front.URL, "/v1/sessions/"+eventsFixedSID+"/events", nil)
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 500 || resp.StatusCode >= 600 {
		t.Errorf("status = %d, want a 5xx (TLS 1.1 upstream must be refused by MinVersion TLS 1.2)", resp.StatusCode)
	}
}
