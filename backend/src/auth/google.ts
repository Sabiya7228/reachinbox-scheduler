import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { env } from '../config/env';
import type { DB } from '../db';
import { upsertGoogleUser } from '../services/userService';

export const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/**
 * Real Google OAuth 2.0 (authorization code flow) via passport.
 * Passport is used ONLY for the OAuth handshake; after it, we store
 * the user id in our own Redis-backed session (see routes/auth.ts).
 */
export function configureGoogleAuth(db: DB) {
  if (!googleConfigured) return;
  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        callbackURL: env.GOOGLE_CALLBACK_URL,
        state: true, // CSRF protection for the OAuth redirect
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) return done(new Error('Google account has no email'));
          const user = await upsertGoogleUser(db, {
            googleId: profile.id,
            email,
            name: profile.displayName || email,
            avatarUrl: profile.photos?.[0]?.value ?? null,
          });
          done(null, user);
        } catch (err) {
          done(err as Error);
        }
      },
    ),
  );
}
