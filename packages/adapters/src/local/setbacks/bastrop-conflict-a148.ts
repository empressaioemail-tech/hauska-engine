/**
 * P-154 (OPS-23 wave 6) / AMENDMENT A-148 — the City of Bastrop's SAME-LAYER
 * conflict, and the facts the A-148 conflict sentence names, each with the
 * source it was read from. This module exists so no call site retypes an
 * ordinance number, a column name, or a confirmation date.
 *
 * WHAT THE AMENDMENT RESOLVED (A-148, overseer 2026-09-14T14:10Z; F24 was
 * previously read as two competing layers citing two ordinances):
 *
 *   The city named `Zone_Types/FeatureServer/25` ("Zone_Types_Draft_11_2025",
 *   `editingInfo.lastEditDate` 2026-07-09) as its CURRENT, authoritative
 *   zoning layer. Its SF row (OBJECTID 297, ZoneTypeClass 3) publishes, in its
 *   TEXT fields:
 *       FrontSetback            "30 feet"
 *       SideSetback             "10 feet"
 *       RearSetback             "30 feet"
 *       CornerSideStreetSetback "20 feet"      -> 30/10/30/20
 *   and, in its NUMERIC shortcut columns, 25 / 5 / 25:
 *       FrontSetback_  25
 *       SideSetback_    5
 *       RearSetback_   25
 *   There is NO numeric corner column. The city's One Click join
 *   (`Parcels_One_Click/FeatureServer/23`, the `Parcel_OneClick_Join` whose
 *   join key `FID_Zone_Types_Draft_11_2025` points at that very row) reads the
 *   NUMBERS, so a customer who opens the city's own tool sees 25/5/25 for
 *   `48021:34049` while our card prints 30/10/30/20.
 *
 *   So this is ONE layer with stale numeric columns, NOT two layers citing two
 *   ordinances. The values our card prints match the layer's text fields.
 *
 * VERIFIED LIVE IN THIS LANE, 2026-09-14, both layers, `?f=json` and
 * `query?where=...` against `services7.arcgis.com/qOeXJdBtGknaCJC4`:
 *   - `Zone_Types/FeatureServer/25` field list carries `FrontSetback`,
 *     `SideSetback`, `RearSetback`, `CornerSideStreetSetback` (esriFieldType-
 *     String) AND `FrontSetback_`, `SideSetback_`, `RearSetback_`
 *     (esriFieldTypeDouble), plus `Ordinance_`.
 *   - OBJECTID 297 reads text 30/10/30/20 and numeric 25/5/25 exactly as above.
 *   - `Parcels_One_Click/FeatureServer/23` prop_id 34049 reads text
 *     "25 ft (porches may encroach up to 10 ft)" / "5 ft (Corner Side Street
 *     Setback: 15 ft)" / "25 ft", numeric 25/5/25, `Ordinance_` "2019-51".
 *     The join layer's OWN text fields agree with its numbers (they were
 *     refreshed to the numbers); the disagreement A-148 names is between the
 *     AUTHORITATIVE layer's text fields and the numeric columns the join reads.
 *
 * OPEN FOR THE OPERATOR — the ordinance the SF row cites, three readings, do
 * not silently pick (see the lane close):
 *   1. A-148's card text records the `Zone_Types/25` SF row as citing
 *      **Ordinance 2024-38**.
 *   2. The sentence the overseer specified names **Ordinance 2026-06** (the B3
 *      Code Repeal and Adoption ordinance our corpus already carries,
 *      effective 2026-04-14) — the value this lane BUILDS WITH, as instructed.
 *   3. The layer's own live `Ordinance_` field, read 2026-09-14, says
 *      **"2019-51"** — the earlier draft-zone-types ordinance F24 originally
 *      read off the One Click layer. Consistent with the stale-column story
 *      (the citation field is itself unrefreshed), but it is a third reading
 *      and it is not resolved here.
 */

/** The city's CURRENT, authoritative zoning layer (A-148). */
export const BASTROP_ZONE_TYPES_25_LAYER_URL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zone_Types/FeatureServer/25";

/** The city's One Click join layer whose numbers the customer sees. */
export const BASTROP_ONE_CLICK_JOIN_LAYER_23_URL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Parcels_One_Click/FeatureServer/23";

/**
 * The numeric shortcut columns the One Click join reads, verbatim from the
 * layer's own field list. THREE columns: front, side, rear. There is no
 * numeric corner column — a sentence that prints a corner for the second
 * source read a column that does not exist (A-148 falsifier).
 */
export const BASTROP_NUMERIC_SHORTCUT_COLUMNS = [
  "FrontSetback_",
  "SideSetback_",
  "RearSetback_",
] as const;

/**
 * The current ordinance the TEXT fields reflect, as specified by the overseer
 * in A-148. See the three-reading divergence above: 2024-38 (A-148 card text)
 * and 2019-51 (the layer's live `Ordinance_` field, 2026-09-14) are the other
 * two. Built with 2026-06 deliberately, not by silence.
 */
export const BASTROP_CURRENT_SETBACK_ORDINANCE = "2026-06";

/**
 * The effective date of {@link BASTROP_CURRENT_SETBACK_ORDINANCE} as our corpus
 * already carries it (the B3 Code Repeal and Adoption ordinance, effective
 * 2026-04-14 — the same date the codified chart's own row is dated). Used ONLY
 * when a stale-columns conflict fires: the layer's own `Ordinance_` field is
 * itself unrefreshed (it reads "2019-51" live), so its citation date cannot
 * date the TEXT values this operation serves. The sentence and the followed
 * row both name the current ordinance, deliberately, not by silence.
 */
export const BASTROP_CURRENT_SETBACK_ORDINANCE_EFFECTIVE_DATE = "2026-04-14";

/**
 * The confirmation the sentence carries, verbatim: the operator confirmed the
 * stale numeric columns with the city on this date (A-148, 2026-09-14).
 */
export const BASTROP_STALE_COLUMNS_CONFIRMATION = {
  with: "the City of Bastrop",
  on: "2026-09-14",
} as const;
