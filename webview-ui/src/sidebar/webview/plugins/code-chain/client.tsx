// code-chain — the §7 session-header affordance. A `conversation.session.
// header.utilities` chip that lists the code chains generated in the open
// conversation; each row reopens the editor-area panel through the api
// client's `openCodeChain` seam (the chain data lives host-side, so the
// chip only carries identity + opens).
//
// Same discipline as the conversation-info sample plugin (§H): contributes
// through `inject` + `register`, reads shared state ONLY through the
// standard store hook (`useCodeChainCards`), never imports the header it
// appears in, and never touches store internals or dispatches a frame.
//
// The chip hides while the session has no chain: an empty "Code chains"
// button is noise; the `/codechain` command (provisioned server-side) is
// the entry point that makes rows appear.

import type { ReactNode } from 'react';

import { api } from '../../api/client';
import { t } from '../../lib/i18n';
import { useCodeChainCards } from '../../state/hooks';
import { inject, register } from '../../state/slots';
import '../../slots.registry';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';

/** Link-chain glyph, inline (lucide `Link` would collide with anchors). */
const ChainIcon = (): ReactNode => (
  <svg aria-hidden className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M9 15l6-6M10.5 6.5l1-1a3.5 3.5 0 015 5l-1 1M13.5 17.5l-1 1a3.5 3.5 0 01-5-5l1-1"
    />
  </svg>
);

const CodeChainEntry = ({ sessionId }: { sessionId: string }): ReactNode => {
  const chains = useCodeChainCards(sessionId);
  if (chains.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={t('cc_chip_aria')}
          className="text-muted-foreground hover:bg-accent flex cursor-pointer items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[11px] transition-colors"
          title={t('cc_chip')}
          type="button"
        >
          <ChainIcon />
          <span>{chains.length}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px]">
        <DropdownMenuLabel>{t('cc_chip')}</DropdownMenuLabel>
        {chains.map((chain) => (
          <DropdownMenuItem
            className="gap-2"
            key={chain.chainId}
            onSelect={() => api.openCodeChain(chain.chainId)}
          >
            <span className="min-w-0 flex-1 truncate">{chain.title}</span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {t('cc_card_nodes', chain.nodeCount)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// order 30: after turn-navigator (10) and conversation-info (20) in the
// same list cell, at a distinct id so no priority cell collides.
inject('conversation.session.header.utilities', () =>
  register(
    {
      name: 'conversation.session.header.utilities',
      id: 'code-chain',
      order: 30,
      priority: 0,
      registrant: 'code-chain',
    },
    CodeChainEntry,
  ),
);
