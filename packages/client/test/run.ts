/**
 * Drives `fold` over a list of inputs, failing loudly on the first FoldError.
 *
 * It lives in its own module rather than in a `*.test.ts` so the row test
 * files can share it without importing one test file from another — an import
 * that would make vitest register the exporting file's suites twice.
 */
import { fold, type FoldInput, type SessionView } from "../src/fold.js";

export function run(view: SessionView, inputs: FoldInput[]): SessionView {
  let out = view;
  for (const input of inputs) {
    const result = fold(out, input);
    if (!result.ok) {
      throw new Error(`fold rejected an input: FoldError(${result.error.reason}): ${result.error.message}`);
    }
    out = result.view;
  }
  return out;
}
