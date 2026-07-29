import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "./support/dbMock";

// The shared db mock only removes the TIL-194 ordering bug while it stays
// complete: the moment src/db.ts grows an export the mock does not have, the
// store can call through to `undefined` again — and the symptom (a different
// file failing, only in a full run) points nowhere near the cause. So assert
// the surfaces match here, cheaply, by reading the source rather than
// importing it (importing ../src/db would hand back the mock).

const SRC = join(import.meta.dir, "..", "src", "db.ts");

/** Every value src/db.ts exports, however it is spelled. Matching only
 *  `export async function` let `export const x = async …` drift in unnoticed,
 *  which is the same silent-gap failure this file exists to prevent. */
function exportedNames(source: string): string[] {
  const re = /^export (?:async )?(?:function|const|let|var) (\w+)/gm;
  return [...source.matchAll(re)].map((m) => m[1]).sort();
}

describe("the shared db mock", () => {
  it("mirrors every value src/db.ts exports", () => {
    expect(Object.keys(db).sort()).toEqual(exportedNames(readFileSync(SRC, "utf8")));
  });

  // Both guards below are built from concatenated pieces so this file never
  // matches itself, and both are quote-agnostic: a guard that only knew the
  // double-quoted spelling was one `'` away from being bypassed, which is a
  // guard that reports safety it is not providing.
  const testFiles = () =>
    readdirSync(import.meta.dir)
      .filter((f) => f.endsWith(".test.ts") && f !== "dbSurface.test.ts")
      .map((f) => [f, readFileSync(join(import.meta.dir, f), "utf8")] as const);

  it("is the only db mock — no test file registers its own", () => {
    const re = new RegExp(["mock", "\\s*\\.\\s*module\\(\\s*['\"]", "\\.\\./src/db"].join(""));
    expect(testFiles().filter(([, src]) => re.test(src)).map(([f]) => f)).toEqual([]);
  });

  it("is the only route to the store — no test reaches ../src/store itself", () => {
    // Binding the store directly only works while dbMock happens to be imported
    // above it in the same file. That is an import-order dependency, i.e. the
    // exact class of bug this module exists to delete — and it is just as true
    // of a dynamic `await import(...)` as of a static one.
    const re = new RegExp(["(?:from|import\\()\\s*['\"]", "\\.\\./src/store", "['\"]"].join(""));
    expect(testFiles().filter(([, src]) => re.test(src)).map(([f]) => f)).toEqual([]);
  });
});
