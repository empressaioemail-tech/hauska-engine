import { createHash } from "node:crypto";

/**
 * sha256 helper. The atom-instance shapes carry a precomputed
 * contentHash; storage uses the same algorithm to map content hash
 * onto IPFS CID at pin time.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
