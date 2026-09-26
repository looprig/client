import { useEffect } from "react";
import { page, userEvent } from "vitest/browser";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { FactoryBootstrap } from "@looprig/client";
import {
  FactoryIdentityProvider,
  useFactoryClient,
  useFactoryTenantId,
} from "./use-connection.js";
import { FakeClientLink } from "./testing/fake-link.js";
import { createFactoryClient } from "@looprig/client";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Identity({ cleanups }: { cleanups?: string[] }): React.JSX.Element {
  const tenant = useFactoryTenantId();
  const client = useFactoryClient();
  useEffect(() => () => { cleanups?.push(tenant); }, [cleanups, tenant]);
  return <span data-testid="identity" data-client={String(client !== null)}>{tenant}</span>;
}

test("does not expose the Factory scope until bootstrap verifies the tenant", async () => {
  const pending = deferred<FactoryBootstrap>();
  const link = new FakeClientLink();
  const create = vi.fn((options) => createFactoryClient({ ...options, clientLinkFactory: () => link }));
  render(
    <FactoryIdentityProvider
      create={create}
      readBootstrap={() => pending.promise}
      pending={<span data-testid="bootstrap-pending">Identifying…</span>}
    >
      <Identity />
    </FactoryIdentityProvider>,
  );

  await expect.element(page.getByTestId("bootstrap-pending")).toBeInTheDocument();
  await expect.element(page.getByTestId("identity")).not.toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  expect(link.connectCalls).toBe(0);

  pending.resolve({ tenant_id: "tenant-verified" });
  await expect.element(page.getByTestId("identity")).toHaveTextContent("tenant-verified");
  expect(create).toHaveBeenCalledTimes(1);
  await expect.poll(() => link.connectCalls).toBe(1);
});

test("an auth generation change removes the old scope before the new bootstrap settles", async () => {
  const first = deferred<FactoryBootstrap>();
  const second = deferred<FactoryBootstrap>();
  const requests = [first, second];
  const links: FakeClientLink[] = [];
  const cleanups: string[] = [];
  const rendered = await render(
    <FactoryIdentityProvider
      authGeneration={1}
      create={(options) => {
        const link = new FakeClientLink();
        links.push(link);
        return createFactoryClient({ ...options, clientLinkFactory: () => link });
      }}
      readBootstrap={() => requests.shift()!.promise}
      pending={<span data-testid="bootstrap-pending">Identifying…</span>}
    >
      <Identity cleanups={cleanups} />
    </FactoryIdentityProvider>,
  );
  first.resolve({ tenant_id: "tenant-old" });
  await expect.element(page.getByTestId("identity")).toHaveTextContent("tenant-old");

  await rendered.rerender(
    <FactoryIdentityProvider
      authGeneration={2}
      create={(options) => {
        const link = new FakeClientLink();
        links.push(link);
        return createFactoryClient({ ...options, clientLinkFactory: () => link });
      }}
      readBootstrap={() => requests.shift()!.promise}
      pending={<span data-testid="bootstrap-pending">Identifying…</span>}
    >
      <Identity cleanups={cleanups} />
    </FactoryIdentityProvider>,
  );

  await expect.element(page.getByTestId("bootstrap-pending")).toBeInTheDocument();
  await expect.element(page.getByTestId("identity")).not.toBeInTheDocument();
  expect(cleanups).toContain("tenant-old");
  expect(links[0]?.state).toBe("disconnected");

  second.resolve({ tenant_id: "tenant-new" });
  await expect.element(page.getByTestId("identity")).toHaveTextContent("tenant-new");
  expect(links).toHaveLength(2);
});

test("a stale bootstrap success cannot replace the current principal", async () => {
  const stale = deferred<FactoryBootstrap>();
  const current = deferred<FactoryBootstrap>();
  const requests = [stale, current];
  const rendered = await render(
    <FactoryIdentityProvider authGeneration="old" readBootstrap={() => requests.shift()!.promise}>
      <Identity />
    </FactoryIdentityProvider>,
  );
  await rendered.rerender(
    <FactoryIdentityProvider authGeneration="new" readBootstrap={() => requests.shift()!.promise}>
      <Identity />
    </FactoryIdentityProvider>,
  );

  stale.resolve({ tenant_id: "tenant-stale" });
  current.resolve({ tenant_id: "tenant-current" });
  await expect.element(page.getByTestId("identity")).toHaveTextContent("tenant-current");
  await expect.element(page.getByText("tenant-stale")).not.toBeInTheDocument();
});

test("a stale bootstrap failure cannot replace the current principal", async () => {
  const stale = deferred<FactoryBootstrap>();
  const current = deferred<FactoryBootstrap>();
  const requests = [stale, current];
  const rendered = await render(
    <FactoryIdentityProvider authGeneration="old" readBootstrap={() => requests.shift()!.promise}>
      <Identity />
    </FactoryIdentityProvider>,
  );
  await rendered.rerender(
    <FactoryIdentityProvider authGeneration="new" readBootstrap={() => requests.shift()!.promise}>
      <Identity />
    </FactoryIdentityProvider>,
  );

  stale.reject(new Error("late stale denial"));
  current.resolve({ tenant_id: "tenant-current" });
  await expect.element(page.getByTestId("identity")).toHaveTextContent("tenant-current");
  await expect.element(page.getByText("late stale denial")).not.toBeInTheDocument();
});

test("renders bootstrap failure and retries with current credentials", async () => {
  const denied = new Error("not authorized");
  const headers = ["old", "new"];
  const seenHeaders: string[] = [];
  let attempt = 0;
  render(
    <FactoryIdentityProvider
      credentials={{ restHeaders: () => ({ Authorization: headers[attempt] ?? "missing" }) }}
      readBootstrap={async (_signal, credentials) => {
        seenHeaders.push(new Headers(await credentials.restHeaders?.()).get("Authorization") ?? "");
        attempt += 1;
        if (attempt === 1) throw denied;
        return { tenant_id: "tenant-after-login" };
      }}
      renderBootstrapError={(error, retry) => (
        <button data-testid="bootstrap-retry" type="button" onClick={retry}>{error.message}</button>
      )}
    >
      <Identity />
    </FactoryIdentityProvider>,
  );

  await expect.element(page.getByTestId("bootstrap-retry")).toHaveTextContent("not authorized");
  headers[1] = "new";
  await userEvent.click(page.getByTestId("bootstrap-retry"));
  await expect.element(page.getByTestId("identity")).toHaveTextContent("tenant-after-login");
  expect(seenHeaders).toEqual(["old", "new"]);
});
