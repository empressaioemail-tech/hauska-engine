/**
 * Fixture: Reeves County gas production (well-level) sample.
 *
 * Source: RRC PDQ (simulated data for district 08, Reeves County).
 * Represents 3 wells with monthly gas production for Jan-Mar 2024.
 */

import type { RawGasProductionRecord } from "../types.js";

export const reevesGasSample: ReadonlyArray<RawGasProductionRecord> = [
  // Well 1: API 42-389-12345
  {
    district: "08",
    apiNumber: "4238912345",
    wellName: "WOLFCAMP A #1H",
    operatorName: "PIONEER NATURAL RESOURCES",
    operatorNumber: "123456",
    month: "2024-01",
    gasVolume: 234567,
    casingheadVolume: 12345,
  },
  {
    district: "08",
    apiNumber: "4238912345",
    wellName: "WOLFCAMP A #1H",
    operatorName: "PIONEER NATURAL RESOURCES",
    operatorNumber: "123456",
    month: "2024-02",
    gasVolume: 228901,
    casingheadVolume: 11987,
  },
  {
    district: "08",
    apiNumber: "4238912345",
    wellName: "WOLFCAMP A #1H",
    operatorName: "PIONEER NATURAL RESOURCES",
    operatorNumber: "123456",
    month: "2024-03",
    gasVolume: 241234,
    casingheadVolume: 12654,
  },

  // Well 2: API 42-389-23456
  {
    district: "08",
    apiNumber: "4238923456",
    wellName: "DELAWARE SAND #2H",
    operatorName: "DIAMONDBACK ENERGY",
    operatorNumber: "234567",
    month: "2024-01",
    gasVolume: 156789,
  },
  {
    district: "08",
    apiNumber: "4238923456",
    wellName: "DELAWARE SAND #2H",
    operatorName: "DIAMONDBACK ENERGY",
    operatorNumber: "234567",
    month: "2024-02",
    gasVolume: 163456,
  },
  {
    district: "08",
    apiNumber: "4238923456",
    wellName: "DELAWARE SAND #2H",
    operatorName: "DIAMONDBACK ENERGY",
    operatorNumber: "234567",
    month: "2024-03",
    gasVolume: 159876,
  },

  // Well 3: API 42-389-34567
  {
    district: "08",
    apiNumber: "4238934567",
    wellName: "BONE SPRING #3H",
    operatorName: "EOG RESOURCES",
    operatorNumber: "345678",
    month: "2024-01",
    gasVolume: 187654,
    casingheadVolume: 9876,
  },
  {
    district: "08",
    apiNumber: "4238934567",
    wellName: "BONE SPRING #3H",
    operatorName: "EOG RESOURCES",
    operatorNumber: "345678",
    month: "2024-02",
    gasVolume: 182345,
    casingheadVolume: 9543,
  },
  {
    district: "08",
    apiNumber: "4238934567",
    wellName: "BONE SPRING #3H",
    operatorName: "EOG RESOURCES",
    operatorNumber: "345678",
    month: "2024-03",
    gasVolume: 193456,
    casingheadVolume: 10123,
  },
];
