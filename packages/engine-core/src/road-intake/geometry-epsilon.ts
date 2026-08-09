/**
 * Magnitude-scaled collinear orientation tolerance for WGS84 segment tests.
 *
 * Fixed 1e-18 sits ~1776× below measured FP noise on Texas diagonal county
 * boundaries (F5 adversarial: max |orient| ≈ 1.776e-15 on-line).
 */
export function collinearOrientationEpsilon(
  ...points: ReadonlyArray<readonly [number, number]>
): number {
  let scale = 1;
  for (const p of points) {
    scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
  }
  return Math.max(1e-14, scale * 1e-14);
}
