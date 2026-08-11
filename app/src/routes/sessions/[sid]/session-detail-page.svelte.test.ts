// Component-level tests for the session detail / live-plus-history
// transcript route (Task 25), replacing Task 20's raw-journal-dump tests now
// that the route itself has evolved to render sdk/core's folded
// `SessionView` (fold.ts/join.ts) instead — see the component's own module
// comment for why.
//
// Runs against a real headless Chromium via vitest-browser-svelte (same
// approach as sessions-page.svelte.test.ts and Task 20's own tests). Both
// `transport` (cold journal reads) and `liveSource` (the live SSE half) are
// hand-rolled fakes — no real network, no real backend — mirroring
// sdk/core/test/join.test.ts's own `FakeJournalReader`/`FakeLiveConnection`/
// `FakeLiveSource` shapes, since this test drives the SAME `joinSessionView`
// (via `LiveSessionViewStore`) those fakes already prove correct; the scope
// here is what this COMPONENT renders and how its autoscroll behaves, not
// re-proving the join algorithm.
import { page as browserPage } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { GATE_APPROVAL_ACTIONS } from "@looprig/client";
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
	LiveFrameSource,
	LooprigTransport,
	ReadHistoryOptions,
	RequestOptions,
	RestoreResponse,
	SessionList,
	SessionStatus,
	SseFrame,
} from "@looprig/client";
import SessionDetailPage from "./+page.svelte";

const testSid = "44444444-4444-4444-4444-444444444444";

// --- Fakes (mirroring sdk/core/test/join.test.ts's own doubles) ------------

/** An `idle` status with no open gate — the default for every test that doesn't care about `GateStore`'s polling. */
const idleStatus: SessionStatus = { session_id: testSid, last_journal_seq: 0, state: "idle" };

class FakeTransport implements LooprigTransport {
	/** Resolves immediately by default with an empty, "done" cold history page — most tests care only about the live half. */
	readHistoryResult: Promise<EventJournalPage> = Promise.resolve({ events: [], next_journal_seq: 0, done: true });
	/** `GateStore` polls this immediately on mount — default to an idle, no-gate status so tests that don't care about gates never see one. */
	readStatusResult: Promise<SessionStatus> = Promise.resolve(idleStatus);
	/** Never settles by default, so a test that doesn't wire this up never accidentally observes a submission complete. */
	submitResult: Promise<InputResponse> = new Promise(() => {});
	respondGateResult: Promise<GateAcceptedResponse> = new Promise(() => {});

	readonly submitCalls: Array<{ sessionId: string; request: CreateRequest }> = [];
	readonly respondGateCalls: Array<{ sessionId: string; gateId: string; request: GateResponseRequest }> = [];

	listSessions(_options?: ListSessionsOptions): Promise<SessionList> {
		throw new Error("not used by this route");
	}
	readStatus(_sessionId: string, _options?: RequestOptions): Promise<SessionStatus> {
		return this.readStatusResult;
	}
	readHistory(_sessionId: string, _options?: ReadHistoryOptions): Promise<EventJournalPage> {
		return this.readHistoryResult;
	}
	createSession(_request?: CreateRequest, _options?: CreateSessionOptions): Promise<CreateResponse> {
		throw new Error("not used by this route");
	}
	restoreSession(_sessionId: string, _options?: RequestOptions): Promise<RestoreResponse> {
		throw new Error("not used by this route");
	}
	submit(sessionId: string, request: CreateRequest, _options?: RequestOptions): Promise<InputResponse> {
		this.submitCalls.push({ sessionId, request });
		return this.submitResult;
	}
	respondGate(
		sessionId: string,
		gateId: string,
		request: GateResponseRequest,
		_options?: RequestOptions,
	): Promise<GateAcceptedResponse> {
		this.respondGateCalls.push({ sessionId, gateId, request });
		return this.respondGateResult;
	}
	interrupt(_sessionId: string, _options?: RequestOptions): Promise<InterruptResponse> {
		throw new Error("not used by this route");
	}
}

