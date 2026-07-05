# Retrieval Quality Eval Scores

Per-jurisdiction retrieval quality metrics demonstrating that confidence is earned and made visible.

## Quality Bar Thresholds

- **Top-3 Accuracy**: 90% minimum (retrieval on curated queries)
- **Section Retrievability**: 100% minimum (section-number lookup accuracy)
- **Cross-ref Accuracy**: 95% minimum (cross-reference resolution)

## Evaluation Methodology

This evaluation was run against the committed corpus snapshot at `services/retrieval-api/corpus/snapshot.json` using the eval harness at `packages/corpus/src/eval/index.ts`.

### Metrics Tested

1. **Top-3 Accuracy**: For each curated query, retrieves top-3 results and verifies the expected atom DID is present
2. **Section Retrievability**: Samples up to 100 section atoms per jurisdiction and verifies each is retrievable by exact section number via `getSectionsBySectionNumber`
3. **Cross-ref Accuracy**: Samples up to 100 cross-reference atoms per jurisdiction and verifies each `toSectionId` resolves to a real section atom

### Curated Queries

Curated queries are sourced from `tools/migrate-legacy-codes/src/*-curated-queries.ts` files. These are reviewer-zero-style queries targeting specific sections with natural language text. Jurisdictions without curated queries receive a default score of 100% for Top-3 Accuracy (N/A case).

## Results

Evaluated at: 2026-07-05T15:32:57.812Z

| Jurisdiction | Top-3 Accuracy | Section Retrievability | Cross-ref Accuracy | Atom Count | Quality Bar |
|-------------|----------------|------------------------|-------------------|------------|-------------|
| Austin, TX | N/A (no queries) | 100.0% | 100.0% | 2,211 | ✓ PASS |
| Bastrop County, TX | N/A (no queries) | 100.0% | 100.0% | 17 | ✓ PASS |
| Bastrop, TX | 0.0% | 100.0% | 100.0% | 193 | ✗ FAIL |
| Boerne, TX | N/A (no queries) | 100.0% | N/A (no xrefs) | 106 | ✓ PASS |
| Brownsville, TX | N/A (no queries) | 100.0% | 100.0% | 870 | ✓ PASS |
| Cedar Hill, TX | N/A (no queries) | 100.0% | 100.0% | 706 | ✓ PASS |
| Converse, TX | N/A (no queries) | 100.0% | 100.0% | 610 | ✓ PASS |
| Copperas Cove, TX | N/A (no queries) | 100.0% | N/A (no xrefs) | 133 | ✓ PASS |
| Crowley, TX | N/A (no queries) | 100.0% | 100.0% | 852 | ✓ PASS |
| Dripping Springs, TX | N/A (no queries) | 100.0% | 100.0% | 954 | ✓ PASS |
| El Paso, TX | N/A (no queries) | 100.0% | 100.0% | 659 | ✓ PASS |
| Elgin, TX | N/A (no queries) | 100.0% | N/A (no xrefs) | 266 | ✓ PASS |
| Georgetown, TX | N/A (no queries) | 100.0% | 100.0% | 658 | ✓ PASS |
| Grand County, UT (Moab) | 90.0% | 100.0% | 100.0% | 285 | ✓ PASS |
| Hutto, TX | N/A (no queries) | 100.0% | 100.0% | 1,741 | ✓ PASS |
| Keller, TX | N/A (no queries) | 100.0% | 100.0% | 165 | ✓ PASS |
| Killeen, TX | N/A (no queries) | 100.0% | 100.0% | 637 | ✓ PASS |
| Lago Vista, TX | N/A (no queries) | 100.0% | 100.0% | 299 | ✓ PASS |
| Leander, TX | N/A (no queries) | 100.0% | 100.0% | 185 | ✓ PASS |
| Live Oak, TX | N/A (no queries) | 100.0% | 100.0% | 539 | ✓ PASS |
| Lockhart, TX | N/A (no queries) | 100.0% | N/A (no xrefs) | 139 | ✓ PASS |
| Manor, TX | N/A (no queries) | 100.0% | 100.0% | 273 | ✓ PASS |
| Mission, TX | N/A (no queries) | 100.0% | N/A (no xrefs) | 708 | ✓ PASS |
| New Braunfels, TX | N/A (no queries) | 100.0% | N/A (no xrefs) | 190 | ✓ PASS |
| Pasadena, TX | N/A (no queries) | 100.0% | 100.0% | 463 | ✓ PASS |
| Rollingwood, TX | N/A (no queries) | 100.0% | N/A (no xrefs) | 421 | ✓ PASS |
| Round Rock, TX | N/A (no queries) | 100.0% | N/A (no xrefs) | 355 | ✓ PASS |
| Saginaw, TX | N/A (no queries) | 100.0% | N/A (no xrefs) | 538 | ✓ PASS |
| San Antonio, TX | N/A (no queries) | 100.0% | 100.0% | 941 | ✓ PASS |
| Schertz, TX | N/A (no queries) | 100.0% | N/A (no xrefs) | 161 | ✓ PASS |
| Sugar Land, TX | N/A (no queries) | 100.0% | 100.0% | 542 | ✓ PASS |
| Taylor, TX | N/A (no queries) | 100.0% | 100.0% | 510 | ✓ PASS |
| Watauga, TX | N/A (no queries) | 100.0% | 100.0% | 235 | ✓ PASS |
| Wimberley, TX | N/A (no queries) | 100.0% | 100.0% | 237 | ✓ PASS |

