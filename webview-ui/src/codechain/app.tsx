// Code-chain panel root (§6.2 three-pane-lite: tour control header, tree
// column ~40%, detail column ~60%). The DOM-recursive row list follows the
// session-list precedent (`renderNodes` in components/session-list.tsx) —
// collapsed subtrees drop out of `flattenVisible`, indentation guides are
// per-level left borders, status is CSS classes. No graph library, no
// canvas; at ≤80 nodes that is the repo's own scaling envelope (§6.1).
//
// State discipline: the panel holds ONLY view state (selection, collapse,
// toast). Chain data arrives whole from the host via `{t:'chain'}`; tour
// movement and navigation are intents posted back — the panel never
// interprets LSP or store semantics itself.

import { useEffect, useMemo, useState } from 'react';

import type { ChainKind, CodeChain, ResolvedNode } from '../../../src/codechain/types';
import { cn } from '../sidebar/webview/lib/utils';
import { t } from '../shared/i18n';
import type { PanelBridge } from './bridge';
import { allNodeIds, flattenVisible, locationLabel } from './tree';

const KIND_DOT: Record<ChainKind, string> = {
  entry: 'bg-success',
  call: 'bg-blue',
  impl: 'bg-info',
  interface: 'bg-warning',
  config: 'bg-muted-foreground',
  data: 'bg-primary',
  note: 'border border-current bg-transparent',
};

const StatusBadge = ({ node }: { node: ResolvedNode }) => {
  const status = node.location.resolveStatus;
  if (status === 'ok') return null;
  if (status === 'ambiguous') {
    return <span className="text-warning shrink-0 text-[10px]">⚠ {t('cc_ambiguous')}</span>;
  }
  if (status === 'stale') {
    return <span className="text-warning shrink-0 text-[10px]">⚠ {t('cc_stale')}</span>;
  }
  return <span className="text-danger shrink-0 text-[10px]">✕ {t('cc_unresolved')}</span>;
};

const ProvenanceBadge = ({ node }: { node: ResolvedNode }) => {
  if (node.provenance === 'llm') return null;
  const label =
    node.provenance === 'callHierarchy'
      ? t('cc_provenance_call')
      : node.provenance === 'typeHierarchy'
        ? t('cc_provenance_type')
        : t('cc_provenance_refs');
  return (
    <span className="text-muted-foreground shrink-0 rounded border px-1 text-[9px]">{label}</span>
  );
};

const TreeRow = ({
  row,
  selected,
  synced,
  onSelect,
  onToggle,
}: {
  row: ReturnType<typeof flattenVisible>[number];
  selected: boolean;
  synced: boolean;
  onSelect: (id: string, focus: boolean) => void;
  onToggle: (id: string) => void;
}) => {
  const { node, depth, hasChildren, collapsed } = row;
  return (
    <div
      className={cn(
        'group hover:bg-muted flex cursor-pointer items-start gap-1.5 py-1 pr-2 text-left',
        selected && 'bg-muted',
        // Reverse-sync highlight is a ring, not a selection swap: the user
        // reading code moves the tree marker, not the detail pane (§6.3).
        synced && !selected && 'outline outline-1 -outline-offset-1 outline-info',
      )}
      // Indentation rail: session-list's language (padding by depth), plus
      // a 1px left border per level so the spine stays visible on hover.
      style={{ paddingLeft: 10 + depth * 14 }}
      onClick={() => onSelect(node.id, false)}
      onDoubleClick={() => onSelect(node.id, true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(node.id, false);
        }
      }}
      role="button"
      tabIndex={0}
    >
      {hasChildren ? (
        <button
          aria-label={collapsed ? 'expand' : 'collapse'}
          className="text-muted-foreground hover:text-foreground -ml-0.5 mt-0.5 cursor-pointer rounded p-0.5 transition-transform"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.id);
          }}
          type="button"
        >
          <span className={cn('inline-block text-[9px] transition-transform', !collapsed && 'rotate-90')}>
            ▶
          </span>
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', KIND_DOT[node.kind])} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn('truncate text-[13px] font-medium', node.location.resolveStatus === 'unresolved' && 'text-muted-foreground line-through')}>
            {node.label}
          </span>
          <StatusBadge node={node} />
          <ProvenanceBadge node={node} />
          {node.kind === 'interface' && (node.location.candidates?.length ?? 0) > 0 && (
            <span className="text-muted-foreground shrink-0 rounded-full border px-1.5 text-[9px]">
              {t('cc_implementations', node.location.candidates?.length ?? 0)}
            </span>
          )}
        </span>
        {node.summary && (
          <span className="text-muted-foreground block truncate text-[11px]">{node.summary}</span>
        )}
      </span>
    </div>
  );
};

