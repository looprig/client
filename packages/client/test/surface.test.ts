/**
 * The package's public surface.
 *
 * `@looprig/client` is the ONE package a Vue or Solid author installs
 * (`packages/react` is only the reference adapter), so every framework-neutral
 * capability must be reachable from the barrel — a consumer must never need a
 * deep import into `src/`. Phase 4's React binding and Phase 5's app consume
 * exactly what this file asserts, so a barrel line deleted by accident fails
 * here rather than three phases downstream.
 *
 * It asserts EXCLUSIONS too: `blocks.ts` exports two cross-module helpers
 * (`isRecord`, `str`) that exist for `enduring.ts`/`gate.ts`/`fold.ts` and have
 * no business being public API on a package root.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(packageRoot, "../..");
// An ALLOWLIST, not a denylist of framework package roots. The invariant this
// file guards is not "no React" but design §1's "zero framework deps", and only
// an allowlist states that: anything not named here is a violation, so a package
// enters the public module graph by being added on purpose or not at all.
//
// The denylist this replaced was already stale on the day it was written -- it
// named `svelte` but not `@sveltejs/kit` or any other `@sveltejs/*` entry point,
// which are as Svelte as `svelte` is -- and it would have silently admitted
// `centrifuge` the moment the transport spike approved it, which is the opposite
// of a review. A denylist has to be extended for every framework that will ever
// exist; this list has to be extended for every dependency this package takes.
//
// This is not maintained by hand against package.json: the "has no framework
// dependencies" test asserts this set and the manifest's `dependencies` keys are
// the SAME set, in both directions, so admitting a package here without
// declaring it (or declaring one without admitting it) fails.
const allowedPackageRoots = new Set(["ajv", "centrifuge", "json-schema-to-ts"]);

function packageRootOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
}

/**
 * Every module specifier the source names, by SPELLING -- syntax only, no type
 * checker. The list below is what this walker claims to cover; it is NOT a
 * claim to cover every construct in TypeScript, and the previous version of
 * this comment ("the walker's job is to describe the language") was exactly
 * that unqualified claim. It was wrong twice: `import("react")` in TYPE
 * position was invisible until a review found it, and then
 * import(`react`) -- a no-substitution TEMPLATE literal, semantically
 * identical to the string form -- was invisible to the fix, because
 * `ts.isStringLiteral` is FALSE for a NoSubstitutionTemplateLiteral. Placed in
 * src/types.ts it shipped a real, undeclared runtime `react` import in
 * `dist/types.js` and both surface tests passed.
 *
 * So: covered spellings, each with a fixture case in the `rejects a $name`
 * table below, and each accepted in BOTH the quoted and the backtick form
 * wherever the grammar allows a template literal.
 *
 *   1. `import ... from "x"` / `export ... from "x"` (incl. `import type`)
 *   2. `import("x")` dynamic import, value position
 *   3. `import("x").T` / `typeof import("x")`, type position
 *   4. `import x = require("x")`
 *   5. `require("x")` -- CJS. Unreachable from this ESM package's own sources,
 *      kept because the walker also runs over fixtures and costs nothing.
 *   6. `declare module "x" { ... }` -- an ambient module declaration or
 *      augmentation names a package as surely as an import does.
 *   7. `/// <reference types="x" />` -- how a `.d.ts` acquires `@types/*`.
 *      This is the one with real teeth of the three added late: it is a
 *      DEPENDENCY EDGE that never appears in any import statement. Note it is
 *      a no-op on its own -- `tsc` PRUNES an unused triple-slash reference from
 *      the emitted `.d.ts` -- so it only ships once the referenced global is
 *      actually used, which is precisely when it matters.
 *
 * Known NOT covered, stated rather than implied: anything requiring the type
 * checker or module resolution (a specifier built by string concatenation, a
 * path alias, `import.meta.resolve(...)`, a bare `require` reached through an
 * alias), and `/// <reference path="..." />`, which names a FILE and not a
 * package. If a construct is added to the language, it belongs on one of these
 * two lists and in the fixture table.
 */
