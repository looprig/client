//go:build integration

package bff_test

// TestIntegrationGateRoundTrip covers Task 31's scenario 3: submit input,
// observe a gate open (via status polling), respond to it, observe it
// close, and prove a second response to the SAME gate is rejected — through
// the real control proxy (bff.NewControlProxy) and real read-plane proxy
// (bff.NewProxiedReadSource), assembled into a real *bff.BFFMux
// (bff.NewMuxWithHost) served over real HTTP, against
// internal/stubserve's stateful stub host.
//
// This file builds the mux via bff.NewMuxWithHost directly rather than
// through compose.Build, and that is a DELIBERATE, necessary divergence,
// not a convenience shortcut — worth spelling out because it surfaces a
// real gap:
//
//   - compose.Build's NewMuxWithHost path constructs its own *bff.CSRFGuard
//     internally (compose.go: `csrf := bff.NewCSRFGuard(0)`) and never
//     returns it, and *bff.BFFMux keeps its csrf field unexported. There is
//     currently NO exported seam — no HTTP endpoint, no returned value —
//     through which any caller (a test, or a real browser SPA) can ever
//     Mint() a token valid against a compose.Build-composed mux.
//   - This is not merely a test inconvenience: grepping this module's own
//     SPA and SDK source (app/src, sdk/core/src, sdk/svelte/src) for any
//     reference to bff.CSRFHeaderName or a token-minting call turns up
//     nothing. As currently wired, EVERY real control POST a real browser
//     would ever send — create, restore, submit input, respond to a gate,
//     interrupt — reaches CSRFGuard.Wrap with no token and is rejected
//     403, in production exactly as in a naive test. See this task's final
//     report for this flagged prominently as a production-blocking gap,
//     independent of and prior to this test file.
//   - internal/bff/control_test.go's own
//     TestControlProxyRegisterRoutesAppliesCSRFThroughRealBFFMux already
//     established the workaround this file follows: build *bff.BFFMux
//     directly via bff.NewMuxWithHost with an externally-held *bff.CSRFGuard
//     the test can Mint() from. Every OTHER piece this file wires — the real
//     bff.NewControlProxy, bff.NewProxiedReadSource, bff.NewSSEProxy, and
//     bff.NewHostOriginGuard — is exactly what compose.Build would have
//     constructed for a proxied+host-enabled Config; only the CSRFGuard's
//     origin (test-held vs. compose-internal) differs, and that is the one
//     piece a real caller cannot obtain by design as this stands today.
//
// Unlike compose_integration_test.go's stub (plain HTTP, because
// compose.Build never surfaces a root-CA option), this file builds the
// three proxies BY HAND and so has direct access to bff.WithControlRootCA /
// bff.WithRootCA / bff.WithSSERootCA — so the stub here runs real TLS,
// demonstrating the more production-representative shape.

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/looprig/client/internal/bff"
	"github.com/looprig/client/internal/stubserve"
	"github.com/looprig/core/uuid"
)

const gateRoundTripToken = "server-side-gate-roundtrip-token"

// gateStatusWire decodes GET .../status's response body without relying on
// serve.SessionStatus's JSON codec directly (it round-trips fine here since
// SessionStatus has no custom UnmarshalJSON restriction unlike StatusEvent,
// but a small local struct keeps this file's dependency on serve's exact Go
// types minimal and keeps the assertions reading as plain wire-shape checks
// — a client-side view, matching the position a real caller is in).
type gateStatusWire struct {
	SessionID     string `json:"session_id"`
	State         string `json:"state"`
	WaitingGateID string `json:"waiting_gate_id"`
}

type gateErrorWire struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// buildGateRoundTripMux wires a real *bff.BFFMux (via bff.NewMuxWithHost —
// see this file's doc for why not compose.Build) with the real control,
// read, and events proxies all pointed at ONE shared stubserve.Host over
// real TLS, plus an externally-held *bff.CSRFGuard the test can mint tokens
// from. It returns the mux's real HTTP base URL, the stub host, and the
// guard.
func buildGateRoundTripMux(t *testing.T) (baseURL string, host *stubserve.Host, csrf *bff.CSRFGuard) {
	t.Helper()

	host = stubserve.NewHost(t, true)
	upstreamURL, err := url.Parse(host.URL())
	if err != nil {
		t.Fatalf("url.Parse(%q) err = %v", host.URL(), err)
	}
	cert := host.Certificate()

	read, err := bff.NewProxiedReadSource(upstreamURL, gateRoundTripToken, bff.WithRootCA(cert))
	if err != nil {
		t.Fatalf("NewProxiedReadSource() err = %v", err)
	}
	controlProxy, err := bff.NewControlProxy(upstreamURL, gateRoundTripToken, bff.WithControlRootCA(cert))
	if err != nil {
		t.Fatalf("NewControlProxy() err = %v", err)
	}
	eventsProxy, err := bff.NewSSEProxy(upstreamURL, gateRoundTripToken, bff.WithSSERootCA(cert))
	if err != nil {
		t.Fatalf("NewSSEProxy() err = %v", err)
	}

	csrf = bff.NewCSRFGuard(time.Hour)
	mux := bff.NewMuxWithHost(read, bff.NewHostOriginGuard(), csrf, controlProxy, eventsProxy)

	front := httptest.NewServer(mux)
	t.Cleanup(front.Close)

	return front.URL, host, csrf
}

