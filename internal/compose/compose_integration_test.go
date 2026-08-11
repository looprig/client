//go:build integration

package compose_test

// Task 31's end-to-end coverage over the REAL composition root
// (compose.Build -> compose.Handler -> compose.NewServer), driven over real
// HTTP against a real net.Listener — not httptest.NewRecorder, and not a
// hand-assembled mux that merely resembles what cmd/looprig-client(-local)
// builds. See startComposedServer's doc for why this uses compose.NewServer
// directly (with our own pre-bound listener) rather than compose.Run itself.
//
// Scenario 1 (TestIntegrationBrowseOnlyHistory) needs no stub host: it seeds
// a real (test-scale) memstore-backed sessionstore.Store + Catalog exactly
// as internal/bff/mounted_test.go does, and drives list/status/journal
// through the real mounted, browse-only composition.
//
// Scenarios 2 and 4 need a stub serve host (internal/stubserve) and use the
// PROXIED+host-enabled composition (cfg.Store empty, cfg.HostURL set) so a
// single stub answers both the read plane and the live plane, matching how
// a real dual-mode deployment against a remote host actually looks. They
// deliberately use a PLAIN HTTP stub (stubserve.NewHost(t, false)), not TLS:
// compose.go's Build never surfaces any of bff's WithRootCA /
// WithSSERootCA / WithControlRootCA options to the proxies it constructs, so
// there is currently no way for a compose.Build-driven test (or a real
// deployment behind a private CA) to make those proxies trust anything but
// the system cert pool. Plain HTTP to a loopback host is the one upstream
// shape config.Load's own validateHostURL allows without TLS, so it's the
// only shape this test can drive through the real composition root. See
// this task's final report for this flagged as a real, if minor, gap.
//
// Scenario 3 (the gate round trip) is NOT in this file — see
// internal/bff/gate_roundtrip_integration_test.go's doc for why it can't be
// driven through compose.Build at all.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/looprig/client/internal/bff"
	"github.com/looprig/client/internal/compose"
	"github.com/looprig/client/internal/config"
	"github.com/looprig/client/internal/stubserve"
	"github.com/looprig/client/pkg/webui"
	"github.com/looprig/core/content"
	"github.com/looprig/core/uuid"
	"github.com/looprig/harness/pkg/event"
	"github.com/looprig/harness/pkg/identity"
	"github.com/looprig/harness/pkg/journal"
	"github.com/looprig/harness/pkg/sessionstore"
	"github.com/looprig/storage"
	"github.com/looprig/storage/memstore"
)

// fixedIntegrationUUID builds a deterministic non-zero uuid from a seed
// byte, the same convention internal/bff's own tests
// (mounted_test.go/control_test.go/events_test.go) and harness's
// catalogreader tests all use for stable, readable ids.
func fixedIntegrationUUID(seed byte) uuid.UUID {
	var u uuid.UUID
	for i := range u {
		u[i] = seed
	}
	return u
}

func integrationAIMsg(text string) *content.AIMessage {
	return &content.AIMessage{Message: content.Message{
		Role:   content.RoleAssistant,
		Blocks: []content.Block{&content.TextBlock{Text: text}},
	}}
}

func integrationUserMsg(text string) *content.UserMessage {
	return &content.UserMessage{Message: content.Message{
		Role:   content.RoleUser,
		Blocks: []content.Block{&content.TextBlock{Text: text}},
	}}
}

func integrationSessionStarted(sid uuid.UUID) event.SessionStarted {
	return event.SessionStarted{Header: event.Header{
		Coordinates: identity.Coordinates{SessionID: sid},
		EventID:     fixedIntegrationUUID(0xE0),
	}}
}

func integrationTurnStarted(sid, loop, turn uuid.UUID) event.TurnStarted {
	return event.TurnStarted{
		Header:    event.Header{Coordinates: identity.Coordinates{SessionID: sid, LoopID: loop, TurnID: turn}, EventID: turn},
		TurnIndex: 1,
		Message:   integrationUserMsg("hello"),
	}
}

