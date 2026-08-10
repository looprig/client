// Command looprig-client-local is the laptop composition root: the
// no-NATS binary. It links ONLY fsstore (github.com/looprig/fsstore) as a
// mounted-read storage backend, and optionally proxies the live/control
// plane to a remote host (CLIENT_HOST_URL/CLIENT_HOST_TOKEN) exactly like
// the dual-mode binary does — the only thing this binary narrows is which
// storage backend it can mount.
//
// There is no code path here that can ever open a NATS backend:
// github.com/looprig/natsstore is not imported by this binary at all, so a
// CLIENT_STORE value naming a "nats:" scheme is rejected before fsstore.Open
// is ever called (see openFSBackend) — and even if that check were somehow
// bypassed, there is no natsstore.Open this program could call, because the
// package isn't linked into it.
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

	"github.com/looprig/client/internal/compose"
	"github.com/looprig/client/internal/config"
	"github.com/looprig/client/internal/storespec"
	"github.com/looprig/client/pkg/webui"
	"github.com/looprig/fsstore"
	"github.com/looprig/storage"
)

// buildTimeout bounds opening the mounted storage backend and constructing
// the BFF's HTTP surface at startup — a separate, short-lived context from
// the long-running one Run serves under (CLAUDE.md: every I/O call is
// context-bounded; a startup-only step must not share the "runs until
// SIGTERM" context's unbounded lifetime).
const buildTimeout = 30 * time.Second

// shutdownBackendTimeout bounds closing the storage backend during graceful
// shutdown.
const shutdownBackendTimeout = 10 * time.Second

func main() {
	if err := run(); err != nil {
		slog.Error("looprig-client-local: fatal", "err", err)
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

	mux, closeBackend, err := compose.Build(buildCtx, cfg, openFSBackend)
	if err != nil {
		return fmt.Errorf("build: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownBackendTimeout)
		defer cancel()
		if cerr := closeBackend(shutdownCtx); cerr != nil {
			slog.Error("looprig-client-local: close backend", "err", cerr)
		}
	}()

	handler := compose.Handler(mux, webui.Handler())
	srv := compose.NewServer(cfg.Addr, handler)

	slog.Info("looprig-client-local: listening", "addr", cfg.Addr, "mode", modeLabel(cfg))
	return compose.Run(runCtx, srv)
}

// openFSBackend is the ONLY compose.BackendOpener this binary ever wires: it
// opens storeSpec exclusively as an fsstore root. Any other scheme —
// notably "nats:", which would require linking github.com/looprig/natsstore
// — is rejected here, before fsstore.Open is ever called. This binary does
// not import natsstore anywhere, so this rejection is not the only thing
// standing between a NATS config value and a NATS connection: there is
// structurally no natsstore.Open for this program to reach even if this
// check were removed.
func openFSBackend(_ context.Context, storeSpec string) (*storage.Composite, func(context.Context) error, error) {
	spec, err := storespec.Parse(storeSpec)
	if err != nil {
		return nil, nil, fmt.Errorf("parse CLIENT_STORE: %w", err)
	}
	if spec.Scheme != storespec.SchemeFS {
		return nil, nil, fmt.Errorf("looprig-client-local: CLIENT_STORE scheme %q is not supported by this binary (fs only — use looprig-client for a %q store)", spec.Scheme, spec.Scheme)
	}

	store, err := fsstore.Open(fsstore.Options{Root: spec.Path})
	if err != nil {
		return nil, nil, fmt.Errorf("open fsstore at %q: %w", spec.Path, err)
	}
	closeFn := func(context.Context) error { return store.Close() }
	return store.Backend(), closeFn, nil
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
