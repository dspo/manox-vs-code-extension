// CodeChainPanel lifecycle as a WebviewViewProvider (§19). The old panel had
// no direct test because `createWebviewPanel` forced a live vscode surface;
// the view API is fully injectable (the resolved `WebviewView` arrives through
// `resolveWebviewView`), so this exercises the resolve/show/update/dispose
// contract against a fake view — the races the migration is built around:
//   * a chain handed to `show` before the view resolves is stashed and drained
//     at resolve (the create-time window the old panel lost);
//   * an `update` before resolve refreshes the host-side state WITHOUT posting
//     (no crash) and the value survives for the ready→resend replay (the old
//     panel dropped the whole update — chain included — in this case);
//   * the ready handshake re-pushes every slice (chain + tourState + sync).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as vscode from 'vscode';
import { CodeChainPanel } from './panel';
import type { ChainNavigation, ReferenceHit } from './navigation';
import type { CodeChain, FromPanel, ToPanel } from './types';
import fixtures from '../../test-fixtures/codechain-cases.json';

const chain = fixtures.chain as unknown as CodeChain;

// The panel touches vscode only at call sites (Uri.joinPath / env.language /
// commands.executeCommand); nothing top-level evaluates a vscode symbol.
vi.mock('vscode', () => ({
	Uri: { joinPath: (base: unknown, ...segs: unknown[]) => ({ toString: () => [base, ...segs].join('/') }) },
	env: { language: 'en' },
	commands: { executeCommand: vi.fn(() => Promise.resolve()) },
}));

interface FakeView {
	webview: {
		options?: unknown;
		html?: string;
		cspSource: string;
		asWebviewUri: (x: unknown) => { toString: () => string };
		onDidReceiveMessage: (cb: (m: FromPanel) => void, thisArgs?: unknown, disposables?: { push: (d: unknown) => void }) => void;
		postMessage: (m: ToPanel) => boolean;
	};
	onDidDispose: (cb: () => void) => void;
	show: (preserveFocus?: boolean) => void;
	title?: string;
	_posts: ToPanel[];
	_msg: (m: FromPanel) => void;
	_dispose: () => void;
	_shown: boolean[];
}

function fakeView(): FakeView {
	const posts: ToPanel[] = [];
	let msgCb: ((m: FromPanel) => void) | undefined;
	let disposeCb: (() => void) | undefined;
	const shown: boolean[] = [];
	const view: FakeView = {
		webview: {
			cspSource: 'vscode-webview:',
			asWebviewUri: (x) => ({ toString: () => String(x) }),
			onDidReceiveMessage: (cb) => {
				msgCb = cb;
			},
			postMessage: (m) => {
				posts.push(m);
				return true;
			},
		},
		onDidDispose: (cb) => {
			disposeCb = cb;
		},
		show: (preserveFocus) => {
			shown.push(Boolean(preserveFocus));
		},
		_posts: posts,
		_msg: (m) => msgCb?.(m),
		_dispose: () => disposeCb?.(),
		_shown: shown,
	};
	return view;
}

function makePanel() {
	const logs: string[] = [];
	const saved: CodeChain[] = [];
	const store = {
		get: (id: string) => (id === chain.chainId ? chain : undefined),
		save: (c: CodeChain) => {
			saved.push(c);
		},
		list: () => [],
	} as unknown as ConstructorParameters<typeof CodeChainPanel>[1];
	const navigation = {
		showNode: vi.fn(async () => true),
		listReferences: vi.fn(async () => [] as ReferenceHit[]),
		watchActiveEditor: vi.fn(),
	} as unknown as ChainNavigation;
	const tools = { handle: vi.fn() };
	const panel = new CodeChainPanel(
		{ extensionUri: { toString: () => 'file:///ext' } } as unknown as vscode.ExtensionContext,
		store,
		navigation,
		() => tools as never,
		{ log: (m: string) => logs.push(m) },
	);
	return { panel, logs, saved, navigation, store };
}

beforeEach(() => {
	vi.mocked(vscode.commands.executeCommand).mockClear();
});

