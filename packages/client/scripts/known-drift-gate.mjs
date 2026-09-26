/**
 * Runs the whole @looprig/client suite and gates on it, allowing exactly the
 * wire-contract drift task U0.1 deliberately left behind (test/known-drift.json).
 *
 * WHY THIS EXISTS. CI runs `npm test --workspaces`, so U0.1's 154 permitted
 * failures made the node job red, and it stayed red with no status report
 * saying so. The two obvious responses are both wrong. Dropping the workspace
 * from CI would stop running a suite that ci.yml's own comment calls out --
 * "a suite CI never runs is indistinguishable from a passing one". Marking the
 * whole workspace `continue-on-error` would make every future regression in the
 * 26 healthy files invisible for as long as the drift lasts, which is longer
 * than anyone will remember the allowance.
 *
 * So: run every test, then compare the SET OF FAILING FILES against a recorded
 * set. A file failing that is not on the list fails the gate. A file on the
 * list that passes ALSO fails the gate, because an allowance that outlives its
 * cause is how a permanent exemption is born; retiring an entry is a one-line
 * edit in the commit that fixes the drift.
 *
 * THREE floors. Each one was added because the floor above it turned out to
 * have nothing underneath, which is the single defect this script has now been
 * revised three times to fix. The pattern each time: a thing was PRINTED, or
 * CLAIMED in a comment, and asserted nowhere.
 *
 * FLOOR 0 -- WHICH FILES ARE ALLOWED TO BE FILE-GRANULAR. `fileGranular` in
 * test/known-drift.json names the three files exempt from FLOOR 2, and the
 * partition is checked in BOTH directions: an entry inside that list must carry
 * `granularityReason` and must not carry `failingTests`, and an entry outside
 * it must carry `failingTests` and must not carry `granularityReason`.
 *
 * The earlier shape check only demanded exactly ONE of the two fields, which a
 * free-text string satisfies. Swapping test/contract.test.ts's 58-name set for
 * `granularityReason: "flaky"` exited 0 and printed "6 gated to an exact
 * failing-test-name set and 4 stay file-granular" as though that were the
 * design. Every future regression across that file's 62 tests would have been
 * invisible for the rest of the allowance -- the exact state FLOOR 2 exists to
 * end, reachable by editing the JSON alone. So the 7/3 partition is now the
 * pinned fact, not an emergent property of which fields happen to be present.
 *
 * FLOOR 1 -- WHICH FILES RAN, AND HOW MANY TESTS EACH COLLECTED. The first
 * version derived `seen`, printed "26 of 36 test files pass", and asserted
 * NOTHING about it: `git mv test/surface.test.ts test/surface.spec.ts` puts the
 * file outside vitest.config.ts's `include: ["test/**\/*.test.ts"]`, the run
 * reports `10 failed | 25 passed (35)`, and the gate exits 0 with the whole
 * export-surface guard silently not running.
 *
 * Pinning the file NAMES fixed that and left the same hole one level in: a
 * `describe` dropped in a merge-conflict resolution, or a deleted `it`, leaves
 * the file running and passing and the gate green. Deleting one passing `it`
 * from test/blocks.test.ts (24 -> 23) exited 0. So `suiteFiles` maps every
 * expected test file to the number of tests it collects, and both the name sets
 * and the per-file counts must match.
 *
 * The flakiness argument that protects the three HTTP files (below) does not
 * reach these counts: how many tests a file COLLECTS is a property of its
 * source, not of any server or timeout. Verified across independent full runs
 * -- all 36 counts identical, including the three HTTP files, whose per-test
 * OUTCOMES do vary.
 *
 * FLOOR 2 -- WHICH TESTS FAIL INSIDE A DRIFTED FILE. File granularity alone
 * means a new failing `it` in an already-drifted file is invisible: a fresh
 * broken test in test/errors.test.ts took the run to 155 failures and an
 * earlier version of this gate still exited 0. That is defensible ONLY for the
 * three files that drive real HTTP servers under timeouts (transport,
 * host-transport-csrf, serve-transport: 85-90s each, machine-dependent per-test
 * outcomes) -- and it had been applied to all ten, including seven that run in
 * 3-24ms with failing sets reproduced identically across independent runs. The
 * seven record the exact SET OF FAILING TEST NAMES; the three record why they
 * do not, per file, and FLOOR 0 pins which three they are.
 *
 * The residual cost, and it is now the only one: inside those three HTTP files
 * a new failure is not distinguished from the drift. Everything else -- which
 * files run, how many tests each contains, and which tests fail in the other
 * seven -- is asserted.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// npm hoists workspace binaries to the ROOT node_modules/.bin, but does not
// always leave a per-workspace copy. Look in both rather than assuming either.
const vitestBin = [
  join(packageRoot, "node_modules/.bin/vitest"),
  resolve(packageRoot, "../../node_modules/.bin/vitest"),
].find((candidate) => existsSync(candidate));
if (vitestBin === undefined) {
  console.error("FAIL: vitest is not installed; run `npm ci` at the workspace root.");
  process.exit(1);
}
const drift = JSON.parse(readFileSync(join(packageRoot, "test/known-drift.json"), "utf8"));
const allowed = new Map(Object.entries(drift.files));
// file -> number of tests it is expected to COLLECT, for every file in the suite.
const suiteFiles = new Map(Object.entries(drift.suiteFiles));
const fileGranular = new Set(drift.fileGranular);

/** Sorted `a` minus `b`, for anything with `.has` and anything iterable. */
const missingFrom = (a, b) => [...a].filter((item) => !b.has(item)).sort();

