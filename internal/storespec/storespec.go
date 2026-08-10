// Package storespec parses config.Config's Store field ("fs:/path",
// "nats://host:4222", ...) into a backend-neutral scheme plus detail, so a
// cmd/ composition root can decide which storage-backend package to import
// and call, without either main.go duplicating ad hoc string-splitting logic
// or a shared package (internal/compose) importing fsstore/natsstore
// itself. Only cmd/ is allowed to import a storage backend package — see
// CLAUDE.md's import-discipline rule and internal/compose's package doc —
// so this package knows the two supported schemes by name but links neither
// backend.
package storespec

import (
	"fmt"
	"strings"
)

// Scheme names a Store spec's storage-backend family.
type Scheme string

const (
	// SchemeFS selects fsstore: Store is "fs:<root>", where <root> is the
	// filesystem directory fsstore.Options.Root should point at.
	SchemeFS Scheme = "fs"
	// SchemeNATS selects natsstore: Store is a full NATS URL, e.g.
	// "nats://host:4222" — the ENTIRE Store value (not just the part after
	// the scheme) is the URL natsstore.Options.URL expects, since "nats://"
	// is itself part of that URL's own syntax. Spec.Raw carries it verbatim.
	SchemeNATS Scheme = "nats"
)

// Spec is a parsed Store value.
type Spec struct {
	// Scheme is the backend family selected by Store's leading "<scheme>:".
	Scheme Scheme
	// Path is the fsstore root: everything after "fs:". Only meaningful for
	// SchemeFS; empty for any other scheme.
	Path string
	// Raw is the original, unparsed Store value. For SchemeNATS this IS the
	// NATS URL to hand to natsstore.Options.URL verbatim.
	Raw string
}

// EmptyStoreError reports that Parse was called with an empty Store value.
// Parse never infers a default backend from silence — an empty Store is a
// caller bug (compose.Build never calls a BackendOpener, and so never
// Parse, unless cfg.Store is non-empty), not a valid spec.
type EmptyStoreError struct{}

func (e *EmptyStoreError) Error() string { return "storespec: store spec is empty" }

// InvalidStoreError reports that Store did not parse as "<scheme>:<rest>" at
// all (no colon present).
type InvalidStoreError struct{ Value string }

func (e *InvalidStoreError) Error() string {
	return fmt.Sprintf("storespec: store spec %q is missing a %q prefix", e.Value, "<scheme>:")
}

// UnknownSchemeError reports a Store value with a well-formed
// "<scheme>:<rest>" shape whose scheme names no backend this package knows.
type UnknownSchemeError struct {
	Value  string
	Scheme string
}

func (e *UnknownSchemeError) Error() string {
	return fmt.Sprintf("storespec: store spec %q has unknown scheme %q (want %q or %q)", e.Value, e.Scheme, SchemeFS, SchemeNATS)
}

// Parse splits raw into a Spec. Fail secure: any shape Parse does not
// explicitly recognize (empty, no scheme, unknown scheme) is a typed error,
// never a silently-guessed default backend.
func Parse(raw string) (Spec, error) {
	if raw == "" {
		return Spec{}, &EmptyStoreError{}
	}
	scheme, rest, ok := strings.Cut(raw, ":")
	if !ok {
		return Spec{}, &InvalidStoreError{Value: raw}
	}
	switch Scheme(scheme) {
	case SchemeFS:
		return Spec{Scheme: SchemeFS, Path: rest, Raw: raw}, nil
	case SchemeNATS:
		return Spec{Scheme: SchemeNATS, Raw: raw}, nil
	default:
		return Spec{}, &UnknownSchemeError{Value: raw, Scheme: scheme}
	}
}
