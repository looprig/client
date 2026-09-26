import { SessionViewStore } from "@looprig/client";
import { memo } from "react";
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { ControlledLiveSource, toolCallCompleted, toolCallStarted } from "./testing/live.js";
import { useRowCount, useTranscriptRow } from "./use-transcript-row.js";

interface Counters {
  rows: number[];
  container: number;
}

function setup(): { live: ControlledLiveSource; store: SessionViewStore } {
  const transport = new FakeTransport();
  const live = new ControlledLiveSource();
  const store = new SessionViewStore({ journal: transport, sessionId: SID, liveSource: live.source });
  return { live, store };
}

/**
 * `memo` is not incidental: `useTranscriptRow`'s Object.is bail-out only
 * suppresses STORE-driven re-renders, and appending a row re-renders the
 * container, which re-renders every child regardless of what the store did.
 * The two together are the guarantee — a memoized row plus a per-row
 * subscription — and that is exactly how a virtualized list is written.
 */
const Row = memo(function Row({
  store,
  ordinal,
  counters,
}: {
  store: SessionViewStore;
  ordinal: number;
  counters: Counters;
}): React.ReactElement {
  const row = useTranscriptRow(store, ordinal);
  // Counting in the render body is fine here: StrictMode is off in this file,
  // so each commit renders each component exactly once.
  counters.rows.push(ordinal);
  return (
    <li data-testid={`row-${ordinal}`}>
      {row?.kind === "tool" ? `${row.toolName}:${row.status}` : (row?.kind ?? "empty")}
    </li>
  );
});

function Transcript({ store, counters }: { store: SessionViewStore; counters: Counters }): React.ReactElement {
  const count = useRowCount(store);
  counters.container += 1;
  return (
    <ul>
      {Array.from({ length: count }, (_unused, ordinal) => (
        <Row key={ordinal} store={store} ordinal={ordinal} counters={counters} />
      ))}
    </ul>
  );
}

test("completing a tool call re-renders only that row", async () => {
  const { live, store } = setup();
  store.start();

  const counters: Counters = { rows: [], container: 0 };
  const screen = await render(<Transcript store={store} counters={counters} />);

  live.emit(toolCallStarted("t1", "Read"));
  live.emit(toolCallStarted("t2", "Bash"));
  await expect.element(screen.getByTestId("row-1")).toHaveTextContent("Bash:running");

  counters.rows.length = 0;
  counters.container = 0;

  live.emit(toolCallCompleted("t2", { resultPreview: "done" }));
  await expect.element(screen.getByTestId("row-1")).toHaveTextContent("Bash:ok");

  // The whole point. Row 0's object is unchanged, so Object.is bails out of its
  // subscription; the row count is unchanged, so the container bails out too.
  expect(counters.rows).toStrictEqual([1]);
  expect(counters.container).toBe(0);

  store.stop();
});

test("appending a row leaves the rows already on screen alone", async () => {
  const { live, store } = setup();
  store.start();

  const counters: Counters = { rows: [], container: 0 };
  const screen = await render(<Transcript store={store} counters={counters} />);

  live.emit(toolCallStarted("t1", "Read"));
  await expect.element(screen.getByTestId("row-0")).toHaveTextContent("Read:running");

  counters.rows.length = 0;
  counters.container = 0;

  live.emit(toolCallStarted("t2", "Bash"));
  await expect.element(screen.getByTestId("row-1")).toHaveTextContent("Bash:running");

  // The container re-renders because the COUNT changed, and the new row mounts.
  // Row 0 does not: `rows` is appended in place and row 0's object is untouched.
  expect(counters.rows).toStrictEqual([1]);
  expect(counters.container).toBe(1);

  store.stop();
});

test("an ordinal past the end reads as undefined rather than throwing", async () => {
  const { live, store } = setup();
  store.start();

  const counters: Counters = { rows: [], container: 0 };
  const screen = await render(
    <ul>
      <Row store={store} ordinal={42} counters={counters} />
    </ul>,
  );

  // A virtualizer can ask for an ordinal that has not arrived yet.
  await expect.element(screen.getByTestId("row-42")).toHaveTextContent("empty");
  live.emit(toolCallStarted("t1", "Read"));
  await expect.poll(() => store.snapshot().view.rows).toHaveLength(1);
  await expect.element(screen.getByTestId("row-42")).toHaveTextContent("empty");

  store.stop();
});
