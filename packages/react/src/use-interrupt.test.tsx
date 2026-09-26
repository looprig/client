import { expect, test } from "vitest";
import { renderHook } from "vitest-browser-react";
import { FakeTransport, SID } from "./testing/fake-transport.js";
import { useInterrupt } from "./use-interrupt.js";

test("interrupting reports whether a running turn was actually cancelled", async () => {
  const transport = new FakeTransport();
  // harness answers `false` for an idle session. That is a normal answer, not
  // a failure, and it must not surface as one.
  transport.interruptResponse = { interrupted: false };
  const { result } = await renderHook(() => useInterrupt(transport, SID));

  await expect(result.current.interrupt()).resolves.toBe(false);

  expect(transport.calls).toStrictEqual([{ method: "interrupt", args: [SID, undefined] }]);
  await expect.poll(() => result.current.interrupting).toBe(false);
  expect(result.current.error).toBeNull();
});

test("a second interrupt while one is in flight is refused", async () => {
  const transport = new FakeTransport();
  const held = transport.defer<{ interrupted: boolean }>("interrupt");
  const { result } = await renderHook(() => useInterrupt(transport, SID));

  const first = result.current.interrupt();
  await expect.poll(() => result.current.interrupting).toBe(true);
  await expect(result.current.interrupt()).resolves.toBe(false);

  held.resolve({ interrupted: true });
  await expect(first).resolves.toBe(true);
  expect(transport.countOf("interrupt")).toBe(1);
});

test("a failed interrupt surfaces the error", async () => {
  const transport = new FakeTransport();
  transport.fail("interrupt", new Error("session not found"));
  const { result } = await renderHook(() => useInterrupt(transport, SID));

  await expect(result.current.interrupt()).resolves.toBe(false);

  await expect.poll(() => result.current.error?.message).toBe("session not found");
  expect(result.current.interrupting).toBe(false);
});

test("a retry after a failure clears the previous error", async () => {
  const transport = new FakeTransport();
  transport.fail("interrupt", new Error("session not found"));
  const { result } = await renderHook(() => useInterrupt(transport, SID));
  await result.current.interrupt();
  await expect.poll(() => result.current.error?.message).toBe("session not found");

  await expect(result.current.interrupt()).resolves.toBe(true);

  await expect.poll(() => result.current.error).toBeNull();
});

test("the callback is stable across re-renders", async () => {
  const transport = new FakeTransport();
  const { result, rerender } = await renderHook(() => useInterrupt(transport, SID));
  const first = result.current.interrupt;

  await rerender();
  await rerender();

  expect(result.current.interrupt).toBe(first);
});
