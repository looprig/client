//go:build integration

// Package stubserve is a small, STATEFUL httptest-backed double for a real
// github.com/looprig/harness/pkg/serve host. It exists only for this
// module's //go:build integration tests (internal/compose,
// internal/bff) to drive the real, wired BFF proxies —
// bff.NewProxiedReadSource, bff.NewControlProxy, bff.NewSSEProxy, and
// (transitively) compose.Build — end-to-end against something that behaves
// plausibly like a real serve host, rather than the single-purpose
// recording stubs each proxy's own unit-test file already builds
// (proxied_test.go's upstreamStub, control_test.go's controlUpstreamStub,
// events_test.go's inline handlers). Those stubs each answer ONE concern in
// isolation; this one is deliberately more stateful, because the scenarios
// Task 31 needs (a gate's open/respond/resolved lifecycle, a live tail that
// survives a reconnect) span several routes that all have to agree on the
// same session's state.
//
// Wire fidelity: every response body this stub writes is either a real
// harness/pkg/serve DTO (SessionStatus, SessionList, EventJournalPage,
// StatusEvent) JSON-encoded the same way serve's own writeJSON does, or an
// SSE frame built with the EXACT byte format pkg/serve/ephemeral.go's
// encodeEnduringFrame documents (verified by reading that file, not
// assumed): `event: enduring\nid: <seq>\ndata: {"v":1,"event":<envelope>}\n\n`.
// It deliberately does NOT import github.com/looprig/harness/pkg/gate (not
// on this module's CLAUDE.md-approved dependency list) — the gate-response
// body is decoded into a small local struct mirroring gate.ResponseRequest's
// wire shape instead, and the error envelope mirrors pkg/serve/errors.go's
// nested {"error":{"code","message","retryable"}} shape without importing
// serve's unexported writeError.
//
// A genuine, verified-not-assumed asymmetry this stub reproduces on purpose:
// pkg/serve/handlers_events.go's handleEvents subscribes a FRESH,
// whole-session stream per connection and never reads Last-Event-ID at all
// (grep confirms no reference to that header anywhere under pkg/serve) — so
// a real serve host does NOT replay history to a reconnecting client. This
// stub does the same: PushEnduring only reaches subscribers live at the
// moment of the call. A client that wants a gap-free transcript across a
// disconnect must pair a fresh journal read (from where it left off) with
// the new live stream — that pairing is the SDK join layer's job (Task 24),
// not this proxy's or this stub's. See TestIntegrationLiveTailReconnect's
// doc in compose_integration_test.go for how that shows up in the test.
package stubserve

import (
	"bytes"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/looprig/core/uuid"
	"github.com/looprig/harness/pkg/event"
	"github.com/looprig/harness/pkg/serve"
)

// frameSchemaVersion and enduringFrame mirror pkg/serve/ephemeral.go's
// unexported wire envelope exactly, so frames this stub emits are
// byte-for-byte the same shape a real serve host emits.
const frameSchemaVersion = 1

type enduringFrame struct {
	V     int             `json:"v"`
	Event json.RawMessage `json:"event"`
}

// gateResponseRequest mirrors gate.ResponseRequest's wire shape without
// importing pkg/gate — see the package doc.
type gateResponseRequest struct {
	Action string                     `json:"action,omitempty"`
	Values map[string]json.RawMessage `json:"values,omitempty"`
}

// stubErrorResponse/stubErrorBody mirror pkg/serve/errors.go's nested error
// envelope (errorResponse/errorBody) without importing serve's unexported
// writeError.
type stubErrorResponse struct {
	Error stubErrorBody `json:"error"`
}

type stubErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// gateRecord is one gate's open/resolved state within a session, enforcing
// the SAME lifecycle harness's pkg/serve/handlers_gate.go documents for a
// real session's RespondGate: a gate answered once is durably resolved, and
// a second response to it is rejected — mapped to 409 here exactly as
// writeGateError maps the session's gateKindNotReady case to
// http.StatusConflict for a gate that is no longer open. See
// handleGateResponse below.
type gateRecord struct {
	resolved bool
	action   string
}

// sessionState is one session's mutable, mutex-guarded projection: the
// status a status poll observes, the durable journal a journal read pages
// over, the gate directory a gate response is validated against, and the
// set of live SSE subscribers a push fans out to.
type sessionState struct {
	mu              sync.Mutex
	status          serve.SessionStatus
	journal         []serve.StatusEvent
	gates           map[string]*gateRecord
	subs            map[chan []byte]struct{}
	lastEventIDSeen string
	inputs          [][]byte
}

