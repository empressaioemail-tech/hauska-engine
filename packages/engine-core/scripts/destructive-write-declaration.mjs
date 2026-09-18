/**
 * P-328: THE PROGRAM'S DESTRUCTIVE-WRITE DECLARATION, carried by hauska-engine.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------------------------
 *
 * The program declared ONE blast-radius number and ONE authorisation convention in hauska-factory
 * (`src/lib/destructive-write-guard.mjs`, P-320): `MAX_DESTRUCTIVE_SHARE = 0.5`, the env var
 * `DESTRUCTIVE_WRITE_AUTHORISATION`, and a token `<writer>:<county-fips>:<destructive>/<population>`
 * bound to the measured counts. That module's registry (`DESTRUCTIVE_WRITERS`) lists factory writers
 * only. The engine cannot import the factory, so the engine's writers held their own numbers
 * instead -- `MAX_ORPHAN_SHARE = 0.05` and `MAX_REACTIVATION_SHARE = 0.05`, two declarations of a
 * number the program had already declared once.
 *
 * P-328's plan row is explicit: the engine writer "reads one declared threshold and authorisation
 * with a drift check against factory's". That is what this module is. It is the ONE place the
 * engine states the number, the env var and the token shape, and `PROGRAM_DECLARATION_PIN` records
 * the factory file it is a copy of, at a pinned SHA, so the copy cannot drift silently.
 *
 * ---------------------------------------------------------------------------------------------
 * THE NUMBER, AND THE COST OF CARRYING IT RATHER THAN THE ENGINE'S EARLIER ONE
 * ---------------------------------------------------------------------------------------------
 *
 * `MAX_DESTRUCTIVE_SHARE = 0.5` is the program's number and is NOT re-derived here. It is a COPY,
 * and a copy that cannot be re-derived is a number that drifts, which is why the pin and the drift
 * check exist beside it.
 *
 * STATED PLAINLY, because it is a change to a live control: the engine's writers refused above
 * 0.05 before this row. Carrying 0.5 LOOSENS the engine's parcel-node and reactivation controls by
 * 10x. The Bastrop incident (92.5 percent) is refused under either number, so the row's completion
 * predicate holds; the band that stopped being refused is 5 to 50 percent, where a mass false
 * retirement would now pass unauthorised. Two things follow, and both are deliberate:
 *
 *   - One number is the program's choice, and the alternatives are worse: a second number is the
 *     defect this row exists to prevent, and a drift check that compares 0.05 to 0.5 is a
 *     permanently-red gate, which DEV_PROCESS calls a dead gate.
 *   - If the operator wants the sharper number, the place to change it is the factory's single
 *     declaration, and the engine follows through this pin. leave_behind carries that proposal.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY A PINNED SHA AND NOT A NETWORK FETCH
 * ---------------------------------------------------------------------------------------------
 *
 * hauska-factory is PRIVATE and unpublished (measured 2026-09-18: the GitHub API and
 * raw.githubusercontent.com both answer 404 for it while a credentialed `git fetch` succeeds, and
 * `npm view hauska-factory` is E404 because its package.json is `"private": true`). hauska-engine
 * is public. So the engine's CI CANNOT read the factory's value: there is no published file to
 * read, and reading it at a pinned SHA still requires repo access. The pin is therefore
 * re-derivable from a LOCAL clone with `git show <sha>:<path>`, which is what
 * `check-destructive-write-share-divergence.mjs --factory <path>` does, and the enforceable
 * cross-repo direction is the factory-side one (the factory can read the public engine). That row
 * is handed back rather than faked here.
 */

/**
 * THE NUMBER. The program's, carried, pinned, and never re-derived in this repo. See the header for
 * the basis and for the 0.05 -> 0.5 loosening this carries.
 */
export const MAX_DESTRUCTIVE_SHARE = 0.5;

/**
 * THE AUTHORISATION VARIABLE. The factory's name, so an operator who has authorised one of these
 * has authorised the other and there is no second thing to get wrong under pressure.
 */
