package bff

// capabilities.go builds the BFF's OWN GET /api/v1/capabilities document. This is
// deliberately NOT a proxy of the mounted/proxied ReadSource's own /v1/capabilities
// route (harness's serve.ReadHandler always advertises "journal" only, because a
// read plane alone never knows whether a control host sits behind the same BFF).
// The BFF is the only party that knows the full picture end-to-end, so it
// synthesizes its own document from hostConfigured (see mux.go's
// NewBrowseOnlyMux and NewMuxWithHost, which each pass a hardcoded, constructor
// -specific value here — never an independently threaded bool a caller could
// mismatch against which routes it actually registered):
//
//   - hostConfigured == true  (NewMuxWithHost: a control host is wired): the
//     BFF can serve the live plane end-to-end, so it advertises the full
//     feature set.
//   - hostConfigured == false (NewBrowseOnlyMux: no control host): the BFF
//     advertises "journal" ONLY. It must never claim live_sse/ephemeral_sse/
//     gate_response with no live plane behind it — a client that trusts this
//     document and opens an SSE connection expecting one of those planes would
//     hang forever.
//
// The wire shape (protocol/version/features) and every feature string are copied
// VERBATIM from harness's pkg/serve/handlers_capabilities.go for wire
// compatibility: an SPA (or any other client) that already knows how to parse
// serve's capabilities document can parse the BFF's without a second code path.

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// contentTypeJSON is the media type of every response this file writes, matching
// harness's serve package's own constant of the same name and value.
const contentTypeJSON = "application/json"

// Wire-compatible protocol/feature constants. These MUST stay byte-identical to
// harness's pkg/serve/handlers_capabilities.go — they are not this package's to
// invent, only to reuse, so the BFF's capabilities document round-trips through
// the exact same client-side parser as serve's own.
const (
	protocolName    = "looprig.serve"
	protocolVersion = 1

	featureJournal      = "journal"
	featureLiveSSE      = "live_sse"
	featureEphemeralSSE = "ephemeral_sse"
	featureGateResponse = "gate_response"
)

// capabilities is the typed document served at GET /api/v1/capabilities. Same
// wire shape as harness's own capabilities document (protocol/version/features),
// but Features here reflects what the BFF actually offers end-to-end — never what
// the mounted/proxied read plane's own /v1/capabilities route would say on its
// own.
type capabilities struct {
	Protocol string   `json:"protocol"`
	Version  int      `json:"version"`
	Features []string `json:"features"`
}

// fullFeatures is advertised when a control host is wired: journal reads plus the
// live plane (live_sse, ephemeral_sse, gate_response), in the same canonical
// order harness's full serve.Handler uses.
var fullFeatures = []string{featureJournal, featureLiveSSE, featureEphemeralSSE, featureGateResponse}

// readOnlyFeatures is advertised when no control host is wired: journal only.
var readOnlyFeatures = []string{featureJournal}

// handleCapabilities builds the GET /api/v1/capabilities handler. It reads no
// per-request state and touches no dependency beyond hostConfigured, which is
// fixed at mux-construction time (see NewBrowseOnlyMux and NewMuxWithHost in
// mux.go) — every request gets the identical
// 200 JSON body naming the protocol, its version, and the feature planes the BFF
// actually backs end-to-end, in their canonical order.
func handleCapabilities(hostConfigured bool) http.HandlerFunc {
	features := readOnlyFeatures
	if hostConfigured {
		features = fullFeatures
	}
	doc := capabilities{Protocol: protocolName, Version: protocolVersion, Features: features}

	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentTypeJSON)
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(doc); err != nil {
			slog.Error("bff: encode capabilities response", "err", err)
		}
	}
}
