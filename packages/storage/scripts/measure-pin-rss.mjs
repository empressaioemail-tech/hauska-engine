import postgres from "postgres";

import { InProcessIpfsPin } from "../src/in-process-cache.js";
import { preparePropertyAtomRows } from "../src/property-atom-batch-write.js";

class LeakyInProcessIpfsPin {
  store = new Map();

  async pin(contentHash, body) {
    const cid = `bafy-${contentHash}`;
    this.store.set(cid, body);
    return { cid, size: body.length };
  }
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");

const sql = postgres(url, { ssl: "require", max: 1 });
const rows = await sql`
  SELECT body FROM public.atoms
  WHERE entity_type = 'parcel-node' AND body->>'countyFips' = '48021'
  LIMIT 8000
`;
const fixtures = rows.map((r) => r.body);
await sql.end();

const mb = () => Math.round(process.memoryUsage().rss / (1024 * 1024));

const fixed = new InProcessIpfsPin();
const rssStart = mb();
await preparePropertyAtomRows(fixtures, fixed);
const peakRssMbAfter = mb();

const leaky = new LeakyInProcessIpfsPin();
for (const inst of fixtures) {
  await leaky.pin(inst.contentHash, JSON.stringify(inst));
}
const peakRssMbBefore = mb();

console.log(
  JSON.stringify({
    peakRssMbBefore,
    peakRssMbAfter,
    deltaMb: peakRssMbBefore - peakRssMbAfter,
    fixtureCount: fixtures.length,
  }),
);
