/**
 * Fixture: Reeves County oil production (lease-level) sample.
 *
 * Source: RRC PDQ (simulated data for district 08, Reeves County).
 * Represents 3 leases with monthly oil production for Jan-Mar 2024.
 */

import type { RawOilProductionRecord } from "../types.js";

export const reevesOilSample: ReadonlyArray<RawOilProductionRecord> = [
  // Lease 1: WOLFCAMP A UNIT
  {
    district: "08",
    leaseNumber: "12345",
    leaseName: "WOLFCAMP A UNIT",
    operatorName: "PIONEER NATURAL RESOURCES",
    operatorNumber: "123456",
    month: "2024-01",
    oilVolume: 15234,
    condensateVolume: 523,
  },
  {
    district: "08",
    leaseNumber: "12345",
    leaseName: "WOLFCAMP A UNIT",
    operatorName: "PIONEER NATURAL RESOURCES",
    operatorNumber: "123456",
    month: "2024-02",
    oilVolume: 14876,
    condensateVolume: 501,
  },
  {
    district: "08",
    leaseNumber: "12345",
    leaseName: "WOLFCAMP A UNIT",
    operatorName: "PIONEER NATURAL RESOURCES",
    operatorNumber: "123456",
    month: "2024-03",
    oilVolume: 16102,
    condensateVolume: 547,
  },

  // Lease 2: DELAWARE SAND LEASE
  {
    district: "08",
    leaseNumber: "23456",
    leaseName: "DELAWARE SAND LEASE",
    operatorName: "DIAMONDBACK ENERGY",
    operatorNumber: "234567",
    month: "2024-01",
    oilVolume: 8932,
  },
  {
    district: "08",
    leaseNumber: "23456",
    leaseName: "DELAWARE SAND LEASE",
    operatorName: "DIAMONDBACK ENERGY",
    operatorNumber: "234567",
    month: "2024-02",
    oilVolume: 9201,
  },
  {
    district: "08",
    leaseNumber: "23456",
    leaseName: "DELAWARE SAND LEASE",
    operatorName: "DIAMONDBACK ENERGY",
    operatorNumber: "234567",
    month: "2024-03",
    oilVolume: 8745,
  },

  // Lease 3: BONE SPRING UNIT
  {
    district: "08",
    leaseNumber: "34567",
    leaseName: "BONE SPRING UNIT",
    operatorName: "EOG RESOURCES",
    operatorNumber: "345678",
    month: "2024-01",
    oilVolume: 12456,
    condensateVolume: 789,
  },
  {
    district: "08",
    leaseNumber: "34567",
    leaseName: "BONE SPRING UNIT",
    operatorName: "EOG RESOURCES",
    operatorNumber: "345678",
    month: "2024-02",
    oilVolume: 11987,
    condensateVolume: 754,
  },
  {
    district: "08",
    leaseNumber: "34567",
    leaseName: "BONE SPRING UNIT",
    operatorName: "EOG RESOURCES",
    operatorNumber: "345678",
    month: "2024-03",
    oilVolume: 13102,
    condensateVolume: 823,
  },
];
