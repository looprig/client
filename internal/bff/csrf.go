package bff

// CSRFGuard defends the control-plane's state-changing routes (input submission,
// gate responses, interrupt, create/restore, and anything else this package mounts
// under a POST/PUT/PATCH/DELETE method) against cross-site request forgery.
// HostOriginGuard (guard.go) already blocks a DNS-rebound host or a foreign Origin
// from reaching these routes at all, but Origin can be absent on some requests a
// browser is willing to send, and defense in depth here is cheap: CSRFGuard adds a
// second, independent check that doesn't rely on either header.
//
// Convention: the BFF mints one token per page load by calling Mint, and is
// expected (a later task's concern — see CSRFHeaderName) to hand that token to the
// SPA once, e.g. via a cookie or a fetch the SPA makes on startup. From then on,
// the SPA must echo the token back on every state-changing request in the
// CSRFHeaderName request header. Wrap enforces this itself: it inspects the
// request method and only demands a valid token for POST, PUT, PATCH, and DELETE —
// GET, HEAD, and everything else pass through untouched. A later task mounting
// this guard therefore doesn't need to reason about which routes are
// state-changing; it can wrap the whole mux.
//
// Storage: minted tokens live in an in-memory map (BFF process state, not
// durable — consistent with HostOriginGuard's process-lifetime posture). Expired
// entries are pruned lazily, on the next Mint or Verify call that touches the map,
// rather than by a background goroutine. This BFF expects at most a handful of
// live tokens at once — realistically one browser tab, occasionally reloaded, plus
// maybe a couple of tabs — so an unbounded ticker/goroutine to sweep a map that
// small would be over-engineering; a scan on the calls that already hold the lock
// is effectively free at this scale and guarantees the map never outgrows "tokens
// minted since the last touch."

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// CSRFHeaderName is the request header the SPA must echo a minted token back in on
// every state-changing request. This is the wire convention CSRFGuard enforces.
const CSRFHeaderName = "X-CSRF-Token"

// DefaultCSRFTokenTTL is the bounded lifetime NewCSRFGuard falls back to when
// called with ttl <= 0. A few hours comfortably outlives a single working
// session in an open browser tab — this is a local control-plane UI, not a
// public site with walk-up users, so there's no pressure to expire aggressively —
// while still bounding how long a leaked or logged token stays exploitable, and
// keeping the in-memory token map's contents naturally bounded to "recent" tokens.
const DefaultCSRFTokenTTL = 4 * time.Hour

// csrfTokenBytes is the amount of crypto/rand entropy per minted token (before
// base64 encoding). 32 bytes (256 bits) is far beyond what's brute-forceable and
// matches the sizing convention used elsewhere for security tokens in this repo.
const csrfTokenBytes = 32

// CSRFGuard mints and verifies per-page-load CSRF tokens for control-plane POSTs
// (and PUT/PATCH/DELETE, if this package ever adds them). See the package-level
// doc comment above for the full threat model, wire convention, and storage
// posture. The zero value is not usable; construct with NewCSRFGuard.
type CSRFGuard struct {
	ttl time.Duration

	mu     sync.Mutex
	tokens map[string]time.Time // token -> mint time
}

// NewCSRFGuard builds a CSRFGuard whose minted tokens are valid for ttl. A
// non-positive ttl falls back to DefaultCSRFTokenTTL.
func NewCSRFGuard(ttl time.Duration) *CSRFGuard {
	if ttl <= 0 {
		ttl = DefaultCSRFTokenTTL
	}
	return &CSRFGuard{
		ttl:    ttl,
		tokens: make(map[string]time.Time),
	}
}

// Mint generates a new token with crypto/rand, records its mint time, and returns
// it. Call this once per page load; the caller is responsible for delivering the
// result to the SPA (see the package doc comment).
func (g *CSRFGuard) Mint() (string, error) {
	buf := make([]byte, csrfTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("bff: mint csrf token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(buf)

	g.mu.Lock()
	defer g.mu.Unlock()
	g.evictExpiredLocked(time.Now())
	g.tokens[token] = time.Now()
	return token, nil
}

// Wrap returns next wrapped so that GET, HEAD, and any other non-state-changing
// method pass straight through untouched, while POST, PUT, PATCH, and DELETE
// require a valid, unexpired token in the CSRFHeaderName header — missing,
// unknown, or expired all answer 403, matching HostOriginGuard's fail-secure,
// reject-fast-before-next convention (see guard.go). A rejected request never
// reaches next.
func (g *CSRFGuard) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isStateChangingMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		token := r.Header.Get(CSRFHeaderName)
		if token == "" || !g.verify(token) {
			// Log the request's method/path for audit purposes only — never the
			// submitted or expected token value, which would leak the secret this
			// guard exists to protect.
			slog.Warn("bff: rejected request: missing or invalid csrf token", "method", r.Method, "path", r.URL.Path)
			http.Error(w, "forbidden: missing or invalid CSRF token", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// verify reports whether token is a live (minted and not yet expired) token. The
// comparison against each stored token uses crypto/subtle.ConstantTimeCompare
// rather than ==, so an attacker who can observe response timing cannot use it to
// learn how many leading bytes of a guess matched a valid token. Expired entries
// encountered along the way are evicted (see the package doc comment's cleanup
// rationale).
func (g *CSRFGuard) verify(token string) bool {
	tokenBytes := []byte(token)

	g.mu.Lock()
	defer g.mu.Unlock()

	now := time.Now()
	valid := false
	for stored, mintedAt := range g.tokens {
		if now.Sub(mintedAt) > g.ttl {
			delete(g.tokens, stored)
			continue
		}
		if subtle.ConstantTimeCompare(tokenBytes, []byte(stored)) == 1 {
			valid = true
		}
	}
	return valid
}

// evictExpiredLocked removes every token whose ttl has elapsed as of now. Callers
// must hold g.mu.
func (g *CSRFGuard) evictExpiredLocked(now time.Time) {
	for stored, mintedAt := range g.tokens {
		if now.Sub(mintedAt) > g.ttl {
			delete(g.tokens, stored)
		}
	}
}

// isStateChangingMethod reports whether method is one CSRFGuard.Wrap protects.
func isStateChangingMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}
