// The exact-keys arms are the run-time boundary the tag lists cannot cover:
// a frame that carries a declared tag with the WRONG key set is dropped, so
// the two hand-synced additions (the optional `successor` on the bind
// hand-off, the workspace state stream) need their own pins here.

import { describe, expect, it } from 'vitest';

import { parseHostEvent } from './guards';

describe('parseHostEvent exact-keys arms', () => {
  it('accepts the bind hand-off frame carrying the successor', () => {
    const handoff = { type: 'sessionDisposed', sessionId: 's1', successor: 's2' };
    expect(parseHostEvent(handoff)).toEqual({ ok: true, value: handoff });

    // The ordinary disposal (no successor key) still parses.
    const plain = { type: 'sessionDisposed', sessionId: 's1' };
    expect(parseHostEvent(plain)).toEqual({ ok: true, value: plain });
  });

  it('accepts the workspace registry state stream', () => {
    const frame = {
      type: 'workspaceUpdate',
      event: { type: 'baseline', workspaces: [], archivedSessionIds: [] },
    };
    expect(parseHostEvent(frame)).toEqual({ ok: true, value: frame });
  });

  it('rejects undeclared keys, missing required keys, and unknown tags', () => {
    expect(parseHostEvent({ type: 'sessionDisposed', sessionId: 's', extra: 1 }).ok).toBe(false);
    expect(parseHostEvent({ type: 'sessionDisposed' }).ok).toBe(false);
    expect(parseHostEvent({ type: 'workspaceUpdate' }).ok).toBe(false);
    expect(parseHostEvent({ type: 'warp' }).ok).toBe(false);
  });
});
