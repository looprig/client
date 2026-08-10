// This app is only ever a client-side-rendered SPA — served statically by
// the Go BFF (pkg/webui) today, and later by the Wails v3 shell (Phase 5).
// None of SvelteKit's SSR/server features are in play; SvelteKit here is
// purely the router/build/tooling host. Disabling ssr means every route
// renders in the browser only, which is also what lets adapter-static's
// `fallback` (see vite.config.ts) serve one shell for arbitrary
// non-prerenderable routes like /sessions/{sid}.
export const ssr = false;
