<script lang="ts">
	// Session detail route (Task 25): the live-plus-history transcript. This
	// evolves Task 20's route (which rendered the raw, unfolded journal —
	// `StatusEvent[]`, before fold.ts/join.ts existed) into the intended end
	// state: ONE renderer fed by sdk/core's `joinSessionView` (join.ts), which
	// already stitches cold history and the live SSE tail into a single
	// ordered `SessionView` stream with no gap and no duplicate at the
	// boundary (see join.ts's own module comment). There is deliberately no
	// separate "live-only" view and no toggle between cold/live modes — the
	// whole point of the join is that a renderer never needs to know which
	// segment a piece of content came from.
	//
	// `LiveSessionViewStore` (sdk/svelte/src/live-session.svelte.ts) drives
	// the join and republishes each yielded `SessionView` as `$state`; this
	// component's job is purely presentational: turn that `SessionView` into
	// a transcript.
	//
	// ## Why three separate sections, not one merged/interleaved timeline
	//
	// `SessionView` is intentionally NOT a single ordered feed (see fold.ts's
	// own module comment): `content`, `toolCalls`, `queuedInputs`, and
	// `compactions` are separate append-only buckets. Content deltas and
	// ephemeral tool-call/marker frames carry no journal sequence at all (by
	// design — see sse.ts: ephemeral frames are unsequenced), and their
	// `header` (an `EventEnvelope`) has no REQUIRED `created_at` either
	// (event_envelope.schema.json — `created_at` isn't in `required`), so
	// there is no reliable key this component could sort all four buckets
	// into one true chronological order by. Fabricating a merged order from
	// incomplete information would misrepresent data this route doesn't
	// actually have, the same reasoning Task 20's raw-dump route documented
	// for not inventing structure beyond what the wire contract provides.
	// Instead: the growing message transcript (content — the "streaming
	// bubbles" and tool-use construction chips) is the primary, virtualized,
	// autoscrolling list; tool call cards (started -> completed) and
	// queued-input/compaction markers render as their own compact sections
	// below it, each faithful to ITS OWN bucket's real append order.
	import { tick, untrack } from "svelte";
	import { page } from "$app/state";
	import {
		createBFFClient,
		createFetchLiveFrameSource,
		type ContentDelta,
		type LiveFrameSource,
		type LooprigTransport,
	} from "@looprig/client";
	import { LiveSessionViewStore } from "@looprig/svelte";
	import { VList, type VListHandle } from "virtua/svelte";

	// Same override seams as Task 20's route: `transport`/`sid` let a
	// component test render this page without a real backend or SvelteKit
	// router; `liveSource` is the equivalent seam for the live half — a test
	// supplies a fake `LiveFrameSource` (matching join.test.ts's
	// `FakeLiveConnection`/`FakeLiveSource` shape) instead of a real
	// `fetch()`-backed one.
	let {
		transport = createBFFClient(),
		liveSource,
		sid,
	}: { transport?: LooprigTransport; liveSource?: LiveFrameSource; sid?: string } = $props();

	const sessionId = $derived(sid ?? page.params.sid ?? "");

	// Rebuilt whenever `sessionId` (or a test's fixed `liveSource`) changes —
	// same "$derived store, $effect drives its lifecycle" split as Task 20's
	// route, generalized to a start()/stop() subscription instead of a single
	// refresh(). `transport` is captured once via `untrack` (matches Task
	// 20's own reasoning: swapping transports mid-session isn't real).
	// `LooprigTransport` structurally satisfies `JournalReader` (both declare
	// the identical `readHistory` method) — no adapter needed, exactly as
	// join.ts's own `JournalReader` doc comment says.
	const store = $derived(
		new LiveSessionViewStore(
			untrack(() => transport),
			sessionId,
			liveSource ?? createFetchLiveFrameSource(sessionId),
		),
	);

	// `untrack` around both calls is load-bearing, not stylistic: `start()`'s
	// own body reads `this.active` (a `$state` field, for its idempotency
	// guard) before writing it, and `stop()`/the async `pump()` loop write
	// `active`/`view`/etc. too. Svelte 5 tracks EVERY reactive read that
	// happens synchronously during an effect's execution, including reads
	// inside methods it calls — so without `untrack`, this effect would end
	// up implicitly "subscribed" to `store.active` (and friends) purely as a
	// side effect of `start()`'s internal guard reading it, and every later
	// write to that field (from the store's own async pump loop) would
	// reschedule THIS effect, tearing the store down and starting it again
	// in a tight loop. Verified empirically for this task: omitting
	// `untrack` here reproduced Svelte's `effect_update_depth_exceeded`
	// within the first assertion of every test that pushed any live frame.
	$effect(() => {
		if (!sessionId) return;
		atBottom = true;
		untrack(() => store.start());
		return () => untrack(() => store.stop());
	});

	// --- Transcript rows: group consecutive same-kind content deltas into growing bubbles ---

	interface TextBubbleRow {
		kind: "text" | "thinking";
		text: string;
	}
	interface ToolUseChipRow {
		kind: "tool_use";
		id: string;
		name: string;
	}
	type TranscriptRow = TextBubbleRow | ToolUseChipRow;

	/**
	 * Folds `content` (fold.ts's `ContentDelta[]`, one entry per streamed
	 * chunk) into display rows: consecutive `text`/`thinking` chunks of the
	 * SAME kind merge into one growing bubble (the actual "streaming bubble"
	 * UX — a message's text should visibly grow in place as chunks arrive,
	 * not spawn a new bubble per token); a `tool_use` chunk (the model
	 * constructing a tool call's arguments — distinct from `ToolCallCard`'s
	 * execution lifecycle, see fold.ts's own doc comment) becomes a compact
	 * chip, deduplicated against an immediately-preceding chip for the same
	 * tool-call id so a long partial-JSON stream doesn't spam duplicate rows.
	 */
	function buildTranscriptRows(content: ContentDelta[]): TranscriptRow[] {
		const rows: TranscriptRow[] = [];
		for (const delta of content) {
			const last = rows.at(-1);
			if (delta.chunkType === "text" || delta.chunkType === "thinking") {
				if (last?.kind === delta.chunkType) {
					last.text += delta.chunkType === "text" ? delta.text : delta.thinking;
				} else {
					rows.push({ kind: delta.chunkType, text: delta.chunkType === "text" ? delta.text : delta.thinking });
				}
			} else {
				// chunkType === "tool_use"
				if (last?.kind === "tool_use" && last.id === delta.id) continue;
				rows.push({ kind: "tool_use", id: delta.id, name: delta.name });
			}
		}
		return rows;
	}

	const transcriptRows = $derived(buildTranscriptRows(store.view.content));

	// --- Stick-to-bottom autoscroll ---
	//
	// New content should auto-scroll into view UNLESS the user has manually
	// scrolled up to read earlier history — forcing scroll-to-bottom
	// unconditionally on every update would yank the viewport out from under
	// someone mid-read, a common and specifically-flagged streaming-chat UX
	// mistake. `atBottom` tracks whether the viewport is currently (near) the
	// latest row; only when it's true does a new row pull the view down with
	// it. A real user scroll (up OR back down again) is what flips this flag
	// via `handleScroll`, driven by virtua's own `onscroll` callback — not
	// re-derived from `transcriptRows` itself, so the flag reflects genuine
	// scroll position, not row count.
	let vlistHandle: VListHandle | undefined = $state();
	let atBottom = $state(true);
	/** Slack (pixels) for "close enough to the bottom to count as stuck," absorbing sub-pixel/rounding drift from virtua's own remeasurement after each scrollToIndex. */
	const STICK_TO_BOTTOM_SLACK_PX = 48;

	function handleScroll(offset: number): void {
		if (!vlistHandle) return;
		const distanceFromBottom = vlistHandle.getScrollSize() - vlistHandle.getViewportSize() - offset;
		atBottom = distanceFromBottom <= STICK_TO_BOTTOM_SLACK_PX;
	}

	// This effect's ONLY reactive dependency is `rowCount` — `atBottom` is
	// read via `untrack` deliberately. Reading it reactively would create a
	// feedback loop: `scrollToIndex` below triggers a real scroll, which
	// fires virtua's `onscroll` -> `handleScroll` -> writes `atBottom` ->
	// (if read reactively) reruns THIS effect again, which can scroll again,
	// generate another scroll event, etc. — this hit Svelte's
	// `effect_update_depth_exceeded` guard empirically before this fix.
	// Depending only on `rowCount` means this effect fires exactly once per
	// new row (a real content-growth event), and each run makes its own
	// fresh, one-time read of whatever `atBottom` happens to be at that
	// instant — genuine user-driven scroll changes still take effect on the
	// NEXT row, they just don't retrigger this effect on their own.
	$effect(() => {
		const rowCount = transcriptRows.length;
		if (rowCount === 0 || !untrack(() => atBottom)) return;
		// Wait for virtua to have re-rendered/remeasured the new row before
		// asking it to scroll to it — scrollToIndex against a not-yet-mounted
		// index would be a no-op.
		void tick().then(() => {
			if (!untrack(() => atBottom)) return; // the user may have scrolled up while this tick was pending
			vlistHandle?.scrollToIndex(rowCount - 1, { align: "end" });
		});
	});
