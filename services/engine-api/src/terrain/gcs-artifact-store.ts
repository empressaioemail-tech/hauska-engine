import { createHash } from "node:crypto";

import { Storage } from "@google-cloud/storage";

export interface TerrainArtifactPutInput {
  parcelNodeId: string;
  format: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface TerrainArtifactStore {
  put(input: TerrainArtifactPutInput): Promise<string>;
}

export interface ReadableTerrainArtifactStore extends TerrainArtifactStore {
  get(ref: string): Promise<Uint8Array | null>;
}

export interface GcsTerrainArtifactStoreOptions {
  bucket: string;
  storage?: Storage;
}

function safeParcelId(parcelNodeId: string): string {
  return parcelNodeId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseGcsRef(ref: string): { bucket: string; objectPath: string } | null {
  if (!ref.startsWith("gcs://")) return null;
  const remainder = ref.slice("gcs://".length);
  const slash = remainder.indexOf("/");
  if (slash <= 0) return null;
  return {
    bucket: remainder.slice(0, slash),
    objectPath: remainder.slice(slash + 1),
  };
}

/** A GCS not-found error carries `code === 404`. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === 404
  );
}

/**
 * Restart-durable terrain artifact store. Object keys are content-addressed:
 * `terrain/{safeParcelId}/{format}/{sha256}`.
 */
export class GcsTerrainArtifactStore implements ReadableTerrainArtifactStore {
  private readonly bucket: string;
  private readonly storage: Storage;

  constructor(opts: GcsTerrainArtifactStoreOptions) {
    if (!opts.bucket) {
      throw new Error("GcsTerrainArtifactStore requires a bucket name");
    }
    this.bucket = opts.bucket;
    this.storage = opts.storage ?? new Storage();
  }

  async put(input: TerrainArtifactPutInput): Promise<string> {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const objectPath = `terrain/${safeParcelId(input.parcelNodeId)}/${input.format}/${sha256}`;
    const file = this.storage.bucket(this.bucket).file(objectPath);
    await file.save(Buffer.from(input.bytes), {
      contentType: input.contentType,
      resumable: false,
    });
    return `gcs://${this.bucket}/${objectPath}`;
  }

  async get(ref: string): Promise<Uint8Array | null> {
    const parsed = parseGcsRef(ref);
    if (!parsed) return null;
    const file = this.storage.bucket(parsed.bucket).file(parsed.objectPath);
    try {
      const [contents] = await file.download();
      return new Uint8Array(contents);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}
