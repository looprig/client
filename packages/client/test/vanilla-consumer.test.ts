/**
 * Runbook 06 task U6.1 steps 1-3: prove the framework-neutral artifact.
 *
 * `test/surface.test.ts` already installs the packed tarball into a throwaway
 * fixture and imports one value from it. This file is the different thing U6.1
 * asks for: a real CONSUMER, compiled by its own `tsc` and run by `node`
 * outside the npm workspace, that drives the package's whole advertised
 * capability set -- join, retry-stable commands, reset repair and paged tool
 * objects -- against a fake Factory REST/ClientLink pair, plus the dependency
 * inspection step 3 names. The consumer's own sources live in
 * `packages/client/consumer/` so they are reviewable rather than string
 * literals in a test; this file only packs, installs, compiles, runs and
 * inspects.
 *
 * THE TWO NEGATIVE ASSERTIONS, AND WHY EACH HAS A POSITIVE CONTROL
 * ----------------------------------------------------------------
 * Step 3 asks for two findings of the form "nothing was found": no
 * React/Svelte/Harness dependency, and no workspace-only `0.0.0` reference. An
 * inspection that runs over the real input and returns an accurate-looking
 * empty answer while being blind is indistinguishable from a correct one, so
 * neither claim is made without a KNOWN-ANSWER input driven through the SAME
 * function:
 *
 *  - `frameworkClosure` is exercised by `installedClosureFixture`, a synthetic
 *    node_modules tree that really does contain React (transitively, two hops
 *    down), Vue and Svelte, and a dependency that is declared but not
 *    installed. If the walker cannot see those, it cannot see their absence
 *    either.
 *  - `workspaceOnlyReferences` is exercised by a fixture whose manifests carry
 *    `0.0.0`, `workspace:*`, `file:` and `link:` specifiers and a `0.0.0`
 *    installed version.
 *
 * The third negative assertion -- "without importing React" -- is not made
 * here at all, because a test cannot prove it by looking at the consumer's
 * source. It is asserted by the consumer itself, from the MECHANISM: `react`,
 * `react-dom`, `svelte`, `@sveltejs/kit`, `@looprig/harness` and
 * `@looprig/react` are not resolvable from its resolution root, so an import of
 * any of them could not compile or run there. See `consumer/main.ts`.
 *
 * WHAT THE CLOSURE CHECK IS AND IS NOT
 * ------------------------------------
 * `EXPECTED_CLOSURE` is an ALLOWLIST of package names, stated plainly because
 * defect class 6 applies: a rule that names React, Svelte and Harness cannot
 * fail for a fourth framework. An allowlist can, and this one does -- a package
 * enters a consumer's install by being added here on purpose or not at all, so
 * Vue, Solid, Angular or anything else fails it without being named. What it
 * genuinely cannot see, stated rather than implied: a framework that arrives
 * INSIDE an already-admitted package (if `ajv` began vendoring React source,
 * the closure would be unchanged), and anything reached by a mechanism other
 * than a manifest dependency edge -- a postinstall script, a bundled
 * dependency, a dynamic import of a package the manifest does not declare.
 * `test/surface.test.ts`'s module-graph walk covers the last of those for this
 * package's own sources; nothing here covers it for a third party's.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(packageRoot, "../..");

/**
 * Every package a consumer of the tarball actually installs, by name.
 * `@looprig/client` itself is the walk's root and is included. Versions are
 * deliberately NOT pinned here -- several of these arrive through ranged
 * transitive dependencies and a registry patch bump is not a finding. The
 * committed lockfile is the version authority, and `agrees with the committed
 * lockfile` below asserts this same set against it.
 */
const EXPECTED_CLOSURE = [
  "@babel/runtime",
  "@looprig/client",
  "@protobufjs/aspromise",
  "@protobufjs/base64",
  "@protobufjs/codegen",
  "@protobufjs/eventemitter",
  "@protobufjs/fetch",
  "@protobufjs/float",
  "@protobufjs/path",
  "@protobufjs/pool",
  "@protobufjs/utf8",
  "@types/node",
  "ajv",
  "centrifuge",
  "events",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-to-ts",
  "json-schema-traverse",
  "long",
  "protobufjs",
  "require-from-string",
  "ts-algebra",
  "undici-types",
] as const;

interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

/** The dependency edges an INSTALL follows: `dependencies` plus non-optional `peerDependencies`. */
function dependencyEdges(manifest: Manifest): string[] {
  const names = new Set(Object.keys(manifest.dependencies ?? {}));
  for (const [name] of Object.entries(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[name]?.optional !== true) names.add(name);
  }
  return [...names];
}