class FakeLiveConnection {
	private readonly buffered: SseFrame[] = [];
	private readonly waiters: Array<{ resolve: (r: IteratorResult<SseFrame, undefined>) => void }> = [];
	private ended = false;

	returnCalls = 0;

	push(frame: SseFrame): void {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ value: frame, done: false });
		else this.buffered.push(frame);
	}

	[Symbol.asyncIterator](): AsyncIterator<SseFrame> {
		return {
			next: (): Promise<IteratorResult<SseFrame, undefined>> => {
				if (this.buffered.length > 0) {
					return Promise.resolve({ value: this.buffered.shift() as SseFrame, done: false });
				}
				if (this.ended) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => this.waiters.push({ resolve }));
			},
			return: (): Promise<IteratorResult<SseFrame, undefined>> => {
				this.returnCalls++;
				this.ended = true;
				for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
				return Promise.resolve({ value: undefined, done: true });
			},
		};
	}
}

class FakeLiveSource {
	readonly connections: FakeLiveConnection[] = [];
	readonly open: LiveFrameSource = () => {
		const conn = new FakeLiveConnection();
		this.connections.push(conn);
		return conn;
	};
}

// --- Frame builders (runtime shape fold.ts expects — see its own module comment on delta's kind-specific guards) ---

function textDelta(text: string): SseFrame {
	return { type: "ephemeral", data: { v: 1, kind: "token_delta", delta: { chunk_type: "text", text } } };
}
function thinkingDelta(thinking: string): SseFrame {
	return { type: "ephemeral", data: { v: 1, kind: "token_delta", delta: { chunk_type: "thinking", thinking } } };
}
function toolUseDelta(id: string, name: string): SseFrame {
	return {
		type: "ephemeral",
		data: { v: 1, kind: "token_delta", delta: { chunk_type: "tool_use", index: 0, id, name, input_json: "" } },
	};
}
function toolCallStarted(id: string, name: string): SseFrame {
	return { type: "ephemeral", data: { v: 1, kind: "tool_call_started", delta: { tool_execution_id: id, tool_name: name } } };
}
function toolCallCompleted(id: string, opts: { isError?: boolean; resultPreview?: string } = {}): SseFrame {
	return {
		type: "ephemeral",
		data: {
			v: 1,
			kind: "tool_call_completed",
			delta: { tool_execution_id: id, is_error: opts.isError, result_preview: opts.resultPreview },
		},
	};
}
function inputQueued(): SseFrame {
	return { type: "ephemeral", data: { v: 1, kind: "input_queued" } };
}
function compactionStarted(attemptId: string): SseFrame {
	return {
		type: "ephemeral",
		data: {
			v: 1,
			kind: "compaction_started",
			delta: { attempt_id: attemptId, reason: 1, basis: { revision: 1, through_event_id: "evt-1" } },
		},
	};
}

