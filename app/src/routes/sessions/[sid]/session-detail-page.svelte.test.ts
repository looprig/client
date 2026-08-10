// Component-level tests for the session detail / "cold transcript" route
// (Task 20), matching the sessions list route's own test approach
// (../sessions-page.svelte.test.ts): a hand-rolled `LooprigTransport` fake,
// no real network or BFF involved.
//
// Verified empirically (2026-08-10): `vitest-browser-svelte`'s `render()`
// mounts `+page.svelte` directly, with no SvelteKit router in play, so
// `$app/state`'s `page.params` is never populated the way real navigation
// would populate it — a first attempt at this test relying on that
// (asserting against the real route param) left every state stuck on
// "empty" because the effect's `sessionId` guard never passed. The fix,
// used below: the component takes `sid` as an optional prop (see its own
// prop-default comment), the exact same override seam `transport` already
// has, so tests can supply a fixed session id without a real router.
import { page as browserPage } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { NetworkError } from "@looprig/client";
import type {
	EventJournalPage,
	ListSessionsOptions,
	LooprigTransport,
	ReadHistoryOptions,
	RequestOptions,
	SessionList,
	SessionStatus,
} from "@looprig/client";
import SessionDetailPage from "./+page.svelte";

/** Same shape as the sessions list route's own FakeTransport: each method resolves/rejects whatever the test wires up, defaulting to a promise that never settles. */
class FakeTransport implements LooprigTransport {
	readHistoryResult: Promise<EventJournalPage> = new Promise(() => {});

	listSessions(_options?: ListSessionsOptions): Promise<SessionList> {
		throw new Error("not used by this route");
	}
	readStatus(_sessionId: string, _options?: RequestOptions): Promise<SessionStatus> {
		throw new Error("not used by this route");
	}
	readHistory(_sessionId: string, _options?: ReadHistoryOptions): Promise<EventJournalPage> {
		return this.readHistoryResult;
	}
}

const populatedPage: EventJournalPage = {
	events: [
		{
			journal_seq: 3,
			event: {
				type: "TurnDone",
				v: 1,
				session_id: "11111111-1111-1111-1111-111111111111",
				turn_id: "22222222-2222-2222-2222-222222222222",
				created_at: "2026-07-08T12:00:00Z",
				// `turn_index` is TurnDone's own open payload field, not part of
				// the envelope schema's constrained keys — exercises the
				// generic "extra fields" rendering path.
				turn_index: 1,
			} as EventJournalPage["events"][number]["event"],
		},
		{
			journal_seq: 4,
			event: {
				type: "GateOpened",
				v: 1,
				step_id: "33333333-3333-3333-3333-333333333333",
			},
		},
	],
	next_journal_seq: 5,
	done: false,
};

const emptyPage: EventJournalPage = { events: [], next_journal_seq: 0, done: true };

/**
 * `vitest-browser-svelte`'s `render()` mounts `+page.svelte` in isolation —
 * no SvelteKit router runs, so `$app/state`'s `page.params` never gets
 * populated the way it would under real navigation. Every test passes `sid`
 * explicitly instead, exercising the same override seam `transport` already
 * provides (see the component's own prop-default comment).
 */
const testSid = "44444444-4444-4444-4444-444444444444";

describe("session detail route", () => {
	it("renders the loading indicator while the transport call is in flight", async () => {
		const transport = new FakeTransport();
		// readHistoryResult defaults to a never-settling promise, so the
		// component stays in the loading state for the whole test.
		render(SessionDetailPage, { transport, sid: testSid });

		await expect.element(browserPage.getByTestId("journal-loading")).toBeInTheDocument();
		await expect.element(browserPage.getByText("Loading journal…")).toBeInTheDocument();
		await expect.element(browserPage.getByTestId("journal-list")).not.toBeInTheDocument();
		await expect.element(browserPage.getByTestId("journal-empty")).not.toBeInTheDocument();
		await expect.element(browserPage.getByTestId("journal-error")).not.toBeInTheDocument();
	});

	it("renders the real raw journal events once loaded, including a type-specific open-payload field", async () => {
		const transport = new FakeTransport();
		transport.readHistoryResult = Promise.resolve(populatedPage);
		render(SessionDetailPage, { transport, sid: testSid });

		const list = browserPage.getByTestId("journal-list");
		await expect.element(list).toBeInTheDocument();

		const rows = browserPage.getByTestId("journal-event");
		await expect.element(rows.first()).toBeInTheDocument();

		await expect.element(browserPage.getByText("TurnDone")).toBeInTheDocument();
		await expect.element(browserPage.getByText("seq 3")).toBeInTheDocument();
		await expect.element(browserPage.getByText("GateOpened")).toBeInTheDocument();
		await expect.element(browserPage.getByText("seq 4")).toBeInTheDocument();
		// The untyped, type-specific payload field (`turn_index`) still
		// renders — this route never drops data it doesn't have a named slot
		// for.
		await expect.element(browserPage.getByText("turn_index")).toBeInTheDocument();

		await expect.element(browserPage.getByTestId("journal-loading")).not.toBeInTheDocument();
		await expect.element(browserPage.getByTestId("journal-empty")).not.toBeInTheDocument();
		await expect.element(browserPage.getByTestId("journal-error")).not.toBeInTheDocument();
	});

	it("renders the distinct empty-state message for a loaded session with no journal events yet — not a zero-row list", async () => {
		const transport = new FakeTransport();
		transport.readHistoryResult = Promise.resolve(emptyPage);
		render(SessionDetailPage, { transport, sid: testSid });

		await expect.element(browserPage.getByTestId("journal-empty")).toBeInTheDocument();
		await expect.element(browserPage.getByText("No journal events yet")).toBeInTheDocument();

		await expect.element(browserPage.getByTestId("journal-list")).not.toBeInTheDocument();
		await expect.element(browserPage.getByTestId("journal-loading")).not.toBeInTheDocument();
		await expect.element(browserPage.getByTestId("journal-error")).not.toBeInTheDocument();
	});

	it("renders the typed error's real message, not a generic fallback", async () => {
		const transport = new FakeTransport();
		const failure = new NetworkError("/sessions/x/journal");
		transport.readHistoryResult = Promise.reject(failure);
		render(SessionDetailPage, { transport, sid: testSid });

		await expect.element(browserPage.getByTestId("journal-error")).toBeInTheDocument();
		await expect.element(browserPage.getByText(failure.message)).toBeInTheDocument();

		await expect.element(browserPage.getByTestId("journal-list")).not.toBeInTheDocument();
		await expect.element(browserPage.getByTestId("journal-empty")).not.toBeInTheDocument();
		await expect.element(browserPage.getByTestId("journal-loading")).not.toBeInTheDocument();
	});
});
