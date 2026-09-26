import type { SessionViewStore, TranscriptRow } from "@looprig/client";
import { useStoreSelector } from "./use-store.js";

/**
 * The number of committed transcript rows.
 *
 * A row list subscribes to THIS, not to `rows`, so appending a row re-renders
 * only the list container and the one new row — never the rows already on
 * screen. Selecting `rows` itself would be worse than useless here:
 * `@looprig/client`'s fold appends the outer array IN PLACE (design §3c, for
 * an O(M) rather than O(M^2) cold replay), so the array's identity never
 * changes and a selector returning it would never re-render at all.
 */
export function useRowCount(store: SessionViewStore): number {
  return useStoreSelector(store, (snapshot) => snapshot.view.rows.length);
}

/**
 * One row by ordinal.
 *
 * Returns the row OBJECT straight out of the snapshot — never a copy, never a
 * derived shape. Rows are copy-on-write in `@looprig/client` (rows.ts's
 * module comment, and `test/rows.test.ts` freezes committed rows to keep it
 * that way), so this selector's result is `Object.is`-stable until that
 * specific row changes, which is what lets React skip re-rendering every other
 * row in a 10,000-row transcript when one tool call completes.
 *
 * The selector must therefore stay a plain index. Reading `snapshot.version`,
 * or spreading the row, would subscribe every mounted row to every notify and
 * turn one completed tool call into a whole-transcript re-render — which is
 * the regression `use-transcript-row.test.tsx` pins.
 *
 * `undefined` when the ordinal is past the end: a virtualizer routinely renders
 * ahead of the data, and `noUncheckedIndexedAccess` makes that the honest
 * return type rather than a lie the caller finds at runtime.
 */
export function useTranscriptRow(store: SessionViewStore, ordinal: number): TranscriptRow | undefined {
  return useStoreSelector(store, (snapshot) => snapshot.view.rows[ordinal]);
}