// integrationTurnDone builds a valid loop-scoped TurnDone. eventID must be
// distinct across every TurnDone appended to the same journal — see
// harness's own catalogreader reader_test.go turnDone doc for why (journal's
// fingerprint-based idempotency dedup).
func integrationTurnDone(sid, loop, turn, eventID uuid.UUID) event.TurnDone {
	return event.TurnDone{
		Header:    event.Header{Coordinates: identity.Coordinates{SessionID: sid, LoopID: loop, TurnID: turn}, EventID: eventID},
		TurnIndex: 1,
		Message:   integrationAIMsg("done"),
	}
}

// startComposedServer starts handler behind a REAL *http.Server built
// exactly the way compose.NewServer builds every server this module ever
// starts (explicit Read/Write/Idle timeouts, capped headers — CLAUDE.md's
// "HTTP server" secure-coding pattern), bound to a real net.Listener on
// loopback, and registers a t.Cleanup that shuts it down gracefully. It
// returns the server's base URL.
//
// This deliberately does NOT call compose.Run: Run's own startup path
// (srv.ListenAndServe()) binds by address STRING, which for a parallel test
// suite would mean either a shared fixed port (a cross-test race/conflict)
// or picking a free port and hoping it is still free by the time
// ListenAndServe gets to it (a real, if small, bind race). Pre-binding our
// own net.Listener on port 0 and calling srv.Serve(listener) sidesteps that
// race entirely while still exercising the exact *http.Server
// compose.NewServer constructs, and shutting it down the same graceful way
// compose.Run's own ctx-done path does (srv.Shutdown).
func startComposedServer(t *testing.T, handler http.Handler) string {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() err = %v", err)
	}
	srv := compose.NewServer(ln.Addr().String(), handler)

	done := make(chan struct{})
	go func() {
		defer close(done)
		if serveErr := srv.Serve(ln); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			t.Errorf("srv.Serve() err = %v", serveErr)
		}
	}()
	t.Cleanup(func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if shutdownErr := srv.Shutdown(shutdownCtx); shutdownErr != nil {
			t.Errorf("srv.Shutdown() err = %v", shutdownErr)
		}
		<-done
	})

	return "http://" + ln.Addr().String()
}

// httpGet issues a real GET against url and fails the test on a transport
// error (never on a non-2xx status — callers assert status themselves).
func httpGet(t *testing.T, url string) *http.Response {
	t.Helper()
	resp, err := http.Get(url) //nolint:gosec // url is test-composed from a loopback baseURL, never external input
	if err != nil {
		t.Fatalf("http.Get(%q) err = %v", url, err)
	}
	return resp
}

// httpGetBody issues a GET and returns the full, closed response's body as a
// string, for a simple substring assertion.
func httpGetBody(t *testing.T, url string) (int, string) {
	t.Helper()
	resp := httpGet(t, url)
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("io.ReadAll() err = %v", err)
	}
	return resp.StatusCode, string(body)
}

// sseConnect opens a live GET .../events connection, optionally carrying a
// Last-Event-ID header (empty means a fresh connection), and returns the
// live *http.Response plus a *bufio.Reader over its body for
// readSSEFrameID to consume incrementally.
func sseConnect(t *testing.T, url, lastEventID string) (*http.Response, *bufio.Reader) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("http.NewRequest() err = %v", err)
	}
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		t.Fatalf("client.Do() err = %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		t.Fatalf("GET %s status = %d, want 200; body = %s", url, resp.StatusCode, body)
	}
	return resp, bufio.NewReader(resp.Body)
}

