// Package compose is the shared construction-decision seam between the
// client's two composition roots (cmd/looprig-client,
// cmd/looprig-client-local): given a validated config.Config, it decides
// mounted-vs-proxied reads and browse-only-vs-host-enabled control, and
// wires the right internal/bff constructors accordingly.
//
// compose deliberately does NOT import fsstore or natsstore: opening the
// actual mounted-read storage backend is the caller's job, supplied as a
// BackendOpener closure. Only cmd/ is allowed to import a storage backend
// package (CLAUDE.md's import-discipline rule, restated in Task 30's plan:
// "only cmd/ imports a storage backend, and ONLY in mounted-read mode");
// compose itself only knows the backend-neutral *storage.Composite shape,
// exactly like internal/bff/mounted.go already does for
// NewMountedReadSource. This is what keeps Build unit-testable with a fake
// BackendOpener (e.g. one wired to storage/memstore) instead of a real
// fsstore/natsstore instance.
package compose

import (
	"context"
	"fmt"
	"net/url"

	"github.com/looprig/client/internal/bff"
	"github.com/looprig/client/internal/config"
	"github.com/looprig/harness/pkg/sessionstore"
	"github.com/looprig/storage"
)

// BackendOpener opens the mounted-read storage backend named by storeSpec
// (config.Config's Store field, e.g. "fs:/path" or "nats://host:4222") and
// returns the assembled *storage.Composite plus a close function bound to
// that backend. Build calls it at most once, and only when cfg.Store is
// non-empty. Each cmd/ binary supplies its own BackendOpener, wired to
// exactly the backend package(s) it is allowed to link — fsstore-only for
// looprig-client-local, fsstore+natsstore for looprig-client — dispatching
// on storeSpec's scheme itself (see internal/storespec). compose never
// imports either backend package.
type BackendOpener func(ctx context.Context, storeSpec string) (*storage.Composite, func(context.Context) error, error)

// noopClose is the close function Build returns for a proxied-only
// composition, where no local backend was ever opened. Callers still call
// it unconditionally during shutdown — it is simply a no-op here.
func noopClose(context.Context) error { return nil }

// NoDataSourceError mirrors config.NoDataSourceError. config.Load already
// refuses to build a Config with neither Store nor HostURL set, but Config's
// fields are exported — a caller (or a test) can construct one directly,
// bypassing Load — so Build enforces the same invariant itself rather than
// trusting every caller went through Load. Fail secure: an ambiguous config
// builds nothing.
type NoDataSourceError struct{}

func (e *NoDataSourceError) Error() string {
	return "compose: config has neither Store nor HostURL set; refusing to build a read source"
}

// InvalidHostURLError reports that cfg.HostURL — expected to have already
// passed config.Load's own validateHostURL — failed to parse as a URL when
// Build tried to use it. Like NoDataSourceError, this defends against a
// Config assembled by hand rather than through Load.
type InvalidHostURLError struct {
	Value string
	Err   error
}

func (e *InvalidHostURLError) Error() string {
	return fmt.Sprintf("compose: config HostURL %q is invalid: %v", e.Value, e.Err)
}

func (e *InvalidHostURLError) Unwrap() error { return e.Err }

