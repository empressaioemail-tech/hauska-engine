/**
 * Minimal robots.txt gate for the eCode360 adapter.
 *
 * Per the 2026-07-29 proof wave (P:/tmp/tx_scraper_proofs/smithville/
 * STATUS.md + robots_raw.txt): ecode360.com's robots.txt disallows
 * `/admin`, `/archives`, `/attachment`, `/dashboard`, `/documents`,
 * `/output`, `/permissions`, `/print`, `/search`, `/user` for UA `*`.
 * The landing page (`/{custId}`), the TOC (`/toc/{custId}`), and the
 * numeric content paths (`/{guid}`) the crawl walks are all allowed.
 *
 * This parser only implements what the adapter needs: UA `*` `Disallow`
 * prefix matching, grouped per the standard robots.txt convention where
 * one or more consecutive `User-agent:` lines open a group that lasts
 * until the next `User-agent:` line not immediately preceded by a
 * directive-free run. It does not implement `Allow` override
 * precedence, wildcards, or `Crawl-delay` — eCode360's robots.txt uses
 * none of those for UA `*`, and adding unused generality here would be
 * unverified against the one source this adapter targets.
 */

export interface RobotsRules {
  /** Disallowed path prefixes for UA `*` (already lowercased). */
  disallowPrefixes: ReadonlyArray<string>;
}

/**
 * Parse a robots.txt body into the UA `*` ruleset.
 *
 * Grouping follows the standard robots.txt convention: a run of one or
 * more consecutive `User-agent:` lines opens a new group (replacing
 * whatever group was open before); any other directive line (Disallow,
 * Allow, Crawl-delay, …) attaches to the currently open group. The next
 * `User-agent:` line — wherever it appears — starts a new group.
 */
export function parseRobotsTxt(body: string): RobotsRules {
  const lines = body.split(/\r?\n/);
  const disallowPrefixes: string[] = [];
  let groupUserAgents: string[] = [];
  let sawNonUserAgentSinceGroupStart = false;

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0]!.trim();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === "user-agent") {
      if (sawNonUserAgentSinceGroupStart) {
        // A directive already attached to the prior group — this
        // User-agent line starts a fresh group.
        groupUserAgents = [];
        sawNonUserAgentSinceGroupStart = false;
      }
      groupUserAgents.push(value.toLowerCase());
      continue;
    }

    sawNonUserAgentSinceGroupStart = true;
    if (field === "disallow" && value && groupUserAgents.includes("*")) {
      disallowPrefixes.push(value.toLowerCase());
    }
  }

  return { disallowPrefixes };
}

/** Thrown when a target path is disallowed by robots.txt for UA `*`. */
export class ECode360RobotsDisallowedError extends Error {
  constructor(public readonly path: string) {
    super(`ECode360: robots.txt disallows "${path}" for UA *`);
    this.name = "ECode360RobotsDisallowedError";
  }
}

/** True when `path` is allowed for UA `*` under `rules`. */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  const lower = path.toLowerCase();
  return !rules.disallowPrefixes.some((prefix) => lower.startsWith(prefix));
}

/** Throws `ECode360RobotsDisallowedError` when `path` is disallowed. */
export function assertPathAllowed(rules: RobotsRules, path: string): void {
  if (!isPathAllowed(rules, path)) {
    throw new ECode360RobotsDisallowedError(path);
  }
}