export const AUTHORISATION_ENV_VAR = "DESTRUCTIVE_WRITE_AUTHORISATION";

/**
 * The token for one measured run: `<writer>:<county-fips>:<destructive>/<population>`.
 * Identical to the factory's `authorisationTokenFor` -- one grammar, two repos.
 */
export function authorisationTokenFor(writer, countyFips, destructive, population) {
  return `${writer}:${String(countyFips)}:${destructive}/${population}`;
}

/**
 * The factory file this declaration is a copy of. `facts` are the literals READ OUT of that file at
 * that ref, so the drift check can compare the engine's declaration to the recorded copy without
 * needing the repo, and `--factory <path>` can re-derive them from a local clone.
 *
 * Re-derive with:
 *   node scripts/check-destructive-write-share-divergence.mjs --factory <path-to-hauska-factory>
 * Read at the ref with `git show 85d63e8d:src/lib/destructive-write-guard.mjs`.
 */
export const PROGRAM_DECLARATION_PIN = Object.freeze({
  repo: "empressaioemail-tech/hauska-factory",
  path: "src/lib/destructive-write-guard.mjs",
  ref: "85d63e8d39f0129ef14267f432b8a555292fd172",
  refSubject: "fix(P-325): a join miss is not a verified absence (#175) -- factory origin/main tip",
  refReadAt: "2026-09-18",
  gitBlobSha: "a0f8e22fa2dcf04b4f665607367140efa0a6fc8a",
  bytes: 19597,
  sha256: "165dc955b840af4e1fd75ed3da1e7db1a5077137421b345a4f6cd6bc88411bd1",
  facts: Object.freeze({
    constantName: "MAX_DESTRUCTIVE_SHARE",
    constantValue: 0.5,
    envVarName: "AUTHORISATION_ENV_VAR",
    envVarValue: "DESTRUCTIVE_WRITE_AUTHORISATION",
    tokenGrammar: "<writer>:<county-fips>:<destructive>/<population>",
    tokenFunction: "authorisationTokenFor",
    refusalCode: "DESTRUCTIVE_BLAST_RADIUS",
    unmeasuredCode: "DESTRUCTIVE_UNMEASURED",
    registerName: "DESTRUCTIVE_WRITERS",
  }),
});

/**
 * THE ENGINE'S REFUSAL CODES, declared once and checked against the module that throws them.
 *
 * The pin above records the FACTORY's names for the same refusals
 * (`DESTRUCTIVE_BLAST_RADIUS`, `DESTRUCTIVE_UNMEASURED`). The engine's are `BLAST_RADIUS_*` and
 * have been since P-213, are named in live refusal messages, and are asserted by P-213's and
 * P-275's tests. The dispatch requires the NUMBER and the TOKEN FORMAT to be the program's; it
 * does not require the code NAMES to be, and renaming four codes across every caller and test to
 * match a string is a change with no measured effect on any refusal.
 *
 * So the divergence is STATED rather than smoothed over -- and the half that can be made
 * single-source is: the guard no longer writes a code literal at a throw site, it imports these,
 * and the drift check asserts every `refuse(...)` in the guard passes one of these identifiers and
 * that every identifier here is thrown somewhere. A code recorded in one file and spelled by hand
 * in another is exactly the arrangement P-320 warned about ("a second copy ... is a number that
 * can drift"); this removes the second spelling.
 */
export const REFUSAL_CODES = Object.freeze({
  engine: Object.freeze({
    blastRadius: "BLAST_RADIUS_EXCEEDED",
    unmeasured: "BLAST_RADIUS_UNMEASURED",
    overrideMalformed: "BLAST_RADIUS_OVERRIDE_MALFORMED",
    overrideMismatch: "BLAST_RADIUS_OVERRIDE_MISMATCH",
  }),
});

