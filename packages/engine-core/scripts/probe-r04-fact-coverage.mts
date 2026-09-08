/**
 * P-120 R-04 deploy pre-check: do the three NEW outbound reads answer at all?
 *
 * 40d36ac wires FEMA NFHL, USDA SSURGO and HIFLD into the feasibility route.
 * Before a canary is smoked, the question worth answering is whether those
 * three sources have coverage in the county we intend to smoke in. If SSURGO
 * or HIFLD returns nothing for Bastrop, a green smoke would prove only that
 * the code did not crash, not that the reads work.
 *
 * WHAT THIS IS NOT. It does not confirm the three states for a specific
 * parcel. Reading 48021:52726's real geometry needs a tier this seat does not
 * have, and the resolvers take a ring/point rather than a parcel id. So this
 * probes COVERAGE at real Bastrop coordinates, which is the strictly weaker
 * claim, and it is reported as that.
 *
 * Run: pnpm --filter @hauska-engine/engine-core exec tsx scripts/probe-r04-fact-coverage.mts
 */
import { resolveFloodplainFact } from "../src/floodplain-acreage-fact/index.js";
import { resolveSoilFact } from "../src/soil-fact/index.js";
import {
  resolveElectricProviderFact,
  resolveGasProviderFact,
} from "../src/electric-provider-fact/index.js";

// Downtown Bastrop, the area 1007 Water St sits in. Real coordinates, not the
// parcel's own boundary.
const POINT = { latitude: 30.1105, longitude: -97.3153 };

/** ~60m square at that point: a real location, an approximate footprint. */
function probeRing(): Array<[number, number]> {
  const half = 30;
  const mPerDegLat = 111_320;
  const mPerDegLng = mPerDegLat * Math.cos((POINT.latitude * Math.PI) / 180);
  const dLat = half / mPerDegLat;
  const dLng = half / mPerDegLng;
  const { latitude: la, longitude: ln } = POINT;
  return [
    [ln - dLng, la - dLat],
    [ln + dLng, la - dLat],
    [ln + dLng, la + dLat],
    [ln - dLng, la + dLat],
    [ln - dLng, la - dLat],
  ];
}

function line(name: string, status: string, detail: string) {
  console.log(`  ${name.padEnd(22)} ${status.padEnd(20)} ${detail.slice(0, 110)}`);
}

async function main() {
  console.log("\nR-04 outbound-read coverage probe — Bastrop 30.1105,-97.3153\n");

  const flood = await resolveFloodplainFact(probeRing());
  line(
    "FEMA NFHL acreage",
    flood.acreage.status,
    flood.acreage.status === "present"
      ? `parcelAcres=${flood.acreage.facts.parcelAcres.toFixed(2)} sfhaAcres=${flood.acreage.facts.sfhaAcres.toFixed(2)} zones=${flood.acreage.facts.zones.length}`
      : `kind=${flood.acreage.kind} ${flood.acreage.reason}`,
  );
  line(
    "FEMA NFHL FIRM panel",
    flood.firmPanel.status,
    flood.firmPanel.status === "present"
      ? `panels=${flood.firmPanel.panels.length} first=${JSON.stringify(flood.firmPanel.panels[0] ?? null)}`
      : `kind=${flood.firmPanel.kind} ${flood.firmPanel.reason}`,
  );

  const soil = await resolveSoilFact(POINT);
  line(
    "USDA SSURGO soil",
    soil.status,
    soil.status === "present"
      ? `muname=${soil.facts.muname} hsg=${soil.facts.hydrologicSoilGroup} drainage=${soil.facts.drainageClass}`
      : `kind=${soil.kind} ${soil.reason}`,
  );

  const elec = await resolveElectricProviderFact(POINT);
  line(
    "HIFLD electric",
    elec.status,
    elec.status === "present"
      ? `candidates=${elec.facts.candidates.length} ambiguous=${elec.facts.ambiguous}`
      : `kind=${elec.kind} ${elec.reason}`,
  );

  const gas = resolveGasProviderFact();
  line("Gas (structural)", gas.status, `kind=${gas.kind} — expected permanently absent by ruling`);

  console.log(
    "\nRead this as county-level COVERAGE, not as a parcel's three states.\n" +
      "The parcel-specific confirmation is the canary smoke itself.\n",
  );
}

main().catch((e) => {
  console.error("probe threw:", e);
  process.exit(1);
});
