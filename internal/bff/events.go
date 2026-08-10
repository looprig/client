package bff

// events.go is the BFF's live-plane reverse proxy: it forwards
// GET /api/v1/sessions/{sid}/events (after /api is stripped, GET
// /v1/sessions/{sid}/events) to a configured session host's real SSE endpoint
// (harness's pkg/serve handleEvents). It follows the SAME security posture as
// proxied.go's read-plane proxy (allowlist-of-one, server-side token injection,
// inbound Authorization stripped, TLS MinVersion 1.2, never InsecureSkipVerify)
// but is a genuinely different shape of proxy: proxied.go relays short-lived
// request/response pairs through httputil.ReverseProxy; this file hand-rolls a
// byte-level relay loop for a long-lived streaming response, because it has two
// concerns ReverseProxy doesn't give direct control over:
//
//  1. Forwarding Last-Event-ID unchanged on reconnect (a plain header copy, but
//     load-bearing: see NewSSEProxy's doc).
//  2. An idle-timeout watchdog distinct from the whole-request context: an SSE
//     response is expected to run for a long time with only occasional traffic
//     (real events, plus harness's own heartbeat comment every
//     defaultHeartbeatInterval — see sseIdleTimeout's doc), so "context-bounded"
//     here means "closed after upstream goes silent past the idle deadline, or
//     the client disconnects" rather than a short fixed deadline.
//
// Deliberately duplicated rather than shared with proxied.go: the two proxies'
// TLS/transport construction looks similar on the surface, but proxied.go's
// ProxiedReadSourceOption is scoped to exactly one concern (an additional trusted
// root CA) while this proxy also needs an idle-timeout knob, and proxied.go is an
// already-reviewed, tested file from an earlier task — refactoring it to share an
// option type across two different proxy shapes (short request/response vs.
// long-lived stream) would trade a few lines of duplication for a shared
// abstraction neither proxy's own concerns cleanly justify. The one thing this
// file DOES reuse conceptually (not by import, since it's unexported in a
// different module) is harness's own SSE frame format and heartbeat cadence,
// verified by reading pkg/serve/handlers_events.go, pkg/serve/ephemeral.go, and
// pkg/serve/options.go directly rather than assumed.

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// contentTypeSSE is the media type harness's events endpoint serves. Duplicated
// here (rather than imported) because it is an unexported constant of
// harness/pkg/serve; this proxy only needs it to set an outbound Accept header,
// never to branch behavior on it (the relay loop is byte-level regardless of
// content type — see ServeHTTP's doc).
const contentTypeSSE = "text/event-stream"

// sseUpstreamHeaderTimeout bounds only the connect-and-receive-headers phase of
// the outbound request to upstream — the same phase proxiedUpstreamTimeout bounds
// for the read-plane proxy, and the same duration, since both are "how long is it
// reasonable to wait for upstream to even start responding." It does NOT bound
// reading the response body: once headers arrive, the body is a long-lived SSE
// stream governed by sseIdleTimeout instead (net/http's Transport applies
// ResponseHeaderTimeout only up to the point headers are received).
const sseUpstreamHeaderTimeout = 15 * time.Second

// sseIdleTimeout is how long this proxy tolerates upstream going completely
// silent — no event, no heartbeat comment, nothing at all — before it treats the
// connection as hung and closes it. Harness's own SSE heartbeat
// (pkg/serve/options.go's defaultHeartbeatInterval, unexported so mirrored here
// as a comment rather than imported) fires a `: ping` comment every 20 seconds
// specifically so an idle stream never goes silent this long under normal
// operation. 60 seconds (3x the heartbeat) is comfortably past ordinary jitter —
// a slow network hop, a GC pause, two back-to-back missed heartbeats — while
// still catching a genuinely dead upstream (crashed process, black-holed
// connection) well before a human waiting on the other end would give up.
const sseIdleTimeout = 60 * time.Second