/** The env var, read once the way a writer reads it: the raw authorisation value, or null. */
export function authorisationFromEnv(env = process.env) {  const raw = env?.[AUTHORISATION_ENV_VAR];
  return raw === undefined || raw === null || String(raw).trim() === ""
    ? null
    : String(raw).trim();
}

/**
 * THE ENGINE'S REGISTER OF DESTRUCTIVE WRITERS.
 *
 * `wired: true` means the writer calls `evaluateBlastRadius` BEFORE it flips any status, on the
 * ordinary path, with a population it measured itself. `wired: false` is a CLAIM about the writer
 * that has to be true, and it is checked rather than trusted:
 * `destructive-write-declaration.test.mjs` scans `src/` and `scripts/` for destructive statements
 * and refuses any module the register does not name -- so a new destructive statement cannot be
 * missed by omission, which is the failure mode a hand-written list always has.
 *
 * This mirrors the factory's `DESTRUCTIVE_WRITERS` in SHAPE, not in contents: the two registers are
 * not joined (leave_behind).
 *
 * WHAT IS DELIBERATELY *NOT* IN THIS REGISTER, AND WHY THE SCAN AGREES
 * ---------------------------------------------------------------------------------------------
 * `scripts/backfill-bastrop-zoning-fact-*.mjs`, `scripts/backfill-property-line-tags-bastrop.mjs`,
 * `scripts/restamp-bastrop-downtown-zoning.mjs`, `scripts/strip-cad-parcel-roll-owner-fields.mjs`
 * and `packages/storage/scripts/backfill-icc-access-policy.mjs` all run `UPDATE atoms SET body =
 * ...`: they rewrite fields IN PLACE on rows that stay served. That is a destructive edit of a
 * body, and it is a real thing to review -- but it is not a destructive STATUS transition and it
 * removes no record, so it is outside what P-328 asks the register to cover ("writers that can set
 * a destructive status on a served record"). They are named here, rather than simply not matched,
 * so that the exclusion is a stated judgement a reader can disagree with instead of a scan that
 * quietly looks away from them.
 */
