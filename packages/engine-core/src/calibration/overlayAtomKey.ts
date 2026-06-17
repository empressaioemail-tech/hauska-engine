/**
 * Canonical overlay atom-id key — spine-local copy of cortex @workspace/codes
 * overlayAtomKey (arrow-two Phase 3).
 */

export const REASONING_ATOM_PREFIX = "reasoning:" as const;
export const WEBSEARCH_ATOM_PREFIX = "websearch:" as const;

/** Hauska DID prefix for corpus code-section atoms (MCP + brief inline refs). */
export const HAUSKA_CODE_SECTION_DID_PREFIX =
  "did:hauska:code-section:" as const;

const REASONING_OVERLAY_PREFIXES = [
  REASONING_ATOM_PREFIX,
  WEBSEARCH_ATOM_PREFIX,
] as const;

/** True when the id names a reasoning-layer atom (distinct overlay namespace). */
export function isReasoningOverlayAtomId(atomId: string): boolean {
  return REASONING_OVERLAY_PREFIXES.some((prefix) => atomId.startsWith(prefix));
}

/**
 * Normalize any citation atom id to the canonical overlay key.
 *
 * - Corpus: bare UUID and `did:hauska:code-section:{uuid}` → lowercase UUID
 * - Reasoning: `reasoning:` / `websearch:` → identity (never collapsed)
 */
export function canonicalOverlayAtomKey(rawAtomId: string): string {
  const atomId = rawAtomId.trim();
  if (!atomId) return atomId;

  if (isReasoningOverlayAtomId(atomId)) {
    return atomId;
  }

  if (atomId.startsWith(HAUSKA_CODE_SECTION_DID_PREFIX)) {
    const entityId = atomId.slice(HAUSKA_CODE_SECTION_DID_PREFIX.length).trim();
    if (!entityId) return atomId;
    return canonicalOverlayAtomKey(entityId);
  }

  if (atomId.startsWith("did:")) {
    return atomId;
  }

  return atomId.toLowerCase();
}

/** Phase-3 overlay row lookup key: `(jurisdictionTenant, canonicalAtomKey)`. */
export function overlayAtomLookupKey(args: {
  jurisdictionTenant: string;
  atomId: string;
}): string {
  return `${args.jurisdictionTenant}\0${canonicalOverlayAtomKey(args.atomId)}`;
}

/** Parse `[[CODE:…]]` token to canonical overlay key (null if not a code token). */
export function canonicalOverlayKeyFromCodeToken(token: string): string | null {
  const match = token.trim().match(/^\[\[CODE:([^\]]+)\]\]$/);
  if (!match) return null;
  return canonicalOverlayAtomKey(match[1]!);
}

/** Build Hauska code-section DID from any corpus id form (UUID or DID). */
export function toHauskaCodeSectionDid(atomId: string): string {
  const key = canonicalOverlayAtomKey(atomId);
  if (key.startsWith("did:")) return key;
  if (isReasoningOverlayAtomId(key)) return key;
  return `${HAUSKA_CODE_SECTION_DID_PREFIX}${key}`;
}
