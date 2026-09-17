// Code Tutor view root. Two layouts over the same data:
//   * `tree`  — the §6.2 three-pane-lite (a dense single-line tree column +
//               a detail pane), the right shape for a wide dock;
//   * `focus` — a single-card reader (the current tour stop), the right shape
//               for a narrow / split-screen dock or a quick guided read.
// Which one boots is decided by the container width (< FOCUS_BREAKPOINT →
// focus); a manual toggle wins forever after (persisted to localStorage, so a
// re-layout never overrides the user's choice).
//
// The DOM-recursive row list follows the session-list precedent
// (`renderNodes` in components/session-list.tsx) — collapsed subtrees drop
// out of `flattenVisible`, indentation guides are per-level left borders,
// status is CSS classes. No graph library, no canvas; at ≤48 nodes that is the
// repo's own scaling envelope (§6.1).
//
// State discipline: the view holds ONLY view state (layout mode, selection,
// collapse, toast, drawer opens). Chain data arrives whole from the host via
// `{t:'chain'}`; tour movement and navigation are intents posted back — the
// view never interprets LSP or store semantics itself.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChainKind, CodeChain, ReferenceHit, ResolvedNode } from '../../../src/codechain/types';
import { tourOrder } from '../../../src/codechain/tour';
import { cn } from '../sidebar/webview/lib/utils';
import { t } from '../shared/i18n';
import { MarkdownContent } from '../shared/markdown-content';
import type { PanelBridge } from './bridge';
import { allNodeIds, flattenVisible, locationLabel } from './tree';
import { useContainerWidth } from './use-container-width';

// Container width below which the view boots into the single-card focus
// layout. The view is draggable across VS Code's docks, so the panel
// arrangement (not the viewport) decides which reading shape fits.
const FOCUS_BREAKPOINT = 700;
const MODE_KEY = 'tutor.layoutMode';
type LayoutMode = 'focus' | 'tree';

const readMode = (): LayoutMode | null => {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'focus' || v === 'tree' ? v : null;
  } catch {
    return null;
  }
};
const writeMode = (mode: LayoutMode): void => {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* webview storage may be unavailable; a non-persisted choice is still fine */
  }
};

// Node-presence set for a chain (used to keep selection/collapse across a
// same-chain re-push, review #6).
const collectIds = (root: ResolvedNode): Set<string> => new Set(allNodeIds(root));

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

/** Just the file (plus line) of a reference row: the host owns path
 * semantics, so the webview only ever prints what it was handed. */
const refLocationLabel = (hit: ReferenceHit): string => {
  const file = hit.uri.split(/[\\/]/).pop() ?? hit.uri;
  return `${file}:${hit.range.startLine + 1}`;
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
        'group hover:bg-muted flex cursor-pointer items-start gap-1.5 py-0.5 pr-2 text-left',
        selected && 'bg-muted',
        // Reverse-sync highlight is a ring, not a selection swap: the user
        // reading code moves the tree marker, not the detail pane (§6.3).
        synced && !selected && 'outline outline-1 -outline-offset-1 outline-info',
      )}
      // Density: the ~120-char summary no longer lives on its own line — it
      // rides the native hover tooltip so the row stays single-line (≈2× the
      // previous vertical density).
      title={node.summary}
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
      <span className={cn('mt-1 size-2 shrink-0 rounded-full', KIND_DOT[node.kind])} />
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
        {/* The story-beat is the one line of context worth expanding for the
         * node the user is actually on; every other row stays a single line. */}
        {selected && node.beat && (
          <span className="text-muted-foreground block truncate text-[10px]">◆ {node.beat}</span>
        )}
      </span>
    </div>
  );
};

/** Collapsible chain-narrative strip: one row ("📖 业务叙事 · N 字 ▸") so the
 * story never pushes the tree/detail off a small screen; the markdown renders
 * only when the user opens it. Expand state is local component state (not
 * persisted) — re-mounting collapses it again by design. */
