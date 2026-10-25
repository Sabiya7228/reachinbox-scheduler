import type IORedis from 'ioredis';

export const HOUR_MS = 60 * 60 * 1000;

/**
 * Atomically reserves a send "slot" for a sender.
 *
 * It enforces two rules at once, in Redis, so it is safe across many workers
 * and many server instances (nothing is kept in memory):
 *
 *  1. Minimum delay: a sender's sends are at least `minDelayMs` apart.
 *     Key `ratelimit:next:{sender}` stores the earliest time the next send may happen.
 *  2. Hourly limit: at most `limit` sends per clock-hour window per sender.
 *     Key `ratelimit:count:{sender}:{hourWindow}` counts reservations in that hour.
 *     If the hour is full, the slot moves to the start of the next hour.
 *
 * Returns the reserved slot time. If slot > now, the caller delays the job until then.
 * Because Lua scripts run atomically in Redis, two workers can never get the same slot.
 */
const RESERVE_SLOT_LUA = `
local nextKey   = KEYS[1]
local prefix    = ARGV[1]
local now       = tonumber(ARGV[2])
local minDelay  = tonumber(ARGV[3])
local limit     = tonumber(ARGV[4])
local hourMs    = tonumber(ARGV[5])

local nextFree = tonumber(redis.call('GET', nextKey) or '0')
local slot = math.max(now, nextFree)
local window, count
local rolled = 0

for i = 1, 1000 do
  window = math.floor(slot / hourMs)
  local key = prefix .. window
  count = tonumber(redis.call('GET', key) or '0')
  if count < limit then
    count = redis.call('INCR', key)
    -- keep the counter until one hour after its window ends
    redis.call('PEXPIREAT', key, (window + 2) * hourMs)
    break
  end
  -- this hour is full: move to the start of the next hour window
  rolled = 1
  slot = (window + 1) * hourMs
end

redis.call('SET', nextKey, slot + minDelay, 'PX', 2 * hourMs + minDelay)
return { slot, count, window, rolled }
`;

/**
 * Strict "send gate": the final check right before SMTP.
 * Uses Redis's own clock (TIME), so workers on different machines with slightly
 * different clocks are all judged by ONE clock. Only one send per sender is
 * granted every `minDelayMs`, no matter how many workers ask at once.
 * Returns { granted, serverNow, retryAt }.
 */
const SEND_GATE_LUA = `
local key      = KEYS[1]
local minDelay = tonumber(ARGV[1])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local last = tonumber(redis.call('GET', key) or '-1')
if last >= 0 and now < last + minDelay then
  return { 0, now, last + minDelay }
end
redis.call('SET', key, now, 'PX', minDelay + 60000)
return { 1, now, 0 }
`;

export interface GateResult {
  granted: boolean;
  /** Redis server time (ms) when the decision was made. */
  serverNow: number;
  /** If not granted: earliest server time when a send may be granted. */
  retryAt: number;
}

export interface SlotReservation {
  /** Epoch ms when this email is allowed to be sent. */
  slot: number;
  /** How many emails are now reserved in the slot's hour window (including this one). */
  countInWindow: number;
  /** The hour window index (floor(slot / 1h)). */
  window: number;
  /** True if the hourly limit pushed this email into a later hour. */
  rolledToNextHour: boolean;
}

export class RateLimiter {
  constructor(
    private readonly redis: IORedis,
    private readonly keyPrefix = 'ratelimit',
  ) {}

  async reserveSlot(sender: string, opts: { now: number; minDelayMs: number; limit: number }): Promise<SlotReservation> {
    const res = (await this.redis.eval(
      RESERVE_SLOT_LUA,
      1,
      `${this.keyPrefix}:next:${sender}`,
      `${this.keyPrefix}:count:${sender}:`,
      opts.now,
      opts.minDelayMs,
      opts.limit,
      HOUR_MS,
    )) as [number, number, number, number];

    return {
      slot: Number(res[0]),
      countInWindow: Number(res[1]),
      window: Number(res[2]),
      rolledToNextHour: Number(res[3]) === 1,
    };
  }

  async acquireSendGate(sender: string, opts: { minDelayMs: number }): Promise<GateResult> {
    if (opts.minDelayMs <= 0) return { granted: true, serverNow: Date.now(), retryAt: 0 };
    const [g, serverNow, retryAt] = (await this.redis.eval(
      SEND_GATE_LUA,
      1,
      `${this.keyPrefix}:lastsend:${sender}`,
      opts.minDelayMs,
    )) as [number, number, number];
    return { granted: Number(g) === 1, serverNow: Number(serverNow), retryAt: Number(retryAt) };
  }

  /** How many sends are reserved in the current hour for a sender (for display/debugging). */
  async currentCount(sender: string, now = Date.now()): Promise<number> {
    const window = Math.floor(now / HOUR_MS);
    return Number((await this.redis.get(`${this.keyPrefix}:count:${sender}:${window}`)) ?? 0);
  }
}
