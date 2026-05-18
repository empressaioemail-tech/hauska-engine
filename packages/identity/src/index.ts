/**
 * @hauska-engine/identity
 *
 * Atom identity module per ADR-011. DID resolver, IPNS read/write
 * surfaces, key-custody hooks. The custody specifics are deferred
 * per ADR-011 §Open-for-refinement — the module localizes the choice
 * so future refinements don't ripple through retrieval / storage.
 */

export interface IpnsMapping {
  atomDid: string;
  currentCid: string;
  updatedAt: string;
}

/**
 * Resolves an atom DID to its current CID per ADR-011 §2 (DID Document
 * lives on IPFS, addressed via IPNS).
 *
 * Until the IPNS substrate lands, resolution falls back to the Postgres
 * index (storage port). The interface is shaped against the IPNS-first
 * design so swapping in IPNS is a non-breaking change.
 */
export interface IdentityResolver {
  resolveDidToCurrentCid(atomDid: string): Promise<IpnsMapping | null>;
  publishMapping(mapping: IpnsMapping): Promise<void>;
}

/**
 * In-memory identity resolver for tests + dev. Production wires an
 * IPNS-backed resolver here.
 */
export class InMemoryIdentityResolver implements IdentityResolver {
  private readonly mappings = new Map<string, IpnsMapping>();

  async resolveDidToCurrentCid(atomDid: string): Promise<IpnsMapping | null> {
    return this.mappings.get(atomDid) ?? null;
  }

  async publishMapping(mapping: IpnsMapping): Promise<void> {
    this.mappings.set(mapping.atomDid, mapping);
  }
}

/**
 * Key-custody hook placeholder. ADR-011 defers the custody model;
 * the engine carries this interface so future custody implementations
 * (multi-sig, threshold, escrow) land here.
 */
export interface KeyCustody {
  signMappingUpdate(atomDid: string, newCid: string): Promise<string>;
}
