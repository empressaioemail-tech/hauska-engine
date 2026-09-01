/**
 * Committed companion row shapes for rails v2.
 *
 * schema.sql stays rail-agnostic (payload jsonb). These types are the contract
 * future ingest must meet. Pointer rows name P-85 columns verified from
 * LDT drizzle 0084 + 0086 — no second store.
 */

import type { RailAccessPair } from "./access-pair.js";
import type { PublicRecordAcquiredBy } from "./access-pair.js";

/**
 * A field that must itself represent absent-verified (Texas non-disclosure
 * sales price; flood BFE when the panel carries none).
 */
export type RepresentableScalar<T> =
  | { representation: "value"; value: T }
  | { representation: "absent-verified"; basis: string };

export interface ValueHistoryRow {
  taxYear: number;
  marketValue: number;
  assessedValue: number;
  landValue: number;
  improvementValue: number;
}

export interface SalesHistoryRow {
  transactionDate: string;
  /** Must accept absent-verified — Texas is a non-disclosure state. */
  price: RepresentableScalar<number>;
  instrumentType?: string;
}

/**
 * Pointer into the existing P-85 records store. Discriminated by the table
 * that actually holds the target. Column names are the catalog names.
 */
export type P85StoreRef =
  | {
      store: "records_request_jobs";
      jobId: string;
    }
  | {
      store: "records_request_artifacts";
      jobId: string;
      artifactId: string;
    }
  | {
      store: "clerk_portal_terms";
      countyFips: string;
      portalId: string;
    };

export interface PublicRecordRefRow {
  countyFips: string;
  /** Maps to records_request_artifacts.recording_ref when the store is artifacts. */
  documentId: string;
  /** Maps to records_request_artifacts.document_type when the store is artifacts. */
  recordKind: string;
  storeRef: P85StoreRef;
  acquiredBy: PublicRecordAcquiredBy;
  access: RailAccessPair;
}

export type FloodwayVsFloodplain = "floodway" | "floodplain";

/** Existing flood rail — committed row shape. A bare zone letter is not this. */
export interface FloodCompanionRow {
  zone: string;
  floodwayVsFloodplain: FloodwayVsFloodplain;
  baseFloodElevation: RepresentableScalar<number>;
  femaPanelId: string;
  panelEffectiveDate: string;
}

export interface OwnerRow {
  partyName: string;
  role: string;
}

export type UtilityKind = "water" | "wastewater" | "electric" | "gas";

export interface UtilityServiceRow {
  utilityKind: UtilityKind;
}

export interface OssfRow {
  systemType: string;
}

export interface AgValuationRow {
  agStatus: string;
  rollbackExposure: RepresentableScalar<string>;
}

export interface MineralRightsRow {
  instrumentId: string;
  interest: string;
}

export interface HoaDeedRestrictionsRow {
  restriction: string;
  citation?: string;
}

export interface OverlayDistrictsRow {
  overlayName: string;
  overlayKind: string;
}