// readSSEFrameID reads one complete SSE frame (through its trailing blank
// line) off r and returns the sequence stamped on its `id: ` line. It fails
// the test on a read error (including EOF, meaning the stream closed before
// a complete frame arrived) or a frame with no id: line.
func readSSEFrameID(t *testing.T, r *bufio.Reader) uint64 {
	t.Helper()
	var id uint64
	sawID := false
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("readSSEFrameID: ReadString() err = %v", err)
		}
		line = strings.TrimRight(line, "\n")
		if line == "" {
			if !sawID {
				t.Fatal("readSSEFrameID: frame had no id: line")
			}
			return id
		}
		if rest, ok := strings.CutPrefix(line, "id: "); ok {
			n, perr := strconv.ParseUint(rest, 10, 64)
			if perr != nil {
				t.Fatalf("readSSEFrameID: parse id line %q: %v", line, perr)
			}
			id = n
			sawID = true
		}
	}
}

// newSeededMountedComposite opens a memstore-backed sessionstore.Store,
// seeds ONE session's catalog entry (so it appears in a list/status read,
// mirroring internal/bff/mounted_test.go's own seeding pattern exactly) and
// separately appends three Enduring events directly to the session's raw
// journal (TurnStarted, then two TurnDone) so the journal read has real
// pagination to exercise — the catalog projection and the raw journal are
// independently maintained stores (sessionstore.Catalog.UpdateOnEvent never
// touches the journal, and vice versa; verified by reading catalog.go), so
// both have to be seeded explicitly to get a realistic browse scenario.
func newSeededMountedComposite(t *testing.T) (composite *storage.Composite, sid uuid.UUID, journalSeqs []uint64) {
	t.Helper()

	composite = memstore.New()
	st, err := sessionstore.Open(composite)
	if err != nil {
		t.Fatalf("sessionstore.Open() err = %v", err)
	}

	sid = fixedIntegrationUUID(0x51)
	loop := fixedIntegrationUUID(0x52)

	cat := st.OpenCatalog()
	if err := cat.UpdateOnEvent(context.Background(), integrationSessionStarted(sid), 1); err != nil {
		t.Fatalf("UpdateOnEvent() err = %v", err)
	}

	lease, err := st.AcquireLease(context.Background(), sid)
	if err != nil {
		t.Fatalf("AcquireLease() err = %v", err)
	}
	j, err := st.OpenJournal(context.Background(), sid, lease)
	if err != nil {
		t.Fatalf("OpenJournal() err = %v", err)
	}

	events := []event.Event{
		integrationTurnStarted(sid, loop, fixedIntegrationUUID(0x53)),
		integrationTurnDone(sid, loop, fixedIntegrationUUID(0x53), fixedIntegrationUUID(0x60)),
		integrationTurnDone(sid, loop, fixedIntegrationUUID(0x54), fixedIntegrationUUID(0x61)),
	}
	for _, ev := range events {
		seq, appendErr := j.Append(context.Background(), journal.NewEventRecord(ev))
		if appendErr != nil {
			t.Fatalf("Append(%T) err = %v", ev, appendErr)
		}
		journalSeqs = append(journalSeqs, seq)
	}

	return composite, sid, journalSeqs
}

