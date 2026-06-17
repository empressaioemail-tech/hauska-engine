/**
 * Cotality (CoreLogic Developer Platform) — shared OAuth client, CLIP
 * resolution, and JSON fetch helpers for all national Cotality adapters.
 *
 * Auth: OAuth2 client_credentials at `https://api.cotality.com/oauth/token`
 * with creds in form body + `scope=openid` (Incapsula WAF requires non-empty body).
 *
 * Demo apps (env vars):
 *   COTALITY_PROPERTY_*     → Property API v2 (`property_auth`)
 *   COTALITY_SPATIALTILE_*  → Spatial Tile (`property_auth`)
 *   COTALITY_RISKMETER_*    → RiskMeter (`spatial_auth`)
 *
 * See `_research/2026-06-06_cotality_api_surface_catalog.md`.
 */

import { CACHE_COORDINATE_PRECISION } from "../cache";
import { AdapterRunError } from "../types";

export const COTALITY_PROVIDER_LABEL = "Cotality";
export const COTALITY_INMEM_TTL_MS = 15 * 60 * 1000;
export const COTALITY_TIMEOUT_MS = 30_000;
export const COTALITY_TOKEN_EXPIRY_BUFFER_MS = 60_000;
export const COTALITY_FRESHNESS_THRESHOLD_MONTHS = 6;

export const COTALITY_USER_AGENT =
  "smartcity-plan-review/1.0 (+https://cortex.empressa.io)";

// ---------------------------------------------------------------------------
// Endpoint constants — OPERATOR-CONFIRM from developer.corelogic.com
// ---------------------------------------------------------------------------

export const COTALITY_TOKEN_URL_DEFAULT =
  "https://api.cotality.com/oauth/token";
export const COTALITY_API_BASE_DEFAULT = "https://api.cotality.com";
export const COTALITY_PROPERTY_BASE_URL_DEFAULT =
  "https://api.cotality.com/v2/properties";
export const COTALITY_SPATIALTILE_BASE_URL_DEFAULT =
  "https://api.cotality.com/spatial-tile";
export const COTALITY_RISKMETER_BASE_URL_DEFAULT =
  "https://api.cotality.com/riskmeter-api";

export function cotalityTokenUrl(): string {
  return process.env.COTALITY_TOKEN_URL ?? COTALITY_TOKEN_URL_DEFAULT;
}

export function cotalityPropertyBaseUrl(): string {
  return (
    process.env.COTALITY_PROPERTY_BASE_URL ??
    COTALITY_PROPERTY_BASE_URL_DEFAULT
  );
}

export function cotalitySpatialTileBaseUrl(): string {
  return (
    process.env.COTALITY_SPATIALTILE_BASE_URL ??
    COTALITY_SPATIALTILE_BASE_URL_DEFAULT
  );
}

