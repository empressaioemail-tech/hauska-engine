/**
 * Audit not-applicable cells — which rails, which population, which reason.
 */

import type { ParcelRecordRailKey } from "./rail-keys.js";
import type { ParcelRecordRow } from "./record-shape.js";

export interface NotApplicableAuditRow {
  railKey: ParcelRecordRailKey;
  count: number;
  incorporatedFalse: number;
  incorporatedTrue: number;
  incorporatedNull: number;
  reasons: Record<string, number>;
}

export interface NotApplicableAuditReport {
  totalNotApplicable: number;
  unincorporatedParcelCount: number;
  inCityParcelCount: number;
  unknownIncorporationParcelCount: number;
  railsStamped: number;
  perRail: NotApplicableAuditRow[];
  /** True when every not-applicable cell is incorporated===false and reasons match. */
  integerMultipleCheck: {
    unincorporatedTimesRails: number | null;
    railsPerUnincorporatedParcel: number | null;
    passes: boolean;
    note: string;
  };
}

export function auditNotApplicableCells(
  records: readonly ParcelRecordRow[],
): NotApplicableAuditReport {
  let unincorporatedParcelCount = 0;
  let inCityParcelCount = 0;
  let unknownIncorporationParcelCount = 0;
  const perRailMap = new Map<ParcelRecordRailKey, NotApplicableAuditRow>();

  for (const rec of records) {
    if (rec.incorporated === false) unincorporatedParcelCount += 1;
    else if (rec.incorporated === true) inCityParcelCount += 1;
    else unknownIncorporationParcelCount += 1;

    for (const [railKey, cell] of Object.entries(rec.cells) as Array<
      [ParcelRecordRailKey, (typeof rec.cells)[ParcelRecordRailKey]]
    >) {
      if (cell.kind !== "not-applicable") continue;
      let row = perRailMap.get(railKey);
      if (!row) {
        row = {
          railKey,
          count: 0,
          incorporatedFalse: 0,
          incorporatedTrue: 0,
          incorporatedNull: 0,
          reasons: {},
        };
        perRailMap.set(railKey, row);
      }
      row.count += 1;
      if (rec.incorporated === false) row.incorporatedFalse += 1;
      else if (rec.incorporated === true) row.incorporatedTrue += 1;
      else row.incorporatedNull += 1;
      const reason = cell.reason;
      row.reasons[reason] = (row.reasons[reason] ?? 0) + 1;
    }
  }

  const perRail = [...perRailMap.values()].sort((a, b) =>
    a.railKey.localeCompare(b.railKey),
  );
  const totalNotApplicable = perRail.reduce((s, r) => s + r.count, 0);
  const railsStamped = perRail.length;

  const railsPerParcel =
    unincorporatedParcelCount > 0 ? totalNotApplicable / unincorporatedParcelCount : null;
  const expectedIfUniform =
    unincorporatedParcelCount > 0 && railsStamped > 0
      ? unincorporatedParcelCount * railsStamped
      : null;

  const passes =
    unincorporatedParcelCount === 0
      ? totalNotApplicable === 0
      : totalNotApplicable === expectedIfUniform &&
        Number.isInteger(railsPerParcel!) &&
        perRail.every(
          (r) =>
            r.incorporatedTrue === 0 &&
            r.incorporatedNull === 0 &&
            r.count === r.incorporatedFalse,
        );

  return {
    totalNotApplicable,
    unincorporatedParcelCount,
    inCityParcelCount,
    unknownIncorporationParcelCount,
    railsStamped,
    perRail,
    integerMultipleCheck: {
      unincorporatedTimesRails: expectedIfUniform,
      railsPerUnincorporatedParcel: railsPerParcel,
      passes,
      note: passes
        ? "not-applicable = N rails × unincorporated parcels only"
        : "not-applicable is NOT an integer multiple of unincorporated parcel count — audit perRail for unearned stamps",
    },
  };
}
