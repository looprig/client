package bff

import (
	"github.com/looprig/harness/pkg/serve"
	"github.com/looprig/harness/pkg/serve/catalogreader"
	"github.com/looprig/harness/pkg/sessionstore"
)

// NewMountedReadSource builds a ReadSource that serves harness's stateless read
// routes directly from a local session store, with no remote host in the loop. This
// is the laptop/mounted-read composition: the BFF process itself links the storage
// backend and answers list/status/journal from durable history.
func NewMountedReadSource(catalog *sessionstore.Catalog, store *sessionstore.Store, opts ...serve.Option) ReadSource {
	return serve.ReadHandler(catalogreader.New(catalog, store), opts...)
}
