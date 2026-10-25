import { eq } from 'drizzle-orm';
import type { DB } from '../db';
import { users, User } from '../db/schema';
import type { ApiUser } from '../types/api';

export async function upsertGoogleUser(
  db: DB,
  profile: { googleId: string; email: string; name: string; avatarUrl: string | null },
): Promise<User> {
  const [user] = await db
    .insert(users)
    .values(profile)
    .onConflictDoUpdate({
      target: users.googleId,
      set: { email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl },
    })
    .returning();
  return user;
}

export async function getUser(db: DB, id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user;
}

export function toApiUser(u: User): ApiUser {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl,
    slackConnected: Boolean(u.slackWebhookUrl),
    slackChannel: u.slackChannel,
  };
}
