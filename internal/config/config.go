// Package config is the client BFF's typed, fail-loud configuration. It is
// read once at the composition root (cmd/) via Load, which takes an already-
// materialized map rather than reading the environment itself, so the env
// read stays at the composition root and this package's validation logic
// stays parallel-safe to test.
package config

import (
	"fmt"
	"net"
	"net/url"
)

// DefaultAddr is the loopback bind address used when CLIENT_ADDR is unset (or
// set to the empty string). Binding loopback by default is fail-secure: a
// public bind is opt-in, never accidental.
const DefaultAddr = "127.0.0.1:8080"

// Config is the client BFF's validated configuration. It is only ever
// produced by Load, which enforces every invariant described below — there
// is no exported constructor that bypasses validation.
//
// HostToken is a secret. Config intentionally implements String and GoString
// to redact it, because Go's default struct formatting (%v, %+v, %#v — the
// shapes a stray slog.Info("config", cfg) or log.Printf("%+v", cfg) would
// use) would otherwise print it verbatim into logs.
type Config struct {
	// Addr is the address the BFF's HTTP listener binds. Defaults to
	// DefaultAddr (loopback) when CLIENT_ADDR is unset or empty.
	Addr string

	// Store is the mounted-read storage backend target (e.g. "fs:/path" or
	// "nats://..."). May be empty if HostEnabled is true — a proxied host and
	// a mounted store are independent read sources, and at least one must be
	// present.
	Store string

	// HostURL is the proxied host's base URL. Empty means no host is
	// configured. When non-empty it has already been validated: it parses,
	// has a scheme and a host, and is either https or http-to-loopback.
	HostURL string

	// HostToken is the bearer token sent to HostURL. It is a secret: never
	// log it, never include it in an error message. Required whenever
	// HostURL is set; may be present even when HostURL is empty (Load does
	// not discard data the caller provided), in which case it is simply
	// unused.
	HostToken string

	// HostEnabled reports whether a proxied host is configured, i.e. whether
	// HostURL is non-empty. Derived, not independently settable.
	HostEnabled bool
}

// String implements fmt.Stringer, redacting HostToken. Covers %v, %s, and (via
// the same method, since Config defines no separate GoString) the %+v verb.
func (c Config) String() string {
	return fmt.Sprintf("config.Config{Addr:%q, Store:%q, HostURL:%q, HostToken:%s, HostEnabled:%t}",
		c.Addr, c.Store, c.HostURL, redactedToken(c.HostToken), c.HostEnabled)
}

// GoString implements fmt.GoStringer, redacting HostToken under the %#v verb.
// Without this, %#v bypasses String and prints every field verbatim,
// including the raw token.
func (c Config) GoString() string {
	return c.String()
}

// redactedToken renders a secret token for display: quoted-empty if absent,
// a fixed marker if present. It never echoes the value itself.
func redactedToken(token string) string {
	if token == "" {
		return `""`
	}
	return `"<redacted>"`
}

// MissingSecretError reports that a secret environment variable required by
// the current configuration was not set. Var names the missing variable;
// Reason explains why it's required in this configuration. Never carries the
// secret value itself, because there isn't one to carry — the variable is
// missing.
type MissingSecretError struct {
	Var    string
	Reason string
}

func (e *MissingSecretError) Error() string {
	return fmt.Sprintf("config: %s is required: %s", e.Var, e.Reason)
}

// InvalidHostSchemeError reports that CLIENT_HOST_URL's scheme is not
// allowed: either it is not http or https at all, or it is http to a
// non-loopback host (which would send HostToken over the wire in cleartext).
// Scheme and Host are the parsed URL components, not the token, so including
// them in the error text is safe.
type InvalidHostSchemeError struct {
	Scheme string
	Host   string
}

