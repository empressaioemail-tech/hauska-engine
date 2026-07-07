/**
 * Fixture: Reeves County injection/disposal (well-level) sample.
 *
 * Source: RRC H-10 (simulated data for district 08, Reeves County).
 * Represents 3 injection/disposal wells with monthly volumes for Jan-Mar 2024.
 */

import type { RawH10InjectionRecord } from "../types.js";

export const reevesInjectionSample: ReadonlyArray<RawH10InjectionRecord> = [
  // SWD Well 1: API 42-389-45678
  {
    district: "08",
    apiNumber: "4238945678",
    wellName: "MARGARITA SWD #1",
    operatorName: "VELOCITY WATER SOLUTIONS",
    operatorNumber: "884481",
    injectionType: "SWD",
    month: "2024-01",
    volume: 287654,
    unit: "BBL",
  },
  {
    district: "08",
    apiNumber: "4238945678",
    wellName: "MARGARITA SWD #1",
    operatorName: "VELOCITY WATER SOLUTIONS",
    operatorNumber: "884481",
    injectionType: "SWD",
    month: "2024-02",
    volume: 293456,
    unit: "BBL",
  },
  {
    district: "08",
    apiNumber: "4238945678",
    wellName: "MARGARITA SWD #1",
    operatorName: "VELOCITY WATER SOLUTIONS",
    operatorNumber: "884481",
    injectionType: "SWD",
    month: "2024-03",
    volume: 301234,
    unit: "BBL",
  },

  // EOR Gas Injection Well: API 42-389-56789
  {
    district: "08",
    apiNumber: "4238956789",
    wellName: "WOLFCAMP EOR GAS #1",
    operatorName: "PIONEER NATURAL RESOURCES",
    operatorNumber: "123456",
    injectionType: "EOR-GAS",
    month: "2024-01",
    volume: 456789,
    unit: "MCF",
  },
  {
    district: "08",
    apiNumber: "4238956789",
    wellName: "WOLFCAMP EOR GAS #1",
    operatorName: "PIONEER NATURAL RESOURCES",
    operatorNumber: "123456",
    injectionType: "EOR-GAS",
    month: "2024-02",
    volume: 462345,
    unit: "MCF",
  },
  {
    district: "08",
    apiNumber: "4238956789",
    wellName: "WOLFCAMP EOR GAS #1",
    operatorName: "PIONEER NATURAL RESOURCES",
    operatorNumber: "123456",
    injectionType: "EOR-GAS",
    month: "2024-03",
    volume: 471234,
    unit: "MCF",
  },

  // SWD Well 2: API 42-389-67890
  {
    district: "08",
    apiNumber: "4238967890",
    wellName: "DELAWARE SWD #2",
    operatorName: "DIAMONDBACK ENERGY",
    operatorNumber: "234567",
    injectionType: "SWD",
    month: "2024-01",
    volume: 198765,
    unit: "BBL",
  },
  {
    district: "08",
    apiNumber: "4238967890",
    wellName: "DELAWARE SWD #2",
    operatorName: "DIAMONDBACK ENERGY",
    operatorNumber: "234567",
    injectionType: "SWD",
    month: "2024-02",
    volume: 203456,
    unit: "BBL",
  },
  {
    district: "08",
    apiNumber: "4238967890",
    wellName: "DELAWARE SWD #2",
    operatorName: "DIAMONDBACK ENERGY",
    operatorNumber: "234567",
    injectionType: "SWD",
    month: "2024-03",
    volume: 209876,
    unit: "BBL",
  },
];
