/**
 * Municipal easement join — City of Bastrop Easements_/43 pattern.
 */

import { classifyEasementStatus } from "./easement-classify.js";
import {
  easementIntersectsParcelRing,
  type EasementFeatureInput,
  type EasementParcelInput,
} from "./geo.js";

export interface JoinMunicipalEasementsResult {
  present: Array<{
    parcelKey: string;
    easementId: string;
    easementClass: ReturnType<typeof classifyEasementStatus>;
    easementGeometry: EasementFeatureInput["geometry"];
  }>;
  perParcelAbsence: string[];
  easementsJoined: number;
}

export function joinMunicipalEasementsToParcels(input: {
  parcels: ReadonlyArray<EasementParcelInput>;
  easements: ReadonlyArray<EasementFeatureInput>;
}): JoinMunicipalEasementsResult {
  const cityParcels = input.parcels.filter((p) => p.inCityLimits === true);
  const present: JoinMunicipalEasementsResult["present"] = [];
  const perParcelAbsence: string[] = [];
  let easementsJoined = 0;

  for (const parcel of cityParcels) {
    const hits = input.easements.filter((e) =>
      easementIntersectsParcelRing(e.geometry, parcel.ring),
    );
    if (hits.length === 0) {
      perParcelAbsence.push(parcel.parcelKey);
      continue;
    }
    for (const easement of hits) {
      easementsJoined += 1;
      present.push({
        parcelKey: parcel.parcelKey,
        easementId: easement.easementId,
        easementClass: classifyEasementStatus(easement.status),
        easementGeometry: easement.geometry,
      });
    }
  }

  return {
    present,
    perParcelAbsence,
    easementsJoined,
  };
}
