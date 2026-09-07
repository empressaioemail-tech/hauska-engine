/**
 * P-120 item 18 -- floodplain acreage in tract + FIRM panel citation.
 *
 * Two independently-fallible sub-facts under one item, matching how the
 * mission names it ("present and cited"): the acreage of the mapped
 * floodplain intersecting the parcel (never a whole-parcel flag -- a
 * parcel that is 5% in a mapped zone reports 5%-of-its-acreage, not a
 * boolean), and the FIRM panel this determination rests on. Each carries
 * its own present/absent so a citation-layer hiccup never discards a real
 * acreage result, or vice versa (`Promise.allSettled`, same resilience
 * shape as `usdaSsurgoSoilsAdapter`).
 *
 * "Floodplain" here means the mapped Special Flood Hazard Area (SFHA
 * true) -- the regulatory 100-year floodplain -- reported as `sfhaAcres`.
 * Zones the parcel also touches that are NOT SFHA (most commonly the
 * 0.2%-annual-chance "shaded X" zone -- the 500-year floodplain) are
 * listed too, because a parcel that is honestly zero SFHA acres but does
 * sit in the 500-year zone is materially different from a parcel with no
 * flood-zone data reaching it at all, and collapsing the two would be
 * exactly the "fabricated zero" this program's own doctrine forbids.
 *
 * `parcelAcres` is computed from the parcel's own GIS ring, deliberately
 * NOT read from the county CAD roll's `CALC_ACRE`-style field: live-checked
 * 2026-09-07 on Bastrop 48021:52726/52727 (two condo units at the same
 * platted address), both CAD rows carry the identical CALC_ACRE 0.064
 * despite visibly different GIS footprints (0.093 and 0.045 acres by this
 * module's own shoelace calc, independently hand-verified) -- CALC_ACRE
 * reads as the parent lot's platted acreage inherited onto both unit rows,
 * not a per-unit figure. A finding for the CAD-roll owner, not something
 * this resolver should silently match by substituting a borrowed field for
 * the parcel's actual measured geometry.
 */
import { intersectionAreaAcres, ringAreaAcres, type Ring } from "./geo.js";
import { queryFirmPanels, queryFloodHazardZones, type FirmPanelCitation } from "./nfhl-query.js";

export interface FloodplainZoneHit {
  fldZone: string | null;
  zoneSubty: string | null;
  sfhaTf: boolean;
  staticBfe: number | null;
  intersectionAcres: number;
}

export interface FloodplainAcreageFacts {
  parcelAcres: number;
  /** Sum of `intersectionAcres` across zones where `sfhaTf` is true. A real
   * measured zero when no SFHA zone reaches the parcel -- not an absence. */
  sfhaAcres: number;
  /** Every intersecting zone, SFHA or not. */
  zones: FloodplainZoneHit[];
}

export type FloodplainAcreageResult =
  | { status: "present"; facts: FloodplainAcreageFacts }
  | { status: "absent"; reason: string };

export type FirmPanelResult =
  | { status: "present"; panels: FirmPanelCitation[] }
  | { status: "absent"; reason: string };

export interface FloodplainFactResolution {
  acreage: FloodplainAcreageResult;
  firmPanel: FirmPanelResult;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function resolveFloodplainFact(
  parcelRing: Ring,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<FloodplainFactResolution> {
  const [zonesSettled, panelsSettled] = await Promise.allSettled([
    queryFloodHazardZones(parcelRing, fetchImpl, signal),
    queryFirmPanels(parcelRing, fetchImpl, signal),
  ]);

  const acreage: FloodplainAcreageResult =
    zonesSettled.status === "rejected"
      ? {
          status: "absent",
          reason: `FEMA NFHL flood-hazard-zone lookup failed: ${errorMessage(zonesSettled.reason)}`,
        }
      : {
          status: "present",
          facts: (() => {
            const parcelAcres = ringAreaAcres(parcelRing);
            const zones: FloodplainZoneHit[] = zonesSettled.value.map((zone) => ({
              fldZone: zone.fldZone,
              zoneSubty: zone.zoneSubty,
              sfhaTf: zone.sfhaTf,
              staticBfe: zone.staticBfe,
              intersectionAcres: intersectionAreaAcres(parcelRing, zone.ring),
            }));
            const sfhaAcres = zones
              .filter((z) => z.sfhaTf)
              .reduce((sum, z) => sum + z.intersectionAcres, 0);
            return { parcelAcres, sfhaAcres, zones };
          })(),
        };

  const firmPanel: FirmPanelResult =
    panelsSettled.status === "rejected"
      ? { status: "absent", reason: `FEMA NFHL FIRM Panels lookup failed: ${errorMessage(panelsSettled.reason)}` }
      : panelsSettled.value.length === 0
        ? {
            status: "absent",
            reason: "NFHL FIRM Panels layer returned no panel intersecting this parcel (unmapped or non-printed area).",
          }
        : { status: "present", panels: panelsSettled.value };

  return { acreage, firmPanel };
}
