/**
 * Packaging invariants.
 *
 * Two artefacts come out of this repository and they must stay apart:
 *
 * * `dist/`, the ncc bundle the GitHub Action runs, committed to git and
 *   already 6.6 MB. libsodium must never land in it: the Action has no use
 *   for sealing, and the bundle lives in version control.
 * * `lib/`, the npm package. It must not carry the Octokit stack, so that
 *   `npx @mankinds/cli dev` stays a small download.
 *
 * Both are structural properties a refactor can break without any test
 * failing, which is exactly why they are asserted rather than documented.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Follow static imports from an entry, within src/. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    // Static imports only: a dynamic import() is the lazy boundary and is
    // deliberately not followed.
    for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        queue.push(specifier.replace(/^\.\//, "").replace(/\.js$/, ".ts"));
      }
    }
  }
  return seen;
}

function staticImportsOf(files: Iterable<string>): Set<string> {
  const externals = new Set<string>();
  for (const file of files) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) externals.add(specifier);
    }
  }
  return externals;
}

describe("the GitHub Action bundle stays lean", () => {
  const reachable = reachableFrom("main.ts");

  it("does not reach the sealing module", () => {
    expect([...reachable]).not.toContain("runner/seal.ts");
  });

  it("does not reach the dev command at all", () => {
    expect([...reachable].filter((file) => file.startsWith("runner/"))).toEqual([]);
  });

  it("does not import libsodium, directly or otherwise", () => {
    expect([...staticImportsOf(reachable)]).not.toContain("libsodium-wrappers");
  });
});

describe("the npm package stays lean", () => {
  const reachable = reachableFrom("bin.ts");

  it("does not reach the @actions stack from the npm entry point", () => {
    const externals = [...staticImportsOf(reachable)];
    expect(externals).not.toContain("@actions/core");
    expect(externals).not.toContain("@actions/github");
  });

  it("keeps @actions out of the runtime dependencies", () => {
    expect(Object.keys(pkg.dependencies)).not.toContain("@actions/core");
    expect(Object.keys(pkg.dependencies)).not.toContain("@actions/github");
  });

  it("loads every command lazily, so the entry point pulls in nothing", () => {
    // bin.ts -> commands.ts -> exit_codes.ts, and nothing else statically.
    expect([...reachable].sort()).toEqual(["bin.ts", "commands.ts", "exit_codes.ts"]);
  });

  it("does not ship the committed Action bundle in the tarball", () => {
    expect(pkg.files).not.toContain("dist");
    expect(pkg.files).toContain("lib");
  });

  it("is publishable", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("exposes a bin npx resolves for the package name", () => {
    // `npx @mankinds/cli dev` picks the bin named after the package, scope
    // stripped. Without it npm cannot choose between the three.
    expect(Object.keys(pkg.bin)).toContain("cli");
  });

  it("keeps the CI binary name, which the Docker image and docs use", () => {
    expect(Object.keys(pkg.bin)).toContain("mankinds-ci");
  });
});

describe("version", () => {
  it("matches the one compiled into the CLI", async () => {
    const { VERSION } = await import("../src/version.js");
    expect(VERSION).toBe(pkg.version);
  });
});