func gatePostBody(t *testing.T, csrfToken, reqURL string, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, reqURL, strings.NewReader(body))
	if err != nil {
		t.Fatalf("http.NewRequest() err = %v", err)
	}
	req.Host = loopbackHost
	if csrfToken != "" {
		req.Header.Set(bff.CSRFHeaderName, csrfToken)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		t.Fatalf("client.Do() err = %v", err)
	}
	return resp
}

func gateGet(t *testing.T, reqURL string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, reqURL, nil)
	if err != nil {
		t.Fatalf("http.NewRequest() err = %v", err)
	}
	req.Host = loopbackHost
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		t.Fatalf("client.Do() err = %v", err)
	}
	return resp
}

func decodeGateStatus(t *testing.T, resp *http.Response) gateStatusWire {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	var status gateStatusWire
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	return status
}

func decodeGateError(t *testing.T, resp *http.Response) gateErrorWire {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	var e gateErrorWire
	if err := json.NewDecoder(resp.Body).Decode(&e); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	return e
}

func TestIntegrationGateRoundTrip(t *testing.T) {
	baseURL, host, csrf := buildGateRoundTripMux(t)

	sid, err := uuid.New()
	if err != nil {
		t.Fatalf("uuid.New() err = %v", err)
	}
	gid, err := uuid.New()
	if err != nil {
		t.Fatalf("uuid.New() err = %v", err)
	}
	host.Seed(sid, "idle")

	token, err := csrf.Mint()
	if err != nil {
		t.Fatalf("csrf.Mint() err = %v", err)
	}

	// 1. Submit input through the real control proxy.
	inputResp := gatePostBody(t, token, baseURL+"/api/v1/sessions/"+sid.String()+"/input",
		`{"blocks":[{"type":"text","text":"please review this change"}]}`)
	defer func() { _ = inputResp.Body.Close() }()
	if inputResp.StatusCode != http.StatusOK {
		t.Fatalf("POST .../input status = %d, want 200", inputResp.StatusCode)
	}

	// 2. A gate opens as a consequence of that input (simulated on the
	// stub — a real session would open this asynchronously; this test
	// only needs the STATUS-VISIBLE consequence, which OpenGate provides
	// directly).
	host.OpenGate(t, sid, gid)

	// 3. Observe the gate open via status polling, through the real
	// read-plane proxy.
	status := decodeGateStatus(t, gateGet(t, baseURL+"/api/v1/sessions/"+sid.String()+"/status"))
	if status.State != "waiting_on_gate" || status.WaitingGateID != gid.String() {
		t.Fatalf("status after OpenGate = %+v, want state=waiting_on_gate, waiting_gate_id=%s", status, gid)
	}

	// 4. Respond to the gate through the real control proxy.
	respondURL := baseURL + "/api/v1/sessions/" + sid.String() + "/gates/" + gid.String()
	firstResp := gatePostBody(t, token, respondURL, `{"action":"Approve"}`)
	defer func() { _ = firstResp.Body.Close() }()
	if firstResp.StatusCode != http.StatusAccepted {
		t.Fatalf("first POST .../gates/%s status = %d, want 202", gid, firstResp.StatusCode)
	}
	if got := host.GateAction(t, sid, gid); got != "Approve" {
		t.Errorf("stub recorded gate action = %q, want %q", got, "Approve")
	}

	// 5. Observe the gate close via status polling.
	status = decodeGateStatus(t, gateGet(t, baseURL+"/api/v1/sessions/"+sid.String()+"/status"))
	if status.State == "waiting_on_gate" || status.WaitingGateID != "" {
		t.Fatalf("status after respond = %+v, want state != waiting_on_gate, waiting_gate_id empty", status)
	}

	// 6. A second response to the SAME already-resolved gate is rejected
	// with 409 gate_not_ready — mirroring pkg/serve/handlers_gate.go's
	// writeGateError mapping for a gate that is no longer ready to be
	// answered (see internal/stubserve's handleGateResponse doc), not
	// silently accepted or overwritten.
	secondResp := gatePostBody(t, token, respondURL, `{"action":"Deny"}`)
	if secondResp.StatusCode != http.StatusConflict {
		t.Fatalf("second POST .../gates/%s status = %d, want 409", gid, secondResp.StatusCode)
	}
	errBody := decodeGateError(t, secondResp)
	if errBody.Error.Code != "gate_not_ready" {
		t.Errorf("second response error code = %q, want %q", errBody.Error.Code, "gate_not_ready")
	}
	// The rejected second response must not have overwritten the
	// original answer.
	if got := host.GateAction(t, sid, gid); got != "Approve" {
		t.Errorf("stub recorded gate action after rejected second response = %q, want unchanged %q", got, "Approve")
	}
}