const DetailPane = ({
  chain,
  node,
  onOpen,
  onPickCandidate,
  onFindRefs,
  onRegen,
}: {
  chain: CodeChain;
  node: ResolvedNode | null;
  onOpen: (id: string) => void;
  onPickCandidate: (id: string, index: number) => void;
  onFindRefs: (id: string) => void;
  onRegen: (question: string) => void;
}) => {
  if (!node) {
    return <div className="text-muted-foreground flex-1 p-4 text-sm">{t('cc_empty')}</div>;
  }
  const fileLine = locationLabel(node);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="font-code min-w-0 flex-1 truncate text-xs text-muted-foreground">{fileLine}</span>
        <button
          className="hover:bg-accent shrink-0 cursor-pointer rounded border px-2 py-0.5 text-[11px]"
          onClick={() => onOpen(node.id)}
          type="button"
        >
          {t('cc_open_editor')}
        </button>
        {node.location.resolveStatus === 'ok' && node.location.uri !== '' && (
          <>
            <button
              className="hover:bg-accent shrink-0 cursor-pointer rounded border px-2 py-0.5 text-[11px]"
              onClick={() => onFindRefs(node.id)}
              type="button"
            >
              {t('cc_find_refs')}
            </button>
            <button
              className="hover:bg-accent shrink-0 cursor-pointer rounded border px-2 py-0.5 text-[11px]"
              onClick={() => void navigator.clipboard?.writeText(node.location.symbolPath?.join('.') ?? node.label)}
              type="button"
            >
              {t('cc_copy_path')}
            </button>
          </>
        )}
        <button
          className="text-info hover:bg-accent ml-auto shrink-0 cursor-pointer rounded border px-2 py-0.5 text-[11px]"
          onClick={() => onRegen(chain.question)}
          title={t('cc_regen')}
          type="button"
        >
          {t('cc_regenerate')}
        </button>
      </div>
      <div className="px-4 py-3">
        {node.edgeNote && (
          <div className="text-muted-foreground mb-2 border-l-2 border-info/40 pl-2 text-xs">
            {t('cc_edge')} · {node.edgeNote}
          </div>
        )}
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{node.summary}</p>
        {node.location.resolveStatus === 'ambiguous' && (node.location.candidates?.length ?? 0) > 0 && (
          <div className="mt-3">
            <div className="text-warning mb-1 text-xs font-medium">{t('cc_candidates')}</div>
            {(node.location.candidates ?? []).map((candidate, index) => (
              <button
                className="hover:bg-muted block w-full cursor-pointer rounded border border-border px-2 py-1 text-left font-code text-xs"
                key={`${candidate.uri}:${candidate.range.startLine}`}
                onClick={() => onPickCandidate(node.id, index)}
                type="button"
              >
                {locationLabel({
                  ...node,
                  location: { uri: candidate.uri, range: candidate.range, resolveStatus: 'ok' },
                })}
                {candidate.label ? ` · ${candidate.label}` : ''}
              </button>
            ))}
          </div>
        )}
        {node.location.resolveStatus === 'unresolved' && (
          <p className="text-danger mt-2 text-xs">
            {t('cc_unresolved')} — {chain.question ? t('cc_regen') : t('cc_refresh')}
          </p>
        )}
      </div>
    </div>
  );
};