function moduleSpecifiers(sourcePath: string): string[] {
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  // `/// <reference types="react" />` -- spelling 7. Parsed by the scanner, not
  // reachable from the AST walk, so it is read off the SourceFile directly.
  for (const directive of source.typeReferenceDirectives) found.push(directive.fileName);
  // A module specifier is a StringLiteral OR a NoSubstitutionTemplateLiteral
  // everywhere one can be written. Every branch below goes through here so a
  // spelling cannot be covered in one position and blind in another, which is
  // how the last gap survived a fix aimed at the place the bug was noticed.
  const specifierText = (node: ts.Node | undefined): string | undefined => {
    let current = node;
    while (current !== undefined && ts.isParenthesizedExpression(current)) current = current.expression;
    if (current === undefined) return undefined;
    return ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)
      ? current.text
      : undefined;
  };
  const push = (text: string | undefined): void => {
    if (text !== undefined) found.push(text);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      push(specifierText(node.moduleSpecifier));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      push(specifierText(node.arguments[0]));
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      push(specifierText(node.arguments[0]));
    } else if (ts.isImportTypeNode(node)) {
      // `type X = import("react").ReactNode` -- an import that appears in the
      // TYPE position and has no import statement at all. This is the form a
      // framework dependency is most likely to arrive in here, because these
      // DTOs are type-level, and it was invisible to the first version of this
      // walker: the whole test passed with `import("react").ReactNode` sitting
      // in src/types.ts. Nothing else caught it either. The packed-consumer
      // test happened to fail, but only because that fixture does not install
      // React's types -- a reason that evaporates for any forbidden package
      // whose types a consumer already has transitively.
      if (ts.isLiteralTypeNode(node.argument)) push(specifierText(node.argument.literal));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      // `import x = require("react")`. Not reachable from this package's own
      // sources (ESM + isolatedModules), but a fixture can spell it.
      push(specifierText(node.moduleReference.expression));
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      // `declare module "react" { ... }`. A string-named module declaration is
      // an ambient declaration of, or an augmentation to, THAT package.
      // `declare global` and `namespace X` have Identifier names and are not
      // module specifiers, so the isStringLiteral guard is load-bearing.
      //
      // Two forms are NOT package references and are skipped, both found by
      // review after this branch shipped without them:
      //
      //  - `declare module "*.css"` and friends. The standard way to type an
      //    asset import. `*.css` is a PATTERN, not a package, and reporting
      //    `index.ts -> *.css` as a forbidden framework dependency is a false
      //    positive with a baffling message.
      //  - `declare module "./local.js"`. A relative name here declares a
      //    module for a FILE, and is not an instruction to go read that file:
      //    routing it into the graph walk made `resolveRelativeModule` THROW
      //    `unresolved public module ./nope.js`, aborting the test instead of
      //    returning a verdict.
      const name = node.name.text;
      if (!name.includes("*") && !name.startsWith(".") && !name.startsWith("/")) push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function resolveRelativeModule(importer: string, specifier: string): string {
  const candidate = resolve(dirname(importer), specifier.replace(/\.js$/, ".ts"));
  if (!existsSync(candidate)) throw new Error(`unresolved public module ${specifier} from ${importer}`);
  return candidate;
}

/** Walks the relative-import graph from `roots`, returning every file reached and every specifier outside the allowlist. */
function walkModuleGraph(roots: string[]): { visited: Set<string>; violations: string[] } {
  const pending = [...roots];
  const visited = new Set<string>();
  const violations: string[] = [];
  const base = dirname(roots[0] ?? "");
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const specifier of moduleSpecifiers(current)) {
      if (specifier.startsWith(".")) {
        pending.push(resolveRelativeModule(current, specifier));
      } else if (!allowedPackageRoots.has(packageRootOf(specifier))) {
        violations.push(`${relative(base, current)} -> ${specifier}`);
      }
    }
  }
  return { visited, violations: violations.sort() };
}

function forbiddenImports(...roots: string[]): string[] {
  return walkModuleGraph(roots).violations;
}