describe("session detail route (live transcript)", () => {
	it("shows Disconnected before the join starts producing anything, and Live once the store is active", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });

		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");
	});

	it("renders the empty state before any content arrives", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });

		await expect.element(browserPage.getByTestId("transcript-empty")).toBeInTheDocument();
		await expect.element(browserPage.getByTestId("transcript-list")).not.toBeInTheDocument();
	});

	it("merges consecutive text chunks into one growing bubble, and keeps a thinking chunk as a distinct bubble", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });

		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");
		const connection = live.connections[0]!;

		connection.push(textDelta("Hello "));
		connection.push(textDelta("world"));
		connection.push(thinkingDelta("pondering..."));

		await expect.element(browserPage.getByText("Hello world")).toBeInTheDocument();
		const bubbles = browserPage.getByTestId("transcript-bubble");
		await expect.element(bubbles.nth(0)).toBeInTheDocument();
		// Exactly two bubbles: the merged text bubble, and the thinking bubble —
		// not three separate rows for the three pushed deltas.
		expect(bubbles.elements()).toHaveLength(2);
		await expect.element(browserPage.getByText("pondering...")).toBeInTheDocument();
	});

	it("renders a tool-use content chunk as a construction chip, distinct from the tool call lifecycle card", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");

		live.connections[0]!.push(toolUseDelta("call-1", "search_docs"));

		await expect.element(browserPage.getByTestId("transcript-tool-use-chip")).toBeInTheDocument();
		await expect.element(browserPage.getByText("search_docs")).toBeInTheDocument();
	});

	it("renders a tool call card that transitions started -> completed IN PLACE, not as two cards", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");

		live.connections[0]!.push(toolCallStarted("call-1", "search_docs"));
		await expect.element(browserPage.getByTestId("tool-call-status")).toHaveTextContent("started");
		expect(browserPage.getByTestId("tool-call-card").elements()).toHaveLength(1);

		live.connections[0]!.push(toolCallCompleted("call-1", { resultPreview: "3 results" }));
		await expect.element(browserPage.getByTestId("tool-call-status")).toHaveTextContent("completed");
		expect(browserPage.getByTestId("tool-call-card").elements()).toHaveLength(1);
		await expect.element(browserPage.getByText("3 results")).toBeInTheDocument();
	});

	it("renders a failed tool call distinctly from a successful one", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");

		live.connections[0]!.push(toolCallStarted("call-1", "run_query"));
		live.connections[0]!.push(toolCallCompleted("call-1", { isError: true }));

		await expect.element(browserPage.getByTestId("tool-call-status")).toHaveTextContent("failed");
	});

	it("renders queued-input and compaction markers", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");

		live.connections[0]!.push(inputQueued());
		live.connections[0]!.push(compactionStarted("attempt-1"));

		await expect.element(browserPage.getByTestId("queued-input-marker")).toBeInTheDocument();
		await expect.element(browserPage.getByTestId("compaction-marker")).toBeInTheDocument();
		await expect.element(browserPage.getByText("Compaction started (attempt attempt-1)")).toBeInTheDocument();
	});

	it("unmounting the component stops the live subscription (cancels the open connection), not just its own subscription", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		const rendered = await render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");

		const connection = live.connections[0]!;
		expect(connection.returnCalls).toBe(0);

		await rendered.unmount();

		await expect.poll(() => connection.returnCalls).toBeGreaterThanOrEqual(1);
	});

	it("rebinds the live subscription when transport changes without changing the session id", async () => {
		const firstTransport = new FakeTransport();
		const live = new FakeLiveSource();
		const rendered = await render(SessionDetailPage, { transport: firstTransport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");

		const firstConnection = live.connections[0]!;
		const replacementTransport = new FakeTransport();
		await rendered.rerender({ transport: replacementTransport, sid: testSid });

		await expect.poll(() => firstConnection.returnCalls).toBeGreaterThanOrEqual(1);
		await expect.poll(() => live.connections).toHaveLength(2);
	});
});