// TestIntegrationGateResponseWithoutCSRFTokenRejected proves the CSRF guard
// really is in front of the gate-response route in the fully-wired mux, not
// merely at the unit level (control_test.go's own
// TestControlProxyRegisterRoutesAppliesCSRFThroughRealBFFMux already proves
// this against a throwaway stub; this is the same property, against
// stubserve's stateful gate lifecycle, so a reader trusts this file's other
// assertions rest on a mux that actually enforces CSRF).
func TestIntegrationGateResponseWithoutCSRFTokenRejected(t *testing.T) {
	baseURL, host, _ := buildGateRoundTripMux(t)

	sid, err := uuid.New()
	if err != nil {
		t.Fatalf("uuid.New() err = %v", err)
	}
	gid, err := uuid.New()
	if err != nil {
		t.Fatalf("uuid.New() err = %v", err)
	}
	host.Seed(sid, "idle")
	host.OpenGate(t, sid, gid)

	resp := gatePostBody(t, "", baseURL+"/api/v1/sessions/"+sid.String()+"/gates/"+gid.String(), `{"action":"Approve"}`)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("POST .../gates/%s with no CSRF token status = %d, want 403", gid, resp.StatusCode)
	}
	if got := host.GateAction(t, sid, gid); got != "" {
		t.Errorf("stub recorded gate action = %q despite a CSRF-rejected request, want unresolved", got)
	}
}

// TestIntegrationGateResponseUnknownGateNotFound proves a response to a gate
// id the stub never opened 404s, distinctly from the "already resolved" 409
// case above — the same not_found/not_ready distinction
// pkg/serve/handlers_gate.go's writeGateError draws.
func TestIntegrationGateResponseUnknownGateNotFound(t *testing.T) {
	baseURL, host, csrf := buildGateRoundTripMux(t)

	sid, err := uuid.New()
	if err != nil {
		t.Fatalf("uuid.New() err = %v", err)
	}
	host.Seed(sid, "idle")

	token, err := csrf.Mint()
	if err != nil {
		t.Fatalf("csrf.Mint() err = %v", err)
	}

	neverOpened, err := uuid.New()
	if err != nil {
		t.Fatalf("uuid.New() err = %v", err)
	}

	resp := gatePostBody(t, token, baseURL+"/api/v1/sessions/"+sid.String()+"/gates/"+neverOpened.String(), `{"action":"Approve"}`)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("POST .../gates/%s (never opened) status = %d, want 404", neverOpened, resp.StatusCode)
	}
	errBody := decodeGateError(t, resp)
	if errBody.Error.Code != "gate_not_found" {
		t.Errorf("error code = %q, want %q", errBody.Error.Code, "gate_not_found")
	}
}

// TestIntegrationControlUpstreamDown is scenario 4's control-plane leg,
// complementing compose_integration_test.go's read-plane and SSE coverage:
// a control POST against an unreachable host must fail fast with a 5xx, not
// hang. It reuses this file's real-TLS rig shape but points the control
// proxy at a listener that has been closed, the same
// listen-then-close idiom proxied_test.go/events_test.go/control_test.go
// established.
func TestIntegrationControlUpstreamDown(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() err = %v", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatalf("Listener.Close() err = %v", err)
	}
	upstreamURL, err := url.Parse("http://" + addr)
	if err != nil {
		t.Fatalf("url.Parse() err = %v", err)
	}

	controlProxy, err := bff.NewControlProxy(upstreamURL, gateRoundTripToken)
	if err != nil {
		t.Fatalf("NewControlProxy() err = %v", err)
	}
	// NewMuxWithHost still requires a real read source and events proxy;
	// their own upstream is irrelevant to this test (only the control leg
	// is exercised), so a trivial 200-OK TLS stub stands in, matching
	// mux_test.go's own newTestControlHost/okStub convention.
	read, err := bff.NewProxiedReadSource(upstreamURL, gateRoundTripToken)
	if err != nil {
		t.Fatalf("NewProxiedReadSource() err = %v", err)
	}
	eventsProxy := newTrustingEventsProxy(t, okStub)

	csrf := bff.NewCSRFGuard(time.Hour)
	mux := bff.NewMuxWithHost(read, bff.NewHostOriginGuard(), csrf, controlProxy, eventsProxy)
	front := httptest.NewServer(mux)
	t.Cleanup(front.Close)

	token, err := csrf.Mint()
	if err != nil {
		t.Fatalf("csrf.Mint() err = %v", err)
	}

	sid := "01234567-89ab-cdef-0123-456789abcdef"
	start := time.Now()
	resp := gatePostBody(t, token, front.URL+"/api/v1/sessions/"+sid+"/input", `{"blocks":[{"type":"text","text":"hi"}]}`)
	defer func() { _ = resp.Body.Close() }()
	elapsed := time.Since(start)

	if resp.StatusCode < 500 || resp.StatusCode >= 600 {
		t.Errorf("status = %d, want a 5xx (upstream unreachable)", resp.StatusCode)
	}
	if elapsed > 5*time.Second {
		t.Errorf("request took %s, want it to fail fast rather than hang", elapsed)
	}
}