// Build assembles the BFF's public *bff.BFFMux from cfg, deciding:
//
//   - Mounted vs. proxied reads: cfg.Store set -> mounted (openBackend opens
//     the backend; the result is wrapped in sessionstore.Open +
//     Store.OpenCatalog and handed to bff.NewMountedReadSource). cfg.Store
//     empty -> proxied against cfg.HostURL (bff.NewProxiedReadSource). Per
//     config.Load's own validation at least one of Store/HostURL is always
//     set, so cfg.Store empty always implies cfg.HostURL is set.
//   - Browse-only vs. host-enabled mux: cfg.HostEnabled (set by Load
//     whenever cfg.HostURL != "") selects bff.NewBrowseOnlyMux or
//     bff.NewMuxWithHost, the latter wiring HostOriginGuard + CSRFGuard +
//     ControlProxy + SSE proxy, all against cfg.HostURL/cfg.HostToken.
//
// A note on the "four combinations" a naive reading of Store/HostEnabled
// suggests (mounted x proxied, times browse-only x host-enabled): they do
// NOT collapse to four independent, reachable cases. cfg.HostEnabled is
// derived by Load from the very same cfg.HostURL a proxied read source also
// targets, so "proxied read, but no host control wired" (Store empty AND
// HostEnabled false) is unreachable through Load — Store empty forces
// HostURL set, which forces HostEnabled true. The reachable combinations are
// exactly: mounted+browse-only, mounted+host-enabled, and
// proxied+host-enabled. Build's own tests cover those three plus a fourth,
// genuinely-defensive case: a Config with neither Store nor HostURL set (the
// NoDataSourceError above), reachable only by constructing a Config by hand
// rather than through Load.
//
// closeFn is always non-nil: it is either the BackendOpener's own close
// function (mounted mode) or noopClose (proxied mode, no local backend ever
// opened). Callers must call it during shutdown regardless of which mode was
// selected.
//
// guard is the single *bff.HostOriginGuard Build wraps the BFF mux in. It is
// caller-constructed and caller-owned rather than built here, specifically
// so the SAME instance can also be passed to Handler (handler.go), which
// wraps the whole top-level surface (SPA + API) in it. Two independently
// constructed guards — one here, one in Handler — are identical only by
// coincidence today (both call bff.NewHostOriginGuard() with no arguments);
// the moment either call site starts threading cfg-derived
// extraAllowedHosts through, that coincidence breaks and the two guards can
// silently diverge (see NewHostOriginGuard's doc for extraAllowedHosts).
// Threading one instance through both call sites makes that divergence
// structurally impossible instead of merely untested.
func Build(ctx context.Context, cfg config.Config, openBackend BackendOpener, guard *bff.HostOriginGuard) (mux *bff.BFFMux, closeFn func(context.Context) error, err error) {
	if cfg.Store == "" && cfg.HostURL == "" {
		return nil, nil, &NoDataSourceError{}
	}

	read, closeBackend, err := buildReadSource(ctx, cfg, openBackend)
	if err != nil {
		return nil, nil, err
	}

	if !cfg.HostEnabled {
		return bff.NewBrowseOnlyMux(read, guard), closeBackend, nil
	}

	hostURL, err := url.Parse(cfg.HostURL)
	if err != nil {
		_ = closeBackend(ctx)
		return nil, nil, &InvalidHostURLError{Value: cfg.HostURL, Err: err}
	}

	// 0 falls back to bff.DefaultCSRFTokenTTL — see NewCSRFGuard's doc.
	csrf := bff.NewCSRFGuard(0)

	controlProxy, err := bff.NewControlProxy(hostURL, cfg.HostToken)
	if err != nil {
		_ = closeBackend(ctx)
		return nil, nil, fmt.Errorf("compose: build control proxy: %w", err)
	}

	eventsProxy, err := bff.NewSSEProxy(hostURL, cfg.HostToken)
	if err != nil {
		_ = closeBackend(ctx)
		return nil, nil, fmt.Errorf("compose: build events proxy: %w", err)
	}

	return bff.NewMuxWithHost(read, guard, csrf, controlProxy, eventsProxy), closeBackend, nil
}

// buildReadSource decides mounted vs. proxied reads. See Build's doc for the
// full decision rationale.
func buildReadSource(ctx context.Context, cfg config.Config, openBackend BackendOpener) (bff.ReadSource, func(context.Context) error, error) {
	if cfg.Store != "" {
		if openBackend == nil {
			return nil, nil, fmt.Errorf("compose: config.Store is set but no BackendOpener was supplied")
		}
		composite, closeBackend, err := openBackend(ctx, cfg.Store)
		if err != nil {
			return nil, nil, fmt.Errorf("compose: open backend for store %q: %w", cfg.Store, err)
		}
		store, err := sessionstore.Open(composite)
		if err != nil {
			_ = closeBackend(ctx)
			return nil, nil, fmt.Errorf("compose: open session store: %w", err)
		}
		catalog := store.OpenCatalog()
		return bff.NewMountedReadSource(catalog, store), closeBackend, nil
	}

	// cfg.Store is empty. config.Load guarantees cfg.HostURL is set in this
	// case (NoDataSourceError otherwise) — the same guarantee Build's own
	// defensive check above re-enforces for a hand-built Config.
	hostURL, err := url.Parse(cfg.HostURL)
	if err != nil {
		return nil, nil, &InvalidHostURLError{Value: cfg.HostURL, Err: err}
	}
	read, err := bff.NewProxiedReadSource(hostURL, cfg.HostToken)
	if err != nil {
		return nil, nil, fmt.Errorf("compose: build proxied read source: %w", err)
	}
	return read, noopClose, nil
}
