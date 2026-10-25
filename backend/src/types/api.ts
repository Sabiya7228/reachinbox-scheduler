/** Shapes returned by the API. The frontend has a matching copy in src/types/api.ts. */
import type { EmailStatus } from '../db/schema';

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  slackConnected: boolean;
  slackChannel: string | null;
}

export interface ApiEmail {
  id: string;
  campaignId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  previewUrl: string | null;
  error: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
