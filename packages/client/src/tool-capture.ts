/**
 * Explicitly loading a retained tool-result object from Factory.
 *
 * This is deliberately NOT part of folding. Folding retains only a logical
 * object id, byte counts, encoding, truncation metadata, and the already-shaped
 * inline preview. A caller invokes the read below in response to a user action
 * and supplies both a per-request page size and a total ceiling. Metadata is
 * checked before range I/O; the bounded result is assembled and digest-verified
 * before anything at all is handed back — nothing is returned until the whole
 * object verifies. The page byte arrays are views over that one verified result
 * buffer, not duplicate copies.
 */

import { sessionObjectPath, type FactoryReads } from "./factory-rest.js";
import {
  RequestAbortedError,
  ToolCaptureIntegrityError,
  ToolCaptureTooLargeError,
  ToolCaptureUnavailableError,
} from "./errors.js";
import type { ObjectMetadata } from "./types.js";
import type { ToolResultCaptureSummary } from "./toolsummary.js";

export interface ReadToolCaptureOptions {
  /** Maximum bytes per Factory range request. */
  pageBytes: number;
  /** UI policy ceiling; captures above it are refused before any object I/O. */
  ceilingBytes: number;
  signal?: AbortSignal;
}

export interface ToolCapturePage {
  start: number;
  end: number;
  bytes: Uint8Array;
}

export interface ToolCaptureContent {
  metadata: ObjectMetadata;
  /**
   * A record of the HTTP byte ranges this read ISSUED, not an incremental
   * delivery channel. `readToolCapturePages` verifies the whole-object digest
   * before it returns anything, so no element of this array is observable
   * before every element exists — there is one digest on the wire and it covers
   * the whole object, so a page handed over early would be bytes verified
   * against nothing. Each entry's `bytes` is a view over `bytes` below, and the
   * whole array is reconstructible from `bytes` and the page size that produced
   * it; it exists so a caller can show WHICH ranges were fetched.
   */
  pages: ToolCapturePage[];
  bytes: Uint8Array;
}

function throwIfCaptureReadAborted(signal: AbortSignal | undefined, path: string): void {
  if (signal?.aborted) throw new RequestAbortedError(path);
}

/** Explicit object read invoked by a user's expand/page action. */
export async function readToolCapturePages(
  reads: FactoryReads,
  sessionId: string,
  capture: ToolResultCaptureSummary,
  options: ReadToolCaptureOptions,
): Promise<ToolCaptureContent> {
  if (!Number.isSafeInteger(options.ceilingBytes) || options.ceilingBytes < 0) {
    throw new RangeError("tool capture ceilingBytes must be a non-negative safe integer");
  }
  // Split into three guards, not collapsed into one `if`, so that each bound is
  // a separate statement a mutation can reach without disturbing the other two.
  // That the bounds are separately KILLED is supplied by the
  // `rejects invalid pageBytes` rows in `test/toolsummary.test.ts` — 1.5 for the
  // integrality bound, 0 and -1 for positivity, 11 for the ceiling — not by the
  // split; the split only makes it possible to write them.
  if (!Number.isSafeInteger(options.pageBytes)) {
    throw new RangeError("tool capture pageBytes must be a positive safe integer within ceilingBytes");
  }
  if (options.pageBytes <= 0) {
    throw new RangeError("tool capture pageBytes must be a positive safe integer within ceilingBytes");
  }
  if (options.pageBytes > options.ceilingBytes) {
    throw new RangeError("tool capture pageBytes must be a positive safe integer within ceilingBytes");
  }
  if (capture.capturedBytes > options.ceilingBytes) throw new ToolCaptureTooLargeError();
  if (capture.objectId === undefined) throw new ToolCaptureUnavailableError();
  const path = sessionObjectPath(sessionId, capture.objectId);
  throwIfCaptureReadAborted(options.signal, path);

  const metadata = await reads.readObjectMetadata(sessionId, capture.objectId, { signal: options.signal });
  throwIfCaptureReadAborted(options.signal, path);
  if (metadata.reference.object_id !== capture.objectId || metadata.size_bytes !== capture.capturedBytes) {
    throw new ToolCaptureIntegrityError();
  }
  const digestMatch = /^sha256:([0-9a-f]{64})$/.exec(metadata.digest ?? "");
  if (digestMatch === null) throw new ToolCaptureIntegrityError();

  const pages: ToolCapturePage[] = [];
  const bytes = new Uint8Array(capture.capturedBytes);
  for (let start = 0; start < capture.capturedBytes; start += options.pageBytes) {
    const end = Math.min(capture.capturedBytes - 1, start + options.pageBytes - 1);
    const page = await reads.readObjectRange(sessionId, capture.objectId, {
      start,
      end,
      signal: options.signal,
    });
    throwIfCaptureReadAborted(options.signal, path);
    const expectedRange = `bytes ${start}-${end}/${capture.capturedBytes}`;
    if (page.contentRange !== expectedRange || page.bytes.length !== end - start + 1) {
      throw new ToolCaptureIntegrityError();
    }
    bytes.set(page.bytes, start);
    pages.push({ start, end, bytes: bytes.subarray(start, end + 1) });
  }

  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  throwIfCaptureReadAborted(options.signal, path);
  const actualHex = Array.from(actual, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actualHex !== digestMatch[1]) throw new ToolCaptureIntegrityError();
  return { metadata, pages, bytes };
}
