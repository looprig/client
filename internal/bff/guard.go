package bff

// HostOriginGuard defends against DNS rebinding. Loopback binding alone does not
// stop it: a malicious web page can get a victim's browser to resolve an
// attacker-controlled DNS name to 127.0.0.1, then have client-side JS make a
// same-origin-shaped fetch() to that name. No CORS preflight fires for a "simple"
// request, and the browser's same-origin policy doesn't help either — the
// attacker's page and the rebound name share nothing the browser checks. The BFF
// binds loopback by default and holds a bearer token server-side, so without this
// guard a malicious page could drive a rebound connection straight to it.
//
// The guard checks what DNS rebinding cannot forge: the Host header the server
// actually received (net/http populates r.Host from the request line/Host header,
// never from anything the browser's origin-based sandboxing controls) and, when
// present, the Origin header. Both must name one of a small set of allowed hosts.

import (
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// defaultAllowedHosts are the loopback host forms every HostOriginGuard accepts
// regardless of caller configuration: IPv4 loopback, the "localhost" name, and
// IPv6 loopback (its hostname form, after a bracketed literal's brackets and any
// port have been stripped by splitHost or net/url's Hostname).
var defaultAllowedHosts = []string{"127.0.0.1", "localhost", "::1"}

// HostOriginGuard is standard net/http middleware — see NewHostOriginGuard — that
// rejects any request whose Host header, or whose Origin header when present,
// does not name one of its allowed hosts.
type HostOriginGuard struct {
	allowedHosts map[string]bool
}

// NewHostOriginGuard builds a HostOriginGuard accepting the three loopback host
// forms — 127.0.0.1, localhost, [::1] — on any port (or no port at all), plus any
// hosts listed in extraAllowedHosts. extraAllowedHosts is additive, never a
// replacement: it exists for the "public bind is opt-in" case, where a
// composition root deliberately widens the allowlist to a specific additional
// hostname. Calling it with no arguments — the common case — is loopback-only.
func NewHostOriginGuard(extraAllowedHosts ...string) *HostOriginGuard {
	allowed := make(map[string]bool, len(defaultAllowedHosts)+len(extraAllowedHosts))
	for _, h := range defaultAllowedHosts {
		allowed[h] = true
	}
	// extraAllowedHosts is caller-supplied and may arrive in any case; the
	// allowlist itself is canonically lowercase (hostAllowed and originAllowed
	// both lowercase the incoming value before lookup), so store it lowercase
	// here too rather than requiring every caller to know that convention.
	for _, h := range extraAllowedHosts {
		allowed[strings.ToLower(h)] = true
	}
	return &HostOriginGuard{allowedHosts: allowed}
}

// Wrap returns next wrapped so the guard runs FIRST — reject-fast at the edge,
// before any auth or business logic in next ever sees the request. A rejected
// request never reaches next at all: fail secure means an unparseable Host or
// Origin is a rejection, not a pass-through, and every rejection answers 403 (the
// route exists; the request's origin doesn't).
func (g *HostOriginGuard) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !g.hostAllowed(r.Host) {
			slog.Warn("bff: rejected request: host not allowed", "host", r.Host)
			http.Error(w, "forbidden: host not allowed", http.StatusForbidden)
			return
		}
		// A request with NO Origin header at all passes this check — many
		// legitimate non-browser or simple-GET requests carry no Origin.
		// Only a request that HAS an Origin pointing somewhere else is
		// rejected.
		if origin := r.Header.Get("Origin"); origin != "" && !g.originAllowed(origin) {
			slog.Warn("bff: rejected request: origin not allowed", "host", r.Host, "origin", origin)
			http.Error(w, "forbidden: origin not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// hostAllowed reports whether hostHeader (r.Host) names one of g's allowed
// hosts, on any port. An empty or unparseable Host fails secure: false.
// Hostnames are compared case-insensitively (RFC 3986/952): the extracted host
// is lowercased before the allowlist lookup, which is itself keyed in
// lowercase (see defaultAllowedHosts and NewHostOriginGuard).
func (g *HostOriginGuard) hostAllowed(hostHeader string) bool {
	host, ok := splitHost(hostHeader)
	if !ok || host == "" {
		return false
	}
	return g.allowedHosts[strings.ToLower(host)]
}

// originAllowed reports whether origin (an Origin header value) names one of g's
// allowed hosts, ignoring scheme and port — only the hostname component is
// compared, symmetric with hostAllowed's "any port" and case-insensitive
// treatment of the Host header. An unparseable Origin, or one with no host at
// all (e.g. the literal string "null" browsers send for some
// sandboxed/cross-origin contexts), fails secure: false. An Origin carrying
// userinfo (e.g.
// "http://evil.example@127.0.0.1/") is also rejected: real browsers never
// construct an Origin header with a userinfo component, so this isn't
// exploitable under the actual threat model, but url.URL.Hostname() ignores
// userinfo entirely, so without this check such an Origin would otherwise be
// compared and accepted on the userinfo's *host* portion alone — a cheap,
// fail-secure tightening against a spoofed-looking value that has no
// legitimate reason to appear here.
func (g *HostOriginGuard) originAllowed(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.User != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return false
	}
	return g.allowedHosts[host]
}

// splitHost extracts the hostname portion of an HTTP Host header, tolerating
// both shapes the header can legally take: "host:port" (net.SplitHostPort
// handles this natively, including bracketed IPv6 literals like "[::1]:7777")
// and a bare host with no port at all, which Go's Host header permits but
// net.SplitHostPort itself rejects with a "missing port in address" error. In
// that no-port case, any other SplitHostPort error means the header is
// malformed in some other way, and the caller must fail secure rather than
// guess at a hostname.
func splitHost(hostHeader string) (string, bool) {
	host, _, err := net.SplitHostPort(hostHeader)
	if err == nil {
		return host, true
	}
	if !strings.Contains(err.Error(), "missing port") {
		return "", false
	}
	if strings.HasPrefix(hostHeader, "[") && strings.HasSuffix(hostHeader, "]") {
		return hostHeader[1 : len(hostHeader)-1], true
	}
	return hostHeader, true
}
