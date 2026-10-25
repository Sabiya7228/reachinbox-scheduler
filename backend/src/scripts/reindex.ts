import { asc, gt } from 'drizzle-orm';
import { db, pool } from '../db';
import { emails } from '../db/schema';
import { SearchService } from '../services/searchService';

/** Rebuilds the Elasticsearch index from Postgres (the source of truth). */
async function main() {
  const search = new SearchService();
  await search.ensureIndex();
  let lastId = '00000000-0000-0000-0000-000000000000';
  let total = 0;
  for (;;) {
    const batch = await db.select().from(emails).where(gt(emails.id, lastId)).orderBy(asc(emails.id)).limit(1000);
    if (batch.length === 0) break;
    await search.indexEmails(batch);
    total += batch.length;
    lastId = batch[batch.length - 1].id;
  }
  console.log(`✅ Reindexed ${total} emails`);
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
