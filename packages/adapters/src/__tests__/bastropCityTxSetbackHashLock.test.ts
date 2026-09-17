/**
 * COMPLETE-BASTROP C1 / WDLL item 8 — dual-repo bastrop-city-tx setback table
 * hash lock (S-05 / H1).
 *
 * Engine and LDT must keep identical LF bytes of bastrop-city-tx.json.
 * Pre-sync working-tree size drift (19670 vs 19258) was CRLF checkout on
 * Windows; git blobs were already identical (LF). Parsed numeric values were
 * identical (no B3 value merge required).
 *
 * Locked SHA256 (UTF-8, LF newlines, no BOM):
 *   9ed2ba806ab7d8f707712f042c8e435b8f5ec445c15d7204f88f05c0a7f02fa5
 *
 * P-299 (2026-09-17) moved the lock on both sides. LDT moved first (its own
 * lock docstring, at the commit this engine lane re-vendored the tables from,
 * `8e7218f7`): the six Place Type rows carried `max_height_ft` 100 with
 * provenance `not_specified: true` (the B3 code states height in stories); 100
 * is not the canonical stated-absence sentinel, so the value became 999 and
 * each table note gained the OT-1 block. That edit is the same in
 * hauska-setback-corpus. LDT's lane did not touch the ENGINE's copy and left
 * the engine lock to move in the change that syncs the corpus release --
 * `p299-engine-corpus-and-slate` is that change, so this file moves here.
 *
 * What the lock did NOT do while it was stale (recorded because it is the same
 * defect class this row exists to close): from LDT's move until this one, BOTH
 * repos' tests passed against their own copy. This one hashed the engine's
 * stale file and reported "matches the cross-repo locked SHA256"; LDT's mirror
 * hashed its new file and reported the same thing. The lock's stated premise --
 * "Engine and LDT must keep identical LF bytes" -- was false for those days and
 * neither test could see it, because each pinned its own bytes. A cross-repo
 * lock needs a cross-repo read; a self-pin is a stale-copy detector with the
 * stale copy baked in (DEV_PROCESS: a guardrail that does not survive a clone
 * is not a guardrail).
 *
 * The value above was MEASURED, not carried over from LDT's docstring: this
 * lane re-vendored this file byte-for-byte from LDT's blob at `8e7218f7` and
 * hashed the result (see
 * `_inbox/2026-09-17_p299-engine-corpus-and-slate_f1-table-revendor.json`,
 * files[bastrop-city-tx].ldtSha256 == afterSha256). The same measurement is
 * what keeps this file and the corpus release one fact: the six rows now carry
 * the corpus's 999-plus-`not_specified` shape, which is why
 * `packages/engine-core`'s emit path consults the flag (see
 * `emit-setback-rule.test.ts`, P-299).
 *
 * Previous lock (pre-P-299):
 *   d54844cd3711579323ceeb96481ade63f1967437a36adeac1c74140ad720cc3c
 *
 * Mirror test: legacy-design-tools/lib/adapters/src/__tests__/bastropCityTxSetbackHashLock.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Canonical SHA256 of bastrop-city-tx.json (LF). Keep in sync with LDT lock. */
export const BASTROP_CITY_TX_SETBACK_SHA256 =
  "9ed2ba806ab7d8f707712f042c8e435b8f5ec445c15d7204f88f05c0a7f02fa5";

const TABLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../local/setbacks/bastrop-city-tx.json",
);

describe("bastrop-city-tx setback hash lock (C1 / WDLL 8)", () => {
  it("matches the cross-repo locked SHA256 (LF-normalized bytes)", () => {
    const raw = readFileSync(TABLE_PATH);
    // Normalize CRLF→LF so Windows autocrlf checkouts still hash-lock to the
    // canonical blob (gitattributes eol=lf keeps the git object LF).
    const normalized = Buffer.from(
      raw.toString("utf8").replace(/\r\n/g, "\n"),
      "utf8",
    );
    const digest = createHash("sha256").update(normalized).digest("hex");
    expect(digest).toBe(BASTROP_CITY_TX_SETBACK_SHA256);
  });

  it("parses as bastrop-city-tx with six Place Type districts", () => {
    const table = JSON.parse(readFileSync(TABLE_PATH, "utf8")) as {
      jurisdictionKey: string;
      districts: Array<{ district_name: string }>;
    };
    expect(table.jurisdictionKey).toBe("bastrop-city-tx");
    expect(table.districts.map((d) => d.district_name)).toEqual([
      "P-1 Nature",
      "P-2 Rural",
      "P-3 Neighborhood",
      "P-4 Neighborhood Mix",
      "P-5 Core",
      "P-EC Employment Center",
    ]);
  });
});
