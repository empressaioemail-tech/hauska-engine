/**
 * Honest warm edge labels for 714 Spring St (48021:33512, P-5).
 *
 * One front residential edge (Spring Street side); side/rear axes stay
 * not_specified — no roadClass, no fabricated setback. Planner probe:
 * insetFeet=[0,0,0,0,0,15], verifyPass=true.
 */

import type { RoadClassification } from "@hauska-engine/atoms";

import { projectRing } from "../geometry.js";
import { PARCEL_714_SPRING_33512 } from "./parcelRings.js";
import type { WarmEdgeInfo } from "../types.js";

/** Southern edge (index 5) faces Spring Street; opposite edge 2 is rear. */
const HONEST_LABELS: Array<{
  index: number;
  label: WarmEdgeInfo["label"];
  roadClass?: RoadClassification;
  osmHighwayTag?: string;
}> = [
  { index: 0, label: "side" },
  { index: 1, label: "side" },
  { index: 2, label: "rear" },
  { index: 3, label: "side" },
  { index: 4, label: "side" },
  {
    index: 5,
    label: "front",
    roadClass: "residential",
    osmHighwayTag: "residential",
  },
];

export function edgeLabels714SpringHonest() {
  const n = projectRing(PARCEL_714_SPRING_33512)!.points.length;
  if (n !== HONEST_LABELS.length) {
    throw new Error(
      `714 Spring ring edge count ${n} != honest label fixture ${HONEST_LABELS.length}`,
    );
  }
  return HONEST_LABELS.map((e) => ({ ...e }));
}
