package compose_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/looprig/client/internal/compose"
)

func TestHandler(t *testing.T) {
	t.Parallel()

	apiCalled, spaCalled := false, false
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		apiCalled = true
		w.WriteHeader(http.StatusOK)
	})
	spa := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		spaCalled = true
		w.WriteHeader(http.StatusOK)
	})

	handler := compose.Handler(api, spa)

	tests := []struct {
		name        string
		path        string
		wantAPI     bool
		wantSPA     bool
		description string
	}{
		{name: "api path routes to the BFF mux", path: "/api/v1/sessions", wantAPI: true},
		{name: "api root routes to the BFF mux", path: "/api/", wantAPI: true},
		{name: "root path falls through to the SPA", path: "/", wantSPA: true},
		{name: "an arbitrary client route falls through to the SPA", path: "/sessions/abc123", wantSPA: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			apiCalled, spaCalled = false, false
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			handler.ServeHTTP(rec, req)

			if apiCalled != tt.wantAPI {
				t.Errorf("path %q: api handler called = %v, want %v", tt.path, apiCalled, tt.wantAPI)
			}
			if spaCalled != tt.wantSPA {
				t.Errorf("path %q: spa handler called = %v, want %v", tt.path, spaCalled, tt.wantSPA)
			}
		})
	}
}
