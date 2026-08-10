// Public barrel export for @looprig/svelte.
//
// Svelte 5 reactivity wrappers over @looprig/client's transport surface:
// session.svelte.ts's one-shot cold reads, live-session.svelte.ts's ongoing
// live/SSE join (over sdk/core's join.ts + live.ts), and
// interaction.svelte.ts's write path (submit / gate respond). See each of
// those files' own module comment for the reasoning specific to what it
// wraps — this package owns only the reactive-wrapper layer, with no
// parsing/validation/protocol-shape logic of its own.
export * from "./session.svelte.js";
export * from "./live-session.svelte.js";
export * from "./interaction.svelte.js";
