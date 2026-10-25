import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { redis } from '../src/lib/redis';
import { HOUR_MS, RateLimiter } from '../src/services/rateLimiter';

const limiter = new RateLimiter(redis, 'rltest');
// a fixed time at the start of an hour window, so tests are deterministic
const T0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS + 1000;

beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await redis.quit();
});

describe('RateLimiter.reserveSlot', () => {
  it('enforces the minimum delay between sends of the same sender', async () => {
    const a = await limiter.reserveSlot('s1', { now: T0, minDelayMs: 2000, limit: 100 });
    const b = await limiter.reserveSlot('s1', { now: T0, minDelayMs: 2000, limit: 100 });
    const c = await limiter.reserveSlot('s1', { now: T0, minDelayMs: 2000, limit: 100 });
    expect([a.slot, b.slot, c.slot]).toEqual([T0, T0 + 2000, T0 + 4000]);
  });

  it('different senders do not block each other', async () => {
    const a = await limiter.reserveSlot('s1', { now: T0, minDelayMs: 2000, limit: 100 });
    const b = await limiter.reserveSlot('s2', { now: T0, minDelayMs: 2000, limit: 100 });
    expect(a.slot).toBe(T0);
    expect(b.slot).toBe(T0);
  });

  it('moves emails to the next hour window when the hourly limit is reached (in order)', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await limiter.reserveSlot('s1', { now: T0, minDelayMs: 1000, limit: 3 }));
    const nextHour = (Math.floor(T0 / HOUR_MS) + 1) * HOUR_MS;
    expect(results.slice(0, 3).every((r) => r.slot < nextHour && !r.rolledToNextHour)).toBe(true);
    expect(results[2].countInWindow).toBe(3); // limit reached exactly here
    expect(results[3]).toMatchObject({ slot: nextHour, rolledToNextHour: true, countInWindow: 1 });
    expect(results[4]).toMatchObject({ slot: nextHour + 1000, countInWindow: 2 });
  });

  it('is safe under heavy concurrency: 1000 parallel reservations never share a slot or exceed the limit', async () => {
    const limit = 200;
    const results = await Promise.all(
      Array.from({ length: 1000 }, () => limiter.reserveSlot('s1', { now: T0, minDelayMs: 10, limit })),
    );
    const slots = results.map((r) => r.slot);
    expect(new Set(slots).size).toBe(1000); // no two emails got the same slot

    const perWindow = new Map<number, number>();
    for (const s of slots) perWindow.set(Math.floor(s / HOUR_MS), (perWindow.get(Math.floor(s / HOUR_MS)) ?? 0) + 1);
    expect([...perWindow.values()].every((n) => n <= limit)).toBe(true);
    expect(perWindow.size).toBe(5); // 1000 emails / 200 per hour = 5 hour windows
  });

  it('send gate: 100 simultaneous attempts → exactly one is granted (Redis clock)', async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.acquireSendGate('s1', { minDelayMs: 2000 })));
    const granted = results.filter((r) => r.granted);
    expect(granted).toHaveLength(1);
    // everyone else is told the same retry time: exactly minDelay after the granted send
    expect(new Set(results.filter((r) => !r.granted).map((r) => r.retryAt))).toEqual(new Set([granted[0].serverNow + 2000]));
  });

  it('send gate: grants again once the delay has passed', async () => {
    expect((await limiter.acquireSendGate('s1', { minDelayMs: 100 })).granted).toBe(true);
    expect((await limiter.acquireSendGate('s1', { minDelayMs: 100 })).granted).toBe(false);
    await new Promise((r) => setTimeout(r, 110));
    expect((await limiter.acquireSendGate('s1', { minDelayMs: 100 })).granted).toBe(true);
  });
});
