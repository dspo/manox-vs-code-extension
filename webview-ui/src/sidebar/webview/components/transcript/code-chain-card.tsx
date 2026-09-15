// The code-chain journal card (§7). A GenCodeChain run renders twice: the
// durable `toolCall`/`toolResult` pair folds into the ordinary ToolCallCard
// (history, searchable), and this card — pushed out-of-band by the host —
// sits in the same turn as the reopen affordance. It is deliberately NOT a
// fold product: the chain itself is host state (workspaceState), so the card
// carries identity only (chainId/title/nodeCount) and posts the reopen ask.

import { Link2 } from 'lucide-react';

import { api } from '../../api/client';
import { t } from '../../lib/i18n';
import type { TranscriptItem } from '../../state/store';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

export type CodeChainCardProps = {
  item: Extract<TranscriptItem, { kind: 'code_chain' }>;
};

export const CodeChainCard = ({ item }: CodeChainCardProps) => (
  <Card className="my-2">
    <CardHeader>
      <CardTitle className="flex items-center gap-1.5 text-sm">
        <Link2 className="text-info size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{item.title}</span>
      </CardTitle>
    </CardHeader>
    <CardContent className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{t('cc_card_nodes', item.nodeCount)}</span>
      <button
        className="text-primary ml-auto shrink-0 cursor-pointer rounded border px-2 py-0.5 transition-colors hover:bg-accent"
        onClick={() => api.openCodeChain(item.chainId)}
        type="button"
      >
        {t('cc_card_open')}
      </button>
    </CardContent>
  </Card>
);
