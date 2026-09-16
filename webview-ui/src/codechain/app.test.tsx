// @vitest-environment jsdom
// Code Tutor view render (§11): the shared fixture chain drives the
// recording-bridge seam across BOTH layouts. Default layout is the tree (the
// mocked container width is 0 = unmeasured → wide → tree), so the §6.2
// three-pane-lite behavior — visible rows follow `flattenVisible`, a row click
// posts a `nodeClick`, collapse hides a subtree, the tour buttons post `tour`,
// the ⟳ posts `refresh`, and the single-line rows ride the summary on hover +
// the collapsed narrative strip — is asserted first. A mocked narrow container
// then flips the SAME fixture into the single-card focus layout (the current
// tour stop) and exercises the ◀ ▶ controls + the ☰ tree drawer.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodeChain } from '../../../src/codechain/types';
import fixtures from '../../../test-fixtures/codechain-cases.json';
import { CodeChainApp } from './app';
import { createRecordingBridge } from './bridge';

// Mock the container-width hook so a single test can pin the layout without a
// real ResizeObserver (absent under jsdom). `width` is read at hook-call time
// (inside render), so `widthBox.width = N` before a render takes effect; 0
// means "unmeasured → tree" for the default suite.
const widthBox = vi.hoisted(() => ({ width: 0 }));
vi.mock('./use-container-width', () => ({
  useContainerWidth: () => ({ ref: { current: null }, width: widthBox.width }),
}));

// This jsdom build exposes no `localStorage`, but the app persists the manual
// layout choice through it (guarded by try/catch). Install an in-memory shim so
// the persistence assertions are meaningful, and so `readMode/writeMode` hit a
// real object rather than the `try`-swallowed undefined.
const memStore = new Map<string, string>();
(globalThis as { localStorage: unknown }).localStorage = {
  getItem: (k: string): string | null => (memStore.has(k) ? (memStore.get(k) as string) : null),
  setItem: (k: string, v: string): void => {
    memStore.set(k, String(v));
  },
  removeItem: (k: string): void => {
    memStore.delete(k);
  },
  clear: (): void => {
    memStore.clear();
  },
};

const chain = fixtures.chain as unknown as CodeChain;

let root: Root | null = null;
const host = () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
};

function renderPanel() {
  const bridge = createRecordingBridge();
  root = createRoot(host());
  act(() => {
    root!.render(createElement(CodeChainApp, { bridge }));
  });
  act(() => {
    bridge.feed({ t: 'chain', chain });
  });
  return { bridge };
}

const text = (): string => document.body.textContent ?? '';
const queryButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').includes(label) || b.getAttribute('title') === label,
  );
const click = (el: Element | undefined): void => {
  if (!el) throw new Error('target button not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const rowByLabel = (label: string): Element | undefined =>
  Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
    (el.textContent ?? '').includes(label),
  );
/** The single-line rows no longer carry the summary as visible text (§C.2) —
 * it rides the native hover `title`, so tests locate a row by that instead. */
const rowBySummary = (summary: string): Element | undefined =>
  Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
    (el.getAttribute('title') ?? '').includes(summary),
  );