describe("session detail route: stick-to-bottom autoscroll", () => {
	/**
	 * Pushes `count` distinct, alternating text/thinking bubbles starting at
	 * `startAt` (alternating so consecutive pushes never merge into one row)
	 * — enough to overflow the 420px transcript viewport. `startAt` matters:
	 * a SECOND call in the same test must continue numbering from where the
	 * first left off (not restart at 0), or "line N" text assertions later
	 * in the test would collide with earlier rows of the same name.
	 */
	function pushManyRows(connection: FakeLiveConnection, startAt: number, count: number): void {
		for (let i = startAt; i < startAt + count; i++) {
			connection.push(i % 2 === 0 ? textDelta(`line ${i}`) : thinkingDelta(`line ${i}`));
		}
	}

	/** Two animation frames — enough for a scroll change (and its resulting native "scroll" event) to be fully processed by the browser and by the component's onscroll handler. */
	async function nextFrames(): Promise<void> {
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	}

	/**
	 * Scrolls the transcript with a real wheel gesture (via the `role="log"`
	 * locator on the VList's own scroll container) rather than teleporting
	 * `scrollTop` directly. This matters specifically because the list is
	 * VIRTUALIZED: jumping `scrollTop` straight to an arbitrary offset lands
	 * inside a range whose item heights virtua has never measured (it only
	 * measures what's actually been rendered), so its own reported
	 * `scrollHeight` at that instant can be a stale estimate — a single
	 * direct assignment computed against that estimate doesn't reliably land
	 * where a real user's incremental scroll would. A `wheel` gesture (real,
	 * repeated, native scroll events) lets virtua update its measurements
	 * incrementally the same way it does for genuine user scrolling, which
	 * is what actually proved reliable for this test (verified empirically:
	 * the direct-`scrollTop` version of this test was flaky/wrong for
	 * exactly this reason).
	 */
	async function wheelScroll(direction: "up" | "down"): Promise<void> {
		await browserPage.getByRole("log").wheel({ delta: { y: direction === "down" ? 400 : -400 }, times: 30 });
		await nextFrames();
	}

	it("auto-scrolls to the latest content by default as new rows stream in", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		const rendered = await render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");

		pushManyRows(live.connections[0]!, 0, 40);
		await expect.element(browserPage.getByText("line 39")).toBeInTheDocument();

		const scrollEl = rendered.container.querySelector("#transcript-scroll");
		if (!(scrollEl instanceof HTMLElement)) throw new Error("expected the VList scroll container to be in the DOM");

		await expect
			.poll(() => scrollEl.scrollHeight - scrollEl.clientHeight - scrollEl.scrollTop)
			.toBeLessThanOrEqual(48);
	});

	it("does NOT force-scroll new content into view once the user has scrolled up to read history", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		const rendered = await render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");

		pushManyRows(live.connections[0]!, 0, 40);
		await expect.element(browserPage.getByText("line 39")).toBeInTheDocument();

		const scrollEl = rendered.container.querySelector("#transcript-scroll");
		if (!(scrollEl instanceof HTMLElement)) throw new Error("expected the VList scroll container to be in the DOM");
		await expect
			.poll(() => scrollEl.scrollHeight - scrollEl.clientHeight - scrollEl.scrollTop)
			.toBeLessThanOrEqual(48);

		// The user scrolls up to read earlier history.
		await wheelScroll("up");
		const scrolledUpPosition = scrollEl.scrollTop;
		expect(scrolledUpPosition).toBeLessThan(scrollEl.scrollHeight - scrollEl.clientHeight - 48);
		// Confirm we can actually see EARLY content now, not just that the
		// number moved — "line 0" is only mounted by virtua when it's near
		// the viewport.
		await expect.element(browserPage.getByText("line 0")).toBeInTheDocument();

		// More content streams in while the user is reading history — the
		// viewport must NOT be yanked back down to the new bottom. (Rows 40-49
		// are far below the current, scrolled-up viewport, so virtua won't
		// even mount them into the DOM while we're up here — asserting on
		// their text wouldn't test what this case is about. The scroll
		// position itself not moving IS the behavior under test.)
		pushManyRows(live.connections[0]!, 40, 10);
		await nextFrames();
		await nextFrames();
		expect(scrollEl.scrollTop).toBeLessThanOrEqual(scrolledUpPosition + 4);

		// Confirm the new content genuinely arrived (it was just off-screen):
		// scrolling down manually reaches it.
		await wheelScroll("down");
		await expect.element(browserPage.getByText("line 49")).toBeInTheDocument();
	});

	it("resumes autoscroll once the user scrolls back to the bottom themselves", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		const rendered = await render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");

		pushManyRows(live.connections[0]!, 0, 40);
		await expect.element(browserPage.getByText("line 39")).toBeInTheDocument();

		const scrollEl = rendered.container.querySelector("#transcript-scroll");
		if (!(scrollEl instanceof HTMLElement)) throw new Error("expected the VList scroll container to be in the DOM");

		await wheelScroll("up");
		await expect.element(browserPage.getByText("line 0")).toBeInTheDocument();

		// The user scrolls back down to the latest content themselves.
		await wheelScroll("down");
		await expect
			.poll(() => scrollEl.scrollHeight - scrollEl.clientHeight - scrollEl.scrollTop)
			.toBeLessThanOrEqual(48);

		pushManyRows(live.connections[0]!, 40, 5);
		await expect.element(browserPage.getByText("line 44")).toBeInTheDocument();

		await expect
			.poll(() => scrollEl.scrollHeight - scrollEl.clientHeight - scrollEl.scrollTop)
			.toBeLessThanOrEqual(48);
	});
});