// Every extension tsconfig.json compiles and emits. `.endsWith(".ts")` was too
// narrow: `src/probe.mts` importing react passed BOTH surface tests. The packed
// consumer did net it -- as `+ "dist/probe.d.mts"` in a file-list mismatch --
// which is the wrong diagnosis, not a second line of defence. A maintainer
// reads "the tarball has an unexpected file", not "a framework dependency
// entered the public module graph".
const emittedSourceExtension = /\.(?:m|c)?tsx?$/;

/** Every source file under `dir` -- i.e. exactly what `tsc -p tsconfig.json` emits into `dist/`, which `files: ["dist"]` publishes in full. */
function srcFiles(dir = join(packageRoot, "src")): string[] {
  return readdirSync(dir, { recursive: true })
    .filter((path): path is string => typeof path === "string" && emittedSourceExtension.test(path))
    .map((path) => join(dir, path))
    .sort();
}

function writeSource(root: string, path: string, source: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

describe("@looprig/client public surface", () => {
  it("exports the transcript row projection", () => {
    for (const name of [
      "rowsForLoop",
      "loopIdsInOrder",
      "anchorOf",
      "splitStepGroup",
      "narrationOf",
      "thinkingOf",
      "redactedThinkingOf",
      "refusalOf",
      "toolUsesOf",
      "toolResultText",
      "toolUseSummary",
    ]) {
      expect(protocol, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports the payload decoders", () => {
    for (const name of [
      "decodeEnduring",
      "decodePrincipal",
      "eventPrincipal",
      "principalLabel",
      "isZeroUUID",
      "decodeBlock",
      "decodeBlocks",
      "decodeMessage",
      "decodeMessages",
      "rejectReasonText",
      "turnFailureText",
      "ERROR_KIND_UNKNOWN",
    ]) {
      expect(protocol, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports the gate surface, including the three exact approval actions", () => {
    expect(protocol).toHaveProperty("decodeGate");
    expect(protocol).toHaveProperty("isAnswerableGate");
    expect(protocol.GATE_APPROVAL_ACTIONS).toStrictEqual({
      approve: "Approve",
      approveAlwaysWorkspace: "Approve always for this workspace",
      deny: "Deny",
    });
    expect(protocol.GATE_KIND_PERMISSION).toBe("harness.permission");
    for (const name of ["GATE_KIND_ASK_USER", "GATE_KIND_FORM", "GATE_KIND_OPEN_URL"]) {
      expect(protocol, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports the Factory transport, join, controllers and durable fold", () => {
    for (const name of [
      "FactorySessionViewStore", "joinFactorySessionView", "createFactoryClient",
      "createFactoryCommands", "createClientLink", "FactoryRestReads", "CapturedTail",
      "fold", "emptySessionView", "createPublicEventFolder", "PendingSlot",
      "createRefreshingFetch", "LinkRecoveryController", "decodeFactoryLiveText",
      "decodeFactoryLiveDelta", "placeLivePreviews", "livePreviewKey",
      "ContractValidationError", "validateFactory", "contractInfo", "errorFromCoreEnvelope", "textBlock",
      "MessageMetadataError", "MAX_METADATA_FIELDS", "MAX_METADATA_KEY_BYTES",
      "MAX_METADATA_VALUE_BYTES", "MAX_METADATA_BYTES",
    ]) expect(protocol, `missing export: ${name}`).toHaveProperty(name);
  });

  it("does not expose the removed serve transport, schemas or fold helpers", () => {
    for (const name of [
      "HostTransport", "ServeTransport", "ThreadReconnectTransport", "createHostTransport",
      "createClient", "restoreSession", "CSRF_TOKEN_HEADER", "generateIdempotencyKey",
      "SseFrameParser", "SseFrameError", "parseSseStream", "createFetchLiveFrameSource",
      "SessionViewStore", "joinSessionView", "selectFrameToDrop", "browserFrameScheduler",
      "ephemeralDropKey", "isDroppableFrame", "addPendingRow", "FoldError",
      "allSchemas", "bffErrorResponseSchema", "validateBFFErrorResponse", "validate",
      "restoreResponseSchema", "validateRestoreResponse", "errorFromResponse", "LooprigError",
    ]) expect(protocol, `legacy export leaked: ${name}`).not.toHaveProperty(name);
  });

  it("exports the Core schemas its Factory validators use", () => {
    const camel = (name: string): string => name.replace(/(^|_)(.)/g, (_, _prefix: string, c: string) => c.toUpperCase());
    for (const name of Object.keys(protocol.factorySchemas)) {
      expect(protocol).toHaveProperty(`factory${camel(name)}Schema`);
    }
    expect(Object.values(protocol.factorySchemas).every((schema) => schema.$id.startsWith("https://looprig.dev/sessionwire/v1/"))).toBe(true);
  });

  it("keeps the package's internal decode helpers OFF the public surface", () => {
    for (const name of ["str", "isRecord"]) {
      expect(protocol, `internal helper leaked: ${name}`).not.toHaveProperty(name);
    }
  });

  it("needs no deep import: every emitted module is reachable from the barrel", () => {
    // The OTHER half of the split above. Reachability is not a publish
    // boundary (see "has no framework dependencies"), but it is exactly design
    // §1's "a Vue or Solid author must never need a deep import into src/":
    // a module tsc emits that the barrel cannot reach is either dead weight in
    // the tarball or a capability only a deep import can get at.
    const { visited } = walkModuleGraph([resolve(packageRoot, "src/index.ts")]);
    const unreachable = srcFiles()
      .map((file) => resolve(file))
      .filter((file) => !visited.has(file))
      .map((file) => relative(packageRoot, file));
    expect(unreachable).toStrictEqual([]);
  });

  it("has no framework dependencies", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string>; scripts?: Record<string, string> };
    // design §1: "Zero framework deps. A Vue or Solid author installs that one
    // package." That is the package's whole reason to exist.
    // Exact, never a range. `centrifuge` is the official Centrifugal client and
    // `5.7.2` is the version the compatibility spike verified against the
    // embedded github.com/centrifugal/centrifuge v0.38.0 server; a caret would
    // let a consumer install a version nothing has ever run against that server.
    // Note the npm package is `centrifuge` -- `centrifuge-js` is the upstream
    // REPOSITORY name, and `@centrifuge/centrifuge-js` is an unrelated
    // blockchain project.
    expect(manifest.dependencies).toStrictEqual({
      ajv: "8.20.0",
      centrifuge: "5.7.2",
      "json-schema-to-ts": "3.1.1",
    });
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      expect(version, `${name} must be pinned exactly, not to a range`).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // The import allowlist and the declared dependencies are one fact stated
    // twice, so assert them equal in BOTH directions rather than asserting a
    // second hand-written list. An entry admitted to the allowlist but never
    // declared is an undeclared runtime import; a dependency declared but not
    // admitted is dead weight in every consumer's install.
    expect([...allowedPackageRoots].sort()).toStrictEqual(Object.keys(manifest.dependencies ?? {}).sort());
    expect(manifest.scripts?.prepack).toBe(
      "npm run build && npm run typecheck && npm run test:package",
    );
    // The subject is EVERY file tsc emits, not only what the barrel reaches.
    // `files: ["dist"]` publishes all of src/, so a module that imports react
    // and is never re-exported from index.ts still ships inside the tarball --
    // and the packed-consumer test cannot catch it either, because that test
    // derives its expected file list from readdirSync(src), so dist/orphan.*
    // is EXPECTED there. Reachability is the wrong scope for a publish
    // boundary; the emit set is the right one.
    expect(forbiddenImports(...srcFiles())).toStrictEqual([]);
  });

  it("declares the public package's complete publish boundary", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      name: "@looprig/client",
      version: "0.3.0",
      type: "module",
      files: ["dist", "LICENSE", "NOTICE", "README.md"],
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      sideEffects: false,
      engines: { node: ">=22" },
      license: "Apache-2.0",
      repository: {
        type: "git",
        url: "git+https://github.com/looprig/client.git",
        directory: "packages/client",
      },
      publishConfig: { access: "public" },
    });
  });

  it.each([
    {
      name: "deep React import",
      files: {
        "index.ts": 'export * from "./leaf.js";\n',
        "leaf.ts": 'import { jsx } from "react/jsx-runtime"; export { jsx };\n',
      },
      want: "leaf.ts -> react/jsx-runtime",
    },
    {
      name: "type-only Svelte import",
      files: {
        "index.ts": 'import type { Readable } from "svelte/store"; export type Public = Readable<string>;\n',
      },
      want: "index.ts -> svelte/store",
    },
    {
      name: "inline import() type",
      files: {
        "index.ts": 'export type Public = import("react").ReactNode;\n',
      },
      want: "index.ts -> react",
    },
    {
      name: "import-equals require",
      files: {
        "index.ts": 'import react = require("react");\nexport const r = react;\n',
      },
      want: "index.ts -> react",
    },
    {
      // A no-substitution TEMPLATE literal. Semantically identical to the
      // string form, and `ts.isStringLiteral` is FALSE for it, so the previous
      // walker read straight past this in every position at once. Placed in
      // the real src/types.ts it shipped `import(`react`)` in dist/types.js.
      name: "backtick dynamic import",
      files: {
        "index.ts": "export const lazyReact = () => import(`react`);\n",
      },
      want: "index.ts -> react",
    },
    {
      name: "backtick import() type",
      files: {
        "index.ts": "export type Public = import(`react`).ReactNode;\n",
      },
      want: "index.ts -> react",
    },
    {
      name: "backtick import-equals require",
      files: {
        "index.ts": "import react = require(`react`);\nexport const r = react;\n",
      },
      want: "index.ts -> react",
    },
    {
      name: "parenthesized dynamic import specifier",
      files: {
        "index.ts": 'export const lazyReact = () => import(("react"));\n',
      },
      want: "index.ts -> react",
    },
    {
      name: "CJS require call",
      files: {
        "index.ts": 'const react = require("react");\nexport { react };\n',
      },
      want: "index.ts -> react",
    },
    {
      // An augmentation names the package it augments; it is a dependency edge
      // with no import statement anywhere.
      name: "ambient module augmentation",
      files: {
        "index.ts": 'declare module "react" {\n  export const patched: boolean;\n}\nexport const x = 1;\n',
      },
      want: "index.ts -> react",
    },
    {
      // A dot is ordinary inside a package name. This fixture distinguishes
      // package declarations from the relative `./file.js` form below.
      name: "dotted ambient package",
      files: {
        "index.ts": 'declare module "lodash.debounce" {\n  export default function debounce(): void;\n}\n',
      },
      want: "index.ts -> lodash.debounce",
    },
    {
      // How a .d.ts acquires @types/*. Pruned from the emit while unused, real
      // the moment the global it brings in is referenced -- as here.
      name: "triple-slash types reference",
      files: {
        "index.ts": '/// <reference types="react" />\nexport const node: React.ReactNode = null;\n',
      },
      want: "index.ts -> react",
    },
    {
      name: "scoped SvelteKit import a framework denylist would have missed",
      files: {
        "index.ts": 'import { error } from "@sveltejs/kit"; export { error };\n',
      },
      want: "index.ts -> @sveltejs/kit",
    },
    {
      name: "transitive Harness re-export",
      files: {
        "index.ts": 'export * from "./bridge.js";\n',
        "bridge.ts": 'export * from "./leaf.js";\n',
        "leaf.ts": 'export { privateAPI } from "@looprig/harness/private";\n',
      },
      want: "leaf.ts -> @looprig/harness/private",
    },
  ])("rejects a $name from the public module graph", ({ files, want }) => {
    const fixture = mkdtempSync(join(tmpdir(), "looprig-protocol-surface-"));
    try {
      for (const [path, source] of Object.entries(files)) writeSource(fixture, path, source);
      expect(forbiddenImports(join(fixture, "index.ts"))).toContain(want);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("does not mistake an asset pattern or a file-local `declare module` for a package", () => {
    // The two over-approximations the `declare module` branch shipped with.
    // `*.css` is a PATTERN -- the standard way to type an asset import -- and
    // reporting `index.ts -> *.css` as a forbidden framework dependency is a
    // false positive with a baffling message. `./sibling.js` names a FILE, and
    // routing it into resolveRelativeModule made the walk THROW rather than
    // return a verdict, which is worse than a wrong answer: it aborts the guard.
    const fixture = mkdtempSync(join(tmpdir(), "looprig-protocol-declare-"));
    try {
      writeSource(
        fixture,
        "index.ts",
        'declare module "*.css" {\n  const url: string;\n  export default url;\n}\n' +
          'declare module "./sibling.js" {\n  export const x: number;\n}\n' +
          "export const y = 1;\n",
      );
      expect(forbiddenImports(join(fixture, "index.ts"))).toStrictEqual([]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("takes every extension tsc emits as its subject, not just .ts", () => {
    // src/probe.mts importing react passed BOTH surface tests: outside
    // srcFiles()'s filter, so the walk never read it, and outside the packed
    // test's identical filter, so the tarball mismatch blamed the file list.
    for (const path of ["a.ts", "b.tsx", "c.mts", "d.cts"]) {
      expect(emittedSourceExtension.test(path), `${path} is emitted by tsconfig.json`).toBe(true);
    }
    for (const path of ["e.d.ts.map", "f.json", "g.js"]) {
      expect(emittedSourceExtension.test(path), `${path} is not a tsc input`).toBe(false);
    }

    const fixture = mkdtempSync(join(tmpdir(), "looprig-protocol-extensions-"));
    try {
      writeSource(fixture, "index.mts", "export const mts = true;\n");
      writeSource(fixture, "b.tsx", "export const tsx = true;\n");
      writeSource(fixture, "ignored.js", "export const js = true;\n");
      expect(srcFiles(fixture).map((path) => relative(fixture, path))).toStrictEqual([
        "b.tsx",
        "index.mts",
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("installs the packed artifact into a standalone consumer that typechecks and runs", () => {
    const fixture = mkdtempSync(join(tmpdir(), "looprig-protocol-consumer-"));
    const packDir = join(fixture, "pack");
    const consumerDir = join(fixture, "consumer");
    const npmCache = process.env.npm_config_cache ?? join(tmpdir(), "looprig-protocol-npm-cache");
    mkdirSync(packDir);
    mkdirSync(consumerDir);
    const run = (command: string, args: string[], cwd: string): string => {
      try {
        return execFileSync(command, args, {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            npm_config_cache: npmCache,
            npm_config_dry_run: "false",
            ...(cwd === consumerDir ? { npm_config_workspaces: "false" } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        throw new Error(
          `${failure.message ?? `${command} failed`}\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`,
        );
      }
    };

    try {
      run("npm", ["run", "build", "--workspace", "@looprig/client"], workspaceRoot);
      const packed = JSON.parse(
        run(
          "npm",
          ["pack", "--workspace", "@looprig/client", "--ignore-scripts", "--json", "--pack-destination", packDir],
          workspaceRoot,
        ),
      ) as Array<{ filename: string; files: Array<{ path: string }> }>;
      const artifact = packed[0];
      if (artifact === undefined) throw new Error("npm pack returned no artifact");
      // Derived from srcFiles(), the SAME list the framework-dependency walk
      // takes as its subject, so the two cannot disagree about what tsc emits.
      // They used to keep separate `.endsWith(".ts")` filters, and a src/*.mts
      // was outside both -- passing the walk, and failing HERE with a bewildered
      // "+ dist/probe.d.mts" instead of "framework dependency".
      const expectedFiles = srcFiles().flatMap((absolute) => {
        const path = relative(join(packageRoot, "src"), absolute);
        const stem = path.replace(emittedSourceExtension, "");
        const [declaration, javascript] = path.endsWith(".mts")
          ? [".d.mts", ".mjs"]
          : path.endsWith(".cts")
            ? [".d.cts", ".cjs"]
            : [".d.ts", ".js"];
        return [declaration, `${declaration}.map`, javascript, `${javascript}.map`].map(
          (suffix) => `dist/${stem}${suffix}`,
        );
      });
      expect(artifact.files.map(({ path }) => path).sort()).toStrictEqual(
        [...expectedFiles, "LICENSE", "NOTICE", "README.md", "package.json"].sort(),
      );

      const tarball = join(packDir, artifact.filename);
      writeFileSync(
        join(consumerDir, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: { "@looprig/client": `file:${tarball}` },
        }),
      );
      writeFileSync(
        join(consumerDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", noEmit: true } }),
      );
      writeFileSync(
        join(consumerDir, "consumer.ts"),
        'import type { ContentBlock } from "@looprig/client";\nconst block: ContentBlock = { type: "text", text: "packed" };\nif (block.type !== "text") throw new Error("unexpected block");\n',
      );
      writeFileSync(
        join(consumerDir, "consumer.mjs"),
        'import { textBlock } from "@looprig/client";\nif (textBlock("packed").Text !== "packed") throw new Error("runtime import failed");\n',
      );
      run("npm", ["install", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], consumerDir);
      const installedPackage = realpathSync(join(consumerDir, "node_modules/@looprig/client"));
      const consumerRelativePath = relative(realpathSync(consumerDir), installedPackage);
      expect(consumerRelativePath).not.toMatch(/^\.\.(?:\/|$)/);
      expect(installedPackage).not.toContain(workspaceRoot);
      const installedManifest = JSON.parse(
        readFileSync(join(installedPackage, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        exports?: { "."?: { types?: string; default?: string } };
      };
      expect(installedManifest.exports?.["."]).toStrictEqual({
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      });
      // Every declared runtime dependency must arrive for a consumer of the
      // TARBALL -- which carries none of them; the file list asserted above is
      // dist/ plus package.json -- at the version the COMMITTED LOCKFILE pins.
      //
      // BOTH halves carry weight, and an earlier version of this comment
      // called the first one "a tautology -- npm installs what the manifest
      // says", which is wrong. `toBe(version)` compares an installed
      // package.json's `version` field against the SPECIFIER; those are equal
      // only for a specifier that is an exact pin AND actually resolved.
      // `ajv: "^8.20.0"` fails it with `ajv did not resolve for a tarball
      // consumer: expected '8.20.0' to be '^8.20.0'`, and so does any alias,
      // `npm:`, git, `file:` or `workspace:` specifier -- on the PACKED
      // manifest, which is the one a consumer gets and is not the one the
      // "has no framework dependencies" regex reads.
      //
      // The lockfile half is the second, independent fact. The workspace's own
      // reproducibility rests on package-lock.json, not on the manifest: the
      // exact top-level pins say nothing about `centrifuge`'s own ranged
      // `events ^3.3.0` and `protobufjs ^7.6.0`. A manifest pin moved without
      // regenerating the lock is the one way the two disagree, and it is the
      // failure this catches. Derived from the manifest, not a second list.
      const lockfile = JSON.parse(readFileSync(join(workspaceRoot, "package-lock.json"), "utf8")) as {
        packages?: Record<string, { version?: string }>;
      };
      for (const [name, version] of Object.entries(installedManifest.dependencies ?? {})) {
        const dependency = JSON.parse(
          readFileSync(join(consumerDir, "node_modules", name, "package.json"), "utf8"),
        ) as { version?: string };
        expect(dependency.version, `${name} did not resolve for a tarball consumer`).toBe(version);
        expect(
          lockfile.packages?.[`node_modules/${name}`]?.version,
          `${name} is pinned to ${version} but the committed lockfile says otherwise`,
        ).toBe(version);
      }
      run(join(workspaceRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumerDir);
      run(process.execPath, ["consumer.mjs"], consumerDir);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
    // 30 s was under the real cost of this case: a protocol build, an npm
    // pack, a consumer `npm install`, a consumer tsc and a node run — measured
    // at ~52 s of work on this host, so the cap failed the whole test
    // gate for machine speed rather than for drift. A per-test cap cannot be
    // raised from the CLI, so it is raised here.
  }, 300_000);
});
