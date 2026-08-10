package compose_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/looprig/client/internal/compose"
	"github.com/looprig/client/internal/config"
	"github.com/looprig/storage"
	"github.com/looprig/storage/memstore"
)

// fakeBackend records whether it was opened/closed, so tests can assert the
// mounted path was (or was not) taken without touching a real fsstore or
// natsstore instance.
type fakeBackend struct {
	opened    bool
	openSpec  string
	closed    bool
	openErr   error
	closeErr  error
	composite *storage.Composite
}

func newFakeBackend() *fakeBackend {
	return &fakeBackend{composite: memstore.New()}
}

func (f *fakeBackend) opener() compose.BackendOpener {
	return func(_ context.Context, storeSpec string) (*storage.Composite, func(context.Context) error, error) {
		f.opened = true
		f.openSpec = storeSpec
		if f.openErr != nil {
			return nil, nil, f.openErr
		}
		return f.composite, func(context.Context) error {
			f.closed = true
			return f.closeErr
		}, nil
	}
}

// TestBuild_MountedBrowseOnly covers the first of the three combinations
// reachable through config.Load: Store set, HostURL unset -> mounted read,
// browse-only mux (no control host wired at all).
func TestBuild_MountedBrowseOnly(t *testing.T) {
	t.Parallel()

	cfg := config.Config{Addr: config.DefaultAddr, Store: "fs:/tmp/x"}
	backend := newFakeBackend()

	mux, closeFn, err := compose.Build(context.Background(), cfg, backend.opener())
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if mux == nil {
		t.Fatal("Build() returned nil mux")
	}
	if closeFn == nil {
		t.Fatal("Build() returned nil closeFn")
	}
	if !backend.opened {
		t.Error("expected the BackendOpener to be called for a mounted read source")
	}
	if backend.openSpec != cfg.Store {
		t.Errorf("BackendOpener called with spec %q, want %q", backend.openSpec, cfg.Store)
	}

	// Browse-only: a control-shaped route is never registered, so a POST
	// falls through to the mounted read source's own mux, which answers
	// 404/405 on its own terms (no matching path, or a path that exists for
	// GET only) — but NEVER 403, the "route exists but was rejected" signal
	// a registered-but-CSRF-guarded control route would produce. Same
	// convention internal/bff's own tests use.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/v1/sessions", nil)
	req.Host = "127.0.0.1" // must pass HostOriginGuard first to reach routing
	mux.ServeHTTP(rec, req)
	if rec.Code == 403 {
		t.Errorf("POST /api/v1/sessions on a browse-only mux = 403, want 404 or 405 (no control route registered)")
	}

	if err := closeFn(context.Background()); err != nil {
		t.Fatalf("closeFn() error = %v", err)
	}
	if !backend.closed {
		t.Error("expected closeFn to close the backend")
	}
}

// TestBuild_MountedHostEnabled covers the second reachable combination:
// Store AND HostURL both set -> mounted read, full host-enabled mux (control
// + events proxied to HostURL).
func TestBuild_MountedHostEnabled(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		Addr:        config.DefaultAddr,
		Store:       "fs:/tmp/x",
		HostURL:     "https://upstream.example",
		HostToken:   "tok-123",
		HostEnabled: true,
	}
	backend := newFakeBackend()

	mux, closeFn, err := compose.Build(context.Background(), cfg, backend.opener())
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if !backend.opened {
		t.Error("expected the BackendOpener to be called for a mounted read source")
	}

	// Host-enabled: a control-shaped route must be REGISTERED (reachable
	// past routing; CSRFGuard then rejects the missing token with 403,
	// proving the route exists rather than 404ing).
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/v1/sessions", nil)
	req.Host = "127.0.0.1" // must pass HostOriginGuard first to reach the CSRF-guarded route
	mux.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Errorf("POST /api/v1/sessions with no CSRF token on a host-enabled mux = %d, want 403", rec.Code)
	}

	if err := closeFn(context.Background()); err != nil {
		t.Fatalf("closeFn() error = %v", err)
	}
}

// TestBuild_ProxiedHostEnabled covers the third reachable combination: Store
// unset, HostURL set -> proxied read AND host-enabled mux, both against the
// same HostURL. The BackendOpener must never be called: no local backend is
// ever opened in this mode.
func TestBuild_ProxiedHostEnabled(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		Addr:        config.DefaultAddr,
		HostURL:     "https://upstream.example",
		HostToken:   "tok-123",
		HostEnabled: true,
	}
	backend := newFakeBackend()

	mux, closeFn, err := compose.Build(context.Background(), cfg, backend.opener())
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if mux == nil {
		t.Fatal("Build() returned nil mux")
	}
	if backend.opened {
		t.Error("BackendOpener must not be called when cfg.Store is empty")
	}

	// closeFn must still be safely callable (a no-op) even though no backend
	// was ever opened.
	if closeFn == nil {
		t.Fatal("Build() returned nil closeFn")
	}
	if err := closeFn(context.Background()); err != nil {
		t.Errorf("closeFn() (no-op, proxied mode) error = %v", err)
	}
}

// TestBuild_NoDataSource covers the fourth case the task's test plan names
// as "proxied+browse-only." That literal combination is UNREACHABLE through
// config.Load: HostEnabled is derived by Load from HostURL != "", so
// cfg.Store == "" (proxied reads) always forces cfg.HostURL != "" (which
// forces HostEnabled == true) under Load's own NoDataSourceError guard. The
// only way to observe Build's "neither set" handling is a Config built by
// hand rather than through Load — which Config's exported fields allow, so
// Build defends against it independently rather than trusting every caller
// went through Load. See compose.go's Build doc for the full accounting.
func TestBuild_NoDataSource(t *testing.T) {
	t.Parallel()

	backend := newFakeBackend()
	_, _, err := compose.Build(context.Background(), config.Config{Addr: config.DefaultAddr}, backend.opener())
	if err == nil {
		t.Fatal("Build() with neither Store nor HostURL set: error = nil, want NoDataSourceError")
	}
	var wantErr *compose.NoDataSourceError
	if !errors.As(err, &wantErr) {
		t.Fatalf("Build() error = %T(%v), want *compose.NoDataSourceError", err, err)
	}
	if backend.opened {
		t.Error("BackendOpener must not be called when Build rejects the config before construction")
	}
}

// TestBuild_BackendOpenError proves a failing BackendOpener surfaces as a
// Build error rather than a partial/half-built mux.
func TestBuild_BackendOpenError(t *testing.T) {
	t.Parallel()

	backend := newFakeBackend()
	backend.openErr = errors.New("boom: disk full")

	cfg := config.Config{Addr: config.DefaultAddr, Store: "fs:/tmp/x"}
	mux, closeFn, err := compose.Build(context.Background(), cfg, backend.opener())
	if err == nil {
		t.Fatal("Build() with a failing BackendOpener: error = nil, want non-nil")
	}
	if mux != nil {
		t.Error("Build() returned a non-nil mux alongside an error")
	}
	if closeFn != nil {
		t.Error("Build() returned a non-nil closeFn alongside an error")
	}
}

// TestBuild_MissingBackendOpener proves Build fails loudly (rather than
// panicking on a nil BackendOpener) when cfg.Store is set but the caller
// forgot to supply one.
func TestBuild_MissingBackendOpener(t *testing.T) {
	t.Parallel()

	cfg := config.Config{Addr: config.DefaultAddr, Store: "fs:/tmp/x"}
	_, _, err := compose.Build(context.Background(), cfg, nil)
	if err == nil {
		t.Fatal("Build() with cfg.Store set and a nil BackendOpener: error = nil, want non-nil")
	}
}
