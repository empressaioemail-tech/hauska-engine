/**
 * In-process hot cache + in-process IPFS pin (dev).
 *
 * The hot cache is a Map<atomDid, instance>. Production swaps in
 * Redis once retrieval pressure forces it per ADR-010 deferred
 * decision.
 *
 * `InProcessIpfsPin` exists so tests and local dev have a working
 * pinning surface without depending on a real IPFS provider. CIDs
 * are derived deterministically from content hashes — `bafy-${hash}`
 * — so cross-references that the atomizer wrote against content
 * hashes resolve consistently.
 */

import type { CodeAtomInstance } from "@hauska-engine/atoms";

import type { IpfsPort, IpfsPinResult } from "./ipfs-port.js";

export class HotCache {
  private readonly store = new Map<string, CodeAtomInstance>();
  private readonly maxEntries: number;

  constructor(maxEntries = 2_000) {
    this.maxEntries = maxEntries;
  }

  get(atomDid: string): CodeAtomInstance | null {
    return this.store.get(atomDid) ?? null;
  }

  set(atomDid: string, instance: CodeAtomInstance): void {
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) this.store.delete(firstKey);
    }
    this.store.set(atomDid, instance);
  }

  invalidate(atomDid: string): void {
    this.store.delete(atomDid);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

export class InProcessIpfsPin implements IpfsPort {
  private readonly store = new Map<string, string>();

  async pin(contentHash: string, body: string): Promise<IpfsPinResult> {
    const cid = `bafy-${contentHash}`;
    this.store.set(cid, body);
    return { cid, size: body.length };
  }

  async fetch(cid: string): Promise<string | null> {
    return this.store.get(cid) ?? null;
  }

  async isPinned(cid: string): Promise<boolean> {
    return this.store.has(cid);
  }
}
