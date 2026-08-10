package bff

// control.go is the BFF's control-plane reverse proxy: it forwards the five
// state-changing session routes to a remote serve control host —
//
//	POST /v1/sessions                       (create)
//	POST /v1/sessions/{sid}/restore         (restore)
//	POST /v1/sessions/{sid}/input           (submit input)
//	POST /v1/sessions/{sid}/gates/{gid}     (respond to a gate)
//	POST /v1/sessions/{sid}/interrupt       (interrupt)
//
// — following the SAME security posture as proxied.go's read-plane proxy:
// allowlist-of-five (mux IS the allowlist, exactly as proxiedReadSource's is),
// server-side token injection via setOutboundAuthorization (tokencustody.go),
// inbound Authorization stripped, TLS MinVersion 1.2, never InsecureSkipVerify,
// context-bounded outbound requests. It is built the same way proxied.go's
// proxy is (httputil.ReverseProxy, short request/response pairs) rather than
// events.go's hand-rolled relay, because these are ordinary bounded POSTs, not a
// long-lived stream.
//
// Idempotency-Key (verified against harness's pkg/serve/handlers_lifecycle.go and
// idempotency.go, NOT assumed): only handleCreate ever reads the
// "Idempotency-Key" header — it hashes the body and consults the per-pod
// idempotencyStore before deciding whether to mint a new session or replay a
// cached 201. handleRestore, handleInput, handleGateResponse, and
// handleInterrupt never reference the header at all; forwarding it to any of
// them would be a silent no-op at best and misleading at worst (it would imply
// those routes are idempotent when upstream provides no such guarantee). This
// proxy therefore forwards Idempotency-Key on create ONLY — a deliberate
// narrowing from an earlier draft of this task's plan, which assumed both create
// and restore needed it; the header is unconditionally stripped (never
// forwarded, even if present) on the other four routes, and a dedicated test
// proves both halves of that.
//
// Request body handling: httputil.ReverseProxy streams the body to upstream
// (it never buffers a full request into memory), and harness's own
// bodyCapMiddleware already caps every request at defaultMaxBodyBytes (1MiB,
// pkg/serve/options.go) before any handler reads it. Re-capping at the BFF is
// still warranted, not redundant: without it, a malicious or broken client could
// push an arbitrarily large body through this process's outbound connection
// before upstream ever gets a chance to reject it, spending this process's and
// the network's resources on bytes that were always going to be refused. This
// proxy therefore applies the identical bound (controlDefaultMaxBodyBytes,
// mirroring harness's own defaultMaxBodyBytes value, not an arbitrary
// re-invented number) via http.MaxBytesReader on the inbound body, so an
// oversized request fails fast at the BFF's own edge with 413, before the first
// byte reaches upstream.
//
// Audit logging: every dispatched control action (never its body — gate
// responses and input blocks are the design doc's "PII-ish" content) is logged
// at Info level with the route name, method, and any {sid}/{gid} path values.
// This is IN SCOPE for this task, not deferred: unlike the read-plane and events
// proxies (which only ever observe history), every route here mutates
// server-side state — creating a session, answering a human gate, interrupting a
// running turn — so CLAUDE.md's "log security events... audit... unexpected
// inputs" is best served by a durable "who did what to which session, when"
// trail distinct from (and never a substitute for) session content logging.
// Upstream failures (transport errors, oversized bodies) are logged separately
// at Warn/Error via controlErrorHandler.

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

// controlUpstreamTimeout bounds every outbound request this proxy makes to the
// remote control host, applied the same way proxiedUpstreamTimeout is: only when
// the inbound request carries no deadline of its own (CLAUDE.md: every I/O call
// is context-bounded with an explicit timeout).
const controlUpstreamTimeout = 15 * time.Second

// controlDefaultMaxBodyBytes mirrors harness's pkg/serve defaultMaxBodyBytes
// (unexported there, so duplicated here as a value rather than imported — the
// same convention events.go uses for contentTypeSSE). Re-stating the SAME bound
// upstream already enforces, not a stricter or looser one invented for this
// proxy, so a client that would be accepted by upstream is never rejected here,
// and a client upstream would reject is rejected at this edge instead.
const controlDefaultMaxBodyBytes int64 = 1 << 20

// headerIdempotencyKey mirrors harness's pkg/serve headerIdempotencyKey
// (unexported there). See this file's package doc for exactly which route
// forwards it.
const headerIdempotencyKey = "Idempotency-Key"

// controlRouteCreate etc. are stable route names used only for logging (audit
// trail and error messages) — never parsed, never part of the wire contract.
const (
	controlRouteCreate    = "create"
	controlRouteRestore   = "restore"
	controlRouteInput     = "input"
	controlRouteGate      = "gate"
	controlRouteInterrupt = "interrupt"
)

