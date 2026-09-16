/**
 * Import stub for `polygon-clipping`, ONLY for bundling legacy-design-tools'
 * edge labeller (`artifacts/api-server/src/lib/buildableEnvelope/edgeLabeling.ts`)
 * with esbuild outside LDT's own install.
 *
 * WHY A STUB IS HONEST HERE. LDT's `buildableEnvelope/geometry.ts` imports
 * polygon-clipping at module scope, but the module under comparison —
 * `labelEdges` — never calls it: only `insetPerEdge` / `geometryCorrectnessGate`
 * do, and the divergence comparison reads `labelEdges`' per-edge labels only.
 * Every export throws, so if a future change routes a compared code path
 * through polygon-clipping the comparison fails loudly instead of quietly
 * comparing geometry computed against a no-op clipper.
 */

const notStubbedForComparison = (op) => {
  throw new Error(
    `polygon-clipping.${op} called while bundling LDT's labeller for the P-262 ` +
      `divergence comparison — the comparison intends to call labelEdges only. ` +
      `Use LDT's own toolchain (pnpm install in legacy-design-tools) instead of the stub.`,
  );
};

export default {
  union: () => notStubbedForComparison("union"),
  intersection: () => notStubbedForComparison("intersection"),
  difference: () => notStubbedForComparison("difference"),
  xor: () => notStubbedForComparison("xor"),
};