export const CodeChainApp = ({ bridge }: { bridge: PanelBridge }) => {
  const [chain, setChain] = useState<CodeChain | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [synced, setSynced] = useState<string | null>(null);
  const [tour, setTour] = useState({ index: -1, total: 0 });
  const [toast, setToast] = useState<string | null>(null);

  useEffect(
    () =>
      bridge.onMessage((message) => {
        switch (message.t) {
          case 'chain': {
            setChain(message.chain);
            // Selection follows the fresh chain's root; collapse is reset —
            // a re-render after refresh/expand must not fight the user's
            // tree state of an older revision.
            setSelected(message.chain.root.id);
            setCollapsed(new Set());
            setToast(null);
            return;
          }
          case 'sync':
            setSynced(message.nodeId);
            return;
          case 'tourState':
            setTour({ index: message.index, total: message.total });
            return;
          case 'toast':
            setToast(message.message);
            return;
        }
      }),
    [bridge],
  );

  useEffect(() => {
    if (toast === null) return undefined;
    const timer = setTimeout(() => setToast(null), 4_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const rows = useMemo(() => (chain ? flattenVisible(chain.root, collapsed) : []), [chain, collapsed]);
  const selectedNode = useMemo(() => {
    if (!chain) return null;
    const hit = rows.find((row) => row.node.id === selected);
    return hit ? hit.node : (rows[0]?.node ?? null);
  }, [chain, rows, selected]);

  const post = (message: Parameters<PanelBridge['post']>[0]): void => bridge.post(message);

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const select = (id: string, focus: boolean): void => {
    setSelected(id);
    post({ t: 'nodeClick', nodeId: id, focus });
  };

  const expandAll = (): void => {
    setCollapsed((prev) => {
      if (!chain) return prev;
      return prev.size > 0 ? new Set() : new Set(allNodeIds(chain.root));
    });
  };

  if (!chain) {
    return <div className="text-muted-foreground flex h-full items-center justify-center text-sm">{t('cc_empty')}</div>;
  }

  return (
    <div className="bg-background text-foreground flex h-screen flex-col">
      {/* Header: identity + tour controls (§6.2 top bar). */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-info">⛓</span>
        <span className="min-w-0 truncate text-sm font-semibold">{chain.title}</span>
        <span className="text-muted-foreground shrink-0 text-xs">
          {t('cc_nodes_stats', chain.stats.nodeCount, chain.stats.unresolvedCount)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="hover:bg-accent cursor-pointer rounded border px-2 py-0.5 text-xs disabled:opacity-40"
            disabled={tour.total === 0 || tour.index <= 0}
            onClick={() => post({ t: 'tour', dir: 'prev' })}
            title={t('cc_prev')}
            type="button"
          >
            ◀ {t('cc_prev')}
          </button>
          <button
            className="hover:bg-accent cursor-pointer rounded border px-2 py-0.5 text-xs disabled:opacity-40"
            disabled={tour.total === 0 || (tour.index >= 0 && tour.index >= tour.total - 1)}
            onClick={() => post({ t: 'tour', dir: 'next' })}
            title={t('cc_next')}
            type="button"
          >
            {t('cc_next')} ▶
          </button>
          <button
            className="hover:bg-accent ml-2 cursor-pointer rounded border px-2 py-0.5 text-xs"
            onClick={() => post({ t: 'refresh' })}
            title={t('cc_refresh')}
            type="button"
          >
            ⟳
          </button>
          <button
            className="hover:bg-accent cursor-pointer rounded border px-2 py-0.5 text-xs"
            onClick={expandAll}
            title={t('cc_expand_all')}
            type="button"
          >
            ⤢
          </button>
        </div>
      </div>
      {tour.total > 0 && tour.index >= 0 && (
        <div className="text-muted-foreground shrink-0 px-3 py-0.5 text-[10px]">
          {tour.index + 1}/{tour.total}
        </div>
      )}
      {toast && (
        <div className="text-warning shrink-0 border-b border-border px-3 py-1 text-xs">{toast}</div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Tree column: flattened visible rows (collapse = drop, so the
         * 200-node virtualization threshold needs no restructure). */}
        <div className="min-h-0 w-2/5 overflow-y-auto border-r border-border py-1">
          {rows.map((row) => (
            <TreeRow
              key={row.node.id}
              onSelect={select}
              onToggle={toggle}
              row={row}
              selected={row.node.id === selected}
              synced={row.node.id === synced}
            />
          ))}
        </div>
        <DetailPane
          chain={chain}
          node={selectedNode}
          onFindRefs={(id) => post({ t: 'findRefs', nodeId: id })}
          onOpen={(id) => select(id, true)}
          onPickCandidate={(id, index) => post({ t: 'pickCandidate', nodeId: id, index })}
          onRegen={(question) => post({ t: 'regen', question })}
        />
      </div>
    </div>
  );
};
