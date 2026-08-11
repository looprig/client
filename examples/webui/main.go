// Command webui exercises the embedded web UI handler without starting a
// server. The embedded document is intentionally a placeholder until a real
// application build is wired into the Go binary.
package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
)

const placeholder = `<!doctype html><html><body><main>Looprig embedded SPA placeholder until a real app build exists.</main></body></html>`

func webUI(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = response.Write([]byte(placeholder))
}

func main() {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	response := httptest.NewRecorder()
	webUI(response, request)
	if response.Code != http.StatusOK {
		panic(fmt.Sprintf("unexpected status: %d", response.Code))
	}
	fmt.Println(response.Body.String())
}
