<script lang="ts">
	// Session list route (Task 19): a shadcn-svelte data table over
	// `LooprigTransport.listSessions`, backed by `SessionListStore`
	// (sdk/svelte/src/session.svelte.ts — see its module comment for the
	// store's own loading/error/data contract).
	//
	// `transport` is an optional prop, defaulting to a real `createBFFClient()`
	// (same-origin `/api/v1/...` calls, per sdk/core/src/transport.ts) so this
	// route genuinely calls the BFF when actually run against a live backend.
	// A component test renders this page with a fake `LooprigTransport`
	// instead — this prop is the seam that makes that possible without a
	// module-level mock.
	import { untrack } from "svelte";
	import { createBFFClient, type LooprigTransport } from "@looprig/client";
	import { SessionListStore } from "@looprig/svelte";
	import * as Table from "$lib/components/ui/table/index.js";

	let { transport = createBFFClient() }: { transport?: LooprigTransport } = $props();

	// `untrack` because this constructor call is deliberately a one-time
	// read of the prop's initial value, not a reactive dependency: this
	// route builds exactly one SessionListStore for its lifetime (swapping
	// transports mid-session isn't a real scenario), so silently capturing
	// only the initial value is the intended behavior, not the bug Svelte's
	// state_referenced_locally warning is meant to catch.
	const store = new SessionListStore(untrack(() => transport));

	// Runs once on mount (transport is captured once via the prop default /
	// the constructor call above, so this effect's only dependency is the
	// store instance itself, which never changes across the component's
	// lifetime) and again any time a caller wants a fresh page by calling
	// `store.refresh()` directly — this effect only covers the initial load.
	$effect(() => {
		void store.refresh();
	});
</script>

<main class="mx-auto max-w-4xl p-6">
	<h1 class="mb-4 text-2xl font-semibold tracking-tight">Sessions</h1>

	{#if store.loading}
		<!--
			Loading state: distinct from the empty state below (a spinner +
			"Loading" text, no border/box), and distinct from the table (no
			rows are ever rendered while this branch is active).
		-->
		<div role="status" data-testid="sessions-loading" class="flex items-center gap-2 py-8 text-muted-foreground">
			<span
				aria-hidden="true"
				class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
			></span>
			<span>Loading sessions…</span>
		</div>
	{:else if store.error}
		<!--
			Error state: the typed error's own `.message` (see sdk/core's
			errors.ts — every LooprigTransport rejection is a real Error
			subclass with a populated `.message`), not a generic fallback
			string. `role="alert"` + a distinct destructive-colored box make
			this structurally different from both the loading spinner and the
			empty-state placeholder.
		-->
		<div
			role="alert"
			data-testid="sessions-error"
			class="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-destructive"
		>
			<p class="font-medium">Couldn't load sessions</p>
			<p class="text-sm">{store.error.message}</p>
		</div>
	{:else if store.sessions.length === 0}
		<!--
			Empty state: a loaded, zero-row catalog is a normal outcome, not an
			error — rendered as its own dashed placeholder box, never the bare
			Table.Root with no rows (which would be visually indistinguishable
			from "still loading" or "one column header and nothing else").
		-->
		<div data-testid="sessions-empty" class="rounded-md border border-dashed p-10 text-center text-muted-foreground">
			<p class="font-medium">No sessions yet</p>
			<p class="text-sm">Sessions you start will show up here.</p>
		</div>
	{:else}
		<div data-testid="sessions-table">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Title</Table.Head>
						<Table.Head>State</Table.Head>
						<Table.Head>Session ID</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each store.sessions as session (session.session_id)}
						<Table.Row>
							<Table.Cell>{session.title ?? "Untitled session"}</Table.Cell>
							<Table.Cell>{session.state ?? "—"}</Table.Cell>
							<Table.Cell class="font-mono text-xs text-muted-foreground">{session.session_id}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</main>
