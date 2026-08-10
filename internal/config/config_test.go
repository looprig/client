package config_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/looprig/client/internal/config"
)

// TestLoadSuccess covers valid configurations: happy path, boundary values
// (unset vs. explicitly-empty CLIENT_ADDR), and the domain-specific loopback
// carve-outs for CLIENT_HOST_URL (127.0.0.1, localhost, [::1], and https to a
// non-loopback host).
func TestLoadSuccess(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		env  map[string]string
		want config.Config
	}{
		{
			name: "loopback default when CLIENT_ADDR is unset",
			env: map[string]string{
				"CLIENT_STORE": "fs:/tmp/x",
			},
			want: config.Config{
				Addr:  config.DefaultAddr,
				Store: "fs:/tmp/x",
			},
		},
		{
			name: "CLIENT_ADDR explicitly empty falls back to loopback default",
			env: map[string]string{
				"CLIENT_ADDR":  "",
				"CLIENT_STORE": "fs:/tmp/x",
			},
			want: config.Config{
				Addr:  config.DefaultAddr,
				Store: "fs:/tmp/x",
			},
		},
		{
			name: "explicit CLIENT_ADDR is accepted verbatim",
			env: map[string]string{
				"CLIENT_ADDR":  "0.0.0.0:9090",
				"CLIENT_STORE": "fs:/tmp/x",
			},
			want: config.Config{
				Addr:  "0.0.0.0:9090",
				Store: "fs:/tmp/x",
			},
		},
		{
			name: "store only, no host, is a valid browse-only configuration",
			env: map[string]string{
				"CLIENT_STORE": "nats://cloud",
			},
			want: config.Config{
				Addr:  config.DefaultAddr,
				Store: "nats://cloud",
			},
		},
		{
			name: "host only, no store, with https and token is valid",
			env: map[string]string{
				"CLIENT_HOST_URL":   "https://host.example",
				"CLIENT_HOST_TOKEN": "tok-123",
			},
			want: config.Config{
				Addr:        config.DefaultAddr,
				HostURL:     "https://host.example",
				HostToken:   "tok-123",
				HostEnabled: true,
			},
		},
		{
			name: "store and host both configured with https token is valid",
			env: map[string]string{
				"CLIENT_STORE":      "fs:/tmp/x",
				"CLIENT_HOST_URL":   "https://host.example",
				"CLIENT_HOST_TOKEN": "tok-123",
			},
			want: config.Config{
				Addr:        config.DefaultAddr,
				Store:       "fs:/tmp/x",
				HostURL:     "https://host.example",
				HostToken:   "tok-123",
				HostEnabled: true,
			},
		},
		{
			name: "http is accepted for 127.0.0.1 loopback host",
			env: map[string]string{
				"CLIENT_HOST_URL":   "http://127.0.0.1:9000",
				"CLIENT_HOST_TOKEN": "tok-123",
			},
			want: config.Config{
				Addr:        config.DefaultAddr,
				HostURL:     "http://127.0.0.1:9000",
				HostToken:   "tok-123",
				HostEnabled: true,
			},
		},
		{
			name: "http is accepted for localhost loopback host",
			env: map[string]string{
				"CLIENT_HOST_URL":   "http://localhost:9000",
				"CLIENT_HOST_TOKEN": "tok-123",
			},
			want: config.Config{
				Addr:        config.DefaultAddr,
				HostURL:     "http://localhost:9000",
				HostToken:   "tok-123",
				HostEnabled: true,
			},
		},
		{
			name: "http is accepted for [::1] loopback host",
			env: map[string]string{
				"CLIENT_HOST_URL":   "http://[::1]:9000",
				"CLIENT_HOST_TOKEN": "tok-123",
			},
			want: config.Config{
				Addr:        config.DefaultAddr,
				HostURL:     "http://[::1]:9000",
				HostToken:   "tok-123",
				HostEnabled: true,
			},
		},
		{
			name: "https is accepted for a loopback host too",
			env: map[string]string{
				"CLIENT_HOST_URL":   "https://127.0.0.1:9443",
				"CLIENT_HOST_TOKEN": "tok-123",
			},
			want: config.Config{
				Addr:        config.DefaultAddr,
				HostURL:     "https://127.0.0.1:9443",
				HostToken:   "tok-123",
				HostEnabled: true,
			},
		},
		{
			name: "token present without host url is retained but host stays disabled",
			env: map[string]string{
				"CLIENT_STORE":      "fs:/tmp/x",
				"CLIENT_HOST_TOKEN": "tok-unused",
			},
			want: config.Config{
				Addr:      config.DefaultAddr,
				Store:     "fs:/tmp/x",
				HostToken: "tok-unused",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := config.Load(tt.env)
			if err != nil {
				t.Fatalf("Load() unexpected error = %v", err)
			}
			if got != tt.want {
				t.Errorf("Load() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

// TestLoadRejectsMissingDataSource covers the "nothing to read" rejection:
// CLIENT_STORE and CLIENT_HOST_URL both empty (or both unset) is a
// configuration error, not a valid browse-only mode.
func TestLoadRejectsMissingDataSource(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		env  map[string]string
	}{
		{name: "both unset", env: map[string]string{}},
		{name: "both explicitly empty", env: map[string]string{"CLIENT_STORE": "", "CLIENT_HOST_URL": ""}},
		{name: "addr set but nothing else", env: map[string]string{"CLIENT_ADDR": "127.0.0.1:9000"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := config.Load(tt.env)
			if err == nil {
				t.Fatal("Load() err = nil, want a no-data-source error")
			}
			var noSource *config.NoDataSourceError
			if !errors.As(err, &noSource) {
				t.Fatalf("Load() err = %T, want *config.NoDataSourceError", err)
			}
		})
	}
}

// TestLoadRejectsHostWithoutToken is the illustrative case from the plan: a
// host URL without a token is a fail-loud, typed, errors.As-classifiable error.
func TestLoadRejectsHostWithoutToken(t *testing.T) {
	t.Parallel()
	_, err := config.Load(map[string]string{
		"CLIENT_STORE":    "fs:/tmp/x",
		"CLIENT_HOST_URL": "https://host.example",
	})
	if err == nil {
		t.Fatal("Load() err = nil, want a missing-token error")
	}
	var missing *config.MissingSecretError
	if !errors.As(err, &missing) {
		t.Fatalf("Load() err = %T, want *config.MissingSecretError", err)
	}
}

// TestLoadRejectsInvalidHostScheme covers the non-https / non-loopback
// rejection, plus domain-specific edge cases: an unsupported scheme entirely,
// and a URL with a scheme but no host.
func TestLoadRejectsInvalidHostScheme(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		hostURL string
	}{
		{name: "plain http to a real remote host", hostURL: "http://not-loopback.example"},
		{name: "plain http to a remote host with port", hostURL: "http://not-loopback.example:8080"},
		{name: "unsupported scheme entirely", hostURL: "ftp://host.example"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := config.Load(map[string]string{
				"CLIENT_HOST_URL":   tt.hostURL,
				"CLIENT_HOST_TOKEN": "tok-123",
			})
			if err == nil {
				t.Fatal("Load() err = nil, want an invalid-scheme error")
			}
			var invalid *config.InvalidHostSchemeError
			if !errors.As(err, &invalid) {
				t.Fatalf("Load() err = %T, want *config.InvalidHostSchemeError", err)
			}
		})
	}
}

// TestLoadRejectsMalformedHostURL covers URLs that fail to parse at all, and
// URLs that parse but have a scheme with no host.
func TestLoadRejectsMalformedHostURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		hostURL string
	}{
		{name: "unparseable url", hostURL: "://missing-scheme"},
		{name: "control character in url", hostURL: "https://host.example/\x7f"},
		{name: "scheme with no host", hostURL: "https://"},
		{name: "no scheme and no host", hostURL: "not-loopback.example"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := config.Load(map[string]string{
				"CLIENT_HOST_URL":   tt.hostURL,
				"CLIENT_HOST_TOKEN": "tok-123",
			})
			if err == nil {
				t.Fatal("Load() err = nil, want an invalid-host-url error")
			}
			var invalid *config.InvalidHostURLError
			if !errors.As(err, &invalid) {
				t.Fatalf("Load() err = %T, want *config.InvalidHostURLError", err)
			}
		})
	}
}

