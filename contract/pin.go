//go:build tools

// Package contract pins the Core module whose published sessionwire schemas
// and fixtures the drift guard compares byte for byte. The guard resolves the
// module rather than importing it, so without this build-tagged import
// `go mod tidy` would drop the pin.
package contract

import _ "github.com/looprig/core/sessionwire/v1"
