// @vitest-environment node
// Models-refetch planner state machine, driven by a fake clock — pure logic,
// no timers, no store (the setInterval + store subscription wiring lives in
// app.tsx and is exercised by the render smoke test).
import { describe, expect, it } from 'vitest';

import {
  createModelsRefetchPlanner,
  DEFAULT_MODELS_REFETCH_INTERVAL_MS,
} from './models-refetch';

/** Fake clock: the planner owns no timer; the scheduler stamps the interval,
 * the state machine only decides whether a refetch comes due. */
function setup(
  overrides: { intervalMs?: number; isSettled?: (count: number) => boolean } = {},
) {
  let clock = 0;
  const p = createModelsRefetchPlanner({
    intervalMs: overrides.intervalMs ?? DEFAULT_MODELS_REFETCH_INTERVAL_MS,
    isSettled: overrides.isSettled,
    now: () => clock,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { p, advance };
}

describe('createModelsRefetchPlanner', () => {
  it('default interval is 10s', () => {
    expect(DEFAULT_MODELS_REFETCH_INTERVAL_MS).toBe(10_000);
  });

  it('a refetch is due immediately on mount so the empty broadcast is re-probed early', () => {
    const { p } = setup();
    expect(p.onMount()).toBe('refetch');
    expect(p.isSettled()).toBe(false);
  });

  it('mount does not double-fire: a tick before the interval elapses stays quiet', () => {
    const { p, advance } = setup({ intervalMs: 1000 });
    expect(p.onMount()).toBe('refetch');
    advance(500);
    expect(p.tick()).toBeNull();
    advance(500);
    expect(p.tick()).toBe('refetch'); // interval now elapsed
  });

  it('does not refetch before the interval has elapsed', () => {
    const { p, advance } = setup({ intervalMs: 1000 });
    p.onMount();
    advance(999);
    expect(p.tick()).toBeNull();
    advance(1);
    expect(p.tick()).toBe('refetch');
  });

  it('keeps refetching every interval while the registry stays empty', () => {
    const { p, advance } = setup({ intervalMs: 1000 });
    p.onMount();
    for (let round = 1; round <= 5; round++) {
      advance(1000);
      expect(p.tick()).toBe('refetch'); // still nothing registered yet
    }
    expect(p.isSettled()).toBe(false);
  });

  it('a refetch resets the clock: no immediate second fire', () => {
    const { p, advance } = setup({ intervalMs: 1000 });
    p.onMount();
    advance(1000);
    expect(p.tick()).toBe('refetch'); // this fetch marks the clock
    advance(500);
    expect(p.tick()).toBeNull(); // only half an interval since the last fetch
  });

  it('a non-empty registry settles: the next tick is null and isSettled flips', () => {
    const { p, advance } = setup({ intervalMs: 1000 });
    p.onMount();
    advance(1000);
    expect(p.tick()).toBe('refetch');
    p.onModels(37); // the registration-finished broadcast finally lands
    expect(p.isSettled()).toBe(true);
    advance(1000);
    expect(p.tick()).toBeNull(); // terminal: no more requests, caller clears interval
  });

  it('settlement can arrive via the mount fetch itself (no extra tick needed)', () => {
    const { p } = setup();
    p.onMount();
    p.onModels(1); // picker needs only one usable entry
    expect(p.isSettled()).toBe(true);
    expect(p.tick()).toBeNull();
  });

  it('settled is sticky: a later transient empty broadcast must not re-arm polling', () => {
    const { p, advance } = setup({ intervalMs: 1000 });
    p.onMount();
    p.onModels(5);
    expect(p.isSettled()).toBe(true);
    p.onModels(0); // a regression to empty (should never re-open the poll)
    expect(p.isSettled()).toBe(true);
    advance(1000);
    expect(p.tick()).toBeNull();
  });

  it('zero models never settles', () => {
    const { p } = setup();
    p.onMount();
    p.onModels(0);
    expect(p.isSettled()).toBe(false);
  });

  it('the settle predicate is injectable (e.g. a provider-count floor)', () => {
    const { p, advance } = setup({ intervalMs: 1000, isSettled: (n) => n >= 3 });
    p.onMount();
    p.onModels(2); // below the custom floor
    expect(p.isSettled()).toBe(false);
    advance(1000);
    expect(p.tick()).toBe('refetch'); // still polling
    p.onModels(3);
    expect(p.isSettled()).toBe(true);
    advance(1000);
    expect(p.tick()).toBeNull();
  });

  it('a planner mounted already settled stays silent', () => {
    const { p } = setup();
    p.onModels(4); // content present before mount (e.g. a re-push raced ahead)
    expect(p.onMount()).toBeNull(); // nothing to re-probe
    expect(p.isSettled()).toBe(true);
  });
});
