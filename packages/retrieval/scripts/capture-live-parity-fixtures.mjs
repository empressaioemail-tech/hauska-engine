#!/usr/bin/env node
/**
 * Capture the live-parity fixture for the serving sweep.
 *
 *   node --import tsx packages/retrieval/scripts/capture-live-parity-fixtures.mjs
 *
 * For each parcel it fetches the DEPLOYED wire body and, in the same pass, the
 * exact store rows the sweep would read. Both halves come from the same moment
 * so the parity test is comparing one state of the world with itself.
 *
 * The parcel list spans the serving path's branches on purpose — a depth-warm
 * city parcel, an unzoned county parcel, an Elgin parcel on a different stamp,
 * a parcel carrying the `", ,"` situs sentinel, and a parcel from a second
 * county on a different pipeline. It is a proof set for the INSTRUMENT, never a
 * certification set for a county.
 *
 * READ ONLY, and bounded: one HTTP GET and three indexed queries per parcel.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(
  here,
  "..",
  "src",
  "serving-sweep",
  "__tests__",
  "__fixtures__",
  "live-parity.json",
);

const ENDPOINT =
  process.env.PE_FACETS_ENDPOINT?.trim() ||
  "https://property-explorer-xi.vercel.app/api/spine/property-atoms";

const SWEPT_ATOM_TYPES = [
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
  "flood-hazard-fact",
  "parcel-node",
  "parcel-terrain-model",
];

const PARCELS = (process.env.PARITY_PARCELS?.trim()
  ? process.env.PARITY_PARCELS.split(",")
  : [
      "48021:36521", // Bastrop city GC, depth-warm promoted, `", ,"` situs
      "48021:34137", // Bastrop gold parcel used by the staff map
      "48021:0", // roster edge: lowest id in the county
      "48021:10001", // unincorporated, no zoning stamp
      "48021:102717", // unincorporated, longer prop id
      "48021:56517", // Elgin stamp jurisdiction
      "48021:28286", // boundary-edge referenced parcel
      "48453:100000", // Travis, second county / different pipeline
      "48453:200000", // Travis
      "48055:10068", // Caldwell, third county
    ]
).map((s) => s.trim());

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`FATAL: ${name} is required`);
  return v.trim();
}

async function main() {
  const atoms = postgres(requireEnv("ATOMS_DATABASE_URL"), { max: 2, prepare: false });
  const cortex = postgres(requireEnv("CORTEX_DATABASE_URL"), { max: 2, prepare: false });
  const cases = [];
  try {
    for (const parcelNodeId of PARCELS) {
      const res = await fetch(`${ENDPOINT}/${encodeURIComponent(parcelNodeId)}/facets`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        process.stderr.write(`[skip] ${parcelNodeId} HTTP ${res.status}\n`);
        continue;
      }
      const live = await res.json();
      const liveReadPath = res.headers.get("x-pe-read-path") ?? "";

      const atomRows = await atoms`
        SELECT body FROM atoms
        WHERE entity_type IN ${atoms(SWEPT_ATOM_TYPES)}
          AND entity_id = ${parcelNodeId}
      `;
      const snapRows = await cortex`
        SELECT adapter_key, payload_json, snapshot_at
        FROM place_layer_snapshots
        WHERE adapter_key IN ${cortex(["node-facets:tier1", "node-facets:tier2"])}
          AND place_key = ${"node:" + parcelNodeId}
      `;
      const t1 = snapRows.find((r) => r.adapter_key === "node-facets:tier1") ?? null;
      const t2 = snapRows.find((r) => r.adapter_key === "node-facets:tier2") ?? null;

      cases.push({
        parcelNodeId,
        liveReadPath,
        live,
        store: {
          atoms: atomRows.map((r) => r.body),
          tier1: t1?.payload_json ?? null,
          tier1SnapshotAt: t1?.snapshot_at ? new Date(t1.snapshot_at).toISOString() : null,
          tier2: t2?.payload_json ?? null,
          tier2SnapshotAt: t2?.snapshot_at ? new Date(t2.snapshot_at).toISOString() : null,
        },
      });
      process.stdout.write(`[ok] ${parcelNodeId} readPath=${liveReadPath}\n`);
    }
  } finally {
    await atoms.end({ timeout: 5 });
    await cortex.end({ timeout: 5 });
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    JSON.stringify({ capturedAt: new Date().toISOString(), endpoint: ENDPOINT, cases }, null, 2) + "\n",
  );
  process.stdout.write(`[SS-W5] captured ${cases.length} parity cases -> ${outFile}\n`);
}

main().catch((err) => {
  console.error("[SS-W5] capture FAILED:", err);
  process.exit(1);
});
