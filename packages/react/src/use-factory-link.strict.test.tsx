import { useEffect } from "react";
import { createFactoryClient } from "@looprig/client";
import type {
  EnduringPublication,
  FactoryClient,
  FactoryClientOptions,
  FactoryCredentials,
} from "@looprig/client";
import { expect, test } from "vitest";
import { FakeClientLink } from "./testing/fake-link.js";
import { renderStrict } from "./testing/strict.js";
import {
  FactoryLinkProvider,
  useFactoryClient,
  useFactoryLinkStatus,
  useSessionBinding,
} from "./use-connection.js";

const TENANT = "tenant-1";

function enduring(sessionId: string, sequence: number): EnduringPublication {
  return {
    type: "enduring_publication",
    tenant_id: TENANT,
    session_id: sessionId,
    event_id: `event-${sequence}`,
    journal_seq: sequence,
    covered_through: sequence,
    body: { kind: "text" },
  };
}

interface Harness {
  readonly link: FakeClientLink;
  /** How many times the provider constructed a Factory client. */
  clientCalls: number;
  /** The credentials object the link was constructed with. */
  linkCredentials: FactoryCredentials | undefined;
  /** The options the provider constructed the client from. */
  clientOptions: FactoryClientOptions | undefined;
  create(options: FactoryClientOptions): FactoryClient;
}

function harness(): Harness {
  const link = new FakeClientLink();
  const state: Harness = {
    link,
    clientCalls: 0,
    linkCredentials: undefined,
    clientOptions: undefined,
    create(options: FactoryClientOptions): FactoryClient {
      state.clientCalls += 1;
      state.clientOptions = options;
      return createFactoryClient({
        ...options,
        clientLinkFactory: (linkOptions) => {
          state.linkCredentials = linkOptions?.credentials;
          return link;
        },
      });
    },
  };
  return state;
}

interface ViewProbe {
  readonly seen: string[];
  readonly mounts: string[];
  readonly cleanups: string[];
  readonly clients: FactoryClient[];
}

function probe(): ViewProbe {
  return { seen: [], mounts: [], cleanups: [], clients: [] };
}

function SessionView({ sessionId, on }: { sessionId: string; on: ViewProbe }): null {
  const client = useFactoryClient();
  useSessionBinding({
    tenantId: TENANT,
    sessionId,
    onPublication: (publication) => {
      on.seen.push(`${sessionId}:${(publication as EnduringPublication).journal_seq}`);
    },
    onReset: () => {},
  });
  // Not part of the subject: this counts the effect passes React actually ran,
  // so a test that claims "mount, unmount, remount" can show it happened rather
  // than assume StrictMode is switched on.
  const { mounts, cleanups, clients } = on;
  useEffect(() => {
    mounts.push(sessionId);
    clients.push(client);
    return () => {
      cleanups.push(sessionId);
    };
  }, [sessionId, mounts, cleanups, clients, client]);
  return null;
}

test("two session views under one provider share one client and one link", async () => {
  const h = harness();
  const seen = probe();
  await renderStrict(
    <FactoryLinkProvider create={h.create}>
      <SessionView sessionId="session-a" on={seen} />
      <SessionView sessionId="session-b" on={seen} />
    </FactoryLinkProvider>,
  );

  await expect.poll(() => h.link.open.length).toBe(2);
  expect(h.clientCalls).toBe(1);
  expect(h.link.maxLiveConnections).toBe(1);
  expect(h.link.open.map((s) => s.sessionId).sort()).toEqual(["session-a", "session-b"]);
  expect(new Set(seen.clients).size).toBe(1);
});

