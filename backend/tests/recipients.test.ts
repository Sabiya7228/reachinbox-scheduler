import { describe, expect, it } from 'vitest';
import { extractEmails } from '../src/services/recipients';
import { computeSendTimes } from '../src/services/scheduleService';

describe('extractEmails', () => {
  it('parses CSV with headers/extra columns, dedupes and lowercases', () => {
    const csv = 'name,email\nAsha,Asha@Example.com\nRavi,ravi@test.io\nDup,asha@example.com\nbad,not-an-email';
    expect(extractEmails(csv)).toEqual(['asha@example.com', 'ravi@test.io']);
  });
  it('parses plain text with mixed separators', () => {
    expect(extractEmails('a@x.com; b@y.org , c@z.net\nd@w.co')).toHaveLength(4);
  });
});

describe('computeSendTimes', () => {
  it('spaces emails by the delay starting at the start time', () => {
    const start = new Date(Date.now() + 60_000);
    const t = computeSendTimes(start, 3, 5000);
    expect(t.map((d) => d.getTime() - start.getTime())).toEqual([0, 5000, 10000]);
  });
  it('never schedules in the past', () => {
    const now = Date.now();
    const t = computeSendTimes(new Date(now - 100_000), 1, 0, now);
    expect(t[0].getTime()).toBe(now);
  });
});
