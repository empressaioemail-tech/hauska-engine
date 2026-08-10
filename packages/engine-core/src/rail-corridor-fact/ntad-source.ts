/**
 * NTAD NARN + grade-crossing live fetch (public ArcGIS REST).
 *
 * NOT the Texas Railroad Commission (oil/gas) — this is railroad TRACKS via
 * BTS NTAD, sourced from FRA NARN. FRA's direct MapServer was down at build
 * time; NTAD FeatureServer is the reliable distribution endpoint.
 */

import type { BBox } from "./geo.js";
import type { RailCorridorClass, RailCorridorStatus } from "@empressaio/atom-contract/property";

export const NTAD_NARN_LINES_URL =
  "https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/NTAD_North_American_Rail_Network_Lines/FeatureServer/0";

export const NTAD_GRADE_CROSSINGS_URL =
  "https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/NTAD_Railroad_Grade_Crossings/FeatureServer/0";

export const NTAD_NARN_SOURCE_VINTAGE = "2026-07-21";

export interface RailCorridorFeature {
  segmentId: string;
  net: string | null;
  status: RailCorridorStatus;
  corridorClass: RailCorridorClass;
  rrowner1: string | null;
  subdiv: string | null;
  geometry: unknown;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface GradeCrossingFeature {
  crossingId: string;
  lng: number;
  lat: number;
}

export function mapNetToStatus(net: string | null | undefined): RailCorridorStatus {
  const code = (net ?? "").trim().toUpperCase();
  if (code === "A" || code === "R") return "abandoned";
  if (code === "T") return "rail-trail";
  return "active";
}

export function mapNetToClass(net: string | null | undefined): RailCorridorClass {
  const code = (net ?? "").trim().toUpperCase();
  if (code === "M") return "mainline";
  if (code === "Y") return "yard";
  return "spur";
}

function segmentBbox(geometry: unknown): BBox | null {
  const coords: number[] = [];
  const walk = (g: unknown) => {
    if (!g || typeof g !== "object") return;
    const geo = g as { type?: string; coordinates?: unknown };
    if (geo.type === "LineString" && Array.isArray(geo.coordinates)) {
      for (const c of geo.coordinates) {
        if (Array.isArray(c) && c.length >= 2) coords.push(c[0], c[1]);
      }
    } else if (geo.type === "MultiLineString" && Array.isArray(geo.coordinates)) {
      for (const ls of geo.coordinates) walk({ type: "LineString", coordinates: ls });
    }
  };
  walk(geometry);
  if (coords.length < 4) return null;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let i = 0; i < coords.length; i += 2) {
    const lng = coords[i]!;
    const lat = coords[i + 1]!;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

async function queryArcGisPage(
  baseUrl: string,
  where: string,
  outFields: string,
  offset: number,
): Promise<{ features: Array<{ attributes: Record<string, unknown>; geometry: unknown }>; exceeded: boolean }> {
  const params = new URLSearchParams({
    where,
    outFields,
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    resultOffset: String(offset),
    resultRecordCount: "2000",
  });
  const res = await fetch(`${baseUrl}/query?${params}`);
  if (!res.ok) {
    throw new Error(`NTAD query HTTP ${res.status} for ${baseUrl}`);
  }
  const body = (await res.json()) as {
    features?: Array<{ attributes: Record<string, unknown>; geometry: unknown }>;
    exceededTransferLimit?: boolean;
    error?: { message?: string };
  };
  if (body.error) {
    throw new Error(`NTAD query error: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  return {
    features: body.features ?? [],
    exceeded: body.exceededTransferLimit === true,
  };
}

export async function fetchNtadRailCorridorsForCounty(
  countyFips: string,
): Promise<RailCorridorFeature[]> {
  const where = `STCNTYFIPS='${countyFips}'`;
  const outFields = "OBJECTID,NET,RROWNER1,SUBDIV";
  const out: RailCorridorFeature[] = [];
  let offset = 0;
  for (;;) {
    const page = await queryArcGisPage(NTAD_NARN_LINES_URL, where, outFields, offset);
    for (const f of page.features) {
      const a = f.attributes;
      const objectId = String(a.OBJECTID ?? a.objectid ?? out.length);
      const net = typeof a.NET === "string" ? a.NET : null;
      const bb = segmentBbox(f.geometry);
      if (!bb) continue;
      out.push({
        segmentId: objectId,
        net,
        status: mapNetToStatus(net),
        corridorClass: mapNetToClass(net),
        rrowner1: typeof a.RROWNER1 === "string" ? a.RROWNER1 : null,
        subdiv: typeof a.SUBDIV === "string" ? a.SUBDIV : null,
        geometry: f.geometry,
        ...bb,
      });
    }
    if (!page.exceeded && page.features.length < 2000) break;
    offset += page.features.length;
    if (page.features.length === 0) break;
  }
  return out;
}

export async function fetchNtadGradeCrossingsForCounty(
  countyFips: string,
): Promise<GradeCrossingFeature[]> {
  const where = `CountyCode='${countyFips}'`;
  const outFields = "CrossingID,Longitude,Latitude";
  const out: GradeCrossingFeature[] = [];
  let offset = 0;
  for (;;) {
    const page = await queryArcGisPage(NTAD_GRADE_CROSSINGS_URL, where, outFields, offset);
    for (const f of page.features) {
      const a = f.attributes;
      const crossingId = String(a.CrossingID ?? "").trim();
      const lng = Number(a.Longitude);
      const lat = Number(a.Latitude ?? a.LATITUDE);
      if (!crossingId || !Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      out.push({ crossingId, lng, lat });
    }
    if (!page.exceeded && page.features.length < 2000) break;
    offset += page.features.length;
    if (page.features.length === 0) break;
  }
  return out;
}

export interface NtadSourceProbeResult {
  countyFips: string;
  narnSegmentCount: number;
  gradeCrossingCount: number;
  abandonedOrTrailCount: number;
  sourceVintage: string;
  licence: string;
  endpoints: { narn: string; gradeCrossings: string };
}

/** Live read-only probe for one county (exit-bounded verification). */
export async function probeNtadRailSource(
  countyFips: string,
): Promise<NtadSourceProbeResult> {
  const [segments, crossings] = await Promise.all([
    fetchNtadRailCorridorsForCounty(countyFips),
    fetchNtadGradeCrossingsForCounty(countyFips),
  ]);
  return {
    countyFips,
    narnSegmentCount: segments.length,
    gradeCrossingCount: crossings.length,
    abandonedOrTrailCount: segments.filter(
      (s) => s.status === "abandoned" || s.status === "rail-trail",
    ).length,
    sourceVintage: NTAD_NARN_SOURCE_VINTAGE,
    licence:
      "USDOT/BTS NTAD — US government work, 17 U.S.C. § 101, unrestricted public use",
    endpoints: {
      narn: NTAD_NARN_LINES_URL,
      gradeCrossings: NTAD_GRADE_CROSSINGS_URL,
    },
  };
}
