package bff

// CSRFGuard defends the control-plane's state-changing routes (input submission,
// gate responses, interrupt, create/restore, and anything else this package mounts
// under a POST/PUT/PATCH/DELETE method) against cross-site request forgery.
// HostOriginGuard (guard.go) already blocks a DNS-rebound host or a foreign Origin
// from reaching these routes at all, but Origin can be absent on some requests a
// browser is willing to send, and defense in depth here is cheap: CSRFGuard adds a
// second, independent check that doesn't rely on either header.
//
// Convention: the BFF mints one token per page load. TokenHandler (below) is the
// delivery mechanism: NewMuxWithHost (mux.go) registers it at
// GET /api/v1/csrf-token, and the SPA fetches it once, same-origin, caching the
// result in memory (see sdk/core/src/transport.ts's BFFTransport) — never in a
// cookie, which would defeat the whole point of an independent, header-carried
// check. From then on, the SPA must echo the token back on every state-changing
// request in the CSRFHeaderName request header. Wrap enforces this itself: it
// inspects the request method and only demands a valid token for POST, PUT,
// PATCH, and DELETE — GET, HEAD, and everything else pass through untouched
// (which is exactly why TokenHandler's own GET route needs no token to reach it:
// it is not itself state-changing). A later task mounting this guard therefore
// doesn't need to reason about which routes are state-changing; it can wrap the
// whole mux.
//
// Storage: minted tokens live in an in-memory map (BFF process state, not
// durable — consistent with HostOriginGuard's process-lifetime posture), capped
// at maxCSRFTokens live entries with oldest-first eviction (see Mint and
// evictOldestLocked) and pruned of expired entries lazily, inside Mint only (see
// evictExpiredLocked) — verify (the check that runs on every control POST) never
// scans the whole map; see its own doc for why.
//
// Single-process constraint: this store is in-memory and lives on exactly one
// process. It does NOT support multiple replicas behind a load balancer sharing
// session-server duty — a token minted by one replica will never verify against
// another, since they don't share this map. This is an accepted v1 constraint,
// not a bug: this BFF is a single-process local control plane today. If
// multi-replica support is ever needed, the fix is a STATELESS token design
// (nonce + expiry + an HMAC over both, keyed by a secret shared across replicas,
// verified with no shared state at all) rather than this in-memory map — do not
// build that speculatively; just don't silently violate this constraint by, say,
// putting two replicas of this process behind a shared load balancer without
// sticky routing.
//
// Threat model note on comparison timing (see verify's doc): verify checks a
// submitted token via a plain map lookup, not a constant-time comparison.
// This is a deliberate choice, not an oversight: each minted token carries
// 256 bits of crypto/rand entropy, so a timing oracle precise enough to
// matter would still need on the order of 2^128 online queries against a
// local server to exploit — not a real threat this guard needs to design
// around. The token's entropy is the actual security property here, not
// comparison timing.
import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
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

// maxCSRFTokens bounds the number of simultaneously live tokens a single
// CSRFGuard tracks. Once a Mint pushes the count above this, the OLDEST
// still-tracked tokens are evicted first (evictOldestLocked), regardless of
// whether they've expired yet. Reachable now that TokenHandler exists (any
// same-origin request can mint), unlike the earlier "at most one or two
// browser tabs" assumption that held when nothing ever called Mint in
// production — 64 comfortably covers many concurrent tabs/reloads while
// keeping the map's worst-case size fixed regardless of how a client
// misbehaves (repeated minting, a bug that never reuses a cached token, etc).
const maxCSRFTokens = 64