func (e *InvalidHostSchemeError) Error() string {
	return fmt.Sprintf("config: CLIENT_HOST_URL scheme %q is not allowed for host %q: use https, or http only for loopback (127.0.0.1, localhost, [::1])",
		e.Scheme, e.Host)
}

// InvalidHostURLError reports that CLIENT_HOST_URL failed to parse as a URL,
// or parsed but is missing a scheme or host. Value is the raw CLIENT_HOST_URL
// string (never the token, which is a separate variable), so including it in
// the error text is safe.
type InvalidHostURLError struct {
	Value string
	Err   error
}

func (e *InvalidHostURLError) Error() string {
	return fmt.Sprintf("config: CLIENT_HOST_URL %q is invalid: %v", e.Value, e.Err)
}

func (e *InvalidHostURLError) Unwrap() error {
	return e.Err
}

// NoDataSourceError reports that neither CLIENT_STORE nor CLIENT_HOST_URL is
// set. Neither a mounted store nor a proxied host means there is nothing to
// read, so this is a configuration error rather than a valid browse-only
// mode.
type NoDataSourceError struct{}

func (e *NoDataSourceError) Error() string {
	return "config: at least one of CLIENT_STORE or CLIENT_HOST_URL must be set"
}

// Load builds a validated Config from env, which the caller (cmd/) populates
// from the process environment. Load never reads os.Getenv itself, so tests
// can run in parallel against distinct maps without racing on shared process
// state.
//
// Validation order:
//  1. At least one of CLIENT_STORE / CLIENT_HOST_URL must be set.
//  2. If CLIENT_HOST_URL is set, it must parse, have a scheme and host, and
//     be https (any host) or http (loopback host only).
//  3. If CLIENT_HOST_URL is set, CLIENT_HOST_TOKEN must be set.
//
// No returned error, on any path, ever includes the value of
// CLIENT_HOST_TOKEN.
func Load(env map[string]string) (Config, error) {
	addr := env["CLIENT_ADDR"]
	if addr == "" {
		addr = DefaultAddr
	}

	store := env["CLIENT_STORE"]
	hostURL := env["CLIENT_HOST_URL"]
	hostToken := env["CLIENT_HOST_TOKEN"]

	if store == "" && hostURL == "" {
		return Config{}, &NoDataSourceError{}
	}

	hostEnabled := hostURL != ""
	if hostEnabled {
		if err := validateHostURL(hostURL); err != nil {
			return Config{}, err
		}
		if hostToken == "" {
			return Config{}, &MissingSecretError{
				Var:    "CLIENT_HOST_TOKEN",
				Reason: "required when CLIENT_HOST_URL is set",
			}
		}
	}

	return Config{
		Addr:        addr,
		Store:       store,
		HostURL:     hostURL,
		HostToken:   hostToken,
		HostEnabled: hostEnabled,
	}, nil
}

// validateHostURL enforces that raw parses as a URL with a scheme and host,
// and that the scheme is https, or http restricted to a loopback host (since
// http would otherwise send the bearer token over the wire in cleartext).
func validateHostURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return &InvalidHostURLError{Value: raw, Err: err}
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return &InvalidHostURLError{Value: raw, Err: fmt.Errorf("missing scheme or host")}
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return &InvalidHostSchemeError{Scheme: parsed.Scheme, Host: parsed.Host}
	}
	if parsed.Scheme == "http" && !isLoopbackHost(parsed.Hostname()) {
		return &InvalidHostSchemeError{Scheme: parsed.Scheme, Host: parsed.Host}
	}
	return nil
}

// isLoopbackHost reports whether host is provably loopback: the literal
// "localhost", or an IP in 127.0.0.0/8 or ::1. Mirrors
// harness/pkg/serve's isLoopbackHost (reimplemented rather than imported, to
// keep this decision local and because the two consumers need not evolve in
// lockstep). Fail-secure: anything that doesn't parse as a loopback IP and
// isn't the "localhost" literal is treated as non-loopback.
func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	if host == "" {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback()
}
