// @vitest-environment node
// Channel watchdog state machine, driven by a fake clock — pure logic,
// no timers, no DOM (the interval + reload wiring lives in the bridge and
// is exercised by the jsdom bridge test).
import { describe, expect, it } from 'vitest';

import {
  createChannelWatchdog,
  DEFAULT_MISS_LIMIT,
  DEFAULT_PING_INTERVAL_MS,
} from './watchdog';

/** Fake clock + fixed seq (the watchdog's own `seq` field is internal; the
 * scheduler stamps ids, the state machine only counts). */
function setup(overrides: { pingIntervalMs?: number; missLimit?: number } = {}) {
  let clock = 0;
  const w = createChannelWatchdog({
    pingIntervalMs: overrides.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
    missLimit: overrides.missLimit ?? DEFAULT_MISS_LIMIT,
    now: () => clock,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { w, advance };
}

describe('createChannelWatchdog', () => {
  it('pings immediately on mount so a dead-on-arrival channel is caught early', () => {
    const { w } = setup();
    expect(w.onMount()).toBe('ping');
    expect(w.isStale()).toBe(false);
  });

  it('defaults: ping every 5s, stale after 3 consecutive misses', () => {
    expect(DEFAULT_PING_INTERVAL_MS).toBe(5000);
    expect(DEFAULT_MISS_LIMIT).toBe(3);
  });

  it('healthy pong stream never trips the watchdog', () => {
    const { w, advance } = setup();
    w.onMount();
    for (let round = 1; round <= 10; round++) {
      advance(DEFAULT_PING_INTERVAL_MS);
      expect(w.tick()).toBe('ping'); // ping #round+1 due
      w.onPong(w.lastPingSeq()); // answered
      expect(w.isStale()).toBe(false);
    }
  });

  it('does not ping before the interval has elapsed', () => {
    const { w, advance } = setup({ pingIntervalMs: 1000 });
    w.onMount();
    advance(500);
    expect(w.tick()).toBeNull();
    advance(500);
    expect(w.tick()).toBe('ping');
  });

  it('stale after missLimit consecutive unanswered pings', () => {
    const { w, advance } = setup({ pingIntervalMs: 1000, missLimit: 3 });
    w.onMount(); // ping unanswered
    advance(1000);
    expect(w.tick()).toBe('ping'); // miss 1
    advance(1000);
    expect(w.tick()).toBe('ping'); // miss 2
    advance(1000);
    expect(w.tick()).toBeNull(); // miss 3 reaches the limit → stale
    expect(w.isStale()).toBe(true);
  });

  it('a pong resets the miss counter and restarts the limit', () => {
    const { w, advance } = setup({ pingIntervalMs: 1000, missLimit: 3 });
    w.onMount(); // ping unanswered
    advance(1000);
    expect(w.tick()).toBe('ping'); // miss 1
    advance(1000);
    expect(w.tick()).toBe('ping'); // miss 2 — current ping then gets its pong
    w.onPong(w.lastPingSeq()); // clears outstanding + misses
    advance(1000);
    expect(w.tick()).toBe('ping'); // fresh cycle, not stale
    expect(w.isStale()).toBe(false);
    // The limit is fully restarted: two more misses are tolerated...
    advance(1000);
    expect(w.tick()).toBe('ping'); // miss 1 of the new window
    advance(1000);
    expect(w.tick()).toBe('ping'); // miss 2
    expect(w.isStale()).toBe(false);
    // ...and stale only comes on the third.
    advance(1000);
    expect(w.tick()).toBeNull();
    expect(w.isStale()).toBe(true);
  });

  it('a pong for a stale seq does not clear the current outstanding ping', () => {
    const { w, advance } = setup({ pingIntervalMs: 1000, missLimit: 3 });
    w.onMount(); // current seq is lastPingSeq()
    const current = w.lastPingSeq();
    advance(1000);
    expect(w.tick()).toBe('ping'); // miss 1; new seq
    advance(1000);
    expect(w.tick()).toBe('ping'); // miss 2; new seq
    w.onPong(current); // the mount ping's echo, arriving two cycles late
    advance(1000);
    expect(w.tick()).toBeNull(); // miss 3 → stale (the late pong must not reset)
    expect(w.isStale()).toBe(true);
  });

  it('any other host message is liveness evidence: no misses accumulate', () => {
    const { w, advance } = setup({ pingIntervalMs: 1000, missLimit: 3 });
    w.onMount();
    for (let round = 0; round < 6; round++) {
      advance(1000);
      expect(w.tick()).toBe('ping'); // pings continue, but...
      w.onAnyHostMessage(); // ...an unrelated host message proves liveness
      expect(w.isStale()).toBe(false);
    }
  });

  it('onAnyHostMessage mid-interval clears an outstanding ping', () => {
    const { w, advance } = setup({ pingIntervalMs: 1000, missLimit: 3 });
    w.onMount();
    advance(500);
    w.onAnyHostMessage(); // stream traffic mid-interval
    advance(500);
    expect(w.tick()).toBe('ping'); // fresh ping, misses unchanged (0)
    expect(w.isStale()).toBe(false);
  });

  it('stale is terminal: ticks stay silent once declared', () => {
    const { w, advance } = setup({ pingIntervalMs: 1000, missLimit: 2 });
    w.onMount();
    advance(1000);
    w.tick(); // miss 1
    advance(1000);
    expect(w.tick()).toBeNull(); // miss 2 → stale
    expect(w.isStale()).toBe(true);
    // Even a pong for the current ping cannot resurrect (the caller reloads).
    w.onPong(w.lastPingSeq());
    w.onAnyHostMessage();
    expect(w.isStale()).toBe(true);
    advance(1000);
    expect(w.tick()).toBeNull();
  });

  it('lastPingSeq stamps the ping the caller must post (monotonic)', () => {
    const { w, advance } = setup({ pingIntervalMs: 1000, missLimit: 3 });
    w.onMount();
    const first = w.lastPingSeq();
    advance(1000);
    w.tick();
    expect(w.lastPingSeq()).toBeGreaterThan(first);
  });
});