// controlProxyConfig is NewControlProxy's construction-time state, built from
// defaults and then mutated by ControlProxyOption values.
type controlProxyConfig struct {
	tlsConfig    *tls.Config
	maxBodyBytes int64
}

// ControlProxyOption customizes NewControlProxy's construction. The zero value
// (no options) trusts only the host's standard CA pool and caps request bodies
// at controlDefaultMaxBodyBytes.
type ControlProxyOption func(*controlProxyConfig)

// WithControlRootCA adds cert as an ADDITIONAL trusted root certificate for the
// upstream TLS connection, on top of (never instead of) the host's standard CA
// pool — the same additive-trust pattern as proxied.go's WithRootCA and events.go's
// WithSSERootCA, for the same reason: it lets tests point this proxy at an
// httptest.NewTLSServer stub without ever setting InsecureSkipVerify.
func WithControlRootCA(cert *x509.Certificate) ControlProxyOption {
	return func(cfg *controlProxyConfig) {
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		pool.AddCert(cert)
		cfg.tlsConfig.RootCAs = pool
	}
}

// WithControlMaxBodyBytes overrides controlDefaultMaxBodyBytes. n <= 0 is
// ignored (keeps whatever the config already has), so a zero-valued option
// application can never disable the cap outright — fail-safe, matching
// WithIdleTimeout's convention in events.go.
func WithControlMaxBodyBytes(n int64) ControlProxyOption {
	return func(cfg *controlProxyConfig) {
		if n > 0 {
			cfg.maxBodyBytes = n
		}
	}
}

// ControlProxy forwards the five allowlisted control routes (see package doc) to
// a remote serve control host. mux IS the allowlist, exactly as
// proxiedReadSource's is in proxied.go: only these five method+path patterns are
// registered, so any other method or path is refused by http.ServeMux itself,
// before any handler (and therefore any network call) runs.
type ControlProxy struct {
	mux          *http.ServeMux
	maxBodyBytes int64
}

// ServeHTTP bounds the request's context with controlUpstreamTimeout (unless the
// inbound request already carries a tighter deadline, mirroring
// proxiedReadSource.ServeHTTP), caps the inbound body at maxBodyBytes via
// http.MaxBytesReader (see package doc's body-handling section), and dispatches
// through the allowlist mux.
func (p *ControlProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, controlUpstreamTimeout)
		defer cancel()
		r = r.WithContext(ctx)
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, p.maxBodyBytes)
	}
	p.mux.ServeHTTP(w, r)
}

// RegisterRoutes wires all five control routes onto mux via
// BFFMux.RegisterControlRoute — the ONLY sanctioned way to add a state-changing
// route (mux.go) — so every route p serves is CSRF-protected. It strips the
// "/api" prefix before dispatch (the same convention NewMux itself uses for the
// read plane's "/api/" catch-all: http.StripPrefix("/api", read)), so p's own
// allowlist mux (built in NewControlProxy) matches on harness's own unprefixed
// route shapes ("/v1/sessions", ...) exactly like proxiedReadSource's does,
// keeping p directly testable with the same request shapes proxied_test.go and
// events_test.go already use.
func (p *ControlProxy) RegisterRoutes(mux *BFFMux) {
	stripped := http.StripPrefix("/api", p)
	mux.RegisterControlRoute("POST /api/v1/sessions", stripped)
	mux.RegisterControlRoute("POST /api/v1/sessions/{sid}/restore", stripped)
	mux.RegisterControlRoute("POST /api/v1/sessions/{sid}/input", stripped)
	mux.RegisterControlRoute("POST /api/v1/sessions/{sid}/gates/{gid}", stripped)
	mux.RegisterControlRoute("POST /api/v1/sessions/{sid}/interrupt", stripped)
}