export function cotalityRiskMeterBaseUrl(): string {
  return (
    process.env.COTALITY_RISKMETER_BASE_URL ??
    COTALITY_RISKMETER_BASE_URL_DEFAULT
  );
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export type CotalityOAuthApp = "property" | "spatialtile" | "riskmeter";

interface CotalityAppCredentials {
  clientId: string;
  clientSecret: string;
}

interface CotalityTokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

const cotalityTokenCache = new Map<
  CotalityOAuthApp,
  CotalityTokenCacheEntry
>();
const cotalityTokenInflight = new Map<
  CotalityOAuthApp,
  Promise<string>
>();

const CRED_ENV: Record<
  CotalityOAuthApp,
  { key: string; secret: string; label: string }
> = {
  property: {
    key: "COTALITY_PROPERTY_KEY",
    secret: "COTALITY_PROPERTY_SECRET",
    label: "COTALITY_PROPERTY_KEY/SECRET",
  },
  spatialtile: {
    key: "COTALITY_SPATIALTILE_KEY",
    secret: "COTALITY_SPATIALTILE_SECRET",
    label: "COTALITY_SPATIALTILE_KEY/SECRET",
  },
  riskmeter: {
    key: "COTALITY_RISKMETER_KEY",
    secret: "COTALITY_RISKMETER_SECRET",
    label: "COTALITY_RISKMETER_KEY/SECRET",
  },
};

/** OAuth security scheme name per demo app (for adapter metadata). */
export const COTALITY_OAUTH_SCHEME: Record<CotalityOAuthApp, string> = {
  property: "property_auth",
  spatialtile: "property_auth",
  riskmeter: "spatial_auth",
};

export function readCotalityAppCredentials(
  app: CotalityOAuthApp,
): CotalityAppCredentials | null {
  const spec = CRED_ENV[app];
  const clientId = process.env[spec.key];
  const clientSecret = process.env[spec.secret];
  if (!clientId || clientId.length === 0) return null;
  if (!clientSecret || clientSecret.length === 0) return null;
  return { clientId, clientSecret };
}

export function requireCotalityAppCredentials(
  app: CotalityOAuthApp,
  fallbackMessage?: string,
): CotalityAppCredentials {
  const creds = readCotalityAppCredentials(app);
  if (creds) return creds;
  throw new AdapterRunError(
    "no-coverage",
    fallbackMessage ??
      `${CRED_ENV[app].label} is not configured on this deployment. Regrid remains the active national parcel/zoning provider.`,
  );
}

export function __resetCotalityTokenCacheForTests(): void {
  cotalityTokenCache.clear();
  cotalityTokenInflight.clear();
}

type CotalityLogLevel = "info" | "warn";

function cotalityLogEvent(
  level: CotalityLogLevel,
  msg: string,
  adapterKey: string,
  fields: Record<string, unknown>,
): void {
  const out = { level, msg, adapter_key: adapterKey, ...fields };
  let line: string;
  try {
    line = JSON.stringify(out);
  } catch {
    line = JSON.stringify({ level, msg, adapter_key: adapterKey });
  }
  if (level === "warn") console.warn(line);
  else console.info(line);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("client_secret")) {
      u.searchParams.set("client_secret", "<redacted>");
    }
    return u.toString();
  } catch {
    return url;
  }
}

interface GetCotalityAccessTokenArgs {
  app: CotalityOAuthApp;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
}

