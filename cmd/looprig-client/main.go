// Command looprig-client is the dual-mode composition root: it links BOTH
// mounted-read storage backends — fsstore (github.com/looprig/fsstore, the
// laptop backend) and natsstore (github.com/looprig/natsstore, the cloud
// backend) — dispatching on CLIENT_STORE's scheme ("fs:" or "nats://") at
// startup. It also supports proxied reads (CLIENT_STORE unset,
// CLIENT_HOST_URL set) exactly like looprig-client-local does.
//
// This is the "convenience" binary the plan names: a single artifact that
// works whichever storage backend an operator points it at, at the cost of
// linking both. looprig-client-local exists specifically for the laptop case
// where NOT linking natsstore (and its NATS/JetStream dependency tree) is
// the point.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/looprig/client/internal/bff"
	"github.com/looprig/client/internal/compose"
	"github.com/looprig/client/internal/config"
	"github.com/looprig/client/internal/storespec"
	"github.com/looprig/client/pkg/webui"
	"github.com/looprig/fsstore"
	"github.com/looprig/natsstore"
	"github.com/looprig/storage"
)

// buildTimeout bounds opening the mounted storage backend and constructing
// the BFF's HTTP surface at startup — see looprig-client-local's identical
// constant for the rationale (a startup-only step must not share the
// "runs until SIGTERM" context's unbounded lifetime). natsstore's Open in
// particular documents that its ctx "bounds the bucket-provisioning
// round-trips" and expects a deadline.
const buildTimeout = 30 * time.Second

// shutdownBackendTimeout bounds closing the storage backend during graceful
// shutdown.
const shutdownBackendTimeout = 10 * time.Second

func main() {
	if err := run(); err != nil {
		slog.Error("looprig-client: fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(envMap(os.Environ()))
	if err != nil {
		// Fail loud on invalid config: log and exit non-zero, never
		// partially start.
		return fmt.Errorf("load config: %w", err)
	}

	runCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	buildCtx, cancelBuild := context.WithTimeout(runCtx, buildTimeout)
	defer cancelBuild()

	// Constructed ONCE and threaded through both Build (wraps the BFF mux
	// internally) and Handler (wraps the whole top-level SPA+API surface),
	// so the two never risk drifting into differently configured guards —
	// see compose.Build's doc for the full rationale.
	guard := bff.NewHostOriginGuard()

	mux, closeBackend, err := compose.Build(buildCtx, cfg, openBackend, guard)
	if err != nil {
		return fmt.Errorf("build: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownBackendTimeout)
		defer cancel()
		if cerr := closeBackend(shutdownCtx); cerr != nil {
			slog.Error("looprig-client: close backend", "err", cerr)
		}
	}()

	handler := compose.Handler(mux, webui.Handler(), guard)
	srv := compose.NewServer(cfg.Addr, handler)

	slog.Info("looprig-client: listening", "addr", cfg.Addr, "mode", modeLabel(cfg))
	return compose.Run(runCtx, srv)
}

// openBackend is this binary's compose.BackendOpener: it dispatches on
// storeSpec's scheme (see internal/storespec) to whichever of the two linked
// backend packages the scheme names. An unknown scheme is a typed error from
// storespec.Parse itself — this function never guesses a default.
func openBackend(ctx context.Context, storeSpec string) (*storage.Composite, func(context.Context) error, error) {
	spec, err := storespec.Parse(storeSpec)
	if err != nil {
		return nil, nil, fmt.Errorf("parse CLIENT_STORE: %w", err)
	}
	switch spec.Scheme {
	case storespec.SchemeFS:
		return openFSBackend(spec)
	case storespec.SchemeNATS:
		return openNATSBackend(ctx, spec)
	default:
		// Unreachable: storespec.Parse only ever returns SchemeFS,
		// SchemeNATS, or a non-nil error.
		return nil, nil, fmt.Errorf("looprig-client: unhandled store scheme %q", spec.Scheme)
	}
}

func openFSBackend(spec storespec.Spec) (*storage.Composite, func(context.Context) error, error) {
	store, err := fsstore.Open(fsstore.Options{Root: spec.Path})
	if err != nil {
		return nil, nil, fmt.Errorf("open fsstore at %q: %w", spec.Path, err)
	}
	closeFn := func(context.Context) error { return store.Close() }
	return store.Backend(), closeFn, nil
}

func openNATSBackend(ctx context.Context, spec storespec.Spec) (*storage.Composite, func(context.Context) error, error) {
	store, err := natsstore.Open(ctx, natsstore.Options{URL: spec.Raw})
	if err != nil {
		return nil, nil, fmt.Errorf("open natsstore at %q: %w", spec.Raw, err)
	}
	// natsstore.Store.Close already has exactly this func(context.Context)
	// error shape, unlike fsstore.Store.Close (no ctx parameter) above — no
	// wrapping closure needed.
	return store.Backend(), store.Close, nil
}

// modeLabel is a human-readable startup log line summarizing the
// composition compose.Build resolved, for operators reading process logs —
// it carries no behavior of its own.
func modeLabel(cfg config.Config) string {
	read := "proxied"
	if cfg.Store != "" {
		read = "mounted"
	}
	control := "browse-only"
	if cfg.HostEnabled {
		control = "host-enabled"
	}
	return read + "/" + control
}

// envMap materializes the process environment into the map config.Load
// expects. Load never reads os.Getenv itself (see internal/config's package
// doc), so this is the one place in the binary the raw environment is
// touched.
func envMap(environ []string) map[string]string {
	m := make(map[string]string, len(environ))
	for _, kv := range environ {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		m[k] = v
	}
	return m
}