// TestIntegrationBrowseOnlyHistory covers Task 31's scenario 1: a mounted
// read source over a real (test-scale) store with seeded sessions; list
// sessions, read status, page the journal — all through the real BFF mux
// (compose.Build's mounted+browse-only path -> compose.Handler ->
// compose.NewServer), real HTTP, no host configured at all.
func TestIntegrationBrowseOnlyHistory(t *testing.T) {
	composite, sid, journalSeqs := newSeededMountedComposite(t)

	opener := func(_ context.Context, storeSpec string) (*storage.Composite, func(context.Context) error, error) {
		if storeSpec != "fs:/seeded" {
			t.Fatalf("BackendOpener called with storeSpec = %q, want %q", storeSpec, "fs:/seeded")
		}
		return composite, func(context.Context) error { return nil }, nil
	}

	cfg := config.Config{Addr: config.DefaultAddr, Store: "fs:/seeded"}
	guard := bff.NewHostOriginGuard()
	mux, closeFn, err := compose.Build(context.Background(), cfg, opener, guard)
	if err != nil {
		t.Fatalf("compose.Build() err = %v", err)
	}
	t.Cleanup(func() {
		if cerr := closeFn(context.Background()); cerr != nil {
			t.Errorf("closeFn() err = %v", cerr)
		}
	})

	baseURL := startComposedServer(t, compose.Handler(mux, webui.Handler(), guard))

	// 1. List sessions: the seeded session appears.
	if status, body := httpGetBody(t, baseURL+"/api/v1/sessions"); status != http.StatusOK || !strings.Contains(body, sid.String()) {
		t.Fatalf("GET /api/v1/sessions = %d, %q; want 200 containing %s", status, body, sid)
	}

	// 2. Read the seeded session's status.
	if status, body := httpGetBody(t, baseURL+"/api/v1/sessions/"+sid.String()+"/status"); status != http.StatusOK || !strings.Contains(body, sid.String()) {
		t.Fatalf("GET .../status = %d, %q; want 200 containing %s", status, body, sid)
	}

	// A never-seeded session's status must 404 -- the browse-only mux
	// answers this from the mounted read source itself, no host involved.
	unseeded := fixedIntegrationUUID(0x99)
	if status, _ := httpGetBody(t, baseURL+"/api/v1/sessions/"+unseeded.String()+"/status"); status != http.StatusNotFound {
		t.Errorf("GET .../status for unseeded session = %d, want 404", status)
	}

	// 3. Page the journal: limit=2 must yield exactly the first two events,
	// not done, with a resume cursor; the second page (from that cursor)
	// must yield the remaining event and report done, with no gap or
	// duplicate across the two pages.
	var page1, page2 journalPageWire
	if status := httpGetJSON(t, baseURL+"/api/v1/sessions/"+sid.String()+"/journal?limit=2", &page1); status != http.StatusOK {
		t.Fatalf("GET .../journal?limit=2 status = %d", status)
	}
	if len(page1.Events) != 2 || page1.Done {
		t.Fatalf("page1 = %+v, want 2 events, done=false", page1)
	}
	if status := httpGetJSON(t, fmt.Sprintf("%s/api/v1/sessions/%s/journal?from_journal_seq=%d&limit=2", baseURL, sid, page1.NextJournalSeq), &page2); status != http.StatusOK {
		t.Fatalf("GET .../journal (page 2) status = %d", status)
	}
	if len(page2.Events) != 1 || !page2.Done {
		t.Fatalf("page2 = %+v, want 1 event, done=true", page2)
	}

	var gotSeqs []uint64
	for _, se := range page1.Events {
		gotSeqs = append(gotSeqs, se.JournalSeq)
	}
	for _, se := range page2.Events {
		gotSeqs = append(gotSeqs, se.JournalSeq)
	}
	if len(gotSeqs) != len(journalSeqs) {
		t.Fatalf("paged journal seqs = %v, want %v", gotSeqs, journalSeqs)
	}
	for i, want := range journalSeqs {
		if gotSeqs[i] != want {
			t.Errorf("paged journal seq[%d] = %d, want %d (no gap/duplicate across pages)", i, gotSeqs[i], want)
		}
	}
}

// journalPageWire decodes GET .../journal's response body. It deliberately
// does NOT use serve.EventJournalPage/serve.StatusEvent directly:
// StatusEvent's doc is explicit that it is a write-only DTO with a custom
// MarshalJSON and no matching UnmarshalJSON (the read plane serializes it
// outward and never decodes it back), so a test acting as the HTTP CLIENT —
// exactly the position the SPA/SDK is in — has to decode the wire shape
// itself, the same {"journal_seq","event"} shape statusEventWire documents.
type journalPageWire struct {
	Events []struct {
		JournalSeq uint64          `json:"journal_seq"`
		Event      json.RawMessage `json:"event,omitempty"`
	} `json:"events"`
	NextJournalSeq uint64 `json:"next_journal_seq"`
	Done           bool   `json:"done"`
}

