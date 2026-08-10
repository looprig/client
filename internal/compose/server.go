package compose

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Server timeouts and header cap, per CLAUDE.md's "HTTP server" secure-coding
// pattern: every *http.Server this module ever starts sets these explicitly.
// No naked http.ListenAndServe with the zero-value server.
const (
	ReadTimeout    = 5 * time.Second
	WriteTimeout   = 10 * time.Second
	IdleTimeout    = 60 * time.Second
	MaxHeaderBytes = 1 << 20
)

// shutdownTimeout bounds Run's graceful drain after ctx is done: in-flight
// requests get this long to finish before Shutdown force-closes whatever is
// still open.
const shutdownTimeout = 10 * time.Second

// NewServer builds an *http.Server bound to addr with the timeouts and
// header cap above. addr is expected to already carry config.go's
// loopback-by-default posture (Config.Addr / DefaultAddr) — NewServer itself
// does not re-validate it; that is config.Load's job.
func NewServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:           addr,
		Handler:        handler,
		ReadTimeout:    ReadTimeout,
		WriteTimeout:   WriteTimeout,
		IdleTimeout:    IdleTimeout,
		MaxHeaderBytes: MaxHeaderBytes,
	}
}

// Run starts srv and blocks until ctx is done, then gracefully shuts srv
// down within shutdownTimeout. If srv.ListenAndServe fails before ctx is
// ever done (e.g. the configured address is already in use), Run returns
// that error immediately without waiting for ctx. http.ErrServerClosed —
// the expected outcome of a graceful Shutdown — is never treated as a
// failure.
//
// Callers typically derive ctx from signal.NotifyContext(context.Background(),
// os.Interrupt, syscall.SIGTERM), so Run's normal exit path is: process
// receives SIGINT/SIGTERM, ctx is done, in-flight requests get up to
// shutdownTimeout to finish, Run returns nil.
func Run(ctx context.Context, srv *http.Server) error {
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	// Wait for the ListenAndServe goroutine to actually return (it will,
	// with http.ErrServerClosed, once Shutdown completes) so Run never
	// returns while that goroutine is still live.
	<-serveErr
	return nil
}
