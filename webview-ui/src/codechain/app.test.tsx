// @vitest-environment jsdom
// Code-chain panel render (§11): the shared fixture chain drives the
// recording-bridge seam — visible rows follow `flattenVisible` (collapsed
// subtrees drop out), a row click posts a `nodeClick`, collapse hides a
// subtree, the tour buttons post `tour`, and the ⟳ posts `refresh`. Pure
// view-state assertions; no store, no LSP.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CodeChain } from '../../../src/codechain/types';
import fixtures from '../../../test-fixtures/codechain-cases.json';
import { CodeChainApp } from './app';
import { createRecordingBridge } from './bridge';

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

beforeEach(() => {
	document.body.innerHTML = '';
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
});

describe('code-chain panel', () => {
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
		const row = Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
			(el.textContent ?? '').includes('validateStock'),
		);
		act(() => {
			row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});
		expect(bridge.sent).toContainEqual({ t: 'nodeClick', nodeId: 'stock.validate', focus: false });
	});

	it('double-click escalates to focus=true (jumps the editor)', () => {
		const { bridge } = renderPanel();
		const row = Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
			(el.textContent ?? '').includes('emitOrderCreated'),
		);
		act(() => {
			row!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		});
		expect(bridge.sent).toContainEqual({ t: 'nodeClick', nodeId: 'event.emitted', focus: true });
	});

	it('collapsing a node drops its subtree from the DOM', () => {
		renderPanel();
		expect(text()).toContain('validateStock');
		// Collapse `service.create` (the 2nd row, root is 1st): its two
		// children disappear.
		const collapseService = (): HTMLButtonElement | undefined => {
			const row = Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
				(el.textContent ?? '').includes('校验库存与风控'),
			);
			return row?.querySelector('button') ?? undefined;
		};
		act(() => {
			collapseService()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});
		expect(text()).not.toContain('validateStock');
		expect(text()).not.toContain('deductInventory');
		// Expand restores it (same row, button now reads "expand").
		act(() => {
			collapseService()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
		const synced = Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
			(el.textContent ?? '').includes('validateStock'),
		);
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
		// Collapse service.create and select validateStock.
		const collapse = Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
			(el.textContent ?? '').includes('校验库存与风控'),
		)!.querySelector('button');
		act(() => collapse!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
		const row = Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
			(el.textContent ?? '').includes('createOrder'),
		);
		act(() => row!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
		const sentBefore = bridge.sent.length;
		// Host re-sends the WHOLE tree (Expand/Annotate/candidate-pick).
		act(() => {
			bridge.feed({ t: 'chain', chain });
		});
		// Selection (createOrder) must survive — no silent jump back to root,
		// and the collapsed subtree stays collapsed.
		expect(document.body.textContent ?? '').not.toContain('validateStock');
		// No spurious nodeClick from re-applying the chain.
		expect(bridge.sent.length).toBe(sentBefore);
	});

	it('a NEW chainId resets view state (selection to root, no collapse)', () => {
		const { bridge } = renderPanel();
		const collapse = Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
			(el.textContent ?? '').includes('校验库存与风控'),
		)!.querySelector('button');
		act(() => collapse!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
		const fresh = { ...chain, chainId: 'cc-other' };
		act(() => {
			bridge.feed({ t: 'chain', chain: fresh });
		});
		// New generation → collapsed subtree re-appears.
		expect(document.body.textContent ?? '').toContain('validateStock');
	});

	// ── progressive narrative / beat rendering ──────────────────────────────

	it('the detail pane renders the chain narrative as a markdown block', () => {
		renderPanel();
		expect(text()).toContain('业务叙事');
		// The fixture story text (asserted in pieces: react-markdown splits
		// the bold span into its own element).
		expect(text()).toContain('用户发起下单后');
		expect(text()).toContain('库存校验');
		expect(text()).toContain('领域事件广播');
		expect(text()).toContain('事务回滚');
	});

	it('node beats render in the tree rows and the detail pane', () => {
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
		expect(text()).toContain('用户发起下单'); // root beat (detail pane is on the root)
		expect(text()).toContain('受理并校验'); // service.create beat (tree row)
	});

	it('two feeds grow the tree (Extend-style same-chain update keeps view state)', () => {
		const { bridge } = renderPanel();
		// Collapse service.create, then push an Extend-shaped update that
		// attaches a new grandchild under it + recomputed stats.
		const collapse = Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
			(el.textContent ?? '').includes('校验库存与风控'),
		)!.querySelector('button');
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