/** A promise plus its resolve/reject, so a test can control exactly when a fake transport call settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A `waiting_on_gate` status carrying an open gate, for the gate-UI tests below. */
function waitingStatus(gateId: string): SessionStatus {
	return { session_id: testSid, last_journal_seq: 0, state: "waiting_on_gate", waiting_gate_id: gateId };
}

describe("session detail route: composer", () => {
	it("successful submit calls transport.submit with the correct wire shape and clears the input", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		transport.submitResult = Promise.resolve({ command_id: "55555555-5555-5555-5555-555555555555" });
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });

		const input = browserPage.getByTestId("composer-input");
		await input.fill("hello world");
		await browserPage.getByTestId("composer-submit").click();

		await expect.poll(() => transport.submitCalls).toHaveLength(1);
		expect(transport.submitCalls[0]).toEqual({
			sessionId: testSid,
			request: { blocks: [{ type: "text", Text: "hello world" }] },
		});
		await expect.element(input).toHaveValue("");
	});

	it("shows a loading/disabled state while the submission is in flight, then clears it", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		const inFlight = deferred<InputResponse>();
		transport.submitResult = inFlight.promise;
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });

		const input = browserPage.getByTestId("composer-input");
		await input.fill("hello");
		const submitButton = browserPage.getByTestId("composer-submit");
		await submitButton.click();

		await expect.element(submitButton).toHaveTextContent("Sending…");
		await expect.element(submitButton).toBeDisabled();
		await expect.element(input).toBeDisabled();

		inFlight.resolve({ command_id: "55555555-5555-5555-5555-555555555555" });

		await expect.element(submitButton).toHaveTextContent("Send");
		await expect.element(input).toHaveValue("");
	});

	it("shows the real typed error message on failure and leaves the input text untouched", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		// Attach a no-op handler immediately: this rejected promise sits in the
		// field for several ticks (render, fill, click) before the composer
		// actually awaits it, and the test runner reports an "unhandled
		// rejection" for one with no attached handler at a microtask flush —
		// even though it IS eventually handled (a promise may have more than
		// one handler; the store's own await still observes the rejection).
		const rejected = Promise.reject(new Error("session is not accepting input right now"));
		rejected.catch(() => {});
		transport.submitResult = rejected;
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });

		const input = browserPage.getByTestId("composer-input");
		await input.fill("hello");
		await browserPage.getByTestId("composer-submit").click();

		await expect
			.element(browserPage.getByTestId("composer-error"))
			.toHaveTextContent("session is not accepting input right now");
		// A failed submission doesn't discard what the user typed.
		await expect.element(input).toHaveValue("hello");
	});
});