beforeEach(() => {
  document.body.innerHTML = '';
  widthBox.width = 0; // default: unmeasured → tree layout
  localStorage.clear();
  // Force the `zh` copy so the assertions below can match button labels
  // (the panel reads the host-injected `vscode-language` meta; jsdom has
  // none, defaulting to English).
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'vscode-language');
  meta.setAttribute('content', 'zh-cn');
  document.head.appendChild(meta);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('code-chain panel — tree layout', () => {
  it('renders the header title + stats and the DFS-visible rows', () => {
    renderPanel();
    expect(text()).toContain('订单创建流程');
    // Fixture stats: 7 nodes, 1 unresolved.
    expect(text()).toMatch(/7/);
    // Every non-collapsed node label is present.
    for (const label of ['createOrder', 'create', 'validateStock', 'emitOrderCreated', 'phantomHelper']) {
      expect(text()).toContain(label);
    }
  });

  it('a row click posts nodeClick with focus=false (panel keeps focus)', () => {
    const { bridge } = renderPanel();
    const row = rowByLabel('validateStock');
    act(() => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(bridge.sent).toContainEqual({ t: 'nodeClick', nodeId: 'stock.validate', focus: false });
  });

  it('double-click escalates to focus=true (jumps the editor)', () => {
    const { bridge } = renderPanel();
    const row = rowByLabel('emitOrderCreated');
    act(() => {
      row!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(bridge.sent).toContainEqual({ t: 'nodeClick', nodeId: 'event.emitted', focus: true });
  });

  it('collapsing a node drops its subtree from the DOM', () => {
    renderPanel();
    expect(text()).toContain('validateStock');
    // Collapse `service.create` (found by its hover-summary, since the row is
    // now single-line): its two children disappear.
    const collapseButton = (): HTMLButtonElement | undefined =>
      rowBySummary('校验库存与风控')?.querySelector('button') ?? undefined;
    act(() => {
      collapseButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(text()).not.toContain('validateStock');
    expect(text()).not.toContain('deductInventory');
    // Expand restores it (same row, button now reads "expand").
    act(() => {
      collapseButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(text()).toContain('validateStock');
  });

  it('tour controls post tour intents; refresh posts refresh', () => {
    const { bridge } = renderPanel();
    // Move the cursor to an interior stop so both step buttons enable.
    act(() => {
      bridge.feed({ t: 'tourState', index: 2, total: 5 });
    });
    click(queryButton('下一步'));
    click(queryButton('上一步'));
    click(queryButton('刷新位置'));
    expect(bridge.sent).toContainEqual({ t: 'tour', dir: 'next' });
    expect(bridge.sent).toContainEqual({ t: 'tour', dir: 'prev' });
    expect(bridge.sent).toContainEqual({ t: 'refresh' });
  });

  it('the tourState message drives the disabled state of the step buttons', () => {
    const { bridge } = renderPanel();
    // Before any tour state the buttons are disabled (index -1).
    expect(queryButton('上一步')!.disabled).toBe(true);
    act(() => {
      bridge.feed({ t: 'tourState', index: 0, total: 5 });
    });
    expect(queryButton('上一步')!.disabled).toBe(true); // at first stop
    expect(queryButton('下一步')!.disabled).toBe(false);
    act(() => {
      bridge.feed({ t: 'tourState', index: 4, total: 5 });
    });
    expect(queryButton('下一步')!.disabled).toBe(true); // at last stop
  });

  it('a `sync` note highlights the node the editor landed on (ring, not selection)', () => {
    const { bridge } = renderPanel();
    // Selecting is a separate affordance; sync only marks. No new
    // nodeClick posts fire from a sync.
    const sentBefore = bridge.sent.length;
    act(() => {
      bridge.feed({ t: 'sync', nodeId: 'stock.validate' });
    });
    expect(bridge.sent.length).toBe(sentBefore);
    const synced = rowByLabel('validateStock');
    // The sync node carries the outline ring but NOT the selection bg
    // (selection stays on the root): a keystroke in the editor must not
    // rewrite the detail pane (§6.3 reverse-sync semantics). Assert the
    // bg token at a class boundary — the row base also carries the
    // `hover:bg-muted` variant, which must not match.
    expect(synced!.className).toContain('outline');
    expect(synced!.className).not.toMatch(/(^|\s)bg-muted(\s|$)/);
  });

  it('posts `ready` on mount so a hidden-then-revealed panel resnapshots (review #1)', () => {
    // renderPanel() mounts the app; the first outbound message is the
    // handshake, ahead of any user interaction.
    const { bridge } = renderPanel();
    expect(bridge.sent[0]).toEqual({ t: 'ready' });
  });

  it('a same-chain re-push preserves selection + collapse (review #6)', () => {
    const { bridge } = renderPanel();
    // Collapse service.create (by hover-summary) and select createOrder (by
    // visible label).
    const collapse = rowBySummary('校验库存与风控')!.querySelector('button');
    act(() => collapse!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => {
      rowByLabel('createOrder')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const sentBefore = bridge.sent.length;
    // Host re-sends the WHOLE tree (Expand/Annotate/candidate-pick).
    act(() => {
      bridge.feed({ t: 'chain', chain });
    });
    // Selection (createOrder) must survive — no silent jump back to root,
    // and the collapsed subtree stays collapsed.
    expect(text()).not.toContain('validateStock');
    // No spurious nodeClick from re-applying the chain.
    expect(bridge.sent.length).toBe(sentBefore);
  });

  it('a NEW chainId resets view state (selection to root, no collapse)', () => {
    const { bridge } = renderPanel();
    const collapse = rowBySummary('校验库存与风控')!.querySelector('button');
    act(() => collapse!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const fresh = { ...chain, chainId: 'cc-other' };
    act(() => {
      bridge.feed({ t: 'chain', chain: fresh });
    });
    // New generation → collapsed subtree re-appears.
    expect(text()).toContain('validateStock');
  });

  // ── progressive narrative / beat rendering ──────────────────────────────

  it('the narrative rides a collapsed strip and expands on click', () => {
    renderPanel();
    // The one-line collapse bar is present (its label carries the story name).
    expect(text()).toContain('业务叙事');
    // The story body is hidden until the user opens it (§C.1 density).
    expect(text()).not.toContain('用户发起下单后');
    // react-markdown would split the bold span; assert the raw text only when
    // expanded, below.
    click(queryButton('业务叙事'));
    expect(text()).toContain('用户发起下单后');
    expect(text()).toContain('库存校验'); // bold span
    expect(text()).toContain('领域事件广播');
    expect(text()).toContain('事务回滚');
  });

  it('single-line rows hide the beat/summary until the row is selected', () => {
    const withBeat: CodeChain = {
      ...chain,
      root: {
        ...chain.root,
        beat: '用户发起下单',
        children: chain.root.children.map((c) => (c.id === 'service.create' ? { ...c, beat: '受理并校验' } : c)),
      },
    };
    const bridge = createRecordingBridge();
    root = createRoot(host());
    act(() => {
      root!.render(createElement(CodeChainApp, { bridge }));
    });
    act(() => {
      bridge.feed({ t: 'chain', chain: withBeat });
    });
    // The root is selected on a fresh chain, so its beat shows (row + detail)…
    expect(text()).toContain('用户发起下单');
    // …but an UNSELECTED row keeps only its label: service.create's beat is
    // not rendered as text (it is reachable via the row's hover title), and
    // its summary is likewise not a visible row line (§C.2 density).
    const serviceRow = rowBySummary('受理并校验') ?? rowBySummary('校验库存与风控');
    expect(serviceRow).toBeDefined();
    expect(serviceRow!.textContent ?? '').not.toContain('受理并校验');
    expect(serviceRow!.textContent ?? '').not.toContain('校验库存与风控');
    // Selecting it surfaces the beat inline (found by its hover-summary title,
    // since the row's visible text is only the label + the now-shown beat).
    act(() => {
      serviceRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(rowBySummary('校验库存与风控')!.textContent ?? '').toContain('受理并校验');
  });

  it('two feeds grow the tree (Extend-style same-chain update keeps view state)', () => {
    const { bridge } = renderPanel();
    // Collapse service.create (by hover-summary), then push an Extend-shaped
    // update that attaches a new grandchild under it + recomputed stats.
    const collapse = rowBySummary('校验库存与风控')!.querySelector('button');
    act(() => collapse!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const grown: CodeChain = {
      ...chain,
      stats: { nodeCount: chain.stats.nodeCount + 1, unresolvedCount: chain.stats.unresolvedCount },
      root: {
        ...chain.root,
        children: chain.root.children.map((c) =>
          c.id === 'service.create'
            ? {
                ...c,
                children: [
                  ...c.children,
                  {
                    id: 'stock.lock',
                    label: 'lockStock',
                    kind: 'impl' as const,
                    summary: '锁库存',
                    beat: '并发保护',
                    provenance: 'llm' as const,
                    location: { uri: '', resolveStatus: 'ok' as const },
                    children: [],
                  },
                ],
              }
            : c,
        ),
      },
    };
    act(() => {
      bridge.feed({ t: 'chain', chain: grown });
    });
    // Same chainId: the user's collapse survives (review #6 semantics),
    // so the new node is inside the collapsed subtree — hidden from the
    // visible rows, but the tree itself is one node bigger.
    expect(text()).not.toContain('lockStock');
    const service = grown.root.children.find((c) => c.id === 'service.create');
    expect(service?.children).toHaveLength(3);
  });

  it('legacy chains (no narrative / beat) render without the story block', () => {
    const legacy: CodeChain = { ...chain, narrative: undefined };
    const bridge = createRecordingBridge();
    root = createRoot(host());
    act(() => {
      root!.render(createElement(CodeChainApp, { bridge }));
    });
    act(() => {
      bridge.feed({ t: 'chain', chain: legacy });
    });
    // Rows still render (no crash on the missing fields)...
    expect(text()).toContain('createOrder');
    // ...but the narrative block is absent entirely.
    expect(text()).not.toContain('业务叙事');
  });
});

describe('code-chain panel — focus layout (narrow container)', () => {
  // Pin the container narrow so the view boots into the single-card reader.
  // The fixture's tour order (all navigable nodes, DFS preorder) puts the root
  // `handler.create` first, so with no `{t:'tourState'}` feed the card shows
  // the root — assertable by label.
  const narrowFixture: CodeChain = {
    ...chain,
    root: {
      ...chain.root,
      beat: '用户发起下单',
      children: [
        { ...chain.root.children[0]!, beat: '受理并校验' },
        ...chain.root.children.slice(1),
      ],
    },
  };

  function renderNarrow() {
    widthBox.width = 360; // < FOCUS_BREAKPOINT → focus
    const bridge = createRecordingBridge();
    root = createRoot(host());
    act(() => {
      root!.render(createElement(CodeChainApp, { bridge }));
    });
    act(() => {
      bridge.feed({ t: 'chain', chain: narrowFixture });
    });
    return { bridge };
  }

  it('renders a single card for the current tour stop (label + prominent beat)', () => {
    renderNarrow();
    // Card headline: the current node's label and its beat (the card shows
    // the beat prominently, independent of tree-row density).
    expect(text()).toContain('createOrder');
    expect(text()).toContain('用户发起下单');
    // The tree column affordances (⟳ refresh, ⤢ expand-all) are NOT in the
    // focus card footer.
    expect(queryButton('刷新位置')).toBeUndefined();
  });

  it('the card footer ◀ ▶ post tour intents and drive disabled state', () => {
    const { bridge } = renderNarrow();
    // An interior stop enables both step buttons.
    act(() => {
      bridge.feed({ t: 'tourState', index: 2, total: 5 });
    });
    click(queryButton('下一步'));
    click(queryButton('上一步'));
    expect(bridge.sent).toContainEqual({ t: 'tour', dir: 'next' });
    expect(bridge.sent).toContainEqual({ t: 'tour', dir: 'prev' });
    // At the last stop, next is disabled.
    act(() => {
      bridge.feed({ t: 'tourState', index: 4, total: 5 });
    });
    expect(queryButton('下一步')!.disabled).toBe(true);
  });

  it('the ☰ tree drawer opens over the card, picking a node posts nodeClick and closes it', () => {
    const { bridge } = renderNarrow();
    // The card alone shows one node; the whole tree is not a visible list yet
    // (validateStock is neither the card's node nor a rendered drawer row).
    expect(rowByLabel('validateStock')).toBeUndefined();
    // Open the drawer (☰, titled "目录").
    click(queryButton('目录'));
    // The full tree now renders inside the overlay drawer.
    expect(rowByLabel('validateStock')).toBeDefined();
    // Picking a node posts nodeClick and closes the drawer.
    act(() => {
      rowByLabel('validateStock')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(bridge.sent).toContainEqual({ t: 'nodeClick', nodeId: 'stock.validate', focus: false });
    // Drawer unmounted: the node list is gone again (back to the single card).
    expect(rowByLabel('validateStock')).toBeUndefined();
    expect(text()).toContain('createOrder');
  });

  it('the card opens the narrative as an overlay reader', () => {
    renderNarrow();
    // Story body hidden until the card's narrative entry is clicked.
    expect(text()).not.toContain('用户发起下单后');
    click(queryButton('业务叙事'));
    expect(text()).toContain('用户发起下单后');
  });

  it('the layout toggle persists the choice and swaps back to the tree', () => {
    renderNarrow();
    expect(localStorage.getItem('tutor.layoutMode')).toBeNull(); // width-driven, not persisted
    click(queryButton('⇄')); // the layout toggle (glyph '⇄'; its title is longer)
    expect(localStorage.getItem('tutor.layoutMode')).toBe('tree');
    // Tree affordances return once widened by hand.
    expect(queryButton('刷新位置')).toBeDefined();
  });

  it('a persisted manual tree choice keeps the tree when widened', () => {
    // A user who explicitly chose the tree on a wide dock keeps it across
    // reloads; only a narrow dock forces focus back.
    localStorage.setItem('tutor.layoutMode', 'tree');
    widthBox.width = 1200; // wide
    const bridge = createRecordingBridge();
    root = createRoot(host());
    act(() => {
      root!.render(createElement(CodeChainApp, { bridge }));
    });
    act(() => {
      bridge.feed({ t: 'chain', chain: narrowFixture });
    });
    expect(localStorage.getItem('tutor.layoutMode')).toBe('tree');
    // Tree layout: the whole DFS list is visible, not a single card.
    expect(rowByLabel('validateStock')).toBeDefined();
    expect(queryButton('刷新位置')).toBeDefined();
  });
});