// Host is the stub serve host: a real *httptest.Server routing harness's
// wire-contract paths to per-session state. The zero value is not usable;
// construct with NewHost.
type Host struct {
	srv *httptest.Server

	mu       sync.Mutex
	sessions map[uuid.UUID]*sessionState
}

// NewHost starts a stub host and registers t.Cleanup to close it. useTLS
// selects httptest.NewTLSServer (the caller is then responsible for trusting
// h.Certificate() via one of bff's WithXRootCA options) vs.
// httptest.NewServer (plain HTTP — the only option compose.Build's own
// proxies currently support, since compose.go never surfaces a root-CA
// option to any of the three proxies it constructs; see
// compose_integration_test.go's doc for why that scenario deliberately uses
// a loopback plain-HTTP stub instead).
func NewHost(t *testing.T, useTLS bool) *Host {
	t.Helper()
	h := &Host{sessions: make(map[uuid.UUID]*sessionState)}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/sessions", h.handleList)
	mux.HandleFunc("GET /v1/sessions/{sid}/status", h.handleStatus)
	mux.HandleFunc("GET /v1/sessions/{sid}/journal", h.handleJournal)
	mux.HandleFunc("GET /v1/sessions/{sid}/events", h.handleEvents)
	mux.HandleFunc("POST /v1/sessions/{sid}/input", h.handleInput)
	mux.HandleFunc("POST /v1/sessions/{sid}/gates/{gid}", h.handleGateResponse)

	if useTLS {
		h.srv = httptest.NewTLSServer(mux)
	} else {
		h.srv = httptest.NewServer(mux)
	}
	t.Cleanup(h.srv.Close)
	return h
}

// URL is the stub's base URL (http:// or https://, per NewHost's useTLS).
func (h *Host) URL() string { return h.srv.URL }

// Certificate is the stub's self-signed leaf certificate, for use with one
// of bff's WithXRootCA options. Only meaningful when NewHost was called with
// useTLS true.
func (h *Host) Certificate() *x509.Certificate { return h.srv.Certificate() }

// Close closes the underlying httptest.Server early (tests may also rely on
// NewHost's registered t.Cleanup).
func (h *Host) Close() { h.srv.Close() }

// Seed registers sid with an initial projected status (state, e.g. "idle" or
// "running") and no journal history, gates, or subscribers — the starting
// point every scenario builds on.
func (h *Host) Seed(sid uuid.UUID, state string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sessions[sid] = &sessionState{
		status: serve.SessionStatus{SessionID: sid, State: state, UpdatedAt: time.Now()},
		gates:  make(map[string]*gateRecord),
		subs:   make(map[chan []byte]struct{}),
	}
}

func (h *Host) session(sid uuid.UUID) (*sessionState, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[sid]
	return s, ok
}

// PushEnduring appends ev to sid's durable journal (bumping its journal
// sequence, updating LastJournalSeq/UpdatedAt on the projected status) and,
// for every client CURRENTLY subscribed to sid's live events, broadcasts it
// as a real `event: enduring` SSE frame. It returns the sequence ev was
// stamped with.
//
// A push with no live subscriber still reaches the journal but is NOT
// delivered to any (past or future) SSE stream — see the package doc's note
// on why that mirrors real serve rather than being a stub limitation.
func (h *Host) PushEnduring(t *testing.T, sid uuid.UUID, ev event.Event) uint64 {
	t.Helper()
	s, ok := h.session(sid)
	if !ok {
		t.Fatalf("stubserve: PushEnduring: unseeded session %s", sid)
	}

	s.mu.Lock()
	seq := uint64(len(s.journal)) + 1
	s.journal = append(s.journal, serve.StatusEvent{JournalSeq: seq, Event: ev})
	s.status.LastJournalSeq = seq
	s.status.UpdatedAt = time.Now()

	raw, err := event.MarshalEvent(ev)
	if err != nil {
		s.mu.Unlock()
		t.Fatalf("stubserve: MarshalEvent: %v", err)
	}
	body, err := json.Marshal(enduringFrame{V: frameSchemaVersion, Event: raw})
	if err != nil {
		s.mu.Unlock()
		t.Fatalf("stubserve: marshal enduring frame: %v", err)
	}
	frame := fmt.Appendf(nil, "event: enduring\nid: %d\ndata: %s\n\n", seq, body)

	subs := make([]chan []byte, 0, len(s.subs))
	for ch := range s.subs {
		subs = append(subs, ch)
	}
	s.mu.Unlock()

	for _, ch := range subs {
		select {
		case ch <- frame:
		case <-time.After(2 * time.Second):
			t.Fatalf("stubserve: PushEnduring: subscriber channel did not drain in time")
		}
	}
	return seq
}

