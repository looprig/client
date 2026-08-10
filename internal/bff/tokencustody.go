package bff

// tokencustody.go holds the ONE piece of logic that is literally identical
// across every proxy in this package that injects the BFF's server-side bearer
// token onto an outbound leg: strip whatever Authorization the inbound
// (browser-originated) request carried, then set exactly the configured
// server-side token in its place. proxied.go and events.go each implemented this
// inline before control.go (Task 26) became the third proxy needing it — at that
// point duplicating it a third time risked the three proxies silently diverging
// (e.g. one forgetting the Del, or ordering Set before Del) in security-critical
// code, so it is extracted here and all three now call it. This is a narrow,
// single-purpose helper, not a general "shared proxy" abstraction: it captures
// only the Authorization custody rule, not TLS/transport construction, which
// events.go's own doc comment explains stays deliberately un-shared because the
// two streaming/non-streaming proxy shapes have genuinely different transport
// concerns (see events.go's package doc).

import "net/http"

// setOutboundAuthorization strips any Authorization value h already carries and
// sets exactly "Bearer "+token in its place. Order matters: Del then Set, so no
// inbound value (e.g. a compromised or confused SPA smuggling its own
// Authorization) can survive alongside or instead of the server-side token.
func setOutboundAuthorization(h http.Header, token string) {
	h.Del("Authorization")
	h.Set("Authorization", "Bearer "+token)
}