// FLOOR 0, and it runs before vitest so a malformed allowance fails in a second
// rather than 90. The partition is the pinned fact: which files are exempt from
// FLOOR 2 is stated once, in `fileGranular`, and every entry is checked against
// it in both directions. "Exactly one of the two fields" is NOT enough -- a
// free-text `granularityReason` satisfies that, so an entry could be downgraded
// out of per-test gating by editing this JSON alone.
{
  const shape = [];
  const orphanExemptions = missingFrom(fileGranular, allowed);
  if (orphanExemptions.length > 0) {
    shape.push(
      `"fileGranular" names ${orphanExemptions.length} file(s) with no entry in "files":`,
      ...orphanExemptions.map((file) => `  - ${file}`),
    );
  }
  for (const [file, entry] of allowed) {
    const hasNames = Array.isArray(entry.failingTests);
    const hasReason = typeof entry.granularityReason === "string" && entry.granularityReason.length > 0;
    if (fileGranular.has(file)) {
      if (!hasReason) shape.push(`  - ${file} is in "fileGranular" but has no "granularityReason"`);
      if (hasNames) shape.push(`  - ${file} is in "fileGranular" but also records "failingTests"`);
    } else {
      if (!hasNames) {
        shape.push(
          `  - ${file} is NOT in "fileGranular" and must record "failingTests", the exact set of`,
          `    failing test names. Moving a file to file granularity means adding it to`,
          `    "fileGranular" -- deliberately, in a commit that says why -- not deleting a field.`,
        );
      }
      if (hasReason) shape.push(`  - ${file} records "granularityReason" but is not in "fileGranular"`);
    }
  }
  if (shape.length > 0) {
    console.error(`\nFAIL: test/known-drift.json does not describe the recorded granularity partition:\n${shape.join("\n")}\n`);
    process.exit(1);
  }
}

