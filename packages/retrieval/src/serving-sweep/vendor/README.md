# Vendored serving-path source — DO NOT EDIT THE LOGIC

Every file in this directory is a **verbatim copy** of a file that runs on the
Smart Site serving path, taken from
`empressaioemail-tech/hauska-map` at commit `d3510a6fbfa883907897d66b942579da132b8358`
(recorded in `VENDOR_SOURCE_SHA.txt`).

They are copied rather than re-implemented because the sweep must measure what
the product SERVES. A re-implementation measures what the sweep author believed
the product serves, which is the defect class this lane exists to find.

| vendored file | origin in hauska-map |
| --- | --- |
| `setback-not-specified.ts` | `apps/property-explorer/api/_lib/setback-not-specified.ts` |
| `atom-chain-to-facets.ts` | `apps/property-explorer/api/_lib/atom-chain-to-facets.ts` |
| `buildable-display-vocab.ts` | `apps/property-explorer/src/lib/buildable-display-vocab.ts` |
| `baked-facets.ts` | `apps/property-explorer/src/lib/baked-facets.ts` |
| `buildable-envelope-types.ts` | `apps/property-explorer/src/lib/buildable-envelope.d.ts` |

## The only edits made

Four import specifiers in `baked-facets.ts`, each marked inline with a
`// VENDOR-PATH-REWRITE` comment naming the original specifier, and the
`.d.ts` → `.ts` rename of the type shim. No logic line was touched. `git diff`
against the hauska-map originals is the check, and
`__tests__/vendor-drift.test.ts` re-asserts it on every run where a hauska-map
checkout is reachable.

`apps/property-explorer/api/_lib/pe-property-atoms.ts` is deliberately NOT
vendored: it imports `@vercel/node` request/response types that do not resolve
in this package. Its decision tree is reproduced in `../bff-flow.ts`, with the
two pure helpers it contributes (`stripCortexEnvelopeProductTruth`,
`honestAtomPendingResponse`) copied verbatim and cited line-for-line there.