// httpGetJSON issues a GET, decodes the JSON response body into v, and
// returns the status code. It fails the test on a transport or decode
// error, but leaves status-code assertions to the caller.
func httpGetJSON(t *testing.T, url string, v any) int {
	t.Helper()
	resp := httpGet(t, url)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
			t.Fatalf("json decode %s: %v", url, err)
		}
	}
	return resp.StatusCode
}

// TestIntegrationLiveTailReconnect covers Task 31's scenario 2: a stub host
// serving real SSE frames; connect, receive frames, simulate a disconnect,
// reconnect, verify no gap/duplicate — through the real, composed BFF SSE
// proxy AND the real read-plane (journal) proxy together.
//
// A load-bearing, verified-not-assumed fact this test's design depends on
// (see internal/stubserve's package doc): harness's real
// pkg/serve/handlers_events.go opens a FRESH subscription per SSE
// connection and never reads Last-Event-ID at all, so a real serve host does
// NOT replay history to a reconnecting client either — an event that occurs
// while nobody is subscribed is simply not delivered over SSE, ever. A
// client that wants a gap-free transcript across a disconnect MUST pair a
// fresh journal read (resuming from the last sequence it saw) with the new
// live stream; that pairing is the SDK join layer's job (Task 24's
// sdk/core/src/join.ts, already thoroughly tested there), not this proxy's.
// This test proves the GO-SIDE WIRING both halves of that pairing depend
// on actually work end-to-end against a real stub host: the SSE proxy
// relays live frames and forwards Last-Event-ID on reconnect, and the
// read-plane proxy serves the exact missed event from the journal in
// between — assembling BOTH into one gapless, non-duplicated sequence the
// same way a real client (join.ts) would.
func TestIntegrationLiveTailReconnect(t *testing.T) {
	host := stubserve.NewHost(t, false)
	sid := fixedIntegrationUUID(0x61)
	loop := fixedIntegrationUUID(0x62)
	host.Seed(sid, "running")

	cfg := config.Config{
		Addr:        config.DefaultAddr,
		HostURL:     host.URL(),
		HostToken:   "test-host-token",
		HostEnabled: true,
	}
	guard := bff.NewHostOriginGuard()
	mux, closeFn, err := compose.Build(context.Background(), cfg, nil, guard)
	if err != nil {
		t.Fatalf("compose.Build() err = %v", err)
	}
	t.Cleanup(func() { _ = closeFn(context.Background()) })

	baseURL := startComposedServer(t, compose.Handler(mux, webui.Handler(), guard))
	eventsURL := baseURL + "/api/v1/sessions/" + sid.String() + "/events"

	// 1. Fresh connection: no Last-Event-ID sent, none observed upstream.
	resp1, r1 := sseConnect(t, eventsURL, "")
	if got := host.LastEventIDSeen(t, sid); got != "" {
		t.Errorf("stub observed Last-Event-ID = %q on a fresh connection, want empty", got)
	}

	// 2. Two live events, relayed byte-for-byte through the real SSE proxy.
	seq1 := host.PushEnduring(t, sid, integrationTurnStarted(sid, loop, fixedIntegrationUUID(0x63)))
	if got := readSSEFrameID(t, r1); got != seq1 {
		t.Fatalf("frame 1 id = %d, want %d", got, seq1)
	}
	seq2 := host.PushEnduring(t, sid, integrationTurnDone(sid, loop, fixedIntegrationUUID(0x63), fixedIntegrationUUID(0x64)))
	if got := readSSEFrameID(t, r1); got != seq2 {
		t.Fatalf("frame 2 id = %d, want %d", got, seq2)
	}

	// 3. Simulate a disconnect.
	if err := resp1.Body.Close(); err != nil {
		t.Fatalf("resp1.Body.Close() err = %v", err)
	}

	// 4. While disconnected, an event happens -- the real "gap" nobody is
	// listening for over SSE (see this test's doc).
	seq3 := host.PushEnduring(t, sid, integrationTurnStarted(sid, loop, fixedIntegrationUUID(0x65)))

	// 5. Catch up via the REAL read-plane (journal) proxy, resuming from
	// seq2+1 -- exactly the NextJournalSeq contract serve.EventJournalPage
	// documents.
	var page journalPageWire
	journalURL := fmt.Sprintf("%s/api/v1/sessions/%s/journal?from_journal_seq=%d", baseURL, sid, seq2+1)
	if status := httpGetJSON(t, journalURL, &page); status != http.StatusOK {
		t.Fatalf("GET .../journal status = %d", status)
	}
	if len(page.Events) != 1 || page.Events[0].JournalSeq != seq3 {
		t.Fatalf("journal catch-up = %+v, want exactly one event at seq %d", page, seq3)
	}

	// 6. Reconnect, carrying Last-Event-ID = the highest sequence the
	// client now has (seq3, via the journal catch-up above) -- proving the
	// real SSE proxy forwards it end-to-end (asserted against the stub,
	// the only place that's observable).
	resp2, r2 := sseConnect(t, eventsURL, strconv.FormatUint(seq3, 10))
	defer func() { _ = resp2.Body.Close() }()
	if got := host.LastEventIDSeen(t, sid); got != strconv.FormatUint(seq3, 10) {
		t.Errorf("stub observed Last-Event-ID = %q, want %d", got, seq3)
	}

	// 7. A new live event reaches the new connection exactly once.
	seq4 := host.PushEnduring(t, sid, integrationTurnStarted(sid, loop, fixedIntegrationUUID(0x66)))
	if got := readSSEFrameID(t, r2); got != seq4 {
		t.Fatalf("frame 4 id = %d, want %d", got, seq4)
	}

	// 8. Assemble what a real client would have reconstructed: conn1's live
	// frames, the journal catch-up, and conn2's live frames. Strictly
	// increasing by exactly 1 each step proves no gap and no duplicate
	// across the whole reconnect.
	got := []uint64{seq1, seq2, page.Events[0].JournalSeq, seq4}
	for i := 1; i < len(got); i++ {
		if got[i] != got[i-1]+1 {
			t.Fatalf("assembled sequence = %v, want strictly consecutive (no gap/duplicate)", got)
		}
	}
}