// SetState overwrites sid's projected status State field (e.g. "idle",
// "running").
func (h *Host) SetState(t *testing.T, sid uuid.UUID, state string) {
	t.Helper()
	s, ok := h.session(sid)
	if !ok {
		t.Fatalf("stubserve: SetState: unseeded session %s", sid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.State = state
	s.status.UpdatedAt = time.Now()
}

// OpenGate opens gid on sid: the gate directory records it unresolved, and
// the projected status moves to "waiting_on_gate" with WaitingGateID set —
// the same status shape a client polling GET .../status observes while a
// real gate is open (pkg/serve/reader.go's SessionStatus.WaitingGateID doc).
func (h *Host) OpenGate(t *testing.T, sid, gid uuid.UUID) {
	t.Helper()
	s, ok := h.session(sid)
	if !ok {
		t.Fatalf("stubserve: OpenGate: unseeded session %s", sid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gates[gid.String()] = &gateRecord{}
	s.status.State = "waiting_on_gate"
	s.status.WaitingGateID = gid
	s.status.UpdatedAt = time.Now()
}

// LastEventIDSeen returns the Last-Event-ID header value the most recent
// GET .../events connection for sid arrived with ("" if none, or if the
// header was absent) — the one piece of state a test needs to introspect
// directly on the stub, since it is otherwise unobservable: it proves the
// real bff.SSEProxy forwarded the header end-to-end rather than merely
// trusting the proxy's own unit tests (events_test.go) that it does so in
// isolation.
func (h *Host) LastEventIDSeen(t *testing.T, sid uuid.UUID) string {
	t.Helper()
	s, ok := h.session(sid)
	if !ok {
		t.Fatalf("stubserve: LastEventIDSeen: unseeded session %s", sid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastEventIDSeen
}

// GateAction returns the action a resolved gate was answered with ("" if the
// gate was never opened or is still unresolved).
func (h *Host) GateAction(t *testing.T, sid, gid uuid.UUID) string {
	t.Helper()
	s, ok := h.session(sid)
	if !ok {
		t.Fatalf("stubserve: GateAction: unseeded session %s", sid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.gates[gid.String()]
	if !ok {
		return ""
	}
	return rec.action
}

func (h *Host) handleList(w http.ResponseWriter, _ *http.Request) {
	h.mu.Lock()
	summaries := make([]serve.SessionSummary, 0, len(h.sessions))
	for sid, s := range h.sessions {
		s.mu.Lock()
		summaries = append(summaries, serve.SessionSummary{
			SessionID:    sid,
			State:        s.status.State,
			LastActiveAt: s.status.UpdatedAt,
		})
		s.mu.Unlock()
	}
	h.mu.Unlock()
	writeStubJSON(w, http.StatusOK, serve.SessionList{Sessions: summaries, Done: true})
}

func (h *Host) handleStatus(w http.ResponseWriter, r *http.Request) {
	sid, err := uuid.Parse(r.PathValue("sid"))
	if err != nil {
		writeStubError(w, http.StatusBadRequest, "invalid_param", "invalid session id")
		return
	}
	s, ok := h.session(sid)
	if !ok {
		writeStubError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}
	s.mu.Lock()
	status := s.status
	s.mu.Unlock()
	writeStubJSON(w, http.StatusOK, status)
}

func (h *Host) handleJournal(w http.ResponseWriter, r *http.Request) {
	sid, err := uuid.Parse(r.PathValue("sid"))
	if err != nil {
		writeStubError(w, http.StatusBadRequest, "invalid_param", "invalid session id")
		return
	}
	s, ok := h.session(sid)
	if !ok {
		writeStubError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}

	q := r.URL.Query()
	from := parseUintQuery(q.Get("from_journal_seq"))
	limit := 100
	if l := q.Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	page := make([]serve.StatusEvent, 0)
	for _, se := range s.journal {
		if se.JournalSeq < from {
			continue
		}
		if len(page) >= limit {
			break
		}
		page = append(page, se)
	}
	done := true
	var next uint64
	if len(page) > 0 {
		last := page[len(page)-1].JournalSeq
		if last < s.status.LastJournalSeq {
			done = false
			next = last + 1
		}
	}
	writeStubJSON(w, http.StatusOK, serve.EventJournalPage{Events: page, NextJournalSeq: next, Done: done})
}

// handleEvents serves the SSE route. It registers a subscriber channel
// BEFORE writing the response header/flush, so by the time a client's
// http.Client.Do call returns (which happens only once the status line and
// headers reach it), the subscription is already live — the
// happens-before a test relies on to push an event immediately after
// connecting without racing the subscription.
func (h *Host) handleEvents(w http.ResponseWriter, r *http.Request) {
	sid, err := uuid.Parse(r.PathValue("sid"))
	if err != nil {
		writeStubError(w, http.StatusBadRequest, "invalid_param", "invalid session id")
		return
	}
	s, ok := h.session(sid)
	if !ok {
		writeStubError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}

	ch := make(chan []byte, 16)
	s.mu.Lock()
	s.lastEventIDSeen = r.Header.Get("Last-Event-ID")
	s.subs[ch] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case frame := <-ch:
			if _, err := w.Write(frame); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *Host) handleInput(w http.ResponseWriter, r *http.Request) {
	sid, err := uuid.Parse(r.PathValue("sid"))
	if err != nil {
		writeStubError(w, http.StatusBadRequest, "invalid_param", "invalid session id")
		return
	}
	s, ok := h.session(sid)
	if !ok {
		writeStubError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeStubError(w, http.StatusBadRequest, "invalid_body", "invalid body")
		return
	}
	if len(bytes.TrimSpace(body)) == 0 {
		writeStubError(w, http.StatusBadRequest, "invalid_body", "invalid body")
		return
	}

	cmdID, err := uuid.New()
	if err != nil {
		writeStubError(w, http.StatusInternalServerError, "internal", "could not submit input")
		return
	}

	s.mu.Lock()
	s.inputs = append(s.inputs, body)
	s.status.State = "running"
	s.status.UpdatedAt = time.Now()
	s.mu.Unlock()

	writeStubJSON(w, http.StatusOK, struct {
		CommandID uuid.UUID `json:"command_id"`
	}{CommandID: cmdID})
}

// handleGateResponse mirrors pkg/serve/handlers_gate.go's handleGateResponse
// authoritatively for the one distinction this task cares about proving:
// an UNRESOLVED gate accepts exactly one response (202, durably resolved),
// and a SECOND response to that same gate is rejected — mapped to 409
// (codeGateNotReady in real serve's terms: the gate is no longer "ready" to
// be answered), never silently accepted or overwritten.
func (h *Host) handleGateResponse(w http.ResponseWriter, r *http.Request) {
	sid, err := uuid.Parse(r.PathValue("sid"))
	if err != nil {
		writeStubError(w, http.StatusBadRequest, "invalid_param", "invalid session id")
		return
	}
	gid := r.PathValue("gid")

	s, ok := h.session(sid)
	if !ok {
		writeStubError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeStubError(w, http.StatusBadRequest, "invalid_body", "invalid body")
		return
	}
	var req gateResponseRequest
	if len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			writeStubError(w, http.StatusBadRequest, "invalid_body", "invalid body")
			return
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	rec, ok := s.gates[gid]
	if !ok {
		writeStubError(w, http.StatusNotFound, "gate_not_found", "gate not found")
		return
	}
	if rec.resolved {
		writeStubError(w, http.StatusConflict, "gate_not_ready", "gate not ready")
		return
	}
	if req.Action == "" {
		writeStubError(w, http.StatusBadRequest, "gate_action_invalid", "invalid gate action")
		return
	}

	rec.resolved = true
	rec.action = req.Action
	s.status.WaitingGateID = uuid.UUID{}
	s.status.State = "running"
	s.status.UpdatedAt = time.Now()

	writeStubJSON(w, http.StatusAccepted, struct{}{})
}

func writeStubJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeStubError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(stubErrorResponse{Error: stubErrorBody{Code: code, Message: msg}})
}

func parseUintQuery(s string) uint64 {
	if s == "" {
		return 0
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}
