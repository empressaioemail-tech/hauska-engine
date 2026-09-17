/**
 * P-260 falsifier 1 — "a Hays boundary-edge fixture resolves a setback table
 * through the corpus (the 'No setback table configured' string does not appear),
 * and a city with genuinely no table still says so".
 *
 * Why Hays: all 509,928 Hays boundary-edge atoms carry
 * "No setback table configured for jurisdiction descriptor" because the
 * descriptor handed to `computeBoundaryEdgeAtoms` had no `setbackTable` — the
 * engine's served set stopped at Bastrop/Elgin/Lockhart-shaped wiring while the
 * corpus already carried Hays's cities (kyle-tx, buda-tx, dripping-springs-tx,
 * san-marcos-tx, austin-tx). This case walks ONE Hays parcel's edges through
 * the same function the bake uses, with the descriptor's table built the same
 * way (`getSetbackTableForZoning` -> `setbackTableDescriptorFromAdapter`), and
 * asserts the per-edge numbers equal the corpus row's own numbers by role.
 *
 * The second case is deliberately not skipped: a Hays city with NO corpus table
 * must still produce the honest-absence string. "Resolved" is not the goal;
 * "resolved, or says why not" is.
 */
import { describe, expect, it } from "vitest";

import { getSetbackTable, getSetbackTableForZoning } from "@hauska-engine/adapters";

import { buildParcelAdjacencyIndex, computeBoundaryEdgeAtoms } from "../../boundary-primitive/index.js";
import { setbackTableDescriptorFromAdapter } from "../setback-table-from-adapter.js";
import { setbackTableNotLandedReason } from "../../setback-writer/city-binding.js";
import type { JurisdictionDescriptor } from "../types.js";

const HAYS_FIPS = "48209";
const NO_TABLE_STRING = "No setback table configured for jurisdiction descriptor.";

/** Kyle, TX is in Hays County and its corpus table carries the RS district. */
const CITY_KEY = "kyle-tx";
const DISTRICT = "RS";

/** A ~110 ft x 100 ft Hays-side ring; shape only — the numbers come from the table. */
const RING = [
  [-97.94, 29.98],
  [-97.9397, 29.98],
  [-97.9397, 29.9804],
  [-97.94, 29.9804],
  [-97.94, 29.98],
] as const;

function descriptorFor(cityKey: string, district: string): JurisdictionDescriptor {
  const resolution = getSetbackTableForZoning(cityKey, district);
  return {
    key: `breadth_${HAYS_FIPS}`,
    displayName: `Breadth bake ${HAYS_FIPS}`,
    jurisdictionTenant: `breadth_${HAYS_FIPS}_${cityKey}`,
    parcelFips: HAYS_FIPS,
    defaultAccessPolicy: "public-free",
    sourceAdapter: "cortex-tier1-snapshot-breadth-bake",
    sourceUrl: "https://hauska.dev/internal/breadth-atom-bake/cortex-snapshot",
    setbackTable: setbackTableDescriptorFromAdapter(resolution?.table),
  };
}

function edgesFor(cityKey: string, district: string) {
  const parcelNodeId = `${HAYS_FIPS}:156346`;
  const entry = {
    countyFips: HAYS_FIPS,
    propId: "156346",
    parcelNodeId,
    ring: [...RING],
    westLng: -97.94,
    southLat: 29.98,
    eastLng: -97.9397,
    northLat: 29.9804,
  };
  const index = buildParcelAdjacencyIndex(HAYS_FIPS, [entry]);
  const extractedAt = "2026-09-17T00:00:00.000Z";
  return computeBoundaryEdgeAtoms({
    parcelNodeId,
    countyFips: HAYS_FIPS,
    propId: "156346",
    district,
    parcelRing: entry.ring,
    descriptor: descriptorFor(cityKey, district),
    adjacencyIndex: index,
    roads: [],
    effectiveDate: extractedAt.slice(0, 10),
    extractedAt,
    sourceAdapter: "cortex-tier1-snapshot-breadth-bake",
    sourceUrl: "https://hauska.dev/internal/breadth-atom-bake/cortex-snapshot",
  });
}

describe("P-260 — a Hays boundary-edge fixture resolves its setbacks through the corpus", () => {
  it("carries the corpus's own numbers per edge role, and never the missing-table string", () => {
    const table = getSetbackTable(CITY_KEY);
    expect(table, `${CITY_KEY} missing from the corpus — this lane's premise moved`).not.toBeNull();
    const row = table!.districts.find(
      (d) => d.district_name.trim().split(/\s+/)[0]!.toUpperCase() === DISTRICT,
    );
    expect(row, `${CITY_KEY} has no ${DISTRICT} row`).toBeDefined();

    const perRoleFeet: Record<string, number> = {
      front: row!.front_ft,
      rear: row!.rear_ft,
      side: row!.side_ft,
      side_corner: row!.side_corner_ft,
    };

    const atoms = edgesFor(CITY_KEY, DISTRICT);
    expect(atoms.length).toBeGreaterThan(0);

    // The falsifier's literal claim, on the serialized atoms the bake writes.
    expect(JSON.stringify(atoms)).not.toContain(NO_TABLE_STRING);

    for (const atom of atoms) {
      const setback = atom.setback as {
        feet?: number;
        provenance?: string;
      };
      expect(setback.provenance, `${atom.boundaryEdgeId} did not resolve a table row`).toBe(
        "district-setback-table",
      );
      const role = atom.role as keyof typeof perRoleFeet;
      expect(
        setback.feet,
        `${atom.boundaryEdgeId} (${atom.role}) does not match the corpus ${DISTRICT} row`,
      ).toBe(perRoleFeet[role]);
    }
  });

  it("a Hays city with genuinely no ruled table still says so, and says why", () => {
    // Woodcreek is a Hays County city the corpus does not carry at all.
    const cityKey = "woodcreek-tx";
    expect(getSetbackTableForZoning(cityKey, DISTRICT)).toBeNull();

    const atoms = edgesFor(cityKey, DISTRICT);
    expect(atoms.length).toBeGreaterThan(0);
    for (const atom of atoms) {
      const setback = atom.setback as { kind?: string; reason?: string };
      expect(setback.kind).toBe("no-setback-row");
      expect(setback.reason).toBe(NO_TABLE_STRING);
    }

    // Not silent: the registry row for this city states the absence in words.
    const reason = setbackTableNotLandedReason(cityKey);
    expect(reason).toContain("no ruled setback table");
    expect(reason).toContain("does not carry this city key");
  });

  it("a corpus city this engine does not serve is reported as unserved, not as missing law", () => {
    // georgetown-tx is in the corpus and withheld by ruling; its absence from
    // service must read as a ruled decision, never as "no setback law exists".
    const reason = setbackTableNotLandedReason("georgetown-tx");
    expect(reason).toContain("withheld");
    expect(getSetbackTableForZoning("georgetown-tx", DISTRICT)).toBeNull();
  });
});
