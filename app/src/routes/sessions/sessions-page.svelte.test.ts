// Component-level tests for the sessions list route (Task 19), matching
// sdk/svelte's own test approach (sdk/svelte/test/session.test.ts): a
// hand-rolled `LooprigTransport` fake, no real network or BFF involved.
//
// Runs against a real headless Chromium via vitest-browser-svelte +
// @vitest/browser-playwright (see app/vite.config.ts's `test.projects`
// comment for why: Svelte 5 component mounting needs a real DOM, and this is
// the current `sv`/shadcn-svelte CLI's own scaffolded approach as of
// 2026-08-10, not @testing-library/svelte + jsdom).
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { NetworkError } from "@looprig/client";
import type {
	CreateRequest,
	CreateResponse,
	CreateSessionOptions,
	EventJournalPage,
	GateAcceptedResponse,
	GateResponseRequest,
	InputResponse,
	InterruptResponse,
	ListSessionsOptions,
	LooprigTransport,
	ReadHistoryOptions,
	RequestOptions,
	RestoreResponse,
	SessionList,
	SessionStatus,
} from "@looprig/client";
import SessionsPage from "./+page.svelte";

/** Same shape as sdk/svelte's own FakeTransport: each method resolves/rejects whatever the test wires up, defaulting to a promise that never settles. */
class FakeTransport implements LooprigTransport {
	listSessionsResult: Promise<SessionList> = new Promise(() => {});

	listSessions(_options?: ListSessionsOptions): Promise<SessionList> {
		return this.listSessionsResult;
	}
	readStatus(_sessionId: string, _options?: RequestOptions): Promise<SessionStatus> {
		throw new Error("not used by this route");
	}
	readHistory(_sessionId: string, _options?: ReadHistoryOptions): Promise<EventJournalPage> {
		throw new Error("not used by this route");
	}
	createSession(_request?: CreateRequest, _options?: CreateSessionOptions): Promise<CreateResponse> {
		throw new Error("not used by this route");
	}
	restoreSession(_sessionId: string, _options?: RequestOptions): Promise<RestoreResponse> {
		throw new Error("not used by this route");
	}
	submit(_sessionId: string, _request: CreateRequest, _options?: RequestOptions): Promise<InputResponse> {
		throw new Error("not used by this route");
	}
	respondGate(
		_sessionId: string,
		_gateId: string,
		_request: GateResponseRequest,
		_options?: RequestOptions,
	): Promise<GateAcceptedResponse> {
		throw new Error("not used by this route");
	}
	interrupt(_sessionId: string, _options?: RequestOptions): Promise<InterruptResponse> {
		throw new Error("not used by this route");
	}
}

const populatedList: SessionList = {
	sessions: [
		{ session_id: "11111111-1111-1111-1111-111111111111", title: "Fix the parser", state: "idle" },
		{ session_id: "22222222-2222-2222-2222-222222222222", title: "Refactor storage", state: "running" },
	],
	skip: 0,
	limit: 100,
	next_skip: 2,
	done: true,
};

const emptyList: SessionList = { sessions: [], skip: 0, limit: 100, next_skip: 0, done: true };

describe("sessions list route", () => {
	it("renders the loading indicator while the transport call is in flight", async () => {
		const transport = new FakeTransport();
		// listSessionsResult defaults to a never-settling promise, so the
		// component stays in the loading state for the whole test.
		render(SessionsPage, { transport });

		await expect.element(page.getByTestId("sessions-loading")).toBeInTheDocument();
		await expect.element(page.getByText("Loading sessions…")).toBeInTheDocument();
		await expect.element(page.getByTestId("sessions-table")).not.toBeInTheDocument();
		await expect.element(page.getByTestId("sessions-empty")).not.toBeInTheDocument();
		await expect.element(page.getByTestId("sessions-error")).not.toBeInTheDocument();
	});

	it("renders a table with the real session data once loaded", async () => {
		const transport = new FakeTransport();
		transport.listSessionsResult = Promise.resolve(populatedList);
		render(SessionsPage, { transport });

		const table = page.getByTestId("sessions-table");
		await expect.element(table).toBeInTheDocument();
		await expect.element(page.getByText("Fix the parser")).toBeInTheDocument();
		await expect.element(page.getByText("Refactor storage")).toBeInTheDocument();
		await expect.element(page.getByText("idle")).toBeInTheDocument();
		await expect.element(page.getByText("running")).toBeInTheDocument();
		await expect.element(page.getByText("11111111-1111-1111-1111-111111111111")).toBeInTheDocument();

		// Not the loading/empty/error states.
		await expect.element(page.getByTestId("sessions-loading")).not.toBeInTheDocument();
		await expect.element(page.getByTestId("sessions-empty")).not.toBeInTheDocument();
		await expect.element(page.getByTestId("sessions-error")).not.toBeInTheDocument();
	});

	it("renders the distinct empty-state message for a loaded, zero-row catalog — not the table", async () => {
		const transport = new FakeTransport();
		transport.listSessionsResult = Promise.resolve(emptyList);
		render(SessionsPage, { transport });

		await expect.element(page.getByTestId("sessions-empty")).toBeInTheDocument();
		await expect.element(page.getByText("No sessions yet")).toBeInTheDocument();

		// An empty catalog is not an error and not "still loading" — and
		// critically, not just a table with zero rows either.
		await expect.element(page.getByTestId("sessions-table")).not.toBeInTheDocument();
		await expect.element(page.getByTestId("sessions-loading")).not.toBeInTheDocument();
		await expect.element(page.getByTestId("sessions-error")).not.toBeInTheDocument();
	});

	it("renders the typed error's real message, not a generic fallback", async () => {
		const transport = new FakeTransport();
		const failure = new NetworkError("/sessions");
		transport.listSessionsResult = Promise.reject(failure);
		render(SessionsPage, { transport });

		await expect.element(page.getByTestId("sessions-error")).toBeInTheDocument();
		await expect.element(page.getByText(failure.message)).toBeInTheDocument();

		await expect.element(page.getByTestId("sessions-table")).not.toBeInTheDocument();
		await expect.element(page.getByTestId("sessions-empty")).not.toBeInTheDocument();
		await expect.element(page.getByTestId("sessions-loading")).not.toBeInTheDocument();
	});
});