</script>

<main class="mx-auto flex max-w-4xl flex-col gap-6 p-6">
	<div>
		<div class="mb-1 flex items-center gap-2">
			<h1 class="text-2xl font-semibold tracking-tight">Session transcript</h1>
			<span
				data-testid="live-status"
				class="rounded-full px-2 py-0.5 text-xs font-medium {store.active
					? 'bg-emerald-500/15 text-emerald-600'
					: 'bg-muted text-muted-foreground'}"
			>
				{store.active ? "Live" : "Disconnected"}
			</span>
		</div>
		<p class="font-mono text-xs text-muted-foreground" data-testid="transcript-session-id">{sessionId}</p>
	</div>

	{#if store.error}
		<div
			role="alert"
			data-testid="transcript-error"
			class="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-destructive"
		>
			<p class="font-medium">The live session connection failed</p>
			<p class="text-sm">{store.error.message}</p>
		</div>
	{/if}

	{#if transcriptRows.length === 0}
		<div data-testid="transcript-empty" class="rounded-md border border-dashed p-10 text-center text-muted-foreground">
			<p class="font-medium">No messages yet</p>
			<p class="text-sm">Content will appear here as the session runs.</p>
		</div>
	{:else}
		<div data-testid="transcript-list" class="overflow-hidden rounded-md border">
			<VList
				bind:this={vlistHandle}
				id="transcript-scroll"
				role="log"
				data={transcriptRows}
				getKey={(_item, index) => index}
				onscroll={handleScroll}
				style="height: 420px;"
			>
				{#snippet children(row)}
					{#if row.kind === "text" || row.kind === "thinking"}
						<div
							data-testid="transcript-bubble"
							data-chunk-type={row.kind}
							class="border-b p-4 last:border-b-0 {row.kind === 'thinking' ? 'italic text-muted-foreground' : ''}"
						>
							<p class="whitespace-pre-wrap text-sm">{row.text}</p>
						</div>
					{:else if row.kind === "tool_use"}
						<div data-testid="transcript-tool-use-chip" class="border-b p-4 text-xs text-muted-foreground last:border-b-0">
							Constructing tool call: <span class="font-mono">{row.name}</span>
						</div>
					{/if}
				{/snippet}
			</VList>
		</div>
	{/if}

	{#if store.view.toolCalls.length > 0}
		<section data-testid="tool-calls" aria-label="Tool calls">
			<h2 class="mb-2 text-sm font-semibold text-muted-foreground">Tool calls</h2>
			<div class="flex flex-col gap-2">
				{#each store.view.toolCalls as card, index (index)}
					<div data-testid="tool-call-card" data-status={card.status} class="rounded-md border p-3 text-sm">
						<div class="flex items-center justify-between gap-2">
							<span class="font-mono text-xs font-medium">{card.toolName ?? "unknown tool"}</span>
							<span
								data-testid="tool-call-status"
								class="rounded px-2 py-0.5 text-xs {card.status === 'completed'
									? card.isError
										? 'bg-destructive/15 text-destructive'
										: 'bg-emerald-500/15 text-emerald-600'
									: 'bg-amber-500/15 text-amber-600'}"
							>
								{card.status === "completed" ? (card.isError ? "failed" : "completed") : "started"}
							</span>
						</div>
						{#if card.summary}
							<p class="mt-1 text-xs text-muted-foreground">{card.summary}</p>
						{/if}
						{#if card.resultPreview}
							<p class="mt-1 font-mono text-xs">{card.resultPreview}</p>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/if}

	{#if store.view.queuedInputs.length > 0 || store.view.compactions.length > 0}
		<section data-testid="markers" aria-label="Session markers" class="flex flex-col gap-2">
			{#each store.view.queuedInputs as marker, index (index)}
				<div data-testid="queued-input-marker" class="rounded border border-dashed px-3 py-1 text-xs text-muted-foreground">
					Input queued{marker.header?.created_at ? ` — ${marker.header.created_at}` : ""}
				</div>
			{/each}
			{#each store.view.compactions as marker, index (index)}
				<div data-testid="compaction-marker" class="rounded border border-dashed px-3 py-1 text-xs text-muted-foreground">
					Compaction started (attempt {marker.attemptId})
				</div>
			{/each}
		</section>
	{/if}
</main>