test("a StrictMode mount, unmount and remount opens one subscription per view", async () => {
  const h = harness();
  const seen = probe();
  await renderStrict(
    <FactoryLinkProvider create={h.create}>
      <SessionView sessionId="session-a" on={seen} />
      <SessionView sessionId="session-b" on={seen} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(2);

  // The cycle really happened: each view's own effect mounted twice and was
  // torn down once in between.
  expect(seen.mounts).toEqual(["session-a", "session-b", "session-a", "session-b"]);
  expect(seen.cleanups).toEqual(["session-a", "session-b"]);

  // ... and it still left exactly one subscription per view, never two.
  expect(h.link.subscriptions).toHaveLength(2);
  expect(h.link.maxLiveConnections).toBe(1);

  for (const subscription of h.link.open) subscription.deliver(enduring(subscription.sessionId, 5));
  expect(seen.seen.sort()).toEqual(["session-a:5", "session-b:5"]);
});

test("unmounting the provider cancels every binding exactly once", async () => {
  const h = harness();
  const seen = probe();
  const rendered = await renderStrict(
    <FactoryLinkProvider create={h.create}>
      <SessionView sessionId="session-a" on={seen} />
      <SessionView sessionId="session-b" on={seen} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(2);
  const opened = h.link.subscriptions.length;

  await rendered.unmount();

  expect(h.link.subscriptions).toHaveLength(opened);
  expect(h.link.subscriptions.map((s) => s.unsubscribeCount)).toEqual(Array<number>(opened).fill(1));
  expect(h.link.liveConnections).toBe(0);
});

test("one view unmounting leaves its peer subscribed", async () => {
  const h = harness();
  const seen = probe();
  const rendered = await renderStrict(
    <FactoryLinkProvider create={h.create}>
      <SessionView sessionId="session-a" on={seen} />
      <SessionView sessionId="session-b" on={seen} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(2);

  await rendered.rerender(
    <FactoryLinkProvider create={h.create}>
      <SessionView sessionId="session-a" on={seen} />
    </FactoryLinkProvider>,
  );

  await expect.poll(() => h.link.open.map((s) => s.sessionId)).toEqual(["session-a"]);
  expect(h.link.forSession("session-b").map((s) => s.unsubscribeCount)).toEqual([1]);
  expect(h.link.liveConnections).toBe(1);
});

test("the link mints a token from the current credentials, not the mounted ones", async () => {
  const h = harness();
  const seen = probe();
  const first: FactoryCredentials = { connectionToken: () => Promise.resolve("token-1") };
  const second: FactoryCredentials = { connectionToken: () => Promise.resolve("token-2") };
  const rendered = await renderStrict(
    <FactoryLinkProvider create={h.create} credentials={first}>
      <SessionView sessionId="session-a" on={seen} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(1);
  await expect(h.linkCredentials?.connectionToken?.()).resolves.toBe("token-1");

  await rendered.rerender(
    <FactoryLinkProvider create={h.create} credentials={second}>
      <SessionView sessionId="session-a" on={seen} />
    </FactoryLinkProvider>,
  );

  await expect(h.linkCredentials?.connectionToken?.()).resolves.toBe("token-2");
  expect(h.clientCalls).toBe(1);
});

test("a credential capability absent at mount is not installed later", async () => {
  const h = harness();
  const seen = probe();
  const rendered = await renderStrict(
    <FactoryLinkProvider create={h.create} credentials={{}}>
      <SessionView sessionId="session-a" on={seen} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(1);
  expect(h.linkCredentials?.connectionToken).toBeUndefined();
  const captured = h.linkCredentials;

  await rendered.rerender(
    <FactoryLinkProvider
      create={h.create}
      credentials={{ connectionToken: () => Promise.resolve("late") }}
    >
      <SessionView sessionId="session-a" on={seen} />
    </FactoryLinkProvider>,
  );

  // Re-reading `h.linkCredentials?.connectionToken` here would be REDUNDANT,
  // not vacuous: `create` reassigns `h.linkCredentials`, and the rerender's
  // credentials do carry a `connectionToken`, so a second `create` would make
  // that re-read fail. It is implied by the assertion above together with the
  // two below — same credentials object, no second `create` — and the only
  // route a late capability has is that second `create`, so that is what is
  // observed directly.
  expect(h.clientCalls).toBe(1);
  expect(h.linkCredentials).toBe(captured);
});

test("REST headers are read from the current credentials on every request", async () => {
  const h = harness();
  const seen = probe();
  const rendered = await renderStrict(
    <FactoryLinkProvider create={h.create} credentials={{ restHeaders: () => ({ a: "1" }) }}>
      <SessionView sessionId="session-a" on={seen} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(1);
  await expect(Promise.resolve(h.linkCredentials?.restHeaders?.())).resolves.toEqual({ a: "1" });

  await rendered.rerender(
    <FactoryLinkProvider create={h.create} credentials={{ restHeaders: () => ({ a: "2" }) }}>
      <SessionView sessionId="session-a" on={seen} />
    </FactoryLinkProvider>,
  );

  await expect(Promise.resolve(h.linkCredentials?.restHeaders?.())).resolves.toEqual({ a: "2" });
});

/** A view that records its rejoins and advances its own cursor. */
function CursorView({
  sessionId,
  advanceTo,
  rejoins,
}: {
  sessionId: string;
  advanceTo: number;
  rejoins: number[];
}): null {
  const binding = useSessionBinding({
    tenantId: TENANT,
    sessionId,
    onPublication: () => {},
    onReset: () => {},
    onRejoin: (cursor) => rejoins.push(cursor),
  });
  useEffect(() => {
    binding.advance(advanceTo);
  }, [binding, advanceTo]);
  return null;
}

test("a re-rendered view delivers to its current handler without resubscribing", async () => {
  const h = harness();
  const before = probe();
  const after = probe();
  const rendered = await renderStrict(
    <FactoryLinkProvider create={h.create}>
      <SessionView sessionId="session-a" on={before} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(1);
  const opened = h.link.subscriptions.length;

  await rendered.rerender(
    <FactoryLinkProvider create={h.create}>
      <SessionView sessionId="session-a" on={after} />
    </FactoryLinkProvider>,
  );
  for (const subscription of h.link.open) subscription.deliver(enduring("session-a", 11));

  expect(after.seen).toEqual(["session-a:11"]);
  expect(before.seen).toEqual([]);
  expect(h.link.subscriptions).toHaveLength(opened);
});

// Enumerated: a single value cannot tell a cursor that is carried from one that
// is reported as whatever the last `advance` happened to be.
for (const [advances, expected] of [
  [[7], 7],
  [[7, 3], 7],
  [[2, 9], 9],
] as const) {
  test(`a view that advances over ${advances.join(",")} rejoins at ${expected}`, async () => {
    const h = harness();
    const rejoins: number[] = [];
    const rendered = await renderStrict(
      <FactoryLinkProvider create={h.create}>
        <CursorView sessionId="session-a" advanceTo={advances[0]} rejoins={rejoins} />
      </FactoryLinkProvider>,
    );
    await expect.poll(() => h.link.open.length).toBe(1);
    for (const next of advances.slice(1)) {
      await rendered.rerender(
        <FactoryLinkProvider create={h.create}>
          <CursorView sessionId="session-a" advanceTo={next} rejoins={rejoins} />
        </FactoryLinkProvider>,
      );
    }

    h.link.drop();

    await expect.poll(() => rejoins).toEqual([expected]);
  });
}

test("useFactoryLinkStatus renders the link's connection state", async () => {
  const h = harness();
  h.link.holdConnect = true;
  const states: string[] = [];
  function StatusView(): null {
    const status = useFactoryLinkStatus();
    states.push(`${status.state}:${status.bindingCount}`);
    return null;
  }
  await renderStrict(
    <FactoryLinkProvider create={h.create}>
      <StatusView />
      <SessionView sessionId="session-a" on={probe()} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => states.at(-1)).toBe("connecting:1");

  h.link.settleConnect();

  await expect.poll(() => states.at(-1)).toBe("connected:1");
});

// The `cursor` option is the view's starting point and the only thing a rebind
// can resume from; enumerated because one value cannot tell "carried" from
// "happens to be the number the fixture used".
for (const cursor of [0, 1, 12]) {
  test(`a view opened at cursor ${cursor} rejoins there`, async () => {
    const h = harness();
    const rejoins: number[] = [];
    function Opened(): null {
      useSessionBinding({
        tenantId: TENANT,
        sessionId: "session-a",
        cursor,
        onPublication: () => {},
        onReset: () => {},
        onRejoin: (at) => rejoins.push(at),
      });
      return null;
    }
    await renderStrict(
      <FactoryLinkProvider create={h.create}>
        <Opened />
      </FactoryLinkProvider>,
    );
    await expect.poll(() => h.link.open.length).toBe(1);

    h.link.drop();

    await expect.poll(() => rejoins).toEqual([cursor]);
  });
}

test("the handle reports the cursor the binding is holding", async () => {
  const h = harness();
  const seen: number[] = [];
  function Reporting(): null {
    const binding = useSessionBinding({
      tenantId: TENANT,
      sessionId: "session-a",
      cursor: 4,
      onPublication: () => {},
      onReset: () => {},
    });
    useEffect(() => {
      seen.push(binding.cursor);
      binding.advance(9);
      seen.push(binding.cursor);
      binding.advance(2);
      seen.push(binding.cursor);
    }, [binding]);
    return null;
  }
  await renderStrict(
    <FactoryLinkProvider create={h.create}>
      <Reporting />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(1);

  expect(seen).toEqual([4, 9, 9, 4, 9, 9]);
});

test("the provider passes its client options through to the Factory client", async () => {
  const h = harness();
  await renderStrict(
    <FactoryLinkProvider create={h.create} options={{ baseUrl: "https://factory.example" }}>
      <SessionView sessionId="session-a" on={probe()} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(1);

  expect(h.clientOptions?.baseUrl).toBe("https://factory.example");
});

test("every link credential the caller supplies is forwarded live", async () => {
  const h = harness();
  const build = (suffix: string): FactoryCredentials => ({
    connectionToken: () => Promise.resolve(`connection-${suffix}`),
    subscriptionToken: (context) => Promise.resolve(`${context.channel}-${suffix}`),
    subscriptionData: (context) => Promise.resolve({ channel: context.channel, suffix }),
  });
  const rendered = await renderStrict(
    <FactoryLinkProvider create={h.create} credentials={build("1")}>
      <SessionView sessionId="session-a" on={probe()} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(1);
  const context = { channel: "session:tenant-1:session-a" };
  await expect(h.linkCredentials?.connectionToken?.()).resolves.toBe("connection-1");
  await expect(h.linkCredentials?.subscriptionToken?.(context)).resolves.toBe(
    "session:tenant-1:session-a-1",
  );
  await expect(h.linkCredentials?.subscriptionData?.(context)).resolves.toEqual({
    channel: "session:tenant-1:session-a",
    suffix: "1",
  });

  await rendered.rerender(
    <FactoryLinkProvider create={h.create} credentials={build("2")}>
      <SessionView sessionId="session-a" on={probe()} />
    </FactoryLinkProvider>,
  );

  await expect(h.linkCredentials?.connectionToken?.()).resolves.toBe("connection-2");
  await expect(h.linkCredentials?.subscriptionToken?.(context)).resolves.toBe(
    "session:tenant-1:session-a-2",
  );
  await expect(h.linkCredentials?.subscriptionData?.(context)).resolves.toEqual({
    channel: "session:tenant-1:session-a",
    suffix: "2",
  });
});

test("a credential the caller withdraws fails rather than minting a stale one", async () => {
  const h = harness();
  const rendered = await renderStrict(
    <FactoryLinkProvider
      create={h.create}
      credentials={{
        connectionToken: () => Promise.resolve("first"),
        subscriptionToken: () => Promise.resolve("first"),
        subscriptionData: () => Promise.resolve("first"),
      }}
    >
      <SessionView sessionId="session-a" on={probe()} />
    </FactoryLinkProvider>,
  );
  await expect.poll(() => h.link.open.length).toBe(1);

  await rendered.rerender(
    <FactoryLinkProvider create={h.create} credentials={{}}>
      <SessionView sessionId="session-a" on={probe()} />
    </FactoryLinkProvider>,
  );

  const context = { channel: "session:tenant-1:session-a" };
  await expect(h.linkCredentials?.connectionToken?.()).rejects.toThrow(
    "no connection token provider",
  );
  await expect(h.linkCredentials?.subscriptionToken?.(context)).rejects.toThrow(
    "no subscription token provider",
  );
  await expect(h.linkCredentials?.subscriptionData?.(context)).rejects.toThrow(
    "no subscription data provider",
  );
});

test("a Factory hook outside the provider says so", async () => {
  function Orphan(): null {
    useFactoryClient();
    return null;
  }
  await expect(renderStrict(<Orphan />)).rejects.toThrowError(
    "a Factory hook requires a <FactoryLinkProvider> above it",
  );
});
