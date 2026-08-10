package bff_test

// These are in-process tests over a REAL memstore-backed sessionstore.Store +
// Catalog and a REAL serve.ReadHandler, driven over net/http/httptest. Because
// memstore is an in-memory reference backend (no process boundary, no filesystem,
// no network) and ReadHandler is exercised directly (not bound to a listener), these
// are ordinary fast, deterministic unit tests with no NATS involved.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/looprig/client/internal/bff"
	"github.com/looprig/core/uuid"
	"github.com/looprig/harness/pkg/event"
	"github.com/looprig/harness/pkg/identity"
	"github.com/looprig/harness/pkg/sessionstore"
	"github.com/looprig/storage/memstore"
)

// fixedUUID builds a deterministic non-zero uuid from a seed byte, mirroring the
// pattern harness's own catalogreader tests use to build stable session ids.
func fixedUUID(seed byte) uuid.UUID {
	var u uuid.UUID
	for i := range u {
		u[i] = seed
	}
	return u
}

// sessionStarted builds a minimal, valid session-scoped SessionStarted event — the
// same shape catalogreader's own tests use to seed a catalog entry.
func sessionStarted(sid uuid.UUID) event.SessionStarted {
	return event.SessionStarted{Header: event.Header{
		Coordinates: identity.Coordinates{SessionID: sid},
		EventID:     fixedUUID(0xE0),
	}}
}

// newMountedSource opens a memstore-backed Store + Catalog, seeds one session by
// folding a SessionStarted event into the catalog (the same wiring catalogreader's
// reader_test.go exercises), and wires the real serve.ReadHandler over it via
// NewMountedReadSource. It returns the ReadSource and the seeded session's id.
func newMountedSource(t *testing.T) (bff.ReadSource, uuid.UUID) {
	t.Helper()
	st, err := sessionstore.Open(memstore.New())
	if err != nil {
		t.Fatalf("sessionstore.Open() err = %v", err)
	}
	cat := st.OpenCatalog()

	sid := fixedUUID(0x77)
	if err := cat.UpdateOnEvent(context.Background(), sessionStarted(sid), 1); err != nil {
		t.Fatalf("UpdateOnEvent() err = %v", err)
	}

	return bff.NewMountedReadSource(cat, st), sid
}

func TestNewMountedReadSourceListSessions(t *testing.T) {
	t.Parallel()

	src, sid := newMountedSource(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	rec := httptest.NewRecorder()
	src.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/sessions status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), sid.String()) {
		t.Errorf("GET /v1/sessions body = %s, want it to contain seeded session id %s", rec.Body.String(), sid)
	}
}

func TestNewMountedReadSourceStatus(t *testing.T) {
	t.Parallel()

	src, sid := newMountedSource(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions/"+sid.String()+"/status", nil)
	rec := httptest.NewRecorder()
	src.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET .../status for seeded session status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), sid.String()) {
		t.Errorf("GET .../status body = %s, want it to contain seeded session id %s", rec.Body.String(), sid)
	}
}

func TestNewMountedReadSourceStatusNotFound(t *testing.T) {
	t.Parallel()

	src, _ := newMountedSource(t)
	unseeded := fixedUUID(0x99)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions/"+unseeded.String()+"/status", nil)
	rec := httptest.NewRecorder()
	src.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET .../status for unseeded session status = %d, want %d; body = %s", rec.Code, http.StatusNotFound, rec.Body.String())
	}
}

func TestNewMountedReadSourceCapabilities(t *testing.T) {
	t.Parallel()

	src, _ := newMountedSource(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
	rec := httptest.NewRecorder()
	src.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/capabilities status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var doc struct {
		Protocol string   `json:"protocol"`
		Version  int      `json:"version"`
		Features []string `json:"features"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("json.Unmarshal(capabilities) err = %v; body = %s", err, rec.Body.String())
	}
	if want := []string{"journal"}; len(doc.Features) != len(want) || doc.Features[0] != want[0] {
		t.Errorf("capabilities features = %v, want %v (mounted read source must advertise read-only)", doc.Features, want)
	}
}
