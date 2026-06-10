/**
 * NOAA Atlas 14 PFDS point precipitation-frequency client.
 *
 * v1 forcing source for design-storm depths (2/10/25/100/500-yr at 24-hr)
 * per 40d Phase 2D.3. Uses the HDSC CGI endpoint documented in NOAA FAQs:
 * https://www.weather.gov/owp/hdsc_faqs
 */

export interface NoaaAtlas14DesignStorm {
  returnPeriodYears: number;
  durationHours: number;
  depthInches: number;
}

export interface NoaaAtlas14PointEstimate {
  lat: number;
  lng: number;
  source: "noaa-atlas-14-pfds";
  fetchedAt: string;
  /** 24-hour precipitation depth by return period. */
  designStorms: ReadonlyArray<NoaaAtlas14DesignStorm>;
  endpoint: string;
}

const RETURN_PERIODS = [2, 10, 25, 100, 500] as const;
const DURATION_HOURS = 24;

/** Parse PFDS HTML table rows for 24-hr depth (inches). */
export function parsePfdsDepthTable(html: string): Map<number, number> {
  const out = new Map<number, number>();
  const rowRe =
    /<tr[^>]*>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const years = Number(match[1]);
    const depth = Number(match[2]);
    if (Number.isFinite(years) && Number.isFinite(depth)) {
      out.set(years, depth);
    }
  }
  return out;
}

export function buildPfdsUrl(lat: number, lng: number): string {
  const params = new URLSearchParams({
    lat: lat.toFixed(6),
    lon: lng.toFixed(6),
    type: "pf",
    data: "depth",
    units: "english",
    series: "pds",
  });
  return `https://hdsc.nws.noaa.gov/cgi-bin/new/cgi_readH5.py?${params.toString()}`;
}

export interface FetchNoaaAtlas14Args {
  lat: number;
  lng: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch design-storm depths for a parcel centroid. Returns empty
 * designStorms when the upstream response cannot be parsed — callers
 * should fall back to manual depth entry.
 */
export async function fetchNoaaAtlas14PointEstimate(
  args: FetchNoaaAtlas14Args,
): Promise<NoaaAtlas14PointEstimate> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const endpoint = buildPfdsUrl(args.lat, args.lng);
  const fetchedAt = new Date().toISOString();
  let designStorms: NoaaAtlas14DesignStorm[] = [];
  try {
    const res = await fetchImpl(endpoint, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const html = await res.text();
      const parsed = parsePfdsDepthTable(html);
      for (const rp of RETURN_PERIODS) {
        const depth = parsed.get(rp);
        if (typeof depth === "number") {
          designStorms.push({
            returnPeriodYears: rp,
            durationHours: DURATION_HOURS,
            depthInches: depth,
          });
        }
      }
    }
  } catch {
    designStorms = [];
  }
  return {
    lat: args.lat,
    lng: args.lng,
    source: "noaa-atlas-14-pfds",
    fetchedAt,
    designStorms,
    endpoint,
  };
}

/** Convert inches to millimeters for the hydrology worker. */
export function inchesToMm(inches: number): number {
  return inches * 25.4;
}