// TestLoadErrorNeverContainsSecret is the highest-priority requirement: no
// failure path, enumerated or not, may leak CLIENT_HOST_TOKEN's value into the
// error text. This covers the illustrative scheme-rejection case plus every
// other rejection path that has a token in scope when it fires (malformed URL
// alongside a token, unsupported scheme alongside a token, a URL with no host
// alongside a token).
func TestLoadErrorNeverContainsSecret(t *testing.T) {
	t.Parallel()

	const secret = "super-secret-token-value"

	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "scheme rejection (illustrative case from the plan)",
			env: map[string]string{
				"CLIENT_HOST_URL":   "http://not-loopback.example",
				"CLIENT_HOST_TOKEN": secret,
			},
		},
		{
			name: "malformed host url alongside a token",
			env: map[string]string{
				"CLIENT_HOST_URL":   "://missing-scheme",
				"CLIENT_HOST_TOKEN": secret,
			},
		},
		{
			name: "unsupported scheme alongside a token",
			env: map[string]string{
				"CLIENT_HOST_URL":   "ftp://host.example",
				"CLIENT_HOST_TOKEN": secret,
			},
		},
		{
			name: "scheme with no host alongside a token",
			env: map[string]string{
				"CLIENT_HOST_URL":   "https://",
				"CLIENT_HOST_TOKEN": secret,
			},
		},
		{
			name: "no scheme at all alongside a token",
			env: map[string]string{
				"CLIENT_HOST_URL":   "not-loopback.example",
				"CLIENT_HOST_TOKEN": secret,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := config.Load(tt.env)
			if err == nil {
				t.Fatal("Load() err = nil, want a validation error")
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatalf("Load() error text leaked the token: %q", err.Error())
			}
		})
	}
}

