/**
 * CP2 refutation guard for the write-then-verify PK lookup.
 *
 * The four county writers locate freshly-written rows by the atoms PRIMARY KEY,
 * deriving `did:hauska:<entityType>:<entityId>` from the atom in hand. That is
 * only correct while two properties hold:
 *
 *   1. `entityId` is populated on the built atom (it is spread in via
 *      `persistenceOf`), so the writer can derive the did at verify time.
 *   2. `body.atomDid` is the contract hash token (`ownfact_<hex>` etc.) and is
 *      NEVER `did:hauska:`-prefixed — because `resolvePropertyAtomDid` passes a
 *      `did:hauska:`-prefixed atomDid straight through instead of rebuilding it,
 *      which would let the stored PK diverge from the writer-derived did.
 *
 * If either property breaks, the verify silently matches ZERO rows and every
 * atom reports "atom not readable back" — which reads as data corruption rather
 * than a query bug. This test fails loudly instead.
 */

import { describe, expect, it } from "vitest";

import {
  buildOwnerFactAbsenceAtom,
  buildPresentOwnerFactAtom,
  type PropertyFactWriteProvenance,
} from "../owner-fact-writer.js";
import { buildWellFactAbsenceAtom } from "../well-fact-writer.js";
import { buildRailCorridorFactAbsenceAtom } from "../rail-corridor-fact-writer.js";
import { buildBuildingFootprintPerParcelAbsenceAtom } from "../building-footprint-writer.js";

const PROVENANCE: PropertyFactWriteProvenance = {
  sourceAdapter: "cad-property-ingest-v1",
  sourceCitation: "Bastrop CAD 2026 property roll",
  sourceUrl: "https://example.test/cad",
  sourceVintage: "2026-01-15",
  observedAt: "2026-08-09T12:00:00.000Z",
  jurisdictionTenant: "tx_48021",
  contentHash: "fnv1a64:deadbeefdeadbeef",
};

/**
 * Mirrors `resolvePropertyAtomDid` in
 * packages/storage/src/property-atom-batch-write.ts — the value that actually
 * lands in the `atom_did` PRIMARY KEY column.
 */
function storedPrimaryKey(atom: {
  atomDid?: string;
  entityType: string;
  entityId: string;
}): string {
  return typeof atom.atomDid === "string" && atom.atomDid.startsWith("did:hauska:")
    ? atom.atomDid
    : `did:hauska:${atom.entityType}:${atom.entityId}`;
}

/** What the four county writers now build their IN-list from. */
function writerDerivedDid(atom: {
  entityType: string;
  entityId: string;
}): string {
  return `did:hauska:${atom.entityType}:${atom.entityId}`;
}

const CASES: ReadonlyArray<{
  name: string;
  entityType: string;
  atom: { atomDid?: string; entityType: string; entityId: string };
}> = [
  {
    name: "owner-fact (present)",
    entityType: "owner-fact",
    atom: buildPresentOwnerFactAtom(
      { parcelNodeId: "48021:27303", taxYear: 2026, ownerName: "DOE, JANE" },
      PROVENANCE,
    ),
  },
  {
    name: "owner-fact (absence)",
    entityType: "owner-fact",
    atom: buildOwnerFactAbsenceAtom(
      {
        parcelNodeId: "48021:27303",
        taxYear: 2026,
        absenceKind: "owner-withheld",
        reason: "owner name withheld by CAD",
      },
      PROVENANCE,
    ),
  },
  {
    name: "well-fact (absence)",
    entityType: "well-fact",
    atom: buildWellFactAbsenceAtom(
      {
        parcelNodeId: "48021:27303",
        wellKey: "none",
        absenceKind: "no-well-on-or-near",
        reason: "no RRC well within radius",
        proximityRadiusMeters: 500,
      },
      PROVENANCE,
    ),
  },
  {
    name: "rail-corridor-fact (absence)",
    entityType: "rail-corridor-fact",
    atom: buildRailCorridorFactAbsenceAtom(
      {
        parcelNodeId: "48021:27303",
        absenceKind: "no-parcel-geometry",
        reason: "parcel geometry unavailable",
      },
      PROVENANCE,
    ),
  },
  {
    name: "building-footprint (absence)",
    entityType: "building-footprint",
    atom: buildBuildingFootprintPerParcelAbsenceAtom(
      {
        parcelNodeId: "48021:27303",
        absenceKind: "no-footprint-feature",
        reason: "no footprint intersects parcel",
        sourceTier: "cad-authoritative",
      },
      PROVENANCE,
    ),
  },
];

describe("CP2: writer-derived PK matches the stored atom_did", () => {
  for (const { name, entityType, atom } of CASES) {
    describe(name, () => {
      it("populates entityId at verify time", () => {
        expect(atom.entityId).toBeTruthy();
        expect(typeof atom.entityId).toBe("string");
      });

      it("keeps body.atomDid as the contract token, not a did:hauska form", () => {
        // If this ever flips, storage passes the atomDid through unchanged and
        // the writer-derived did below stops matching the stored PK.
        expect(atom.atomDid?.startsWith("did:hauska:")).toBe(false);
      });

      it("derives a did identical to the stored primary key", () => {
        expect(atom.entityType).toBe(entityType);
        expect(writerDerivedDid(atom)).toBe(storedPrimaryKey(atom));
      });
    });
  }
});
