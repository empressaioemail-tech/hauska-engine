# Per-jurisdiction setback tables

Hand-curated JSON tables (locked decision #9 / DA-PI-4) populated from
publicly available ordinances. One file per jurisdiction; one row per
zoning district.

## Schema

```json
{
  "district_name": "string",
  "front_ft": "number",
  "rear_ft": "number",
  "side_ft": "number",
  "side_corner_ft": "number",
  "max_height_ft": "number",
  "max_lot_coverage_pct": "number",
  "max_impervious_pct": "number",
  "citation_url": "string"
}
```

## Why hand-curated rather than scraped from the GIS layer?

The GIS layer carries the polygon and the district code, but the
dimensional rules live in the ordinance text — typically a PDF that
isn't reliably structured. Code-ontology ingestion (zoning ordinances
→ `code-section` atoms) is explicitly out of scope for this sprint per
Spec 51 OQ-1, so the table is the bridge between the polygon and the
prose-only ordinance until the A05 code-atom pipeline ships.

## Adding a jurisdiction

1. Drop a `<jurisdiction-key>.json` file here (use the same slug the
   adapter writes to `briefing_sources.provider`).
2. Append the import + record entry in `index.ts`.
3. Adjust the test asserting completeness in `__tests__/`.

## Statewide fallback tables

Two tables are statewide fallbacks rather than per-county entries:
`utah-unincorporated.json` and `idaho-unincorporated.json`. They serve
parcels whose `localKey` resolves to a county we don't have a
hand-curated table for, but whose state has reasonably uniform
unincorporated zoning rules at the state level.

Decision (DA-PI-4 / V1-5, 2026-05-02): keep these as discovered
implementation detail rather than promoting them to a first-class
"statewide fallback" concept in the spec docs. The fallback rows already
carry honest per-row provenance and the adapter output labels them
clearly, so a spec-level concept would add doc surface without
changing behaviour. Revisit if a third statewide-fallback table appears —
at that point the pattern is worth naming.

### Why no `texas-unincorporated` table

Decision (DA-PI-4 / V1-5, 2026-05-02): intentional skip. Texas
unincorporated zoning is effectively non-existent at the state level —
counties have no zoning authority absent a special charter — so a
statewide fallback table would produce more confusion than signal. A
Texas parcel that resolves to an unincorporated localKey gets no setback
row from this directory, which is the correct answer rather than a
misleading default.