export async function getCotalityAccessToken(
  args: GetCotalityAccessTokenArgs,
): Promise<string> {
  const { app, fetchImpl, signal, adapterKeyForLog } = args;
  requireCotalityAppCredentials(app);

  const now = Date.now();
  const cached = cotalityTokenCache.get(app);
  if (cached && cached.expiresAt > now) return cached.accessToken;

  const inflight = cotalityTokenInflight.get(app);
  if (inflight) return inflight;

  const creds = readCotalityAppCredentials(app)!;
  const fetcher: typeof fetch = fetchImpl ?? fetch;
  const tokenUrl = cotalityTokenUrl();

  const promise = (async (): Promise<string> => {
    cotalityLogEvent("info", "cotality oauth token start", adapterKeyForLog, {
      app,
      scheme: COTALITY_OAUTH_SCHEME[app],
      token_url: redactUrl(tokenUrl),
    });
    const startedAtMs = Date.now();

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: "openid",
    });

    let res: Response;
    try {
      res = await fetcher(tokenUrl, {
        method: "POST",
        signal,
        headers: {
          "User-Agent": COTALITY_USER_AGENT,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (err) {
      const throwExcerpt =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      cotalityLogEvent("warn", "cotality oauth token failed", adapterKeyForLog, {
        app,
        error_class: "network",
        duration_ms: Date.now() - startedAtMs,
        throw_excerpt: throwExcerpt,
      });
      throw new AdapterRunError(
        "network-error",
        `Cotality OAuth token request failed (${app} app): ${throwExcerpt}. Use Force refresh to retry.`,
      );
    }

    if (!res.ok) {
      let bodyExcerpt = "";
      try {
        bodyExcerpt = (await res.text()).slice(0, 256);
      } catch {
        /* swallow */
      }
      cotalityLogEvent("warn", "cotality oauth token failed", adapterKeyForLog, {
        app,
        error_class: "status",
        http_status: res.status,
        duration_ms: Date.now() - startedAtMs,
        body_excerpt: bodyExcerpt,
      });
      throw new AdapterRunError(
        "upstream-error",
        `Cotality OAuth token responded HTTP ${res.status} (${app} app).${
          bodyExcerpt ? ` Upstream: ${bodyExcerpt}` : ""
        } Check consumer KEY/SECRET for this demo app.`,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AdapterRunError(
        "parse-error",
        `Cotality OAuth token response was not JSON (${app} app): ${message}`,
      );
    }

    const tokenObj = json as { access_token?: unknown; expires_in?: unknown };
    const accessToken =
      typeof tokenObj.access_token === "string" ? tokenObj.access_token : null;
    if (!accessToken) {
      throw new AdapterRunError(
        "parse-error",
        `Cotality OAuth token response missing access_token (${app} app).`,
      );
    }

    const expiresInSec =
      typeof tokenObj.expires_in === "number" && tokenObj.expires_in > 0
        ? tokenObj.expires_in
        : 3600;
    const expiresAt =
      Date.now() + expiresInSec * 1000 - COTALITY_TOKEN_EXPIRY_BUFFER_MS;

    cotalityTokenCache.set(app, { accessToken, expiresAt });
    cotalityLogEvent("info", "cotality oauth token ok", adapterKeyForLog, {
      app,
      duration_ms: Date.now() - startedAtMs,
      expires_in_sec: expiresInSec,
    });
    return accessToken;
  })();

  const tracked = promise.finally(() => {
    const entry = cotalityTokenInflight.get(app);
    if (entry === tracked) cotalityTokenInflight.delete(app);
  });

  cotalityTokenInflight.set(app, tracked);
  return tracked;
}

// ---------------------------------------------------------------------------
// HTTP JSON fetch
// ---------------------------------------------------------------------------

export async function cotalityFetchJson(args: {
  url: string;
  bearerToken: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
  label: string;
}): Promise<unknown> {
  const { url, bearerToken, fetchImpl, signal, adapterKeyForLog, label } =
    args;
  const startedAtMs = Date.now();

  cotalityLogEvent("info", "cotality request start", adapterKeyForLog, {
    label,
    url: redactUrl(url),
  });

  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal,
      headers: {
        "User-Agent": COTALITY_USER_AGENT,
        Accept: "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
    });
  } catch (err) {
    const throwExcerpt =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    cotalityLogEvent("warn", "cotality request failed", adapterKeyForLog, {
      label,
      error_class: "network",
      duration_ms: Date.now() - startedAtMs,
      throw_excerpt: throwExcerpt,
    });
    throw new AdapterRunError(
      "network-error",
      `Cotality ${label} did not get a response. Network error: ${throwExcerpt}. Use Force refresh to retry.`,
    );
  }

  if (!res.ok) {
    let bodyExcerpt = "";
    try {
      bodyExcerpt = (await res.text()).slice(0, 256);
    } catch {
      /* swallow */
    }
    cotalityLogEvent("warn", "cotality request failed", adapterKeyForLog, {
      label,
      error_class: "status",
      http_status: res.status,
      duration_ms: Date.now() - startedAtMs,
      body_excerpt: bodyExcerpt,
    });
    throw new AdapterRunError(
      "upstream-error",
      `Cotality ${label} responded HTTP ${res.status}.${
        bodyExcerpt ? ` Upstream: ${bodyExcerpt}` : ""
      } Use Force refresh to retry.`,
    );
  }

  try {
    return await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterRunError(
      "parse-error",
      `Cotality ${label} response was not JSON: ${message}`,
    );
  }
}

export async function cotalityGetWithApp(args: {
  app: CotalityOAuthApp;
  path: string;
  baseUrl?: string;
  query?: Record<string, string | number | undefined | null>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
  label: string;
}): Promise<unknown> {
  const {
    app,
    path,
    baseUrl,
    query,
    fetchImpl,
    signal,
    adapterKeyForLog,
    label,
  } = args;

  if (!readCotalityAppCredentials(app)) {
    throw new AdapterRunError(
      "no-coverage",
      `${CRED_ENV[app].label} is not configured.`,
    );
  }

  const fetcher: typeof fetch = fetchImpl ?? fetch;
  const token = await getCotalityAccessToken({
    app,
    fetchImpl: fetcher,
    signal,
    adapterKeyForLog,
  });

  const base =
    baseUrl ??
    (app === "riskmeter"
      ? cotalityRiskMeterBaseUrl()
      : app === "spatialtile"
        ? cotalitySpatialTileBaseUrl()
        : cotalityPropertyBaseUrl());

  const url = new URL(
    `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`,
  );
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && String(v).length > 0) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  return cotalityFetchJson({
    url: url.toString(),
    bearerToken: token,
    fetchImpl: fetcher,
    signal,
    adapterKeyForLog,
    label,
  });
}