/** npm's hoisted resolution: the nearest `node_modules/<name>` walking up from `fromDir`. */
function locatePackage(fromDir: string, name: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface ClosureResult {
  /** Sorted package names reachable from the entry package, including it. */
  readonly packages: string[];
  /** `dependent -> dependency` edges the manifests declare and the install does not satisfy. */
  readonly unresolved: string[];
  /** Where each package was found, for the workspace-only scan below. */
  readonly directories: Map<string, string>;
}

/**
 * Walks the installed dependency closure of `entry` from a consumer root.
 *
 * Derived from module resolution, not from a list of forbidden names: the
 * answer is WHICH packages an install of this tarball puts on disk. An
 * unsatisfied edge is REPORTED rather than skipped, because a walker that
 * quietly stops at a missing package returns a short closure that looks clean.
 */
function frameworkClosure(consumerRoot: string, entry: string): ClosureResult {
  const start = join(consumerRoot, "node_modules", entry);
  if (!existsSync(join(start, "package.json"))) {
    throw new Error(`${entry} is not installed under ${consumerRoot}`);
  }
  const directories = new Map<string, string>();
  const unresolved: string[] = [];
  const pending: [string, string][] = [[entry, start]];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const [name, dir] = next;
    if (directories.has(name)) continue;
    directories.set(name, dir);
    for (const dependency of dependencyEdges(readManifest(dir))) {
      const located = locatePackage(dir, dependency);
      if (located === undefined) unresolved.push(`${name} -> ${dependency}`);
      else pending.push([dependency, located]);
    }
  }
  return { packages: [...directories.keys()].sort(), unresolved: unresolved.sort(), directories };
}

/**
 * A specifier that can only be satisfied inside the workspace that produced it.
 * `0.0.0` is npm's conventional placeholder for a linked, never-published
 * package -- the exact thing runbook 06 C1.4 has to replace -- and `workspace:`,
 * `file:` and `link:` are the protocols that link one. A published artifact
 * carrying any of them installs for its author and for nobody else.
 */
const WORKSPACE_ONLY_SPECIFIER = /^(?:0\.0\.0(?:[-+].*)?|(?:workspace|file|link):.*)$/;

/**
 * Every workspace-only reference in an installed closure: a package whose own
 * VERSION is the `0.0.0` placeholder, and any dependency SPECIFIER that names
 * one. Scoped to the closure, so the consumer fixture's own unavoidable
 * `file:<tarball>` install specifier is out of scope by construction and is not
 * silently excluded by a name.
 */
function workspaceOnlyReferences(closure: ClosureResult): string[] {
  const findings: string[] = [];
  for (const [name, dir] of closure.directories) {
    const manifest = readManifest(dir);
    if (manifest.version !== undefined && WORKSPACE_ONLY_SPECIFIER.test(manifest.version)) {
      findings.push(`${name} is installed at the workspace-only version ${manifest.version}`);
    }
    const declared = { ...manifest.dependencies, ...manifest.peerDependencies };
    for (const [dependency, specifier] of Object.entries(declared)) {
      if (WORKSPACE_ONLY_SPECIFIER.test(specifier)) {
        findings.push(`${name} depends on ${dependency} by the workspace-only specifier ${specifier}`);
      }
    }
  }
  return findings.sort();
}

/** The same closure, predicted from the committed lockfile rather than from an install. */
function lockfileClosure(entryLockPath: string): string[] {
  const lockfile = JSON.parse(readFileSync(join(workspaceRoot, "package-lock.json"), "utf8")) as {
    packages?: Record<string, Manifest>;
  };
  const packages = lockfile.packages ?? {};
  const entry = packages[entryLockPath];
  if (entry === undefined) throw new Error(`the committed lockfile has no entry for ${entryLockPath}`);
  const seen = new Set<string>(["@looprig/client"]);
  const pending = dependencyEdges(entry);
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const record = packages[`node_modules/${name}`];
    if (record === undefined) throw new Error(`the committed lockfile has no entry for node_modules/${name}`);
    pending.push(...dependencyEdges(record));
  }
  return [...seen].sort();
}

function writeJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/**
 * A synthetic installed tree, the known-answer input both inspections are
 * driven over. Every forbidden thing the real tree must not contain IS here:
 * React two hops down (so a direct-dependency check would miss it), Vue --
 * which no rule in this file names -- one hop down, Svelte through a
 * peerDependency, a declared-but-uninstalled package, a `0.0.0` installed
 * version, and `0.0.0`/`workspace:`/`file:`/`link:` specifiers.
 */