describe('CodeChainPanel (webview view)', () => {
	it('wires the reverse-sync watcher once, on the service-lifetime callback', () => {
		const { navigation } = makePanel();
		expect(navigation.watchActiveEditor).toHaveBeenCalledTimes(1);
	});

	it('show before resolve stashes the chain, focuses the view, and drains it at resolve', () => {
		const { panel } = makePanel();
		panel.show(chain);
		// Focused the not-yet-resolved view instead of dropping the chain.
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith('manox.tutorView.focus');

		const view = fakeView();
		panel.resolveWebviewView(view as never);
		// Resolve drained the pending chain: the new bundle is not stuck empty.
		expect(view._posts.map((p) => p.t)).toContain('chain');
		expect(view._posts.map((p) => p.t)).toContain('tourState');
		expect(view.title).toBe(`⛓ ${chain.title}`);
	});

	it('show on a resolved view reveals + pushes (preserveFocus), no focus-command fallback', () => {
		const { panel } = makePanel();
		const view = fakeView();
		panel.resolveWebviewView(view as never);
		vi.mocked(vscode.commands.executeCommand).mockClear();

		panel.show(chain);
		expect(view._shown).toEqual([true]); // reveal without stealing focus
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
		expect(view._posts.map((p) => p.t)).toContain('chain');
	});

	it('update before resolve refreshes host state without posting or throwing (old drop-bug fix)', () => {
		const { panel } = makePanel();
		const grown: CodeChain = { ...chain, stats: { nodeCount: chain.stats.nodeCount + 1, unresolvedCount: chain.stats.unresolvedCount } };
		panel.update(grown); // no view yet → just updates state; no post, no throw
		const view = fakeView();
		panel.resolveWebviewView(view as never);
		// The latest update survived for the ready→resend replay.
		const posted = view._posts.find((p) => p.t === 'chain');
		expect(posted?.t === 'chain' && posted.chain.stats.nodeCount).toBe(grown.stats.nodeCount);

		view._msg({ t: 'ready' });
		// ready→resend re-sends every slice: chain + tourState + sync.
		expect(view._posts.map((p) => p.t)).toEqual(expect.arrayContaining(['chain', 'tourState', 'sync']));
	});

	it('onDidChangeViewState is gone: resolve re-applies an already-live chain (reload path)', () => {
		const { panel } = makePanel();
		const v1 = fakeView();
		panel.resolveWebviewView(v1 as never);
		panel.show(chain);
		expect(v1.title).toBe(`⛓ ${chain.title}`);

		v1._dispose(); // view closed → state reset
		const v2 = fakeView();
		panel.resolveWebviewView(v2 as never);
		panel.show(chain); // reopen with a chain
		expect(v2._posts.map((p) => p.t)).toContain('chain');

		// A fresh resolve over an already-live chain re-pushes it (reload safety).
		const v3 = fakeView();
		panel.resolveWebviewView(v3 as never);
		expect(v3._posts.map((p) => p.t)).toEqual(expect.arrayContaining(['chain', 'tourState']));
		expect(v3.title).toBe(`⛓ ${chain.title}`);
	});

	it('identity guard: a message or dispose from a replaced view is ignored', () => {
		const { panel, navigation } = makePanel();
		const v1 = fakeView();
		panel.resolveWebviewView(v1 as never);
		panel.show(chain);
		vi.mocked(navigation.showNode).mockClear();

		const v2 = fakeView();
		panel.resolveWebviewView(v2 as never);
		// v1 is now stale: a nodeClick on it must not navigate.
		v1._msg({ t: 'nodeClick', nodeId: chain.root.id, focus: false });
		expect(navigation.showNode).not.toHaveBeenCalled();
		// v2 (live) does navigate.
		v2._msg({ t: 'nodeClick', nodeId: chain.root.id, focus: false });
		expect(navigation.showNode).toHaveBeenCalledTimes(1);
	});

	// ── references drawer (panel → host request, host → panel answer) ────────

	it('a findRefs request answers with the node\'s references, live each time', async () => {
		const { panel, navigation } = makePanel();
		const hits: ReferenceHit[] = [
			{ uri: 'file:///repo/src/a.ts', range: { startLine: 3, startCharacter: 2, endLine: 3, endCharacter: 9 }, preview: 'callIt(a)' },
		];
		vi.mocked(navigation.listReferences).mockResolvedValue(hits);
		const view = fakeView();
		panel.resolveWebviewView(view as never);
		panel.show(chain);
		view._posts.length = 0;

		view._msg({ t: 'findRefs', nodeId: chain.root.id });
		await vi.waitFor(() => expect(view._posts.map((p) => p.t)).toContain('references'));
		const answer = view._posts.find((p) => p.t === 'references');
		expect(answer?.t === 'references' && answer.nodeId).toBe(chain.root.id);
		expect(answer?.t === 'references' && answer.hits).toEqual(hits);

		// Re-opening the drawer re-queries (a cached count would go stale as
		// the user edits); the host never memoizes the answer.
		view._msg({ t: 'findRefs', nodeId: chain.root.id });
		await vi.waitFor(() => expect(navigation.listReferences).toHaveBeenCalledTimes(2));
	});

	it('a slow references reply for a chain the view has left is dropped', async () => {
		const { panel, navigation } = makePanel();
		let release: ((hits: ReferenceHit[]) => void) | undefined;
		vi.mocked(navigation.listReferences).mockImplementation(
			() => new Promise<ReferenceHit[]>((resolve) => (release = resolve)),
		);
		const v1 = fakeView();
		panel.resolveWebviewView(v1 as never);
		panel.show(chain);
		v1._msg({ t: 'findRefs', nodeId: chain.root.id });

		// The view is replaced while the provider is still working; the
		// answer must not land in the new view.
		const v2 = fakeView();
		panel.resolveWebviewView(v2 as never);
		panel.show({ ...chain, chainId: 'cc-next' });
		v2._posts.length = 0;
		release?.([]);
		await Promise.resolve();
		await Promise.resolve();
		expect(v2._posts.filter((p) => p.t === 'references')).toHaveLength(0);
	});
});