const NarrativeBar = ({ narrative }: { narrative: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 border-b border-border pb-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('cc_narrative')}
        className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-1 text-left text-[11px]"
      >
        <span className="shrink-0">{t('cc_narrative_toggle', narrative.length)}</span>
        <span className={cn('inline-block shrink-0 transition-transform', open && 'rotate-90')}>▸</span>
      </button>
      {open && (
        <MarkdownContent content={narrative} className="text-foreground/90 mt-2 text-[13px]" />
      )}
    </div>
  );
};

/** Host-sourced state of one node's references drawer. `loading` is the
 * truth between opening the drawer and the host's `{t:'references'}` answer —
 * the query runs host-side (the webview cannot reach an LSP), so "no
 * references" is never guessed from a missing list. */
interface RefsState {
  hits: ReferenceHit[];
}

/** The node's "Find References" drawer, rendered UNDER the explanation: the
 * reading order is "what this step does" → "where else it shows up". It
 * replaces the old action-bar button and, unlike it, lists the references
 * inline instead of handing the user off to another view. Collapsed by
 * default; every open refetches, because references are live code facts that
 * go stale the moment the user edits (`toggleRefs`). */
const ReferencesDrawer = ({
  refs,
  open,
  onToggle,
  onOpenHit,
}: {
  refs: RefsState | null;
  open: boolean;
  onToggle: () => void;
  onOpenHit: (hit: ReferenceHit) => void;
}) => {
  // `null` = the host has not answered for this node yet.
  const summary =
    refs === null
      ? t('cc_refs_loading')
      : refs.hits.length === 0
        ? t('cc_refs_none')
        : t('cc_refs_count', refs.hits.length);
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-1 text-left text-[11px]"
      >
        <span className={cn('inline-block shrink-0 transition-transform', open && 'rotate-90')}>▸</span>
        <span className="shrink-0">{t('cc_find_refs')}</span>
        <span className="shrink-0 opacity-70">· {summary}</span>
      </button>
      {open && refs !== null && refs.hits.length > 0 && (
        <div className="mt-1">
          {groupByFile(refs.hits).map(([uri, hits]) => (
            <div className="mb-1" key={uri}>
              <div className="text-muted-foreground truncate font-code text-[10px]">
                {uri.split(/[\\/]/).pop() ?? uri}
              </div>
              {hits.map((hit) => (
                <button
                  type="button"
                  key={`${hit.uri}:${hit.range.startLine}:${hit.range.startCharacter}`}
                  onClick={() => onOpenHit(hit)}
                  title={refLocationLabel(hit)}
                  className="hover:bg-muted block w-full cursor-pointer truncate px-1 py-0.5 text-left font-code text-[11px]"
                >
                  <span className="text-muted-foreground mr-1.5 shrink-0 text-[10px]">
                    {hit.range.startLine + 1}
                  </span>
                  {hit.preview || refLocationLabel(hit)}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** References in the provider's order, folded per file (the drawer's one
 * level of grouping). */
const groupByFile = (hits: ReferenceHit[]): [string, ReferenceHit[]][] => {
  const groups = new Map<string, ReferenceHit[]>();
  for (const hit of hits) {
    const bucket = groups.get(hit.uri);
    if (bucket) bucket.push(hit);
    else groups.set(hit.uri, [hit]);
  }
  return [...groups.entries()];
};

/** The per-node detail body shared by the tree detail pane and the focus
 * card (§B.2 "复用 DetailPane 渲染"): edgeNote + summary (markdown) + the
 * ambiguity candidate picker + the unresolved hint + the references drawer.
 * `showBeat` toggles the beat line so the focus card can render it
 * prominently at the top instead.
 *
 * There is deliberately no action bar: clicking a node IS the open-in-editor
 * gesture (single click jumps with `preserveFocus`, double click focuses),
 * and the references drawer replaces the old button. */
const NodeDetailBody = ({
  node,
  showBeat,
  refs,
  refsOpen,
  onToggleRefs,
  onOpenRef,
  onPickCandidate,
}: {
  node: ResolvedNode;
  showBeat: boolean;
  refs: RefsState | null;
  refsOpen: boolean;
  onToggleRefs: () => void;
  onOpenRef: (hit: ReferenceHit) => void;
  onPickCandidate: (id: string, index: number) => void;
}) => (
  <>
    {showBeat && node.beat && <div className="text-muted-foreground mb-1 truncate text-xs">◆ {node.beat}</div>}
    {node.edgeNote && (
      <div className="text-muted-foreground mb-2 border-l-2 border-info/40 pl-2 text-xs">
        {t('cc_edge')} · {node.edgeNote}
      </div>
    )}
    {/* narrative / summary are model-authored markdown; sanitization is handled
     * by MarkdownContent (react-markdown + rehype-sanitize, the shared
     * precedent of the transcript components). Progressive Extend makes
     * summaries markdown routinely, so the graph stays in the bundle. */}
    <MarkdownContent content={node.summary} className="text-sm leading-relaxed" />
    {/* References ride directly under the explanation: the reading order the
     * user asked for (what this step is → where else it shows up). Only a
     * node with a resolved position has references to look up. */}
    {node.location.resolveStatus !== 'unresolved' && node.location.uri !== '' && (
      <ReferencesDrawer refs={refs} open={refsOpen} onOpenHit={onOpenRef} onToggle={onToggleRefs} />
    )}
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
        {t('cc_unresolved')} — {t('cc_refresh')}
      </p>
    )}
  </>
);

const DetailPane = ({
  chain,
  node,
  refs,
  refsOpen,
  onToggleRefs,
  onOpenRef,
  onPickCandidate,
}: {
  chain: CodeChain;
  node: ResolvedNode | null;
  refs: RefsState | null;
  refsOpen: boolean;
  onToggleRefs: () => void;
  onOpenRef: (hit: ReferenceHit) => void;
  onPickCandidate: (id: string, index: number) => void;
}) => {
  if (!node) {
    return <div className="text-muted-foreground flex-1 p-4 text-sm">{t('cc_empty')}</div>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="text-muted-foreground border-b border-border px-4 py-1.5 font-code text-xs">
        <span className="block truncate">{locationLabel(node)}</span>
      </div>
      <div className="px-4 py-3">
        {chain.narrative && <NarrativeBar narrative={chain.narrative} />}
        <NodeDetailBody
          node={node}
          onOpenRef={onOpenRef}
          onPickCandidate={onPickCandidate}
          onToggleRefs={onToggleRefs}
          refs={refs}
          refsOpen={refsOpen}
          showBeat
        />
      </div>
    </div>
  );
};

// ── Focus layout ────────────────────────────────────────────────────────────

/** A full-screen overlay drawer: backdrop click or Esc closes it; the caller
 * supplies the panel content. Used for the tree "directory" and the narrative
 * reader so the focus card itself stays a single readable column. */
const Overlay = ({ onClose, children }: { onClose: () => void; children: React.ReactNode }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="bg-background/40 fixed inset-0 z-40"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="border-border bg-background absolute inset-y-0 left-0 flex w-[min(18rem,85%)] flex-col border-r shadow-lg"
        // Clicks inside the panel must not bubble to the backdrop handler.
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};

const FocusCard = ({
  chain,
  node,
  tour,
  refs,
  refsOpen,
  onToggleRefs,
  onOpenRef,
  onPrev,
  onNext,
  onOpenToc,
  onToggleMode,
  onPickCandidate,
}: {
  chain: CodeChain;
  node: ResolvedNode | null;
  tour: { index: number; total: number };
  refs: RefsState | null;
  refsOpen: boolean;
  onToggleRefs: () => void;
  onOpenRef: (hit: ReferenceHit) => void;
  onPrev: () => void;
  onNext: () => void;
  onOpenToc: () => void;
  onToggleMode: () => void;
  onPickCandidate: (id: string, index: number) => void;
}) => {
  const [narrativeOpen, setNarrativeOpen] = useState(false);
  if (!node) {
    return <div className="text-muted-foreground flex flex-1 items-center justify-center p-4 text-sm">{t('cc_empty')}</div>;
  }
  // Mirror the header tree-mode enable/disable rules exactly so the two
  // layouts never offer different moves at the same stop.
  const atStart = tour.total === 0 || tour.index <= 0;
  const atEnd = tour.total === 0 || (tour.index >= 0 && tour.index >= tour.total - 1);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <span className={cn('size-2.5 shrink-0 rounded-full', KIND_DOT[node.kind])} />
          <span className={cn('min-w-0 flex-1 truncate text-base font-semibold', node.location.resolveStatus === 'unresolved' && 'text-muted-foreground line-through')}>
            {node.label}
          </span>
        </div>
        {/* The location is a label, not an action: clicking the tour stop IS
            the open-in-editor gesture. */}
        <div className="text-muted-foreground truncate font-code text-xs">{locationLabel(node)}</div>
        {/* The beat is the headline of the single-card reader. */}
        {node.beat && (
          <div className="text-info border-info/30 border-l-2 pl-2 text-sm font-medium">◆ {node.beat}</div>
        )}
        <NodeDetailBody
          node={node}
          onOpenRef={onOpenRef}
          onPickCandidate={onPickCandidate}
          onToggleRefs={onToggleRefs}
          refs={refs}
          refsOpen={refsOpen}
          showBeat={false}
        />
        {chain.narrative && (
          <button
            type="button"
            onClick={() => setNarrativeOpen(true)}
            className="text-muted-foreground hover:text-foreground self-start cursor-pointer text-[11px]"
          >
            {t('cc_narrative_toggle', chain.narrative.length)} ▸
          </button>
        )}
        {/* Tour control footer. */}
        <div className="border-border flex items-center gap-2 border-t pt-3">
          <button
            className="hover:bg-accent cursor-pointer rounded border px-2 py-1 text-xs disabled:opacity-40"
            disabled={atStart}
            onClick={onPrev}
            title={t('cc_prev')}
            type="button"
          >
            ◀
          </button>
          <button
            className="hover:bg-accent cursor-pointer rounded border px-2 py-1 text-xs disabled:opacity-40"
            disabled={atEnd}
            onClick={onNext}
            title={t('cc_next')}
            type="button"
          >
            ▶
          </button>
          <span className="text-muted-foreground text-xs">
            {tour.index >= 0 ? tour.index + 1 : 0}/{tour.total}
          </span>
          <button
            className="hover:bg-accent ml-auto cursor-pointer rounded border px-2 py-1 text-xs"
            onClick={onOpenToc}
            title={t('cc_toc')}
            type="button"
          >
            ☰
          </button>
          <button
            className="hover:bg-accent cursor-pointer rounded border px-2 py-1 text-xs"
            onClick={onToggleMode}
            title={t('cc_toggle_layout')}
            type="button"
          >
            ⇄
          </button>
        </div>
      </div>
      {narrativeOpen && chain.narrative && (
        <Overlay onClose={() => setNarrativeOpen(false)}>
          <div className="border-border flex items-center gap-2 border-b px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t('cc_narrative')}</span>
            <button className="hover:bg-accent cursor-pointer rounded border px-2 py-0.5 text-xs" onClick={() => setNarrativeOpen(false)} type="button">
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <MarkdownContent content={chain.narrative} className="text-foreground/90 text-[13px]" />
          </div>
        </Overlay>
      )}
    </div>
  );
};

export const CodeChainApp = ({ bridge }: { bridge: PanelBridge }) => {
  const [chain, setChain] = useState<CodeChain | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Last-applied chainId: distinguishes a fresh generation (reset view
  // state) from a same-chain re-push (preserve it) — review #6.
  const chainIdRef = useRef<string | null>(null);
  const [synced, setSynced] = useState<string | null>(null);
  const [tour, setTour] = useState({ index: -1, total: 0 });
  const [toast, setToast] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  // References drawer: which node's drawer is open, and the host's answer for
  // that node. Keyed by node id rather than "current node" so a late answer
  // can never surface under a different stop, and so the drawer starts fresh
  // (collapsed + loading) the moment the user moves on.
  const [refsFor, setRefsFor] = useState<{ nodeId: string; open: boolean } | null>(null);
  const [refs, setRefs] = useState<Record<string, RefsState>>({});

  // Layout mode: a manual toggle persists. A narrow dock (below the focus
  // breakpoint) always forces the focus card so a split screen never sees two
  // columns squeezed into it; widening relaxes back to the tree UNLESS the
  // user explicitly chose 'tree' (that override then survives a widen step,
  // while a forced 'focus' yields to a widen — you can always widen to read
  // the directory).
  const { ref: containerRef, width } = useContainerWidth<HTMLDivElement>();
  const manualTree = useMemo(() => readMode() === 'tree', []);
  const [mode, setMode] = useState<LayoutMode>(() => {
    if (width > 0 && width < FOCUS_BREAKPOINT) return 'focus';
    return readMode() ?? 'tree';
  });
  useEffect(() => {
    if (width <= 0) return; // unmeasured (jsdom) → leave the initial layout
    setMode((prev) => {
      if (width < FOCUS_BREAKPOINT) return 'focus';
      if (prev === 'focus' && !manualTree) return 'tree';
      return prev;
    });
  }, [width, manualTree]);

  const toggleMode = useCallback((): void => {
    setMode((prev) => {
      const next: LayoutMode = prev === 'focus' ? 'tree' : 'focus';
      writeMode(next);
      return next;
    });
  }, []);

  // Mount handshake (review #1): the webview context can still be discarded
  // across a window reload even with `retainContextWhenHidden`. Announce
  // readiness once so the host re-sends the current chain snapshot —
  // otherwise a re-shown view sits in the empty state forever.
  useEffect(() => {
    bridge.post({ t: 'ready' });
  }, [bridge]);

  useEffect(
    () =>
      bridge.onMessage((message) => {
        switch (message.t) {
          case 'chain': {
            const next = message.chain;
            // Same-chain re-pushes (candidate-pick, Expand, Annotate, and
            // the post-`ready` resnapshot) must NOT kick the user back to
            // the root or blow away their collapse state — the host sends
            // the whole tree every time (§6.4 patch channel was cut), so
            // state preservation lives here (review #6). Only a genuinely
            // new chainId resets view state.
            const isNewGeneration = next.chainId !== chainIdRef.current;
            chainIdRef.current = next.chainId;
            setChain(next);
            setToast(null);
            if (isNewGeneration) {
              setSelected(next.root.id);
              setCollapsed(new Set());
            } else {
              // Keep the current selection only while the node still
              // exists; prune collapse entries for removed nodes.
              const present = collectIds(next.root);
              setSelected((prev) => (prev && present.has(prev) ? prev : next.root.id));
              setCollapsed((prev) => {
                const kept = new Set([...prev].filter((id) => present.has(id)));
                return kept.size === prev.size ? prev : kept;
              });
            }
            return;
          }
          case 'sync':
            setSynced(message.nodeId);
            return;
          case 'tourState':
            setTour({ index: message.index, total: message.total });
            return;
          case 'references':
            // The host always answers (empty on an absent provider), so an
            // entry here means "queried". Keyed by node: the drawer renders
            // whatever it has for the node it is showing, never a neighbour's
            // answer.
            setRefs((prev) => ({ ...prev, [message.nodeId]: { hits: message.hits } }));
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

  // The focus card walks the SAME DFS-navigable tour order the host computes
  // (`tourOrder`), so `{t:'tourState'}`'s `index` is a valid cursor here too —
  // no host protocol change (plan: zero semantic change).
  const tourNodes = useMemo(() => (chain ? tourOrder(chain) : []), [chain]);
  const focusNode = tourNodes[tour.index] ?? tourNodes[0] ?? null;

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

  /** Open/close the references drawer for `nodeId`. Every OPEN refetches from
   * the host (the query is an LSP round-trip the webview cannot make, and a
   * cached list would silently describe code the user has since changed);
   * closing keeps the last answer in state, so a re-open shows it instantly
   * while the refetch is in flight. */
  const toggleRefs = (nodeId: string): void => {
    const wasOpen = refsFor?.nodeId === nodeId && refsFor.open;
    setRefsFor({ nodeId, open: !wasOpen });
    // Closing keeps the last answer (a re-open shows it instantly); opening
    // clears it so the drawer can never present a previous query's rows as
    // this one's answer while the host is still working.
    if (wasOpen) return;
    setRefs((prev) => {
      if (!(nodeId in prev)) return prev;
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
    post({ t: 'findRefs', nodeId });
  };

  /** A reference row opens that exact location. The host runs the jump (it
   * owns uri parsing, column choice and decoration), and `focus:false` keeps
   * the panel where it is — the same reveal discipline as a node click. */
  const openRef = (hit: ReferenceHit): void => {
    post({ t: 'openRef', uri: hit.uri, range: hit.range });
  };

  // `null` = not queried yet (the drawer reads that as "searching"): the
  // query lives host-side, so "no references" is never inferred from a
  // missing entry — the host always answers, even when it finds none.
  const refsForNode = (nodeId: string | null): RefsState | null =>
    (nodeId !== null ? refs[nodeId] : undefined) ?? null;
  const refsOpenFor = (nodeId: string | null): boolean =>
    nodeId !== null && refsFor?.nodeId === nodeId && refsFor.open;

  if (!chain) {
    return <div className="text-muted-foreground flex h-full items-center justify-center text-sm">{t('cc_empty')}</div>;
  }

  return (
    <div ref={containerRef} className="bg-background text-foreground flex h-full flex-col">
      {/* Header: identity + (tree-mode) tour controls (§6.2 top bar). */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-info">⛓</span>
        <span className="min-w-0 truncate text-sm font-semibold">{chain.title}</span>
        <span className="text-muted-foreground shrink-0 text-xs">
          {t('cc_nodes_stats', chain.stats.nodeCount, chain.stats.unresolvedCount)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {mode === 'tree' && (
            <>
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
            </>
          )}
          <button
            className="hover:bg-accent cursor-pointer rounded border px-2 py-0.5 text-xs"
            onClick={toggleMode}
            title={t('cc_toggle_layout')}
            type="button"
          >
            ⇄
          </button>
        </div>
      </div>
      {mode === 'tree' && tour.total > 0 && tour.index >= 0 && (
        <div className="text-muted-foreground shrink-0 px-3 py-0.5 text-[10px]">
          {tour.index + 1}/{tour.total}
        </div>
      )}
      {toast && (
        <div className="text-warning shrink-0 border-b border-border px-3 py-1 text-xs">{toast}</div>
      )}
      {mode === 'tree' ? (
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
            onOpenRef={openRef}
            onPickCandidate={(id, index) => post({ t: 'pickCandidate', nodeId: id, index })}
            onToggleRefs={() => selectedNode && toggleRefs(selectedNode.id)}
            refs={refsForNode(selectedNode?.id ?? null)}
            refsOpen={refsOpenFor(selectedNode?.id ?? null)}
          />
        </div>
      ) : (
        <FocusCard
          chain={chain}
          node={focusNode}
          tour={tour}
          onNext={() => post({ t: 'tour', dir: 'next' })}
          onOpenRef={openRef}
          onOpenToc={() => setTocOpen(true)}
          onPickCandidate={(id, index) => post({ t: 'pickCandidate', nodeId: id, index })}
          onPrev={() => post({ t: 'tour', dir: 'prev' })}
          onToggleMode={toggleMode}
          onToggleRefs={() => focusNode && toggleRefs(focusNode.id)}
          refs={refsForNode(focusNode?.id ?? null)}
          refsOpen={refsOpenFor(focusNode?.id ?? null)}
        />
      )}
      {tocOpen && (
        <Overlay onClose={() => setTocOpen(false)}>
          <div className="border-border flex items-center gap-2 border-b px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{chain.title}</span>
            <button className="hover:bg-accent cursor-pointer rounded border px-2 py-0.5 text-xs" onClick={() => setTocOpen(false)} type="button">
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {rows.map((row) => (
              <TreeRow
                key={row.node.id}
                onSelect={(id) => {
                  select(id, false);
                  setTocOpen(false);
                }}
                onToggle={toggle}
                row={row}
                selected={row.node.id === selected}
                synced={row.node.id === synced}
              />
            ))}
          </div>
        </Overlay>
      )}
    </div>
  );
};