function installedClosureFixture(root: string): void {
  const modules = join(root, "node_modules");
  writeJSON(join(modules, "@looprig/client/package.json"), {
    name: "@looprig/client",
    version: "0.0.0",
    dependencies: { "@looprig/adapter": "0.0.0", vue: "^3.0.0", ghost: "^1.0.0" },
  });
  writeJSON(join(modules, "@looprig/adapter/package.json"), {
    name: "@looprig/adapter",
    version: "1.0.0",
    dependencies: { react: "^19.0.0", "@looprig/harness": "workspace:*" },
    peerDependencies: { svelte: "^5.0.0", "solid-js": "^1.0.0" },
    peerDependenciesMeta: { "solid-js": { optional: true } },
  });
  writeJSON(join(modules, "react/package.json"), { name: "react", version: "19.0.0" });
  writeJSON(join(modules, "vue/package.json"), { name: "vue", version: "3.4.0" });
  writeJSON(join(modules, "svelte/package.json"), {
    name: "svelte",
    version: "5.0.0",
    dependencies: { "@looprig/client": "file:../client", "@looprig/legacy": "link:../legacy" },
  });
  writeJSON(join(modules, "@looprig/harness/package.json"), { name: "@looprig/harness", version: "1.0.0" });
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `${failure.message ?? `${command} failed`}\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`,
    );
  }
}

