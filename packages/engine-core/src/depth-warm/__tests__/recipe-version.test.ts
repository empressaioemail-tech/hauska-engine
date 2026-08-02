/**
 * A3 — recipe_version rewarm-trigger test (Phase A foundation).
 * Every promoted atom must carry the recipe_version it was warmed under,
 * stamped from the single source-of-truth RECIPE_VERSION constant.
 */

import { describe, expect, it } from "vitest";

import { getSetbackTable } from "@hauska-engine/adapters";

import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { setbackTableDescriptorFromAdapter } from "../../property-reasoning/setback-table-from-adapter.js";
import type { JurisdictionDescriptor } from "../../property-reasoning/types.js";
import { RECIPE_VERSION } from "../../recipe-version.js";
import {
  PARCEL_714_SPRING_33512,
} from "../fixtures/parcelRings.js";
import { edgeLabels714SpringHonest } from "../fixtures/edgeLabels714Spring.js";
import { emitDepthWarmPromotion } from "../promote.js";
import { computeWarmCandidate } from "../warm-compute.js";

function buildDescriptor(): JurisdictionDescriptor {
  const adapterSetback = setbackTableDescriptorFromAdapter(
    getSetbackTable("bastrop-development-code"),
  );
  if (!adapterSetback) {
    throw new Error("bastrop-development-code adapter table required");
  }
  const base = bastropDescriptor as JurisdictionDescriptor;
  return {
    ...base,
    setbackTable: adapterSetback,
  };
}

const descriptor = buildDescriptor();
const PARCEL_ID = "48021:33512";
const SPRING_ROAD = {
  osmWayId: 123456789,
  osmHighwayTag: "residential",
  name: "Spring Street",
  classification: "residential" as const,
  polyline: [
    [-97.3188, 30.1102],
    [-97.3182, 30.1105],
    [-97.3176, 30.1108],
  ] as [number, number][],
};

describe("recipe_version stamped on warm + promote (A3 rewarm trigger)", () => {
  it("computeWarmCandidate stamps recipeVersion equal to RECIPE_VERSION constant", () => {
    const candidate = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "SF-1",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels: edgeLabels714SpringHonest(),
    });
    expect(candidate.recipeVersion).toBe(RECIPE_VERSION);
  });

  it("promoted atoms (setback-rule + buildable-envelope) carry recipe_version equal to the constant", () => {
    const candidate = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "SF-1",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels: edgeLabels714SpringHonest(),
    });
    const atoms = emitDepthWarmPromotion({
      candidate,
      descriptor,
      zoningFactAtomDid: `did:hauska:zoning-fact:${PARCEL_ID}`,
    });

    const envelope = atoms.find((a) => a.entityType === "buildable-envelope") as
      | (typeof atoms[number] & { recipe_version?: string })
      | undefined;
    expect(envelope).toBeDefined();
    expect(envelope!.recipe_version).toBe(RECIPE_VERSION);

    const setback = atoms.find((a) => a.entityType === "setback-rule") as
      | (typeof atoms[number] & { recipe_version?: string })
      | undefined;
    expect(setback).toBeDefined();
    expect(setback!.recipe_version).toBe(RECIPE_VERSION);
  });
});
