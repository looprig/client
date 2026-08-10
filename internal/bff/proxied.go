package bff

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

// proxiedUpstreamTimeout bounds every outbound request this ReadSource makes to
// the remote serve read plane. It is applied to a context derived from the
// inbound request when that request carries no deadline of its own, so a hung or
// unresponsive upstream can never block a proxied read forever (CLAUDE.md: every
// I/O call is context-bounded with an explicit timeout).
const proxiedUpstreamTimeout = 15 * time.Second

// ProxiedReadSourceOption customizes the TLS configuration NewProxiedReadSource
// builds for its outbound transport. The zero value (no options) trusts only the
// host's standard CA pool, as production wiring should.
type ProxiedReadSourceOption func(*tls.Config)

// WithRootCA adds cert as an ADDITIONAL trusted root certificate for the
// upstream TLS connection, on top of (never instead of) the host's standard CA
// pool. It exists so tests can point the proxy at an httptest.NewTLSServer stub
// and have the real transport trust that stub's self-signed certificate — the
// correct alternative to setting InsecureSkipVerify, which this package never
// does.
//
// The implementation clones the system trust store and adds cert to the clone,
// rather than replacing tls.Config.RootCAs outright: per crypto/tls semantics,
// setting RootCAs to a pool containing only cert would make cert the SOLE
// trusted root, silently dropping every public-CA-signed root the host
// otherwise trusts. x509.CertPool exposes no API to merge two pools, so a
// single extra certificate (rather than an arbitrary caller-supplied pool) is
// the option's unit of composition — it can always be added onto a fresh clone
// of the system pool.
func WithRootCA(cert *x509.Certificate) ProxiedReadSourceOption {
	return func(cfg *tls.Config) {
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		pool.AddCert(cert)
		cfg.RootCAs = pool
	}
}

// proxiedReadSource forwards allowlisted requests to a remote serve read plane via
// an httputil.ReverseProxy. mux IS the allowlist: only the four known read routes
// are registered on it, matched by Go 1.22 method+path pattern (so {sid} varies
// freely as a wildcard segment while every other path or method is refused). A
// disallowed request never reaches proxy — http.ServeMux resolves 404/405 for it
// internally, before any handler (and therefore before any network call) runs.
type proxiedReadSource struct {
	mux *http.ServeMux
}

// ServeHTTP bounds the request's context with proxiedUpstreamTimeout (unless the
// inbound request already carries a tighter deadline) and dispatches through the
// allowlist mux. Bounding here — before the allowlist check — means even a
// refused request never outlives the timeout, and an allowed request can never
// hang the outbound leg past it.
func (p *proxiedReadSource) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, proxiedUpstreamTimeout)
		defer cancel()
		r = r.WithContext(ctx)
	}
	p.mux.ServeHTTP(w, r)
}

// NewProxiedReadSource builds a ReadSource that reverse-proxies harness's
// stateless read routes to a remote serve read plane instead of mounting one
// in-process. This is the cloud/thin-client composition (design doc §"Cloud
// client"): the BFF process links no storage backend at all, and instead holds a
// single server-side bearer token that it injects on every outbound leg —
// whatever Authorization the inbound (browser-originated) request carried is
// discarded, never forwarded.
//
// upstreamBaseURL must be an absolute http(s) URL identifying the remote serve
// read plane (e.g. https://serve.internal:8443); it is validated eagerly so a
// malformed composition-root value fails loudly at construction, not on first
// request. token is the server-held bearer credential sent to upstream and must be
// non-empty — fail secure: a proxy configured with no credential is a broken
// composition, not one that silently proxies unauthenticated.
func NewProxiedReadSource(upstreamBaseURL *url.URL, token string, opts ...ProxiedReadSourceOption) (ReadSource, error) {
	if upstreamBaseURL == nil {
		return nil, fmt.Errorf("bff: proxied read source: upstream base URL is nil")
	}
	if upstreamBaseURL.Scheme != "http" && upstreamBaseURL.Scheme != "https" {
		return nil, fmt.Errorf("bff: proxied read source: upstream base URL %q has unsupported scheme %q (want http or https)", upstreamBaseURL.String(), upstreamBaseURL.Scheme)
	}
	if upstreamBaseURL.Host == "" {
		return nil, fmt.Errorf("bff: proxied read source: upstream base URL %q has no host", upstreamBaseURL.String())
	}
	if token == "" {
		return nil, fmt.Errorf("bff: proxied read source: token must not be empty")
	}

	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	for _, opt := range opts {
		opt(tlsConfig)
	}

	transport := &http.Transport{
		TLSClientConfig:       tlsConfig,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: proxiedUpstreamTimeout,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}

	target := *upstreamBaseURL
	authHeader := "Bearer " + token

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(&target)
			// Server-side token custody: strip whatever Authorization the
			// inbound request carried (a compromised or confused SPA might
			// smuggle one) and set exactly the configured server-side
			// token. Order matters: Del then Set, so no inbound value can
			// survive alongside or instead of ours.
			pr.Out.Header.Del("Authorization")
			pr.Out.Header.Set("Authorization", authHeader)
		},
		Transport: transport,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/capabilities", proxy.ServeHTTP)
	mux.HandleFunc("GET /v1/sessions", proxy.ServeHTTP)
	mux.HandleFunc("GET /v1/sessions/{sid}/status", proxy.ServeHTTP)
	mux.HandleFunc("GET /v1/sessions/{sid}/journal", proxy.ServeHTTP)

	return &proxiedReadSource{mux: mux}, nil
}