describe("the packed @looprig/client artifact", () => {
  let fixture: string;
  let consumerDir: string;
  let consumerOutput: string;
  let closure: ClosureResult;

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), "looprig-protocol-vanilla-"));
    const packDir = join(fixture, "pack");
    consumerDir = join(fixture, "consumer");
    mkdirSync(packDir);
    mkdirSync(consumerDir);
    const npmCache = process.env.npm_config_cache ?? join(tmpdir(), "looprig-protocol-npm-cache");

    run("npm", ["run", "build", "--workspace", "@looprig/client"], workspaceRoot, { npm_config_cache: npmCache });
    const packed = JSON.parse(
      run(
        "npm",
        ["pack", "--workspace", "@looprig/client", "--ignore-scripts", "--json", "--pack-destination", packDir],
        workspaceRoot,
        { npm_config_cache: npmCache, npm_config_dry_run: "false" },
      ),
    ) as { filename: string }[];
    const artifact = packed[0];
    if (artifact === undefined) throw new Error("npm pack returned no artifact");
    const tarball = join(packDir, artifact.filename);

    // The consumer's own sources, copied out of the repository so they are
    // reviewable there rather than being string literals here.
    cpSync(join(packageRoot, "consumer"), consumerDir, { recursive: true });
    writeJSON(join(consumerDir, "package.json"), {
      name: "looprig-protocol-vanilla-consumer",
      private: true,
      type: "module",
      // The tarball is the ONLY runtime dependency. `typescript` and
      // `@types/node` are the consumer's OWN toolchain -- it compiles with its
      // own tsc, not the workspace's, so no part of this run reaches back into
      // the workspace's node_modules.
      dependencies: { "@looprig/client": `file:${tarball}` },
      devDependencies: { "@types/node": "^22.0.0", typescript: "^6.0.0" },
    });
    run("npm", ["install", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], consumerDir, {
      npm_config_cache: npmCache,
      npm_config_dry_run: "false",
      npm_config_workspaces: "false",
    });

    // Resolution must not escape the temporary directory. Asserted, not
    // assumed: a consumer whose `@looprig/client` symlinked back into the
    // workspace would test workspace resolution and prove nothing.
    const installed = realpathSync(join(consumerDir, "node_modules/@looprig/client"));
    if (relative(realpathSync(consumerDir), installed).startsWith("..")) {
      throw new Error(`the consumer resolved @looprig/client outside itself: ${installed}`);
    }
    if (installed.startsWith(realpathSync(workspaceRoot))) {
      throw new Error(`the consumer resolved @looprig/client inside the workspace: ${installed}`);
    }

    run(join(consumerDir, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumerDir);
    consumerOutput = run(process.execPath, ["out/main.js"], consumerDir);
    closure = frameworkClosure(consumerDir, "@looprig/client");
  }, 600_000);

  it("compiles and runs a vanilla consumer that joins, commands, repairs and pages", () => {
    // Every assertion is in consumer/main.ts and each throws on failure, so a
    // clean exit plus this line is the whole scenario having passed.
    expect(consumerOutput).toContain("vanilla consumer: OK");
  });

  it("cannot resolve any UI framework or Harness from the consumer's root", () => {
    const line = consumerOutput.split("\n").find((entry) => entry.startsWith("RESOLUTION_REPORT "));
    expect(line, "the consumer did not report what it checked").toBeDefined();
    const report = JSON.parse(line!.slice("RESOLUTION_REPORT ".length)) as Record<string, boolean>;
    // Asserted as a WHOLE MAP rather than key by key: a consumer that stopped
    // checking `svelte` would otherwise pass this silently, and the `true` for
    // `@looprig/client` is the anti-vacuity half -- resolution works here,
    // and the frameworks are still absent.
    expect(report).toStrictEqual({
      "@looprig/client": true,
      react: false,
      "react-dom": false,
      "react/jsx-runtime": false,
      svelte: false,
      "@sveltejs/kit": false,
      "@looprig/harness": false,
      "@looprig/react": false,
    });
  });

  it("installs a dependency closure with no React, Svelte or Harness in it", () => {
    expect(closure.unresolved).toStrictEqual([]);
    expect(closure.packages).toStrictEqual([...EXPECTED_CLOSURE]);
    // Redundant given the allowlist above, and kept for legibility: this is the
    // sentence step 3 asks for, and it should be readable without deriving it.
    for (const forbidden of ["react", "react-dom", "svelte", "@sveltejs/kit", "@looprig/harness", "@looprig/react"]) {
      expect(closure.packages, `${forbidden} is in the installed closure`).not.toContain(forbidden);
    }
  });

  it("reports a framework in a closure that has one, including one no rule names", () => {
    // POSITIVE CONTROL for the assertion above. Same function, known-answer
    // input. Without this, an empty finding is indistinguishable from a blind
    // walker.
    const control = mkdtempSync(join(tmpdir(), "looprig-protocol-closure-control-"));
    try {
      installedClosureFixture(control);
      const found = frameworkClosure(control, "@looprig/client");
      // `react` is TWO hops down, so a direct-dependency check would miss it;
      // `svelte` arrives through a non-optional peerDependency; `vue` is named
      // by no rule in this file and is caught anyway, which is the difference
      // between an allowlist and a denylist.
      expect(found.packages).toStrictEqual([
        "@looprig/adapter",
        "@looprig/client",
        "@looprig/harness",
        "react",
        "svelte",
        "vue",
      ]);
      // An optional peer is not installed and is correctly not walked.
      expect(found.packages).not.toContain("solid-js");
      // A declared edge the install does not satisfy is REPORTED, not skipped.
      // `ghost` is absent, and the legacy workspace link target is absent.
      // The root @looprig/client package satisfies svelte's self-reference.
      expect(found.unresolved).toStrictEqual([
        "@looprig/client -> ghost",
        "svelte -> @looprig/legacy",
      ]);
    } finally {
      rmSync(control, { recursive: true, force: true });
    }
  });

  it("makes no workspace-only 0.0.0 reference", () => {
    expect(workspaceOnlyReferences(closure)).toStrictEqual([]);
    // The packed manifest is the one a consumer actually receives, and it is
    // the file a `0.0.0` would sit in. Read from the INSTALLED copy.
    const manifest = readManifest(join(consumerDir, "node_modules/@looprig/client"));
    expect(manifest.version).toBe("0.2.0");
    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
      expect(specifier, `${name} must be an exact published pin`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("reports a workspace-only reference in a tree that has one", () => {
    // POSITIVE CONTROL for the assertion above, over the same fixture.
    const control = mkdtempSync(join(tmpdir(), "looprig-protocol-workspace-control-"));
    try {
      installedClosureFixture(control);
      expect(workspaceOnlyReferences(frameworkClosure(control, "@looprig/client"))).toStrictEqual([
        "@looprig/adapter depends on @looprig/harness by the workspace-only specifier workspace:*",
        "@looprig/client depends on @looprig/adapter by the workspace-only specifier 0.0.0",
        "@looprig/client is installed at the workspace-only version 0.0.0",
        "svelte depends on @looprig/client by the workspace-only specifier file:../client",
        "svelte depends on @looprig/legacy by the workspace-only specifier link:../legacy",
      ]);
    } finally {
      rmSync(control, { recursive: true, force: true });
    }
  });

  it("agrees with the committed lockfile about which packages a consumer installs", () => {
    // The install resolved ranges fresh, with no lockfile of its own. If it and
    // the committed lockfile disagree about the SET, the workspace has been
    // reproducing a different closure than a consumer gets. Versions are not
    // compared here -- several of these are ranged transitives and a registry
    // patch bump is not a finding; `test/surface.test.ts` pins the exact
    // versions of the three direct dependencies against this same lockfile.
    expect(lockfileClosure("packages/client")).toStrictEqual(closure.packages);
  });

  it("keeps the consumer's sources out of the published tarball", () => {
    // `files: ["dist"]` already excludes `consumer/`, but the directory is new
    // and sits inside the package root, which is exactly where an accidental
    // inclusion would come from.
    expect(readdirSync(join(consumerDir, "node_modules/@looprig/client")).sort()).toStrictEqual([
      "LICENSE",
      "NOTICE",
      "README.md",
      "dist",
      "package.json",
    ]);
  });
});
