/**
 * Host catalogue loader and URL resolution for discovery queue items.
 * NEVER synthesize gis.{slug}tx.gov hostnames.
 */

import hostCatalogueJson from "./host-catalogue.json" with { type: "json" };

import { fetchJsonResilient } from "./fetch-json.js";
import type { HostCatalogue, HostCatalogueEntry, QueueItem, SearchPathSource } from "./types.js";

export type ResolvedHost = {
  url: string;
  source: SearchPathSource;
};

export function loadHostCatalogue(): HostCatalogue {
  return hostCatalogueJson as HostCatalogue;
}

export function catalogueBaseUrls(): string[] {
  return loadHostCatalogue().hosts.map((h) => h.baseUrl.replace(/\/+$/, ""));
}

export function findCatalogueHost(baseUrl: string): HostCatalogueEntry | undefined {
  const norm = baseUrl.replace(/\/+$/, "");
  return loadHostCatalogue().hosts.find((h) => h.baseUrl.replace(/\/+$/, "") === norm);
}

/**
 * Detect hostname shapes we must never construct from a cityKey slug.
 * Observed catalogue/seed URLs that happen to match are allowed.
 */
export function looksLikeSlugSynthesizedHost(cityKey: string, url: string): boolean {
  try {
    const slug = cityKey.replace(/-tx$/i, "").replace(/-/g, "");
    const host = new URL(url).hostname.toLowerCase();
    const synthetic = "gis." + slug + "tx.gov";
    return host === synthetic || host === "maps." + slug + "countytx.gov";
  } catch {
    return false;
  }
}

/**
 * Normalize a directory/service URL.
 * Hub FeatureServer/MapServer hits are KEPT at service granularity (do not
 * collapse to the org rest/services root — that fans out into unrelated cities).
 * Seed/catalogue roots ending at /rest/services stay as folder-recurse roots.
 */
export function normalizeArcGisRestUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) return null;
  const candidate = trimmed.startsWith("http://")
    ? "https://" + trimmed.slice("http://".length)
    : trimmed;

  // Layer URL → parent service
  const layerMatch = candidate.match(/^(https:\/\/.+\/(?:MapServer|FeatureServer))\/\d+$/i);
  if (layerMatch) return layerMatch[1]!;

  if (/\/(MapServer|FeatureServer)$/i.test(candidate)) return candidate;

  if (candidate.endsWith("/rest/services")) return candidate;
  if (candidate.includes("/rest/services")) {
    return candidate.split("/rest/services")[0]! + "/rest/services";
  }
  return null;
}

export function resolveSeedHostUrls(item: QueueItem): ResolvedHost[] {
  const out: ResolvedHost[] = [];
  for (const raw of item.seedHostUrls ?? []) {
    const norm = normalizeArcGisRestUrl(raw);
    if (norm) {
      out.push({ url: norm, source: "seed" });
    }
  }
  return out;
}

export function resolveCatalogueHostUrls(): ResolvedHost[] {
  return loadHostCatalogue().hosts.map((h) => ({
    url: h.baseUrl.replace(/\/+$/, ""),
    source: "catalogue" as const,
  }));
}

export async function searchArcGisHubForCity(item: QueueItem): Promise<ResolvedHost[]> {
  // City-name primary; TX qualifier; keep result count small to bound fan-out.
  const q = `title:Zoning ("${item.cityName}" OR "${item.cityName}, TX") Texas`;
  const url = `https://www.arcgis.com/sharing/rest/search?q=${encodeURIComponent(q)}&f=json&num=8`;
  try {
    const res = await fetchJsonResilient(url);
    if (res.transportError || res.status >= 400) return [];
    const body = res.body as { results?: Array<{ url?: string; type?: string }> };
    const out: ResolvedHost[] = [];
    for (const r of body.results ?? []) {
      if (!r.url) continue;
      const t = r.type ?? "";
      if (!/Feature Service|Map Service/i.test(t)) continue;
      const norm = normalizeArcGisRestUrl(r.url);
      if (norm) out.push({ url: norm, source: "agol-hub" });
    }
    return out;
  } catch {
    return [];
  }
}

export async function searchTxGioCkanForCity(item: QueueItem): Promise<ResolvedHost[]> {
  const q = `zoning OR land use district ${item.cityName}`;
  const url = `https://data.geographic.texas.gov/api/3/action/package_search?q=${encodeURIComponent(q)}&rows=10`;
  try {
    const res = await fetchJsonResilient(url);
    if (res.transportError || res.status >= 400) return [];
    const body = res.body as {
      result?: { results?: Array<{ resources?: Array<{ url?: string }> }> };
    };
    const out: ResolvedHost[] = [];
    for (const pkg of body.result?.results ?? []) {
      for (const resource of pkg.resources ?? []) {
        if (!resource.url) continue;
        const norm = normalizeArcGisRestUrl(resource.url);
        if (norm) out.push({ url: norm, source: "txgio-ckan" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve hosts for one queue item.
 * Seeds always. Hub/CKAN are city-scoped directory probes (fail-soft).
 * Full catalogue roots attach only when the city has no seeds AND Hub returned
 * nothing — never blindly recurse every catalogue host for every city.
 */
export async function resolveHostUrlsForQueueItem(
  item: QueueItem,
  opts: {
    includeCatalogue?: boolean;
    includeHub?: boolean;
    includeCkan?: boolean;
  } = {},
): Promise<ResolvedHost[]> {
  const seen = new Set<string>();
  const merged: ResolvedHost[] = [];

  function add(host: ResolvedHost) {
    const key = host.url.replace(/\/+$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({ url: key, source: host.source });
  }

  const seeds = resolveSeedHostUrls(item);
  for (const h of seeds) add(h);

  // Seeds are authoritative directory hits for this city — do not Hub-fan
  // unless the caller forces includeHub or there are no seeds.
  let hub: ResolvedHost[] = [];
  const runHub = opts.includeHub === true || (opts.includeHub !== false && seeds.length === 0);
  if (runHub) {
    hub = await searchArcGisHubForCity(item);
    for (const h of hub) add(h);
  }

  if (opts.includeCkan === true || (opts.includeCkan !== false && seeds.length === 0 && hub.length === 0)) {
    // CKAN only as fallback when seeds+hub empty, unless explicitly requested.
    if (opts.includeCkan === true || (seeds.length === 0 && hub.length === 0)) {
      for (const h of await searchTxGioCkanForCity(item)) add(h);
    }
  }

  const needCatalogueFallback =
    opts.includeCatalogue === true ||
    (opts.includeCatalogue !== false && seeds.length === 0 && hub.length === 0);

  if (needCatalogueFallback) {
    for (const h of resolveCatalogueHostUrls()) add(h);
  }

  return merged;
}
