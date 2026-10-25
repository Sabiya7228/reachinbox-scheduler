import { Router } from 'express';
import type { Queue } from 'bullmq';
import { and, count, desc, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db';
import { emails, Email, EmailStatus } from '../db/schema';
import type { EmailJobData } from '../queue/emailQueue';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { scheduleCampaign, scheduleInputSchema } from '../services/scheduleService';
import type { SearchService } from '../services/searchService';
import type { ApiEmail, Paginated } from '../types/api';
import { logger } from '../lib/logger';

/** "Scheduled" tab shows not-yet-finished emails; "Sent" tab shows finished ones (sent or failed). */
const TAB_STATUSES: Record<'scheduled' | 'sent', EmailStatus[]> = {
  scheduled: ['scheduled', 'sending'],
  sent: ['sent', 'failed'],
};

export function toApiEmail(e: Email): ApiEmail {
  return {
    id: e.id,
    campaignId: e.campaignId,
    senderEmail: e.senderEmail,
    recipient: e.recipient,
    subject: e.subject,
    body: e.body,
    status: e.status,
    scheduledAt: e.scheduledAt.toISOString(),
    sentAt: e.sentAt ? e.sentAt.toISOString() : null,
    previewUrl: e.previewUrl,
    error: e.error,
  };
}

const listQuery = z.object({
  tab: z.enum(['scheduled', 'sent']).default('scheduled'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface EmailRouterDeps {
  db: DB;
  queue: Queue<EmailJobData>;
  search: SearchService;
  allowedSenders: string[];
  maxPerHourPerSender: number;
}

export function emailsRouter(deps: EmailRouterDeps) {
  const { db } = deps;
  const r = Router();
  r.use(requireAuth);

  r.get('/senders', (_req, res) => {
    res.json({ senders: deps.allowedSenders, maxPerHourPerSender: deps.maxPerHourPerSender });
  });

  r.post(
    '/schedule',
    asyncHandler(async (req, res) => {
      const input = scheduleInputSchema.parse(req.body);
      const result = await scheduleCampaign(deps, req.session.userId!, input);
      res.status(201).json(result);
    }),
  );

  r.get(
    '/stats',
    asyncHandler(async (req, res) => {
      const rows = await db
        .select({ status: emails.status, n: count() })
        .from(emails)
        .where(eq(emails.userId, req.session.userId!))
        .groupBy(emails.status);
      const by = Object.fromEntries(rows.map((x) => [x.status, Number(x.n)])) as Partial<Record<EmailStatus, number>>;
      res.json({
        scheduled: (by.scheduled ?? 0) + (by.sending ?? 0),
        sent: by.sent ?? 0,
        failed: by.failed ?? 0,
      });
    }),
  );

  r.get(
    '/',
    asyncHandler(async (req, res) => {
      const { tab, page, pageSize } = listQuery.parse(req.query);
      const where = and(eq(emails.userId, req.session.userId!), inArray(emails.status, TAB_STATUSES[tab]));
      const order = tab === 'scheduled' ? asc(emails.scheduledAt) : desc(emails.sentAt);
      const [items, [{ total }]] = await Promise.all([
        db.select().from(emails).where(where).orderBy(order, asc(emails.id)).limit(pageSize).offset((page - 1) * pageSize),
        db.select({ total: count() }).from(emails).where(where),
      ]);
      const body: Paginated<ApiEmail> = { items: items.map(toApiEmail), total: Number(total), page, pageSize };
      res.json(body);
    }),
  );

  r.get(
    '/search',
    asyncHandler(async (req, res) => {
      const { q, tab } = z
        .object({ q: z.string().trim().min(1).max(200), tab: z.enum(['scheduled', 'sent']).optional() })
        .parse(req.query);
      let ids: string[];
      try {
        ids = await deps.search.search(req.session.userId!, q, tab ? TAB_STATUSES[tab] : undefined);
      } catch (err) {
        logger.warn('Search failed', err instanceof Error ? err.message : err);
        res.status(503).json({ error: 'Search is unavailable (is Elasticsearch running?)' });
        return;
      }
      if (ids.length === 0) {
        res.json({ items: [] });
        return;
      }
      // ES gives us matching ids (ranked); Postgres gives the fresh data.
      const rows = await db
        .select()
        .from(emails)
        .where(and(eq(emails.userId, req.session.userId!), inArray(emails.id, ids)));
      const byId = new Map(rows.map((e) => [e.id, e]));
      res.json({ items: ids.map((id) => byId.get(id)).filter((e): e is Email => Boolean(e)).map(toApiEmail) });
    }),
  );

  r.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) {
        res.status(404).json({ error: 'Email not found' });
        return;
      }
      const [row] = await db
        .select()
        .from(emails)
        .where(and(eq(emails.id, id.data), eq(emails.userId, req.session.userId!)));
      if (!row) {
        res.status(404).json({ error: 'Email not found' });
        return;
      }
      res.json(toApiEmail(row));
    }),
  );

  return r;
}