// TestConfigRedaction proves that Config never prints its HostToken verbatim
// through any of Go's default formatting verbs, guarding against an accidental
// log line like slog.Info("config loaded", "config", cfg) or
// log.Printf("%+v", cfg) leaking the bearer token.
func TestConfigRedaction(t *testing.T) {
	t.Parallel()

	const secret = "super-secret-token-value"
	cfg := config.Config{
		Addr:        "127.0.0.1:8080",
		Store:       "fs:/tmp/x",
		HostURL:     "https://host.example",
		HostToken:   secret,
		HostEnabled: true,
	}

	formats := []string{"%v", "%+v", "%#v", "%s"}
	for _, f := range formats {
		t.Run(f, func(t *testing.T) {
			t.Parallel()
			out := fmt.Sprintf(f, cfg)
			if strings.Contains(out, secret) {
				t.Fatalf("Sprintf(%q, cfg) leaked the token: %q", f, out)
			}
			// Sanity: the redaction shouldn't just blank the whole struct — other
			// fields, and evidence a token IS present, should still show up so this
			// isn't accidentally silently dropping useful debug information.
			if !strings.Contains(out, "host.example") {
				t.Errorf("Sprintf(%q, cfg) = %q, want it to still mention the non-secret HostURL", f, out)
			}
		})
	}

	// A zero-value (empty) token must not be confused with a redacted one.
	empty := config.Config{Addr: "127.0.0.1:8080", Store: "fs:/tmp/x"}
	out := fmt.Sprintf("%+v", empty)
	if strings.Contains(strings.ToLower(out), "redacted") {
		t.Errorf("Sprintf(%%+v, cfg) with empty token = %q, should not claim redaction of an empty secret", out)
	}
}
