<script lang="ts">
	// Session detail / "cold transcript" route (Task 20): renders one page of
	// a session's RAW durable event journal (`StatusEvent[]`, from
	// `LooprigTransport.readHistory` via `SessionHistoryStore` — see
	// sdk/svelte/src/session.svelte.ts's module comment).
	//
	// This is deliberately NOT a folded chat transcript. `StatusEvent` is a
	// thin wrapper — `{ journal_seq, event? }` (contract/schema/
	// status_event.schema.json) — where `event` is the durable wire envelope
	// (contract/schema/event_envelope.schema.json): a `type` discriminator, a
	// schema version `v`, optional producer IDs (session/loop/turn/step/
	// event) and `created_at`, plus a per-type payload the envelope schema
	// deliberately does not constrain further ("Only the envelope-invariant
	// keys are constrained here; the per-type payload is open."). There is no
	// message/tool-card/gate-prompt fold anywhere in this codebase yet —
	// that's Task 23 (event folding, owned by sdk/core) and Task 24
	// (history-live join), both later. Building that logic here would mean
	// inventing throwaway fold logic Task 23 would have to replace, which the
	// design explicitly disallows (sdk/svelte and app must not implement
	// their own history join). So this route renders each journal entry
	// honestly: its known envelope fields as structured data, plus whatever
	// additional (untyped, per the open payload) fields the entry happens to
	// carry, rendered generically as key/value pairs — never as markdown or
	// code, since nothing in this shape is long-form text or source code
	// today. shiki/svelte-exmarkdown are therefore deliberately NOT wired
	// into this route; see the task report for the full reasoning.
	import { untrack } from "svelte";
	import { page } from "$app/state";
	import {
		createBFFClient,
		type EventEnvelope,
		type LooprigTransport,
		type StatusEvent,
	} from "@looprig/client";
	import { SessionHistoryStore } from "@looprig/svelte";
	import { VList } from "virtua/svelte";

	// `sid` is an optional prop, defaulting to the real route param, for
	// exactly the same reason `transport` defaults to a real
	// `createBFFClient()`: it's the seam that lets a component test render
	// this page with a fixed session id directly, without standing up
	// SvelteKit's router (`vitest-browser-svelte`'s `render()` mounts this
	// component in isolation — `$app/state`'s `page.params` has no route
	// context to populate `sid` from in that environment, since no
	// navigation ever occurred).
	let { transport = createBFFClient(), sid }: { transport?: LooprigTransport; sid?: string } =
		$props();

	// `page.params.sid` per SvelteKit's `$app/state` (2.70.x) — the current
	// way to read a reactive route param in a Svelte 5 component. This app is
	// `ssr = false` on an adapter-static SPA fallback (see root +layout.ts
	// and app/vite.config.ts's adapter comment), so there is no server `load`
	// function to read the param from instead.
	//
	// `Page.params`'s static type is `string | undefined` here (not just
	// `string`) because `$app/state`'s `page` export is typed generically
	// over EVERY route's param shape, not narrowed to this one dynamic
	// segment (that narrowing only happens via a route's generated
	// `./$types`, which a param read outside a `load` function doesn't get).
	// SvelteKit guarantees a matched `[sid]` route always populates `sid` at
	// runtime; the `?? ""` fallback exists only to keep this honest for the
	// type checker, not because an empty id is expected in real usage.
	const sessionId = $derived(sid ?? page.params.sid ?? "");

	// Rebuilt whenever `sessionId` changes, so navigating client-side from
	// one session's URL directly to another's re-fetches rather than showing
	// stale data. `transport` is still captured once via `untrack` (mirrors
	// the sessions list route — swapping transports mid-session isn't a real
	// scenario), but unlike that fixed list route, the session id genuinely
	// can change under client-side routing.
	const store = $derived(new SessionHistoryStore(untrack(() => transport), sessionId));

	// Runs on mount, and again whenever `store` becomes a new instance (i.e.
	// `sessionId` changed) — same "$effect calls refresh()" pattern as the
	// sessions list route, generalized to react to the store identity rather
	// than assuming a single store for the component's whole lifetime. Skips
	// the call entirely for the defensive empty-id case above, rather than
	// issuing a request that can only 404.
	$effect(() => {
		if (!sessionId) return;
		void store.refresh();
	});

	/** The envelope-invariant keys constrained by event_envelope.schema.json. Everything else on `event` is that type's open, unconstrained payload. */
	const KNOWN_ENVELOPE_KEYS = new Set([
		"type",
		"v",
		"session_id",
		"loop_id",
		"turn_id",
		"step_id",
		"event_id",
		"created_at",
	]);

	/**
	 * Every key of `event` beyond the envelope-invariant ones above is that
	 * event type's open payload — genuinely untyped from `FromSchema`'s
	 * perspective (the envelope schema has no `additionalProperties: false`),
	 * but still real data on the wire (e.g. `TurnDone`'s `turn_index`, per
	 * contract/fixtures/journal_page.json). Reading it via a narrow cast at
	 * this rendering boundary is the same "explicit serialization boundary"
	 * carve-out CLAUDE.md's strict-typing rule allows elsewhere (ajv
	 * validation, JSON unmarshal) — nothing downstream of this function
	 * treats the values as anything but a display string.
	 */
	function extraFields(event: EventEnvelope | undefined): [string, unknown][] {
		if (!event) return [];
		return Object.entries(event as unknown as Record<string, unknown>).filter(
			([key]) => !KNOWN_ENVELOPE_KEYS.has(key),
		);
	}

	function formatTimestamp(createdAt: string | undefined): string {
		if (!createdAt) return "—";
		const parsed = new Date(createdAt);
		return Number.isNaN(parsed.getTime()) ? createdAt : parsed.toLocaleString();
	}