## Individual Reports

Detailed per-jurisdiction eval reports are available as JSON files in this directory:

- `austin_tx.json` - Austin, TX
- `bastrop_county_tx.json` - Bastrop County, TX
- `bastrop_tx.json` - Bastrop, TX
- `boerne_tx.json` - Boerne, TX
- `brownsville_tx.json` - Brownsville, TX
- `cedar_hill_tx.json` - Cedar Hill, TX
- `converse_tx.json` - Converse, TX
- `copperas_cove_tx.json` - Copperas Cove, TX
- `crowley_tx.json` - Crowley, TX
- `dripping_springs_tx.json` - Dripping Springs, TX
- `el_paso_tx.json` - El Paso, TX
- `elgin_tx.json` - Elgin, TX
- `georgetown_tx.json` - Georgetown, TX
- `grand_county_ut.json` - Grand County, UT (Moab)
- `hutto_tx.json` - Hutto, TX
- `keller_tx.json` - Keller, TX
- `killeen_tx.json` - Killeen, TX
- `lago_vista_tx.json` - Lago Vista, TX
- `leander_tx.json` - Leander, TX
- `live_oak_tx.json` - Live Oak, TX
- `lockhart_tx.json` - Lockhart, TX
- `manor_tx.json` - Manor, TX
- `mission_tx.json` - Mission, TX
- `new_braunfels_tx.json` - New Braunfels, TX
- `pasadena_tx.json` - Pasadena, TX
- `rollingwood_tx.json` - Rollingwood, TX
- `round_rock_tx.json` - Round Rock, TX
- `saginaw_tx.json` - Saginaw, TX
- `san_antonio_tx.json` - San Antonio, TX
- `schertz_tx.json` - Schertz, TX
- `sugar_land_tx.json` - Sugar Land, TX
- `taylor_tx.json` - Taylor, TX
- `watauga_tx.json` - Watauga, TX
- `wimberley_tx.json` - Wimberley, TX

## Report Schema

Each jurisdiction JSON file contains:

```typescript
interface EvalReport {
  jurisdictionTenant: string;
  evaluatedAt: string;
  passed: boolean;
  scores: {
    top3Score: number;
    sectionNumScore: number;
    crossRefScore: number;
  };
  thresholds: QualityBarThresholds;
  failures: QueryRunFailure[];
  queriesEvaluated: number;
  sectionsSampled: number;
  crossRefsSampled: number;
}
```

## Notes

- Scores are expressed as decimals (0.0 to 1.0)
- Jurisdictions with zero samples for a metric default to 100% (no data to test)
- Quality bar passing requires ALL three metrics to meet their respective thresholds
- The `failures` array in each report contains details on any queries that did not retrieve their expected atom in the top-3 results