// NewControlProxy builds an http.Handler (*ControlProxy) that reverse-proxies
// harness's five control routes to a remote serve control host. See the package
// doc for the full security posture, the Idempotency-Key routing decision, and
// the body-cap and audit-logging reasoning.
//
// upstreamBaseURL and token are validated exactly as NewProxiedReadSource and
// NewSSEProxy validate them: a nil or malformed URL, or an empty token, is a
// broken composition that must fail loudly at construction, never silently
// proxy unauthenticated on first request.
func NewControlProxy(upstreamBaseURL *url.URL, token string, opts ...ControlProxyOption) (*ControlProxy, error) {
	if upstreamBaseURL == nil {
		return nil, fmt.Errorf("bff: control proxy: upstream base URL is nil")
	}
	if upstreamBaseURL.Scheme != "http" && upstreamBaseURL.Scheme != "https" {
		return nil, fmt.Errorf("bff: control proxy: upstream base URL %q has unsupported scheme %q (want http or https)", upstreamBaseURL.String(), upstreamBaseURL.Scheme)
	}
	if upstreamBaseURL.Host == "" {
		return nil, fmt.Errorf("bff: control proxy: upstream base URL %q has no host", upstreamBaseURL.String())
	}
	if token == "" {
		return nil, fmt.Errorf("bff: control proxy: token must not be empty")
	}

	cfg := &controlProxyConfig{
		tlsConfig:    &tls.Config{MinVersion: tls.VersionTLS12},
		maxBodyBytes: controlDefaultMaxBodyBytes,
	}
	for _, opt := range opts {
		opt(cfg)
	}

	transport := &http.Transport{
		TLSClientConfig:       cfg.tlsConfig,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: controlUpstreamTimeout,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}

	target := *upstreamBaseURL

	// newRouteProxy builds one *httputil.ReverseProxy per route so each route's
	// Idempotency-Key behavior is a structural property of which proxy instance
	// handles it (forwardIdempotencyKey), not a runtime string comparison that
	// could be mismatched — see the package doc's Idempotency-Key section.
	newRouteProxy := func(route string, forwardIdempotencyKey bool) *httputil.ReverseProxy {
		return &httputil.ReverseProxy{
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.SetURL(&target)
				// Server-side token custody: see setOutboundAuthorization
				// (tokencustody.go).
				setOutboundAuthorization(pr.Out.Header, token)

				if forwardIdempotencyKey {
					if key := pr.In.Header.Get(headerIdempotencyKey); key != "" {
						pr.Out.Header.Set(headerIdempotencyKey, key)
					}
				} else {
					// Fail-safe: explicitly strip rather than merely "not
					// copy," so a future refactor that starts cloning
					// inbound headers wholesale cannot silently start
					// leaking this one through on a route upstream never
					// consults it on.
					pr.Out.Header.Del(headerIdempotencyKey)
				}

				auditControlAction(route, pr.In)
			},
			Transport:    transport,
			ErrorHandler: controlErrorHandler(route),
		}
	}

	createProxy := newRouteProxy(controlRouteCreate, true)
	restoreProxy := newRouteProxy(controlRouteRestore, false)
	inputProxy := newRouteProxy(controlRouteInput, false)
	gateProxy := newRouteProxy(controlRouteGate, false)
	interruptProxy := newRouteProxy(controlRouteInterrupt, false)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sessions", createProxy.ServeHTTP)
	mux.HandleFunc("POST /v1/sessions/{sid}/restore", restoreProxy.ServeHTTP)
	mux.HandleFunc("POST /v1/sessions/{sid}/input", inputProxy.ServeHTTP)
	mux.HandleFunc("POST /v1/sessions/{sid}/gates/{gid}", gateProxy.ServeHTTP)
	mux.HandleFunc("POST /v1/sessions/{sid}/interrupt", interruptProxy.ServeHTTP)

	return &ControlProxy{mux: mux, maxBodyBytes: cfg.maxBodyBytes}, nil
}

// auditControlAction logs, at Info level, that route was dispatched to upstream
// for r — method plus any {sid}/{gid} path values r's own matching mux resolved.
// It NEVER logs the request body (input blocks, gate response values): the design
// doc calls that content "PII-ish," and this is an operational audit trail (who
// did what to which session, when), not a content log.
func auditControlAction(route string, r *http.Request) {
	fields := []any{"route", route, "method", r.Method}
	if sid := r.PathValue("sid"); sid != "" {
		fields = append(fields, "sid", sid)
	}
	if gid := r.PathValue("gid"); gid != "" {
		fields = append(fields, "gid", gid)
	}
	slog.Info("bff: control proxy: dispatching control action", fields...)
}

// controlErrorHandler builds a *httputil.ReverseProxy ErrorHandler for route. A
// body that exceeded maxBodyBytes surfaces here as a read error on pr.Out's body
// (http.MaxBytesReader's error, wrapped in *http.MaxBytesError since Go 1.19) and
// is mapped to 413, distinct from every other transport-level failure (upstream
// unreachable, timeout, TLS failure, ...), which is mapped to the generic 502 the
// other proxies in this package also use for an unreachable/failed upstream.
// Neither branch echoes err's text to the client; it is logged (audit trail) but
// never written to the response body.
func controlErrorHandler(route string) func(http.ResponseWriter, *http.Request, error) {
	return func(w http.ResponseWriter, r *http.Request, err error) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			slog.Warn("bff: control proxy: request body too large", "route", route, "method", r.Method)
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		slog.Error("bff: control proxy: upstream request failed", "route", route, "method", r.Method, "err", err)
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}
}
