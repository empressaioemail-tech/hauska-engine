# Map layers capability contract

> **Status:** active (2026-06-17). Gate-fronted spine capability per
> [`_decisions/2026-06-17_map_extraction_shared_capability`](https://github.com/empressaioemail-tech/doc_repo/blob/main/_decisions/2026-06-17_map_extraction_shared_capability.md).

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/map-layers/contract` | Machine-readable contract for gate + consumers |
| `POST` | `/v1/map-layers/assemble` | Parcel-keyed layer assembly |

Both require gate-front headers + bearer (see `gate-front-seam.md`).

## Gate exposure (cc-agent-M)

| Field | Value |
|-------|-------|
| Package id | `map-layers` |
| Recommended access tiers | `public-paid`, `platform-internal`, `tenant-private` |
| Tenant binding | `X-Hauska-Tenant-Id` → echoed as `payload.tenantScope` |
| Max-tier | Map render is Max-gated at the product; gate enforces entitlement |

The gate **must not** serve layers cross-tenant. engine-api trusts
`gateFront.tenantId` and echoes it on the response for consumer audit.

## Request — `POST /v1/map-layers/assemble`

```json
{
  "parcel": {
    "latitude": 30.2672,
    "longitude": -97.7431,
    "address": "501 Congress Ave, Austin, TX",
    "parcelKey": "optional-stable-id"
  },
  "jurisdiction": {
    "stateKey": "texas",
    "localKey": null,
    "partnerCity": false
  },
  "layers": ["parcel-polygon", "flood-zone", "zoning"],
  "forceRefresh": false,
  "bbox": {
    "westLng": -97.75,
    "southLat": 30.26,
    "eastLng": -97.74,
    "northLat": 30.27
  }
}
```

`bbox` is reserved for wave-3 DEM/topography wiring (cc-agent-C).

## Response — outer `EngineEnvelope`

```json
{
  "payload": {
    "parcelKey": "austin-demo-1",
    "place": { "latitude": 30.2672, "longitude": -97.7431 },
    "tenantScope": "tenant-map-1",
    "assembledAt": "2026-06-17T12:00:00.000Z",
    "layers": [
      {
        "layerKey": "parcel-polygon",
        "status": "ok",
        "adapterKey": "cotality:parcels",
        "envelope": {
          "payload": { "kind": "parcel", "geojson": {} },
          "confidence": { "value": 1, "kind": "deterministic" },
          "dataVintage": "2026-06-01T00:00:00.000Z",
          "coverage": { "degraded": false },
          "source": { "adapter": "cotality:parcels" }
        }
      }
    ]
  },
  "confidence": { "value": 1, "kind": "deterministic" },
  "dataVintage": "2026-06-01T00:00:00.000Z",
  "coverage": { "degraded": true, "reason": "partial: …" },
  "source": { "adapter": "map-layers:assemble" }
}
```

**No bare geometry at the wire root.** Each `layers[]` slot carries its
own nested `EngineEnvelope` with vintage + confidence-kind + degraded.

## Layer keys

| Key | Wired now | Pending (cc-agent-C wave-3) |
|-----|-----------|------------------------------|
| `parcel-polygon` | `cotality:parcels` only (Regrid purged) | honest `pending` when Cotality has no polygon |
| `flood-zone` | `fema:nfhl-flood-zone` | — |
| `floodway` | — | RiskMeter floodway geometry |
| `dem` | — | catchment DEM grid |
| `topography` | — | contour derivation |
| `opportunity-zone-tract` | — | federal OZ registry |
| `zoning` | `cotality:zoning` only (Regrid purged) | honest `pending` when Cotality has no geometry |

When Cotality returns no geometry for `parcel-polygon` or `zoning`, the slot
is `pending` with honest degradation — no silent fallback to dropped providers.

## Consumer migration (cc-agent-C)

1. Replace cortex-api `POST /engagements/:id/generate-layers` geometry
   fan-out with gate-proxied `POST /v1/map-layers/assemble`.
2. Persist `briefing_sources` in cortex until storage lifts to spine.
3. Map render reads `layers[].envelope` — surface vintage + confidence-kind
   per layer (commitment #2).

## Surfaces lifted off cortex BFF

| Cortex BFF today | Engine capability |
|------------------|-------------------|
| `generate-layers` adapter fan-out | `map-layers/assemble` |
| `siteTopographyIngest` (DEM) | `topography/dem` + pending `dem` slot |
| FEMA / Cotality adapters | same adapters via `@hauska-engine/adapters` (Regrid purged 2026-07-13) |

Persistence (briefing_sources supersession) stays cortex-side for now.
