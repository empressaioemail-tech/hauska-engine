import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the hauska-engine repository root (directory containing pnpm-workspace.yaml).
 */
export function resolveHauskaEngineRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("hauska-engine root not found (pnpm-workspace.yaml)");
}