// ---------------------------------------------------------------------------
// CLIP resolution (Property geocode search)
// ---------------------------------------------------------------------------

export interface CotalityClipContext {
  clip: string;
  latitude: number;
  longitude: number;
  address?: string | null;
  county?: string;
  raw?: unknown;
}

interface ClipDedupEntry {
  promise: Promise<CotalityClipContext>;
  expiresAt: number;
}

const clipDedup = new Map<string, ClipDedupEntry>();

function clipDedupKey(
  latitude: number,
  longitude: number,
  address?: string | null,
): string {
  const factor = 10 ** CACHE_COORDINATE_PRECISION;
  const lat = Math.round(latitude * factor) / factor;
  const lng = Math.round(longitude * factor) / factor;
  const addr = address?.trim().toLowerCase() ?? "";
  return `${lat},${lng}:${addr}`;
}

export function __resetCotalityClipDedupForTests(): void {
  clipDedup.clear();
}

function extractClipFromSearchResponse(json: unknown): CotalityClipContext | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;

  const candidates: unknown[] = [];
  if (Array.isArray(root.items)) candidates.push(...root.items);
  if (Array.isArray(root.properties)) candidates.push(...root.properties);
  if (Array.isArray(root.results)) candidates.push(...root.results);
  if (Array.isArray(root.data)) candidates.push(...root.data);
  if (root.clip != null) candidates.push(root);

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const clip =
      row.clip ??
      row.CLIP ??
      row.propertyClip ??
      (row.property as Record<string, unknown> | undefined)?.clip;
    if (clip == null) continue;
    const clipStr = String(clip);
    const lat =
      pickNum(row.latitude) ??
      pickNum(row.lat) ??
      pickNum(
        (row.coordinates as Record<string, unknown> | undefined)?.latitude,
      );
    const lng =
      pickNum(row.longitude) ??
      pickNum(row.lon) ??
      pickNum(row.lng) ??
      pickNum(
        (row.coordinates as Record<string, unknown> | undefined)?.longitude,
      );
    const county =
      typeof row.county === "string"
        ? row.county
        : typeof row.countyName === "string"
          ? row.countyName
          : undefined;
    return {
      clip: clipStr,
      latitude: lat ?? NaN,
      longitude: lng ?? NaN,
      county,
      raw: item,
    };
  }
  return null;
}

function pickNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function resolveCotalityClip(args: {
  latitude: number;
  longitude: number;
  address?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  adapterKeyForLog: string;
}): Promise<CotalityClipContext> {
  const { latitude, longitude, address, fetchImpl, signal, adapterKeyForLog } =
    args;

  const key = clipDedupKey(latitude, longitude, address);
  const now = Date.now();
  const existing = clipDedup.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;

  const promise = (async (): Promise<CotalityClipContext> => {
    if (!readCotalityAppCredentials("property")) {
      throw new AdapterRunError(
        "no-coverage",
        "COTALITY_PROPERTY_KEY/SECRET is not configured. Cannot resolve Cotality CLIP.",
      );
    }

    const query: Record<string, string | number | undefined | null> = {
      lat: latitude,
      lon: longitude,
      latitude,
      longitude,
    };
    if (address) {
      query.address = address;
      query.fullAddress = address;
    }

    const json = await cotalityGetWithApp({
      app: "property",
      path: "/search/geocode",
      query,
      fetchImpl,
      signal,
      adapterKeyForLog,
      label: "property-geocode",
    });

    const parsed = extractClipFromSearchResponse(json);
    if (!parsed) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality geocode search returned no CLIP at this lat/lng/address.",
      );
    }

    return {
      ...parsed,
      latitude: Number.isFinite(parsed.latitude) ? parsed.latitude : latitude,
      longitude: Number.isFinite(parsed.longitude)
        ? parsed.longitude
        : longitude,
      address: address ?? null,
    };
  })();

  clipDedup.set(key, { promise, expiresAt: now + COTALITY_INMEM_TTL_MS });
  promise.catch(() => {
    const entry = clipDedup.get(key);
    if (entry?.promise === promise) clipDedup.delete(key);
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Geometry + feature helpers
// ---------------------------------------------------------------------------

export interface NormalizedFeature {
  type: "Feature";
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
  id?: string | number;
}

export function normalizeGeometryToCoordinates(geom: unknown): unknown | null {
  if (!geom) return null;
  if (typeof geom === "object") {
    const g = geom as Record<string, unknown>;
    if (g.type === "Polygon" || g.type === "MultiPolygon") {
      if (Array.isArray(g.coordinates)) return g.coordinates;
    }
    if (Array.isArray(g.rings)) return g.rings;
    if (g.geometry) return normalizeGeometryToCoordinates(g.geometry);
    if (g.shape) return normalizeGeometryToCoordinates(g.shape);
    if (Array.isArray(g.parcels) && g.parcels.length > 0) {
      const first = g.parcels[0] as Record<string, unknown>;
      return normalizeGeometryToCoordinates(first.geometry ?? first);
    }
  }
  if (typeof geom === "string") {
    const s = geom.trim().toUpperCase();
    if (s.startsWith("POLYGON") || s.startsWith("MULTIPOLYGON")) return null;
  }
  return null;
}

export function buildPolygonFeature(
  geometryCoords: unknown,
  baseProps: Record<string, unknown>,
  geomType: "Polygon" | "MultiPolygon" = "Polygon",
): NormalizedFeature {
  return {
    type: "Feature",
    geometry: {
      type: geomType,
      coordinates: geometryCoords,
    },
    properties: { ...baseProps },
  };
}

export function extractParcelGeometryFromSpatialTile(
  json: unknown,
): unknown | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const list =
    (Array.isArray(root.parcels) ? root.parcels : null) ??
    (Array.isArray(root.items) ? root.items : null) ??
    (Array.isArray(root.features) ? root.features : null);
  if (list && list.length > 0) {
    const first = list[0] as Record<string, unknown>;
    return (
      first.geometry ??
      (first.parcel as Record<string, unknown> | undefined)?.geometry ??
      first
    );
  }
  return root.geometry ?? null;
}

export function snapshotDateFromJson(json: unknown): string {
  if (!json || typeof json !== "object") return new Date().toISOString();
  const root = json as Record<string, unknown>;
  const candidates = [
    root.vintage,
    root.lastUpdated,
    root.asOf,
    root.refreshDate,
    root.snapshotDate,
    root.taxYear ? `${root.taxYear}-01-01` : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return new Date().toISOString();
}

export function providerLabel(county?: string | null): string {
  if (county && county.length > 0) {
    return `${COTALITY_PROVIDER_LABEL} (via ${county})`;
  }
  return COTALITY_PROVIDER_LABEL;
}

export function cotalityAppliesGeocoded(ctx: {
  parcel: { latitude: number; longitude: number };
}): boolean {
  return (
    Number.isFinite(ctx.parcel.latitude) &&
    Number.isFinite(ctx.parcel.longitude)
  );
}

/** Adapter metadata stamped on payloads for operator smoke tracking. */
export function cotalityAdapterMeta(
  adapterKey: string,
  app: CotalityOAuthApp,
  liveSmoke: "pending" | "not-run" | "passed" | "failed" = "pending",
): Record<string, unknown> {
  return {
    source: "cotality",
    adapterKey,
    cotalityDemoApp: app,
    cotalityOAuthScheme: COTALITY_OAUTH_SCHEME[app],
    liveSmokeStatus: liveSmoke,
  };
}