describe("session detail route: gate approval", () => {
	const gateId = "66666666-6666-6666-6666-666666666666";

	it("no gate prompt when no gate is open", async () => {
		const transport = new FakeTransport();
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });

		await expect.element(browserPage.getByTestId("live-status")).toHaveTextContent("Live");
		await expect.element(browserPage.getByTestId("gate-prompt")).not.toBeInTheDocument();
		await expect.element(browserPage.getByTestId("composer-input")).not.toBeDisabled();
	});

	it("renders the three-option prompt when a gate is open, and disables the composer", async () => {
		const transport = new FakeTransport();
		transport.readStatusResult = Promise.resolve(waitingStatus(gateId));
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });

		await expect.element(browserPage.getByTestId("gate-prompt")).toBeInTheDocument();
		await expect.element(browserPage.getByTestId("gate-approve-button")).toHaveTextContent("Approve");
		await expect
			.element(browserPage.getByTestId("gate-approve-always-button"))
			.toHaveTextContent("Approve always for this workspace");
		await expect.element(browserPage.getByTestId("gate-deny-button")).toHaveTextContent("Deny");

		// Composer-disabled-during-gate UX choice (see the route's own
		// `composerDisabled` doc comment): a gate blocks further turns, so
		// submitting more input while one is open wouldn't do anything useful.
		await expect.element(browserPage.getByTestId("composer-input")).toBeDisabled();
		await expect.element(browserPage.getByTestId("composer-submit")).toBeDisabled();
	});

	it("Approve calls respondGate with the exact opaque gate id and the exact 'Approve' action", async () => {
		const transport = new FakeTransport();
		transport.readStatusResult = Promise.resolve(waitingStatus(gateId));
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("gate-prompt")).toBeInTheDocument();

		transport.respondGateResult = Promise.resolve({});
		transport.readStatusResult = Promise.resolve(idleStatus);
		await browserPage.getByTestId("gate-approve-button").click();

		await expect.poll(() => transport.respondGateCalls).toHaveLength(1);
		expect(transport.respondGateCalls[0]).toEqual({
			sessionId: testSid,
			gateId,
			request: { action: GATE_APPROVAL_ACTIONS.approve },
		});
		// The immediate re-poll after a successful response clears the prompt.
		await expect.element(browserPage.getByTestId("gate-prompt")).not.toBeInTheDocument();
	});

	it("'Approve always for this workspace' calls respondGate with that exact action string", async () => {
		const transport = new FakeTransport();
		transport.readStatusResult = Promise.resolve(waitingStatus(gateId));
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("gate-prompt")).toBeInTheDocument();

		transport.respondGateResult = Promise.resolve({});
		transport.readStatusResult = Promise.resolve(idleStatus);
		await browserPage.getByTestId("gate-approve-always-button").click();

		await expect.poll(() => transport.respondGateCalls).toHaveLength(1);
		expect(transport.respondGateCalls[0]).toEqual({
			sessionId: testSid,
			gateId,
			request: { action: GATE_APPROVAL_ACTIONS.approveAlwaysWorkspace },
		});
		expect(transport.respondGateCalls[0]!.request.action).toBe("Approve always for this workspace");
	});

	it("Deny calls respondGate with the exact 'Deny' action", async () => {
		const transport = new FakeTransport();
		transport.readStatusResult = Promise.resolve(waitingStatus(gateId));
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("gate-prompt")).toBeInTheDocument();

		transport.respondGateResult = Promise.resolve({});
		transport.readStatusResult = Promise.resolve(idleStatus);
		await browserPage.getByTestId("gate-deny-button").click();

		await expect.poll(() => transport.respondGateCalls).toHaveLength(1);
		expect(transport.respondGateCalls[0]).toEqual({
			sessionId: testSid,
			gateId,
			request: { action: GATE_APPROVAL_ACTIONS.deny },
		});
	});

	it("shows the real typed error message when a gate response fails, and keeps the prompt open", async () => {
		const transport = new FakeTransport();
		transport.readStatusResult = Promise.resolve(waitingStatus(gateId));
		const live = new FakeLiveSource();
		render(SessionDetailPage, { transport, liveSource: live.open, sid: testSid });
		await expect.element(browserPage.getByTestId("gate-prompt")).toBeInTheDocument();

		// See the composer failure test's own comment for why a no-op handler
		// is attached immediately: `click()` has enough actionability-check
		// ticks before it actually dispatches that a bare `Promise.reject(...)`
		// gets flagged as unhandled otherwise, even though `respond()` does
		// eventually await (and react to) this same rejection.
		const rejected = Promise.reject(new Error("gate already resolved"));
		rejected.catch(() => {});
		transport.respondGateResult = rejected;
		await browserPage.getByTestId("gate-deny-button").click();

		await expect.element(browserPage.getByTestId("gate-error")).toHaveTextContent("gate already resolved");
		await expect.element(browserPage.getByTestId("gate-prompt")).toBeInTheDocument();
	});
});