const reportDir = mkdtempSync(join(tmpdir(), "looprig-protocol-drift-"));
const reportPath = join(reportDir, "vitest.json");
try {
  // `run` and a JSON reporter to a FILE: the JSON reporter writes machine
  // output to stdout otherwise, and vitest's own progress lines would be
  // interleaved with it. Human-readable output still goes to the terminal, so
  // a CI log shows the real failures rather than only this script's verdict.
  const result = spawnSync(
    process.execPath,
    [
      vitestBin,
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
    ],
    { cwd: packageRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const failing = new Set();
  const seen = new Set();
  /** file -> { failed: Set<fullName>, tests: number } */
  const detail = new Map();
  for (const suite of report.testResults ?? []) {
    const file = relative(packageRoot, suite.name);
    seen.add(file);
    if (suite.status === "failed") failing.add(file);
    const assertions = suite.assertionResults ?? [];
    detail.set(file, {
      failed: new Set(assertions.filter((a) => a.status === "failed").map((a) => a.fullName)),
      tests: assertions.length,
    });
  }

  const unexpected = [...failing].filter((file) => !allowed.has(file)).sort();
  // An allowed file that is absent from the report is as much a stale entry as
  // one that passes -- a deleted or renamed test file must not keep its
  // exemption alive under a name nothing runs.
  const recovered = [...allowed.keys()].filter((file) => !failing.has(file)).sort();

  const lines = [];
  // FLOOR 1. Before any verdict about failures, assert WHICH FILES RAN. A file
  // renamed out of vitest.config.ts's include glob, deleted, or added is not a
  // pass and not a failure -- it is an absence, and an absence is what every
  // vacuous guard in this repository has looked like.
  const vanished = missingFrom(suiteFiles.keys(), seen);
  const appeared = missingFrom(seen, suiteFiles);
  if (vanished.length > 0 || appeared.length > 0) {
    lines.push(
      `FAIL: the test files vitest RAN are not the files test/known-drift.json expects` +
        ` (${seen.size} ran, ${suiteFiles.size} expected):`,
      ...vanished.map((file) => `  - ${file} (expected, did not run)`),
      ...appeared.map((file) => `  + ${file} (ran, not expected)`),
      "A file that stops running stops guarding, silently, and this gate would",
      "otherwise report OK. Add or remove the name in \"suiteFiles\" in the same",
      "commit that adds or removes the file.",
    );
  }

  // ...and how many tests each of them CONTAINS, for all 36 and not only the
  // drifted ones. A file that runs and passes with a `describe` missing is the
  // same absence as a file that does not run; the only difference is that it is
  // harder to see. Applies to the three HTTP files too: a COLLECTED count is a
  // property of the source, not of a server or a timeout.
  const miscounted = [...suiteFiles]
    .filter(([file, tests]) => seen.has(file) && detail.get(file)?.tests !== tests)
    .map(([file, tests]) => `  - ${file}: collected ${detail.get(file)?.tests}, expected ${tests}`)
    .sort();
  if (miscounted.length > 0) {
    lines.push(
      `FAIL: ${miscounted.length} test file(s) do not contain the number of tests test/known-drift.json records:`,
      ...miscounted,
      "A test deleted, or a whole describe lost in a merge, leaves the file running",
      "and passing and this gate green. Update the count in \"suiteFiles\" in the",
      "same commit that adds or removes a test.",
    );
  }
  if (unexpected.length > 0) {
    lines.push(
      `FAIL: ${unexpected.length} test file(s) failed that the known-drift allowance does not cover:`,
      ...unexpected.map((file) => `  - ${file}${seen.has(file) ? "" : " (not present in the report)"}`),
      "These are real regressions. The U0.1 wire-contract drift does not excuse them.",
    );
  }
  if (recovered.length > 0) {
    lines.push(
      `FAIL: ${recovered.length} file(s) in test/known-drift.json no longer fail:`,
      ...recovered.map((file) => `  - ${file}${seen.has(file) ? "" : " (no longer present)"}`),
      "Remove them from test/known-drift.json in the commit that fixed them. An",
      "allowance that outlives its cause is a permanent exemption.",
    );
  }

  // FLOOR 2. Inside each drifted file that is fast and deterministic, the exact
  // set of failing test names and the number of tests collected. A new failure
  // is a name not on the list; a suite that stops collecting is a count that
  // dropped; a fixed test is a name on the list that no longer fails.
  for (const [file, entry] of allowed) {
    if (!Array.isArray(entry.failingTests)) continue;
    const observed = detail.get(file);
    if (observed === undefined) continue; // already reported by FLOOR 1
    const expectedFailing = new Set(entry.failingTests);
    const newlyFailing = missingFrom(observed.failed, expectedFailing);
    const noLongerFailing = missingFrom(expectedFailing, observed.failed);
    if (newlyFailing.length > 0 || noLongerFailing.length > 0) {
      lines.push(
        `FAIL: ${file} does not match its recorded per-test drift:`,
        ...newlyFailing.map((name) => `  NEW failure, not part of the U0.1 drift: ${name}`),
        ...noLongerFailing.map((name) => `  recorded as failing but now passes: ${name}`),
      );
    }
  }

  if (lines.length > 0) {
    console.error(`\n${lines.join("\n")}\n`);
    process.exit(1);
  }

  const totalTests = [...suiteFiles.values()].reduce((sum, tests) => sum + tests, 0);
  console.error(
    `\nOK: all ${suiteFiles.size} expected test files ran, each with the ${totalTests} recorded` +
      ` tests they collectively contain.` +
      `\n     ${seen.size - failing.size} of ${seen.size} pass and gate normally.` +
      `\n     ${allowed.size} are covered by test/known-drift.json (recorded ${drift.recordedOn},` +
      ` retire in ${drift.retireIn}), of which ${allowed.size - fileGranular.size} are gated to an` +
      ` exact failing-test-name set and ${fileGranular.size} stay file-granular by the pinned` +
      ` "fileGranular" partition.` +
      `\n     Reason: ${drift.reason}\n`,
  );
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