// sseCopyBufferSize is the read buffer the relay loop reuses across iterations.
// It bounds worst-case latency-to-flush (the loop writes+flushes whatever a
// single Read call returns, however small) without ever accumulating into an
// unbounded buffer — the loop is streaming, not batching.
const sseCopyBufferSize = 4096

// sseHopByHopHeaders lists the response headers that describe THIS hop of the
// connection (proxy<->client) rather than the resource itself, so they must never
// be copied verbatim from the upstream<->proxy hop's response — the standard
// reverse-proxy convention (net/http/httputil's ReverseProxy applies the same
// list, unexported there too).
var sseHopByHopHeaders = []string{
	"Connection",
	"Proxy-Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

// sseProxyConfig is NewSSEProxy's construction-time state, built from defaults and
// then mutated by SSEProxyOption values.
type sseProxyConfig struct {
	tlsConfig   *tls.Config
	idleTimeout time.Duration
}

// SSEProxyOption customizes NewSSEProxy's construction. The zero value (no
// options) trusts only the host's standard CA pool and uses sseIdleTimeout.
type SSEProxyOption func(*sseProxyConfig)

// WithSSERootCA adds cert as an ADDITIONAL trusted root certificate for the
// upstream TLS connection, on top of (never instead of) the host's standard CA
// pool — the same additive-trust pattern as proxied.go's WithRootCA, and for the
// same reason: it lets tests point this proxy at an httptest.NewTLSServer stub
// without ever setting InsecureSkipVerify. See WithRootCA's doc for why the pool
// is cloned-and-added-to rather than replaced outright.
func WithSSERootCA(cert *x509.Certificate) SSEProxyOption {
	return func(cfg *sseProxyConfig) {
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		pool.AddCert(cert)
		cfg.tlsConfig.RootCAs = pool
	}
}

// WithIdleTimeout overrides sseIdleTimeout. d <= 0 is ignored (keeps whatever the
// config already has) so a zero-valued option application can never disable the
// watchdog outright — fail-safe, matching the convention harness's own
// streamEvents clamps heartbeat with.
func WithIdleTimeout(d time.Duration) SSEProxyOption {
	return func(cfg *sseProxyConfig) {
		if d > 0 {
			cfg.idleTimeout = d
		}
	}
}

// sseProxy forwards the ONE allowlisted route — GET /v1/sessions/{sid}/events —
// to upstream. mux IS the allowlist, exactly as proxiedReadSource's is in
// proxied.go: only this one method+path pattern is registered, so any other
// method or path is refused by http.ServeMux itself, before sseProxy.serveEvents
// (and therefore any outbound network call) ever runs.
type sseProxy struct {
	mux         *http.ServeMux
	upstream    url.URL
	token       string
	client      *http.Client
	idleTimeout time.Duration
}

// ServeHTTP dispatches through the allowlist mux. Unlike proxiedReadSource's
// ServeHTTP, this deliberately does NOT bound the request's context with a short
// fixed timeout — see NewSSEProxy's doc for why a long-lived SSE stream needs a
// different "context-bounded" story (idle timeout + client disconnect, not a
// fixed deadline).
func (p *sseProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mux.ServeHTTP(w, r)
}

// NewSSEProxy builds an http.Handler that reverse-proxies harness's live SSE
// events endpoint to a remote session host, following proxied.go's security
// posture (allowlist-of-one, server-side token injection, inbound Authorization
// stripped, TLS 1.2 minimum, never InsecureSkipVerify) with SSE-specific
// streaming behavior layered on top:
//
//   - Last-Event-ID is forwarded to upstream unchanged whenever the inbound
//     request carries it (a browser's EventSource sends this automatically on
//     reconnect after a dropped connection).
//   - The upstream response body — including its `id: <journal_seq>` stamps on
//     enduring frames — is relayed byte-for-byte: this proxy reads the SSE body
//     as opaque bytes and writes+flushes each chunk promptly, never parsing or
//     re-encoding frame content (frame PARSING is a client-side/SDK concern, not
//     this proxy's).
//   - A read from upstream that produces nothing at all for sseIdleTimeout (or an
//     option-overridden duration) is treated as a hung upstream and the
//     connection is closed, rather than left open indefinitely.
//
// upstreamBaseURL and token are validated exactly as NewProxiedReadSource
// validates them (see that function's doc for the fail-fast/fail-secure
// reasoning): a nil or malformed URL, or an empty token, is a broken composition
// that must fail loudly at construction, not silently proxy unauthenticated on
// first request.
func NewSSEProxy(upstreamBaseURL *url.URL, token string, opts ...SSEProxyOption) (http.Handler, error) {
	if upstreamBaseURL == nil {
		return nil, fmt.Errorf("bff: sse proxy: upstream base URL is nil")
	}
	if upstreamBaseURL.Scheme != "http" && upstreamBaseURL.Scheme != "https" {
		return nil, fmt.Errorf("bff: sse proxy: upstream base URL %q has unsupported scheme %q (want http or https)", upstreamBaseURL.String(), upstreamBaseURL.Scheme)
	}
	if upstreamBaseURL.Host == "" {
		return nil, fmt.Errorf("bff: sse proxy: upstream base URL %q has no host", upstreamBaseURL.String())
	}
	if token == "" {
		return nil, fmt.Errorf("bff: sse proxy: token must not be empty")
	}

	cfg := &sseProxyConfig{
		tlsConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
		idleTimeout: sseIdleTimeout,
	}
	for _, opt := range opts {
		opt(cfg)
	}

	transport := &http.Transport{
		TLSClientConfig:       cfg.tlsConfig,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: sseUpstreamHeaderTimeout,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}
	// Deliberately no Client.Timeout: that bounds the ENTIRE round trip
	// including reading the response body, which for this proxy is a
	// long-lived stream expected to run far longer than any sane fixed
	// timeout. Body-read liveness is governed by the idle watchdog instead
	// (see serveEvents), not by the transport/client configuration.
	client := &http.Client{Transport: transport}

	p := &sseProxy{
		upstream:    *upstreamBaseURL,
		token:       token,
		client:      client,
		idleTimeout: cfg.idleTimeout,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/sessions/{sid}/events", p.serveEvents)
	p.mux = mux

	return p, nil
}

// serveEvents is the single allowlisted route's handler. See NewSSEProxy's doc
// for the properties it guarantees.
func (p *sseProxy) serveEvents(w http.ResponseWriter, r *http.Request) {
	outURL := p.upstream
	outURL.Path = joinURLPath(p.upstream.Path, r.URL.Path)
	outURL.RawQuery = r.URL.RawQuery

	// Bounded by client disconnect (r.Context() cancels when the client goes
	// away) and by the idle watchdog started below — NOT by a short fixed
	// deadline. See NewSSEProxy's and ServeHTTP's docs.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	outReq, err := http.NewRequestWithContext(ctx, http.MethodGet, outURL.String(), nil)
	if err != nil {
		slog.Error("bff: sse proxy: build outbound request", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	outReq.Header.Set("Accept", contentTypeSSE)
	// Forward Last-Event-ID unchanged, whenever the inbound request carries
	// one, and ONLY that header from the inbound request — everything else on
	// the outbound leg is set explicitly below. This proxy does not blindly
	// forward arbitrary inbound headers (cookies, custom headers a compromised
	// SPA might smuggle) the way a generic reverse proxy would; it forwards
	// exactly what upstream's protocol needs.
	if lastEventID := r.Header.Get("Last-Event-ID"); lastEventID != "" {
		outReq.Header.Set("Last-Event-ID", lastEventID)
	}
	// Server-side token custody: see setOutboundAuthorization
	// (tokencustody.go) — strips whatever Authorization the inbound request
	// carried (a no-op here given the fresh header map above, but shared logic
	// beats re-deriving the same Del-then-Set contract a third time) and sets
	// exactly the configured server-side token.
	setOutboundAuthorization(outReq.Header, p.token)

	resp, err := p.client.Do(outReq)
	if err != nil {
		slog.Error("bff: sse proxy: upstream request failed", "err", err)
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}
	defer func() { _ = resp.Body.Close() }()

	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)

	rc := http.NewResponseController(w)
	// Clear any per-connection write deadline, exactly as harness's own
	// streamEvents does for the same reason: a server-wide WriteTimeout would
	// otherwise truncate this long-lived stream. ErrNotSupported is benign.
	if err := rc.SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
		slog.Debug("bff: sse proxy: set write deadline", "err", err)
	}
	if err := rc.Flush(); err != nil {
		return
	}

	activity := make(chan struct{}, 1)
	go watchIdle(ctx, cancel, p.idleTimeout, activity)
	notifyActivity := func() {
		select {
		case activity <- struct{}{}:
		default:
		}
	}

	// The relay loop itself: read whatever upstream has ready, write it,
	// flush it, repeat. This is deliberately NOT io.Copy — io.Copy would
	// buffer internally and has no way to distinguish "upstream is slow" from
	// "upstream is dead," and it never flushes on the caller's behalf. Every
	// Read call returns as soon as ANY data is available (never waits to fill
	// buf), so a chunk that arrives is written+flushed to the client
	// immediately, and the bytes themselves are never inspected or
	// re-encoded — this is a byte-level relay, not a frame parser.
	buf := make([]byte, sseCopyBufferSize)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if ferr := rc.Flush(); ferr != nil {
				return
			}
			notifyActivity()
		}
		if readErr != nil {
			if readErr != io.EOF {
				slog.Debug("bff: sse proxy: upstream body read ended", "err", readErr)
			}
			return
		}
	}
}

