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

function exportedFunctions(source: string): string[] {
  return [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]).sort();
}

describe("the shared db mock", () => {
  it("mirrors every function src/db.ts exports", () => {
    expect(Object.keys(db).sort()).toEqual(exportedFunctions(readFileSync(SRC, "utf8")));
  });

  it("is the only db mock — no test file registers its own", () => {
    const needle = ["mock", ".module(", '"../src/db"'].join(""); // split so this file never self-matches
    const offenders = readdirSync(import.meta.dir)
      .filter((f) => f.endsWith(".test.ts"))
      .filter((f) => readFileSync(join(import.meta.dir, f), "utf8").includes(needle));
    expect(offenders).toEqual([]);
  });

  it("is the only route to the store — no test imports ../src/store directly", () => {
    // A direct static import only binds the mocked module while dbMock happens
    // to be imported above it in the same file. That is an import-order
    // dependency, i.e. the exact class of bug this module exists to delete.
    const offenders = readdirSync(import.meta.dir)
      .filter((f) => f.endsWith(".test.ts"))
      .filter((f) => /^import .* from "\.\.\/src\/store"/m.test(readFileSync(join(import.meta.dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
