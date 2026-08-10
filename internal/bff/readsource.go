package bff

import "net/http"

// ReadSource is the BFF's read plane: an http.Handler serving serve's stateless read
// routes. It is chosen at the composition root — either serve.ReadHandler mounted
// in-process over a local store, or a reverse proxy to a remote serve. The BFF and
// the SDK are blind to which is wired, because both speak the identical wire contract.
type ReadSource interface {
	http.Handler
}
