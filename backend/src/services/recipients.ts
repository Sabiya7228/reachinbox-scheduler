/**
 * Extracts unique, lower-cased email addresses from any text: CSV, TXT,
 * one-per-line, comma/semicolon separated, or with extra columns like names.
 */
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function extractEmails(text: string): string[] {
  const found = text.match(EMAIL_REGEX) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase()))];
}

export function isValidEmail(value: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value);
}
