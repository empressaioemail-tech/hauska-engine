/**
 * IPFS pinning port — pluggable substrate per ADR-010.
 *
 * Default pinning provider is deferred ("Pinata vs. Filebase vs.
 * Google Cloud-hosted IPFS node vs. Hauska-operated cluster";
 * ADR-010 §Open-decisions). The port abstracts the choice so we can
 * swap providers without rewriting consumers.
 *
 * The local dev mode uses the `InProcessIpfsPin` implementation in
 * `./in-process-cache.ts` — it stores content in a Map keyed by
 * content hash. Production wires a real provider implementation
 * (likely Pinata for v1 simplicity).
 */

export interface IpfsPinResult {
  cid: string;
  /** Bytes pinned. Useful for cost telemetry. */
  size: number;
}

export interface IpfsPort {
  pin(contentHash: string, body: string): Promise<IpfsPinResult>;
  fetch(cid: string): Promise<string | null>;
  isPinned(cid: string): Promise<boolean>;
}
