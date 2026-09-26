import { useEffect, useState } from "react";
import { expect, test } from "vitest";
import { renderHookStrict } from "./strict.js";

test("double-invokes effects: mount, cleanup, mount", async () => {
  let mounts = 0;
  let cleanups = 0;

  await renderHookStrict(() => {
    useEffect(() => {
      mounts += 1;
      return () => {
        cleanups += 1;
      };
    }, []);
  });

  // The whole reason this helper exists. `renderHook(hook, { wrapper: strict })`
  // reports 1 and 0 here — StrictMode one level below the root double-renders
  // but does not remount — which is what makes 04-react.md's Task 4.8 hollow.
  expect([mounts, cleanups]).toStrictEqual([2, 1]);
});

test("exposes the last committed hook value", async () => {
  const { result } = await renderHookStrict(() => useState("ready")[0]);

  expect(result.current).toBe("ready");
});

test("unmount runs the effect cleanup", async () => {
  let cleanups = 0;
  const { unmount } = await renderHookStrict(() => {
    useEffect(() => () => {
      cleanups += 1;
    }, []);
  });

  await unmount();

  // One from the StrictMode remount, one from the real unmount.
  expect(cleanups).toBe(2);
});

test("rerender re-runs the hook, so a closed-over argument is picked up", async () => {
  let sessionId = "first";
  const seen: string[] = [];
  const { rerender } = await renderHookStrict(() => {
    seen.push(sessionId);
  });

  sessionId = "second";
  await rerender();

  // React bails out BEFORE calling the component when it is handed the
  // identical element reference, so a helper that reused one would report only
  // "first" here — silently, and only in whichever test happened to depend on
  // it.
  expect(seen.at(-1)).toBe("second");
});
