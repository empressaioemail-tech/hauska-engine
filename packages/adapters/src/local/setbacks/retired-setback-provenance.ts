/**
 * P-219 — setback provenances that are RETIRED as value authors.
 *
 * A retired provenance is one that may still be READ (to name a second source,
 * to resolve a dominant district, to disclose a conflict) but may never again
 * supply a setback VALUE that a surface prints or that a minted atom carries.
 * Retirement is proven by decline, never by documentation: every value path
 * that could cite one of these runs {@link isRetiredSetbackProvenance} and
 * returns {@link retiredSetbackDecline} instead of a number, and
 * `__tests__/retired-setback-provenance.test.ts` fails if a served value or a
 * minted atom carries the prefix again.
 *
 * ## `bastrop-per-parcel/*`
 *
 * The City of Bastrop One Click join (`Parcels_One_Click/FeatureServer/23`)
 * reads the NUMERIC shortcut columns of the city's authoritative zoning layer
 * (`Zone_Types/FeatureServer/25`). For the SF rows those columns were never
 * refreshed after Ordinance 2026-06 (the B3 Code Repeal and Bastrop
 * Development Code Adoption, effective 2026-04-14) and still carry the
 * pre-repeal figures, while the layer's own TEXT fields carry the current
 * ones. Read live 2026-09-15, every one of the 175 `ZoneTypeClass = 3` rows on
 * layer 25 reads TEXT 30 / 10 / 30 with a 20 ft corner side and NUMERIC
 * 25 / 5 / 25; layer 23 prop_id 34049 reads 25 / 5 / 25 with `Ordinance_`
 * "2019-51". The BDC corpus row for SF-1 carries the same 30/10/30/20 the
 * city's own text fields do, so the ordinance and the city's authoritative
 * layer agree and only the shortcut columns dissent.
 *
 * Until this was retired, `setbackTableFromBastropPerParcelRecord` minted
 * `bastrop-per-parcel/<propId>/{front,rear,side-interior,side-corner}` as the
 * provenance of served scalars, and both PDF products printed
 * "25 / 5 / 25 ft -- source: Setback rule for SF-1 cited to
 * bastrop-per-parcel/34049/front" beside a link to Ordinance 2019-51, five
 * months after the city repealed it.
 *
 * ## What this does NOT retire
 *
 * The layer-23 record itself. It stays in use for R26 dominant-district
 * resolution on split-zone parcels, for min-lot-size and impervious display
 * meta, and as the NAMED second source of the P-154 / A-148 conflict row. A
 * disclosure that names a source is not a served value.
 *
 * ## Known remainder (escalated, P-219 close)
 *
 * Districts with no ruled corpus row — Bastrop's MU / GC / PDD / PI / IND /
 * P-OS, measured live 2026-09-15 at 3,788 of the 16,751 rows on layer 23
 * (22.6%, counting `prop_id` grouped by `ZoneTypeClass` over every row in the
 * layer) — have nothing to repoint to, and for GC and IND the numeric columns
 * were measured to AGREE with the authoritative layer's text. Retiring them
 * here would replace correct values with an absence, so they are deliberately
 * out of {@link RETIRED_WHEN_RULED_TABLE_EXISTS}'s reach: this guard only
 * declines a retired provenance where a ruled table can take over. That
 * remainder is a named escalation, not an oversight.
 */

/**
 * Atom-DID prefixes retired as setback value authors. Matched
 * case-insensitively against the head of the DID, so every axis under a
 * retired namespace is covered without listing them one by one.
 */
export const RETIRED_SETBACK_PROVENANCE_PREFIXES = [
  "bastrop-per-parcel/",
] as const;

/**
 * True when this atom DID names a retired setback value author. Empty and
 * absent DIDs are NOT retired: an empty result is not an absence, and a
 * missing provenance is its own (separate) honesty problem, not this one.
 */
export function isRetiredSetbackProvenance(
  atomDid: string | null | undefined,
): boolean {
  const did = (atomDid ?? "").trim().toLowerCase();
  if (!did) return false;
  return RETIRED_SETBACK_PROVENANCE_PREFIXES.some((prefix) => did.startsWith(prefix));
}

/**
 * The one sentence a surface prints when it refuses a retired value, and the
 * one reason a decline carries. Names the instrument that superseded it rather
 * than characterising the retired source as wrong: which of its own two
 * readings the city honours is the city's ruling, not ours.
 */
export const RETIRED_SETBACK_DECLINE_REASON =
  "Setback value declined: its only provenance is a retired source " +
  "(the city's unrefreshed numeric shortcut columns, cited to an ordinance " +
  "superseded on 2026-04-14). The ruled table for this district is served instead.";

export interface RetiredSetbackDecline {
  kind: "retired-setback-provenance";
  atomDid: string;
  reason: string;
}

/** Build the decline a value path returns in place of a retired number. */
export function retiredSetbackDecline(atomDid: string): RetiredSetbackDecline {
  return {
    kind: "retired-setback-provenance",
    atomDid,
    reason: RETIRED_SETBACK_DECLINE_REASON,
  };
}

/**
 * Documentation anchor for the retirement's scope, referenced by the CI test:
 * a retired provenance declines wherever a ruled table exists to take over.
 * Where none does, the value path is unchanged and the remainder is escalated
 * (see the module doc).
 */
export const RETIRED_WHEN_RULED_TABLE_EXISTS = true as const;