// CSRFGuard mints and verifies per-page-load CSRF tokens for control-plane POSTs
// (and PUT/PATCH/DELETE, if this package ever adds them). See the package-level
// doc comment above for the full threat model, wire convention, and storage
// posture. The zero value is not usable; construct with NewCSRFGuard.
type CSRFGuard struct {
	ttl time.Duration

	mu     sync.Mutex
	tokens map[string]time.Time // token -> mint time
	order  []string             // token mint order, oldest first; see evictOldestLocked/evictExpiredLocked
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
// it. Call this once per page load (TokenHandler below does exactly that over
// HTTP); the caller is responsible for delivering the result to the SPA (see the
// package doc comment). This is the one place lazy full-map maintenance happens:
// expired entries are pruned (evictExpiredLocked) and, if the live count still
// exceeds maxCSRFTokens, the oldest survivors are evicted too
// (evictOldestLocked) — verify (called on every control POST, far more often
// than Mint) does neither and stays a plain O(1) lookup.
func (g *CSRFGuard) Mint() (string, error) {
	buf := make([]byte, csrfTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("bff: mint csrf token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(buf)

	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	g.evictExpiredLocked(now)
	g.tokens[token] = now
	g.order = append(g.order, token)
	g.evictOldestLocked()
	return token, nil
}

// csrfTokenResponse is TokenHandler's JSON body.
type csrfTokenResponse struct {
	CSRFToken string `json:"csrf_token"`
}

// TokenHandler builds the GET /api/v1/csrf-token handler that NewMuxWithHost
// (mux.go) registers. It mints a token via Mint — kept as the single source
// of mint logic so the handler and Verify/verify can never drift apart — and
// writes it as {"csrf_token": "..."}. The response is explicitly
// non-cacheable (Cache-Control: no-store): a CSRF token is a security
// credential, and any cached copy served back to a later, different page
// load would be stale and misleading at best. X-Content-Type-Options: nosniff
// pins the declared JSON content type against MIME sniffing.
//
// This route is deliberately GET (never state-changing), so CSRFGuard.Wrap
// never demands a token to reach it — a client with no token yet must be
// able to fetch its first one.
func (g *CSRFGuard) TokenHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		token, err := g.Mint()
		if err != nil {
			slog.Error("bff: mint csrf token for token endpoint", "err", err)
			writeBFFError(w, http.StatusInternalServerError, "internal", "failed to mint csrf token", true)
			return
		}
		w.Header().Set("Content-Type", contentTypeJSON)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(csrfTokenResponse{CSRFToken: token}); err != nil {
			slog.Error("bff: encode csrf token response", "err", err)
		}
	}
}

// Wrap returns next wrapped so that GET, HEAD, and any other non-state-changing
// method pass straight through untouched, while POST, PUT, PATCH, and DELETE
// require a valid, unexpired token in the CSRFHeaderName header — missing,
// unknown, or expired all answer 403 with codeCSRFInvalid (see errors.go),
// matching HostOriginGuard's fail-secure, reject-fast-before-next convention
// (see guard.go). A rejected request never reaches next. codeCSRFInvalid is
// marked retryable: true — a client that clears its cached token, mints a
// fresh one from TokenHandler, and retries the identical request once is
// following the intended recovery path, not fighting the guard.
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
			writeBFFError(w, http.StatusForbidden, codeCSRFInvalid, "missing or invalid CSRF token", true)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// verify reports whether token is a live (minted and not yet expired) token,
// via a direct O(1) map lookup — not a scan over every stored token. This
// runs on every control POST, so keeping it O(1) matters far more than
// keeping Mint's own bookkeeping O(1) does (Mint runs once per token,
// verify runs once per state-changing request). Lazy full-map eviction
// (expired entries, over-cap entries) happens only inside Mint
// (evictExpiredLocked/evictOldestLocked); verify only ever inspects the one
// entry the submitted token names, never the rest of the map.
//
// The map lookup above is the only equality check this function performs.
// It is not a timing side channel worth defending against here: the real
// security property is the minted token's 256 bits of crypto/rand entropy
// (see the package doc's threat-model note), not comparison timing. A
// future refactor that compares untrusted candidate bytes against a secret
// some other way (not via this map's own hashing) would need its own
// constant-time check at that point — it would not inherit one from here.
func (g *CSRFGuard) verify(token string) bool {
	g.mu.Lock()
	mintedAt, ok := g.tokens[token]
	g.mu.Unlock()

	if !ok {
		return false
	}
	return time.Since(mintedAt) <= g.ttl
}

// evictExpiredLocked removes every token at the FRONT of g.order whose ttl
// has elapsed as of now, stopping at the first still-live entry. This is
// safe and sufficient (not just "good enough"): g.order is always
// mint-time-sorted (Mint only ever appends), and every CSRFGuard uses one
// fixed ttl, so expiry is monotonic in mint order — once one entry is found
// not-yet-expired, every later entry is even fresher and cannot be expired
// either. Callers must hold g.mu.
func (g *CSRFGuard) evictExpiredLocked(now time.Time) {
	i := 0
	for i < len(g.order) {
		token := g.order[i]
		mintedAt, ok := g.tokens[token]
		if !ok {
			// Already removed (e.g. by evictOldestLocked, over the cap) —
			// drop this stale order entry too and keep scanning.
			i++
			continue
		}
		if now.Sub(mintedAt) <= g.ttl {
			break
		}
		delete(g.tokens, token)
		i++
	}
	g.order = g.order[i:]
}

// evictOldestLocked trims g.order/g.tokens down to at most maxCSRFTokens live
// entries, oldest-first — called after Mint has just appended a new token, so
// it only ever needs to remove entries older than the one just minted.
// Callers must hold g.mu.
func (g *CSRFGuard) evictOldestLocked() {
	for len(g.order) > maxCSRFTokens {
		oldest := g.order[0]
		g.order = g.order[1:]
		delete(g.tokens, oldest)
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
