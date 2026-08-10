package compose_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/looprig/client/internal/compose"
)

func TestNewServer_SetsExplicitTimeouts(t *testing.T) {
	t.Parallel()

	srv := compose.NewServer("127.0.0.1:0", http.NewServeMux())

	if srv.ReadTimeout <= 0 {
		t.Errorf("ReadTimeout = %v, want > 0", srv.ReadTimeout)
	}
	if srv.WriteTimeout <= 0 {
		t.Errorf("WriteTimeout = %v, want > 0", srv.WriteTimeout)
	}
	if srv.IdleTimeout <= 0 {
		t.Errorf("IdleTimeout = %v, want > 0", srv.IdleTimeout)
	}
	if srv.MaxHeaderBytes <= 0 {
		t.Errorf("MaxHeaderBytes = %v, want > 0", srv.MaxHeaderBytes)
	}
	if srv.Addr != "127.0.0.1:0" {
		t.Errorf("Addr = %q, want %q", srv.Addr, "127.0.0.1:0")
	}
}

// TestRun_GracefulShutdownOnContextCancel proves Run starts a real listener
// (an ephemeral 127.0.0.1 port — the same loopback-by-default posture
// config.DefaultAddr uses) and returns cleanly (no error) once its context
// is canceled — the SIGINT/SIGTERM path main() relies on.
func TestRun_GracefulShutdownOnContextCancel(t *testing.T) {
	t.Parallel()

	srv := compose.NewServer("127.0.0.1:0", http.NewServeMux())
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() {
		done <- compose.Run(ctx, srv)
	}()

	// Give ListenAndServe a moment to bind before canceling, so this test
	// exercises the "cancel while genuinely serving" path rather than a race
	// against startup.
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run() error = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not return within 5s of ctx cancellation")
	}
}

// TestRun_ListenError proves a server that can never bind (an address with
// no valid port, guaranteeing a synchronous ListenAndServe failure) surfaces
// its error from Run immediately, without waiting for ctx.
func TestRun_ListenError(t *testing.T) {
	t.Parallel()

	srv := compose.NewServer("this-is-not-a-valid-address", http.NewServeMux())
	ctx := context.Background() // never canceled: Run must not need it here

	done := make(chan error, 1)
	go func() {
		done <- compose.Run(ctx, srv)
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Error("Run() with an unbindable address: error = nil, want non-nil")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not return promptly on a listen failure")
	}
}
