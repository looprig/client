// Public barrel export for @looprig/svelte.
//
// Svelte 5 reactivity wrappers over @looprig/client's read-plane transport
// methods. See session.svelte.ts's module comment for the full picture of
// what this package owns (the reactive-wrapper layer) and deliberately does
// not yet build (anything live/SSE, since sdk/core doesn't expose that yet).
export * from "./session.svelte.js";
