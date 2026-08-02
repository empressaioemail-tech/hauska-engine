/**
 * Recipe-version source of truth (Phase A / A3).
 *
 * Every promoted atom must carry the recipe_version it was warmed under so the
 * whole state can be rewarmed on any recipe improvement (engines are
 * deterministic: same frozen inputs + same recipe_version -> same outputs).
 *
 * Bump this constant whenever the warm/inset/cert recipe changes in a way
 * that would produce different outputs for the same frozen inputs. Do NOT
 * hardcode the version string anywhere else — import this constant.
 */
export const RECIPE_VERSION = "1.0.0" as const;
