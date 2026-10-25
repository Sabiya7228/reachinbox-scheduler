import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env';
import type { Email } from '../db/schema';
import { logger } from '../lib/logger';

export const EMAIL_INDEX = 'emails';

export interface SearchIndexer {
  indexEmails(emails: Email[]): Promise<void>;
}

/**
 * Elasticsearch is a *secondary* index. Postgres is the source of truth.
 * If ES is down, indexing errors are logged (not thrown) so sending never stops;
 * `npm run es:reindex` rebuilds the index from Postgres at any time.
 */
export class SearchService implements SearchIndexer {
  readonly client: Client;

  constructor(url = env.ELASTICSEARCH_URL) {
    // Fail fast: search is secondary and must never slow down sending.
    this.client = new Client({ node: url, maxRetries: 1, requestTimeout: 3000 });
  }

  async ensureIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: EMAIL_INDEX });
    if (exists) return;
    await this.client.indices.create({
      index: EMAIL_INDEX,
      mappings: {
        properties: {
          userId: { type: 'keyword' },
          campaignId: { type: 'keyword' },
          status: { type: 'keyword' },
          senderEmail: { type: 'keyword' },
          recipient: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          subject: { type: 'text' },
          body: { type: 'text' },
          scheduledAt: { type: 'date' },
          sentAt: { type: 'date' },
        },
      },
    });
    logger.info(`Created Elasticsearch index "${EMAIL_INDEX}"`);
  }

  private toDoc(e: Email) {
    return {
      userId: e.userId,
      campaignId: e.campaignId,
      status: e.status,
      senderEmail: e.senderEmail,
      recipient: e.recipient,
      subject: e.subject,
      body: e.body,
      scheduledAt: e.scheduledAt,
      sentAt: e.sentAt,
    };
  }

  /** Upserts emails into the index (doc id = email id, so re-indexing is idempotent). */
  async indexEmails(emails: Email[]): Promise<void> {
    if (emails.length === 0) return;
    try {
      const operations = emails.flatMap((e) => [{ index: { _index: EMAIL_INDEX, _id: e.id } }, this.toDoc(e)]);
      const res = await this.client.bulk({ operations, refresh: false });
      if (res.errors) logger.warn('Some emails failed to index in Elasticsearch');
    } catch (err) {
      logger.warn('Elasticsearch indexing failed (ignored)', err instanceof Error ? err.message : err);
    }
  }

  /** Full-text search over recipient/subject/body, restricted to one user's emails. */
  async search(userId: string, q: string, status?: string[]) {
    const res = await this.client.search<ReturnType<SearchService['toDoc']>>({
      index: EMAIL_INDEX,
      size: 50,
      query: {
        bool: {
          filter: [{ term: { userId } }, ...(status?.length ? [{ terms: { status } }] : [])],
          must: [
            {
              multi_match: {
                query: q,
                fields: ['recipient^3', 'subject^2', 'body'],
                fuzziness: 'AUTO',
              },
            },
          ],
        },
      },
    });
    return res.hits.hits.map((h) => h._id as string);
  }
}
