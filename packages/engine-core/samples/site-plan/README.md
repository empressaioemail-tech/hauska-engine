# Site-plan SHEET STANDARD v1.0 reference samples

Rendered by the standard-governed renderer (src/site-plan/pdf/SHEET_STANDARD_v1.html).

| Fixture | File | Role |
|---|---|---|
| `48021:34785` (1009 Chestnut, Bastrop) | `48021_34785_site_plan.pdf` | three-page gold set |
| `qa2:dense-small` | `qa2_dense-small_site_plan.pdf` | degenerate case (8 segments, no buildable envelope) |

Regenerate (gold hits the live Esri World Imagery export for sheet 3):
```
cd packages/engine-core
npx tsx scripts/generate-site-plan-gold-34785.mjs
npx tsx scripts/generate-site-plan-gold-dense-qa2.mjs
```

Planner verifies the live PDF (customer-reads-as-paid-deliverable). Builder does not claim customer QA.