export const DESTRUCTIVE_WRITERS = Object.freeze([
  Object.freeze({
    id: "parcel-node-county-reconcile",
    module: "scripts/write-parcel-node-county.mjs",
    producer: "src/parcel-node/reconcile-county-parcel-nodes.ts",
    status: "retired (parcel-node atoms)",
    what: "the re-acquisition orphan pass: prior active parcel-node rows absent from the new plan are flipped to status 'retired'",
    wired: true,
    reason:
      "Wired (P-213) and the refusal is ordered before any retire body is built or written, in " +
      "dry-run and --apply. This is the writer P-328 is about: the same population that was " +
      "emptied at Bastrop (57,704 of 62,394 = 92.5 percent). Its declared number is now the " +
      "program's, read from this module.",
  }),
  Object.freeze({
    id: "road-node-county-reconcile",
    module: "scripts/write-road-node-county.mjs",
    producer: "src/road-node/ (reconcileCountyRoadNodes)",
    status: "retired (road-node atoms)",
    what: "the PBF-scoped orphan pass: prior active road-node rows absent from the new PBF plan are flipped to status 'retired'",
    wired: true,
    reason:
      "WIRED BY THIS ROW (P-328), not before it. P-213's own header named this writer as having " +
      "the IDENTICAL unconditional-orphan-retirement shape as the parcel-node writer and 'found " +
      "while building this guard, not fixed by it' -- so it carried the same hazard with no share " +
      "check at all, for the whole life of the parcel-node guard. Same population shape (prior " +
      "active rows vs the new plan), same destructive transition, same declared number.",
  }),
  Object.freeze({
    id: "parcel-node-retired-review-reactivation",
    module: "scripts/retired-reactivation-guard.mjs, scripts/review-retired-parcel-nodes.mjs",
    producer: "scripts/review-retired-parcel-nodes.mjs",
    status: "active (retired -> active)",
    what:
      "the retired-row review's reactivation: rows the county's own service corroborates are returned " +
      "from 'retired' to 'active'. `review-retired-parcel-nodes.mjs` is named beside the guard " +
      "because it carries the `status: \"retired\"` literal -- there as a READ projection rebuilt " +
      "from the stored body to plan the review, not as a write -- and because it is the only " +
      "caller that decides which rows the reactivation can touch. A literal scan cannot tell a " +
      "read projection from a write, so the register names the module rather than exempting it: an " +
      "exemption would be a hole a future real write into that file could be made through.",
    wired: true,
    reason:
      "Wired (P-275) in the OPPOSITE direction. A mass reactivation is not a destructive-status " +
      "transition, so it is not the same class as the two above; it is registered because it " +
      "moves a population's status in one run and because P-275's own header declared its number " +
      "as 'the same declared number write-parcel-node-county.mjs uses', i.e. it never had an " +
      "independent basis. It now reads the program's single number from this module rather than " +
      "holding a second one, which is what makes the engine's declaration genuinely ONE number.",
  }),
  Object.freeze({
    id: "depth-warm-promotion-supersede",
    module: "src/depth-warm/promote.ts",
    status: "retired (superseded atoms)",
    what: "a promoted depth-warm atom retires the atom it replaces",
    wired: false,
    reason:
      "NOT wired, and the reason is that it is not a SET-VALUED comparison: a promotion retires " +
      "the specific predecessor atom it is replacing, one promotion at a time, chosen by the " +
      "promotion's own evidence rather than computed as a difference against a prior population. " +
      "There is no population to take a share of. A batch promotion mode -- 'promote every " +
      "candidate in a county', which would retire as a set -- would be in class and must call " +
      "evaluateBlastRadius with the number of predecessors that mode would retire.",
  }),
  Object.freeze({
    id: "property-atom-retire-and-bakes",
    module:
      "src/property-reasoning/retire.ts, src/road-intake/road-supersede.ts, " +
      "packages/storage/scripts/write-property-atom-proof.mjs, " +
      "packages/storage/src/road-ingest-supersede.ts, " +
      "scripts/bake-property-atom-county.mjs, scripts/bake-property-atom-gold-set.mjs",
    status: "retired (property/reference/road atoms)",
    what: "single-atom or fixture-scoped retirements: a reasoning retire, two supersede body builders (`retireRoadNodeInstance` in storage is the one the road-node county writer calls), and the property-atom bakes/proofs",
    wired: false,
    reason:
      "NOT wired, and the reason is scope of effect rather than size: these build ONE retire body " +
      "for a named atom (the two supersede paths are body builders their callers hand a single " +
      "predecessor to -- `retireRoadNodeInstance` is called once per superseded road node by " +
      "write-road-node-county.mjs, whose SET-valued orphan pass is registered and wired above), or " +
      "they operate on a fixture/gold-set corpus the caller names explicitly, so there is no county " +
      "population whose share could be taken. The county-scoped property-atom writers reach the " +
      "store through writePropertyAtomsBatch, whose destructive surface is the parcel-node " +
      "reconcile registered above.",
  }),
  Object.freeze({
    id: "building-footprint-absence-supersede-delete",
    module: "scripts/write-building-footprint-county.mjs",
    producer: "packages/atoms/src/building-footprint-writer.ts",
    status: "deleted (superseded absence atoms)",
    what: "after a county's footprint atoms are written, the absence atom for a parcel that now has a present sibling in the same run is DELETEd, so a present and its stale absence placeholder cannot both be read",
    wired: false,
    reason:
      "NOT wired, and this is the one near-miss worth stating precisely rather than waving at. It " +
      "IS set-valued and county-scoped, so it is in the class the guard covers -- but its NORMAL " +
      "outcome is a share near 1.0, not near 0. The set it removes is exactly the absence atoms " +
      "for parcels this same run just minted a present atom for: the delete is EVIDENCED BY the " +
      "run's own output rather than inferred from a difference against a prior population. A " +
      "first-ever footprint acquisition for a county legitimately supersedes every absence atom " +
      "it has, and a 0.5 guard would REFUSE that ordinary run. The parcel-node orphan pass that " +
      "P-328 is about is the opposite shape: it asserts rows are no longer observed on the " +
      "strength of a plan that can be undersized, and Bastrop is that failure. Wiring the guard " +
      "here would be a permanently-red gate on the healthy path, which DEV_PROCESS calls a dead " +
      "gate. What this writer SHOULD get if the absence-aware readers spread is a count bound " +
      "rather than a share one -- at most one delete per present atom minted -- and that is " +
      "handed back in leave_behind rather than built here.",
  }),
  Object.freeze({
    id: "bastrop-road-legacy-id-migration",
    module: "scripts/migrate-bastrop-road-legacy-synthetic-ids.mjs",
    status: "deleted (predecessor row, after replacement verified)",
    what: "re-points a legacy road node's atom_links onto a re-minted atom_did, writes the replacement, verifies it reads back, then DELETEs the single predecessor row it replaced",
    wired: false,
    reason:
      "NOT wired: one named atom at a time (`DELETE FROM atoms WHERE atom_did = <plan.oldAtomDid>`, " +
      "inside a loop over rows the migration chose), never a difference against a prior population " +
      "-- there is no denominator to take a share of, and the deletion happens only AFTER the " +
      "replacement is verified readable, so the information moves rather than leaves. Same class " +
      "as the hand-named retirements above; if it gains a set-valued mode, it is in class.",
  }),
  Object.freeze({
    id: "hand-named-retirement-scripts",
    module:
      "scripts/retire-bastrop-per-parcel-setback-authorship.mjs, " +
      "scripts/retire-road-class-setback-table.mjs, " +
      "scripts/stamp-bastrop-successor-zoning-fact.mjs",
    status: "retired / superseded (hand-named atom sets)",
    what: "one-off retirement and supersede scripts that act on an explicitly enumerated set of ids or a single named table/rail",
    wired: false,
    reason:
      "NOT wired, on the same reasoning the factory's register gives for its hand-named purge: " +
      "each of these acts on a set chosen BY HAND and named in the script (a specific " +
      "authorship vintage, a specific road-class table, the Bastrop successor zoning facts), not " +
      "on a difference computed against a prior population. A share of that set would be a " +
      "percentage of a number someone already wrote down, which is a weaker authorisation than " +
      "the explicit enumeration the script already carries. If any of them gains a set-valued " +
      "mode -- 'everything of this kind in a county' -- it is in class and must call " +
      "evaluateBlastRadius with the number that mode would retire.",
  }),
  Object.freeze({
    id: "boundary-primitive-persist",
    module: "src/boundary-primitive/persist.ts",
    status: "retired (superseded boundary atoms)",
    what: "persisting a refined boundary retires the primitive it replaces",
    wired: false,
    reason:
      "NOT wired: one persisted primitive retires its own named predecessor, not a set computed " +
      "against a prior population -- the same shape and the same reasoning as depth-warm " +
      "promotion above. A county-wide 're-persist every boundary' mode would be in class.",
  }),
  Object.freeze({
    id: "factory-writers",
    module: "hauska-factory: src/lib/destructive-write-guard.mjs DESTRUCTIVE_WRITERS",
    status: "out of repo",
    what: "the factory's own destructive writers (publish-retirement and the rest)",
    wired: false,
    reason:
      "OUT OF THIS REPO, and named so the boundary is legible rather than implied: the factory's " +
      "writers are registered and guarded in hauska-factory by the module this declaration is " +
      "pinned to. The two registers are not joined -- a reader of one cannot see the other -- " +
      "which is stated here and handed back in leave_behind.",
  }),
]);

export function destructiveWriterById(id) {
  return DESTRUCTIVE_WRITERS.find((w) => w.id === id) ?? null;
}
