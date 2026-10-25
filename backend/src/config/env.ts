import 'dotenv/config';
import { z } from 'zod';

/**
 * All configuration comes from environment variables and is validated once at
 * startup. If something required is missing, the app refuses to start with a
 * clear message instead of failing later in a confusing way.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:4000/api/auth/google/callback'),

  SLACK_CLIENT_ID: z.string().default(''),
  SLACK_CLIENT_SECRET: z.string().default(''),
  SLACK_REDIRECT_URL: z.string().default(''),

  // Comma-separated Ethereal accounts: "user1@ethereal.email:pass1,user2@ethereal.email:pass2"
  ETHEREAL_SENDERS: z.string().default(''),
  SMTP_HOST: z.string().default('smtp.ethereal.email'),
  SMTP_PORT: z.coerce.number().default(587),

  // Throughput settings (all configurable, nothing hardcoded)
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  MIN_DELAY_BETWEEN_EMAILS_MS: z.coerce.number().int().min(0).default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).default(200),
  SEND_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;

export interface SenderAccount {
  email: string;
  password: string;
}

/** Parses ETHEREAL_SENDERS ("email:pass,email:pass") into sender accounts. */
export function parseSenders(raw: string): SenderAccount[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(':');
      if (idx === -1) throw new Error(`Invalid ETHEREAL_SENDERS entry "${pair}" (expected email:password)`);
      return { email: pair.slice(0, idx).trim(), password: pair.slice(idx + 1).trim() };
    });
}

export const senders = parseSenders(env.ETHEREAL_SENDERS);
