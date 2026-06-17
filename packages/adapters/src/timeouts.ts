/**
 * Shared per-adapter timeout budgets for the site-context adapter
 * runner (QA-22).
 *
 * The runner ({@link runAdapters}) caps every adapter at a per-call
 * budget — `max(adapter.timeoutMs, context.timeoutMs)` — so one slow
 * upstream cannot stall the Generate Layers batch indefinitely, and a
 * feed that is genuinely down degrades to a single failed row rather
 * than failing the whole layer set.
 *
 * The default budget is 15s. That is ample for the fast feeds (FEMA
 * NFHL, USGS EPQS), but QA-22 observed several public endpoints timing
 * out against it on real engagements: the EPA EJScreen broker, the FCC
 * National Broadband Map API, the Grand County, UT county ArcGIS
 * server, and — caught later, in the P1-3 follow-up — the UGRC
 * (ArcGIS Online) statewide feeds behind `ugrc:dem` / `ugrc:parcels` /
 * `ugrc:address-points`. The failure surfaces to architects as a
 * `timeout` pill on the affected rows and a degraded site-context
 * layer set. Those upstreams answer reliably given more headroom, so
 * each carries the widened {@link SLOW_UPSTREAM_TIMEOUT_MS} budget via
 * its adapter's optional `timeoutMs` floor.
 */

/**
 * Default per-adapter network budget. The runner falls back to this
 * when neither the adapter nor the caller (`context.timeoutMs`) widens
 * it. The api-server's generate-layers route passes this as the
 * `context.timeoutMs` floor, overridable via the `ADAPTER_TIMEOUT_MS`
 * env var.
 */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 15_000;

/**
 * Widened per-adapter budget for known-slow public upstreams: the EPA
 * EJScreen broker, the FCC NBM API, the Grand County county ArcGIS
 * server, and the UGRC ArcGIS Online statewide feeds. 3x the default —
 * headroom for a slow ArcGIS response *and* the `fetchWithRetry` retry
 * ladder (up to 3 attempts + backoff) on top of it, while still
 * bounding the Generate Layers worst case. An adapter's `timeoutMs`
 * can only widen the runner budget, never tighten it, so wiring this
 * on the slow adapters is safe regardless of the caller's floor.
 *
 * P1-3 raised this from QA-22's original 30s: 30s still timed out the
 * Grand County ArcGIS feeds on the canary Musgrave engagement, because
 * three retry attempts at a genuinely slow upstream do not fit inside
 * 30s — a recoverable transient blip was being converted into a hard
 * `timeout`. 45s covers the full retry ladder.
 *
 * Grand County roads is deliberately NOT on this constant: its OSM
 * Overpass fallback has a 25s server-side `[timeout:25]` directive and
 * needs the larger `GRAND_COUNTY_ROADS_TIMEOUT_MS` (60s) to cover a
 * retry.
 */
export const SLOW_UPSTREAM_TIMEOUT_MS = 45_000;