</script>

<main class="mx-auto max-w-4xl p-6">
	<h1 class="mb-1 text-2xl font-semibold tracking-tight">Session journal</h1>
	<p class="mb-4 font-mono text-xs text-muted-foreground" data-testid="journal-session-id">{sessionId}</p>

	{#if store.loading}
		<!-- Loading state: matches the sessions list route's spinner pattern exactly, for visual consistency across the app. -->
		<div role="status" data-testid="journal-loading" class="flex items-center gap-2 py-8 text-muted-foreground">
			<span
				aria-hidden="true"
				class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
			></span>
			<span>Loading journal…</span>
		</div>
	{:else if store.error}
		<!-- Error state: the typed error's real `.message`, same destructive-box pattern as the sessions list route. -->
		<div
			role="alert"
			data-testid="journal-error"
			class="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-destructive"
		>
			<p class="font-medium">Couldn't load the session journal</p>
			<p class="text-sm">{store.error.message}</p>
		</div>
	{:else if store.events.length === 0}
		<!-- Empty state: a freshly created session genuinely has no journal events yet — a normal outcome, not an error, and never a virtualized list rendering zero (awkward) rows. -->
		<div data-testid="journal-empty" class="rounded-md border border-dashed p-10 text-center text-muted-foreground">
			<p class="font-medium">No journal events yet</p>
			<p class="text-sm">Events will show up here once this session starts recording its journal.</p>
		</div>
	{:else}
		<div data-testid="journal-list" class="overflow-hidden rounded-md border">
			<VList data={store.events} getKey={(item: StatusEvent) => item.journal_seq} style="height: 60vh;">
				{#snippet children(item)}
					<div data-testid="journal-event" class="border-b p-4 last:border-b-0">
						<div class="flex items-center justify-between gap-2">
							<span class="rounded bg-muted px-2 py-0.5 font-mono text-xs font-medium">
								{item.event?.type ?? "unknown event"}
							</span>
							<span class="font-mono text-xs text-muted-foreground">seq {item.journal_seq}</span>
						</div>
						<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
							<dt class="text-muted-foreground">created_at</dt>
							<dd class="font-mono text-xs">{formatTimestamp(item.event?.created_at)}</dd>
							{#if item.event?.turn_id}
								<dt class="text-muted-foreground">turn_id</dt>
								<dd class="font-mono text-xs">{item.event.turn_id}</dd>
							{/if}
							{#if item.event?.step_id}
								<dt class="text-muted-foreground">step_id</dt>
								<dd class="font-mono text-xs">{item.event.step_id}</dd>
							{/if}
							{#if item.event?.loop_id}
								<dt class="text-muted-foreground">loop_id</dt>
								<dd class="font-mono text-xs">{item.event.loop_id}</dd>
							{/if}
							{#if item.event?.event_id}
								<dt class="text-muted-foreground">event_id</dt>
								<dd class="font-mono text-xs">{item.event.event_id}</dd>
							{/if}
							{#each extraFields(item.event) as [key, value] (key)}
								<dt class="text-muted-foreground">{key}</dt>
								<dd class="font-mono text-xs">{JSON.stringify(value)}</dd>
							{/each}
						</dl>
					</div>
				{/snippet}
			</VList>
		</div>
	{/if}
</main>
