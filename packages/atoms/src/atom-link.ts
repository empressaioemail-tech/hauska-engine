/**
 * Atom-link edge taxonomy per ADR-010 §Initial-link-taxonomy.
 *
 * Storage stores these in the `atom_links` table (`from_cid`, `to_cid`,
 * `link_type`). Retrieval traverses them under ADR-007 scope.
 */

export type LinkType =
  | "cites"
  | "adjudicates"
  | "applies-to"
  | "derives-from"
  | "precedent-of"
  | "interprets"
  | "contains"
  | "instance-of"
  | "amends"
  | "supersedes"
  | "defines"
  | "uses-term"
  | "see-also"
  | "subject-to"
  | "as-defined-in";

export interface AtomLink {
  fromEntityType: string;
  fromEntityId: string;
  toEntityType: string;
  toEntityId: string;
  linkType: LinkType;
  /** Free-form context for retrieval signal (e.g. the surrounding sentence). */
  context?: string;
}