// watchIdle cancels cancel if idleTimeout elapses with no signal on activity. It
// owns the only timer that ever calls Stop/Reset on itself, which is what makes
// the Stop-then-drain-then-Reset sequence below race-free per time.Timer's
// documented contract (the caller of Reset must be the sole reader of the
// timer's channel). It returns as soon as ctx is done — including when cancel
// itself is what caused that (the idle-fire path) — so the goroutine never
// outlives the request it was started for.
func watchIdle(ctx context.Context, cancel context.CancelFunc, idleTimeout time.Duration, activity <-chan struct{}) {
	timer := time.NewTimer(idleTimeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			cancel()
			return
		case <-activity:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(idleTimeout)
		}
	}
}

// copyResponseHeaders copies every response header from src to dst except the
// hop-by-hop headers in sseHopByHopHeaders — the standard reverse-proxy
// convention: those headers describe the upstream<->proxy hop, not the resource,
// and must never be relayed onto the proxy<->client hop.
func copyResponseHeaders(dst, src http.Header) {
	hop := make(map[string]struct{}, len(sseHopByHopHeaders))
	for _, h := range sseHopByHopHeaders {
		hop[h] = struct{}{}
	}
	for k, vv := range src {
		if _, skip := hop[http.CanonicalHeaderKey(k)]; skip {
			continue
		}
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

// joinURLPath joins a base path and a request path with exactly one slash between
// them, mirroring net/http/httputil's unexported singleJoiningSlash (the same
// join semantics httputil.ReverseProxy's SetURL uses for proxied.go's proxy) so
// this hand-rolled proxy composes upstream URLs the same way. basePath is
// typically empty (upstreamBaseURL carries no path component), in which case this
// degenerates to returning reqPath unchanged.
func joinURLPath(basePath, reqPath string) string {
	if basePath == "" {
		return reqPath
	}
	aSlash := strings.HasSuffix(basePath, "/")
	bSlash := strings.HasPrefix(reqPath, "/")
	switch {
	case aSlash && bSlash:
		return basePath + reqPath[1:]
	case !aSlash && !bSlash:
		return basePath + "/" + reqPath
	}
	return basePath + reqPath
}
