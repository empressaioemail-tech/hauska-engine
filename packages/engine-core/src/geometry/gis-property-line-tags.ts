/**
 * Shared GIS-approximate property-line tags (bearing DMS + distance feet).
 *
 * ONE formula for site-plan PDF and property-boundary-edge atoms — do not
 * invent a second bearing path. Always GIS-approximate; never survey-grade.
 */

const METERS_PER_FOOT = 0.3048;

/** PDF footer / drawing honesty (Track B). */
export const PROPERTY_LINE_TAGS_HONESTY =
  "Property-line tags: GIS-approximate from county parcel ring — not a boundary survey.";

/** Atom provenance honesty (machine-checkable; WDLL anti-fabrication). */
export const PROPERTY_LINE_TAGS_ATOM_HONESTY =
  "GIS-approximate — not a survey";

export const PROPERTY_LINE_TAGS_PROVENANCE_KIND = "gis-approximate" as const;

export const PROPERTY_LINE_TAGS_SOURCE = "county parcel ring / txgio" as const;

export interface PropertyLineTagsProvenance {
  kind: typeof PROPERTY_LINE_TAGS_PROVENANCE_KIND;
  honesty: typeof PROPERTY_LINE_TAGS_ATOM_HONESTY;
  source: typeof PROPERTY_LINE_TAGS_SOURCE;
}

export interface PropertyLineTags {
  bearing: string;
  distanceFeet: number;
  provenance: PropertyLineTagsProvenance;
}

/** Quadrant bearing from local-ENU segment ( +Y = north, +X = east ). GIS-approx. */
export function formatGisBearing(dxMeters: number, dyMeters: number): string {
  if (!(Math.abs(dxMeters) > 1e-9 || Math.abs(dyMeters) > 1e-9)) {
    return "N 0°00' E";
  }
  // Azimuth from north toward east, degrees [0, 360).
  let az = (Math.atan2(dxMeters, dyMeters) * 180) / Math.PI;
  if (az < 0) az += 360;

  const pad2 = (n: number) => n.toString().padStart(2, "0");
  // Quadrant bearings: due-east = N 90° E; due-west = N 90° W.
  if (az <= 90) {
    const d = Math.floor(az);
    const m = Math.round((az - d) * 60) % 60;
    return `N ${d}°${pad2(m)}' E`;
  }
  if (az < 180) {
    const fromS = 180 - az;
    const d = Math.floor(fromS);
    const m = Math.round((fromS - d) * 60) % 60;
    return `S ${d}°${pad2(m)}' E`;
  }
  if (az < 270) {
    const fromS = az - 180;
    const d = Math.floor(fromS);
    const m = Math.round((fromS - d) * 60) % 60;
    return `S ${d}°${pad2(m)}' W`;
  }
  const fromN = 360 - az;
  const d = Math.floor(fromN);
  const m = Math.round((fromN - d) * 60) % 60;
  return `N ${d}°${pad2(m)}' W`;
}

/**
 * Property-line tag text from a GIS ring segment (PDF craft). Callers must
 * surface PROPERTY_LINE_TAGS_HONESTY; never present as survey-grade.
 */
export function formatPropertyLineTag(segment: {
  a: { x: number; y: number };
  b: { x: number; y: number };
  lengthFeet: number;
}): string {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const bearing = formatGisBearing(dx, dy);
  return `${bearing}  ${segment.lengthFeet.toFixed(1)}'`;
}

/**
 * Distance-first tag ("98.3' · N 89°58' W"), the Industry template's gold
 * reference presentation. Same single `formatGisBearing` formula — only the
 * display order and separator differ from `formatPropertyLineTag`.
 */
export function formatPropertyLineTagDistanceFirst(segment: {
  a: { x: number; y: number };
  b: { x: number; y: number };
  lengthFeet: number;
}): string {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const bearing = formatGisBearing(dx, dy);
  return `${segment.lengthFeet.toFixed(1)}' · ${bearing}`;
}

/**
 * Compute atom propertyLineTags from local-ENU edge endpoints (metres).
 * Boundary-primitive `interior.edgeEndpoints` are already in this frame
 * (centroid-projected depth-warm projectRing — not raw lng/lat).
 */
export function computePropertyLineTagsFromLocalEnuEndpoints(
  a: readonly [number, number],
  b: readonly [number, number],
): PropertyLineTags {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const distanceFeet = Math.hypot(dx, dy) / METERS_PER_FOOT;
  return {
    bearing: formatGisBearing(dx, dy),
    distanceFeet,
    provenance: {
      kind: PROPERTY_LINE_TAGS_PROVENANCE_KIND,
      honesty: PROPERTY_LINE_TAGS_ATOM_HONESTY,
      source: PROPERTY_LINE_TAGS_SOURCE,
    },
  };
}

/** True when honesty string carries GIS-approx negation of survey-grade. */
export function propertyLineTagsHonestyIsGisApproximate(honesty: string): boolean {
  const lower = honesty.toLowerCase();
  const hasGisApprox = lower.includes("gis-approximate") || lower.includes("gis-approx");
  const negatesSurvey =
    lower.includes("not a survey") ||
    lower.includes("not a boundary survey") ||
    (lower.includes("not") && lower.includes("survey"));
  return hasGisApprox && negatesSurvey;
}

/**
 * Parse quadrant bearing to azimuth degrees [0, 360) from north toward east.
 * Returns null when the string is not a recognized N/S _°_' E/W form.
 */
export function azimuthDegreesFromGisBearing(bearing: string): number | null {
  const m = bearing
    .trim()
    .match(/^([NS])\s+(\d+)°(\d{2})'\s+([EW])$/i);
  if (!m) return null;
  const ns = m[1]!.toUpperCase();
  const deg = Number(m[2]);
  const min = Number(m[3]);
  const ew = m[4]!.toUpperCase();
  if (!(deg >= 0 && deg <= 90) || !(min >= 0 && min < 60)) return null;
  const q = deg + min / 60;
  if (ns === "N" && ew === "E") return q;
  if (ns === "S" && ew === "E") return 180 - q;
  if (ns === "S" && ew === "W") return 180 + q;
  if (ns === "N" && ew === "W") return (360 - q) % 360;
  return null;
}

/** Smallest absolute angular difference in degrees (0..180). */
export function bearingAngularDeltaDegrees(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}
