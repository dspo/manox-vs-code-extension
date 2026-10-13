import { describe, expect, it } from 'vitest';

import {
  chatLayoutForWidth,
  CONVERSATION_MIN_PX,
  maxSessionListWidth,
  SASH_PX,
  SESSION_LIST_BREAKPOINT_PX,
} from './layout';

describe('chatLayoutForWidth', () => {
  it('conversation only below the session-list breakpoint', () => {
    expect(chatLayoutForWidth(0)).toBe('conversation');
    expect(chatLayoutForWidth(775)).toBe('conversation');
    expect(chatLayoutForWidth(1119)).toBe('conversation');
  });
  it('adds the session list at its breakpoint', () => {
    expect(chatLayoutForWidth(1120)).toBe('list-conversation');
    expect(chatLayoutForWidth(2000)).toBe('list-conversation');
  });
  it('has no info-card step (the card is an overlay, not a column)', () => {
    // Any width between the two old breakpoints must NOT produce a distinct
    // layout: the card reserves nothing, so there is nothing to make room
    // for. Regression guard for the removed INFO_CARD_GUTTER_PX reservation.
    const layouts = new Set([0, 400, 776, 1000, 1119].map(chatLayoutForWidth));
    expect([...layouts]).toEqual(['conversation']);
  });
  it('never lets the session list squeeze the message content below its minimum', () => {
    for (const width of [SESSION_LIST_BREAKPOINT_PX, 1600, 2000]) {
      const content = width - maxSessionListWidth(width) - SASH_PX;
      expect(content).toBeGreaterThanOrEqual(CONVERSATION_MIN_PX);
    }
    // The list cap reserves only the content floor and the sash; at the
    // breakpoint it tops out at 1120 - 480 - 4 = 636.
    expect(maxSessionListWidth(SESSION_LIST_BREAKPOINT_PX)).toBe(636);
  });
});