// TestIntegrationUpstreamDown covers Task 31's scenario 4: pointing the
// composed handler's proxies at an unreachable host must fail fast with a
// clear (5xx) error, never hang -- for both the read-plane proxy (a GET
// .../status) and the SSE proxy (a GET .../events), reusing the
// listen-then-close idiom internal/bff/proxied_test.go, events_test.go, and
// control_test.go already established for "upstream unreachable."
func TestIntegrationUpstreamDown(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() err = %v", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatalf("Listener.Close() err = %v", err)
	}

	cfg := config.Config{
		Addr:        config.DefaultAddr,
		HostURL:     "http://" + addr,
		HostToken:   "test-host-token",
		HostEnabled: true,
	}
	guard := bff.NewHostOriginGuard()
	mux, closeFn, err := compose.Build(context.Background(), cfg, nil, guard)
	if err != nil {
		t.Fatalf("compose.Build() err = %v", err)
	}
	t.Cleanup(func() { _ = closeFn(context.Background()) })

	baseURL := startComposedServer(t, compose.Handler(mux, webui.Handler(), guard))
	sid := fixedIntegrationUUID(0x70)

	tests := []struct {
		name string
		path string
	}{
		{name: "read plane status", path: "/api/v1/sessions/" + sid.String() + "/status"},
		{name: "live events", path: "/api/v1/sessions/" + sid.String() + "/events"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			start := time.Now()
			resp := httpGet(t, baseURL+tt.path)
			defer func() { _ = resp.Body.Close() }()
			elapsed := time.Since(start)

			if resp.StatusCode < 500 || resp.StatusCode >= 600 {
				t.Errorf("status = %d, want a 5xx (upstream unreachable)", resp.StatusCode)
			}
			if elapsed > 5*time.Second {
				t.Errorf("request took %s, want it to fail fast rather than hang", elapsed)
			}
		})
	}
}
