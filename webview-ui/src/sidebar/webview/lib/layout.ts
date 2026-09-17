// Breakpoint layout for the conversation view: the session list joins the
// conversation column as the container widens.
//
// There is NO info-card breakpoint any more. The conversation-info card is an
// overlay opened from the header chip (`plugins/conversation-info`), so it no
// longer claims a column the transcript had to clear — see the note in
// `components/conversation-view.tsx`. The card's width below is only the
// overlay's own size, not a reservation.

/** The info overlay's own width (the panel the header chip opens). */
export const INFO_CARD_WIDTH_PX = 260;
export const CONVERSATION_MIN_PX = 480;
// Sash width the session list leaves beside the conversation column
// (SidebarSash's w-1).
export const SASH_PX = 4;

export const SESSION_LIST_BREAKPOINT_PX = 1120;

export type ChatLayout = 'conversation' | 'list-conversation';

export function chatLayoutForWidth(width: number): ChatLayout {
  if (width >= SESSION_LIST_BREAKPOINT_PX) return 'list-conversation';
  return 'conversation';
}

/** Widest the session list may grow while the message content keeps at
 * least CONVERSATION_MIN_PX beside the sash. The card's overlay floats over
 * the transcript and reserves nothing, so it is not part of this budget. */
export function maxSessionListWidth(width: number): number {
  return Math.max(0, width - CONVERSATION_MIN_PX - SASH_PX);
}
