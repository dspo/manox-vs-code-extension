// The four client tools' reply contract + self-correction loop (§4, §9.3)
// over the FakeLsp fixture: every business outcome answers `reply.ok
// {content, isError}` — never an RPC Err — so the model reads the structured
// feedback; a successful GenCodeChain publishes (store + panel + journal
// verb); bare and `client_`-prefixed names both route.

import { describe, expect, it } from 'vitest';

import fixtures from '../../test-fixtures/codechain-cases.json';
import { ChainStore, type ChainStoreSink } from './chainStore';
import type { CodeChain, ChainNodeDraft } from './types';
import type { LspClient, LspItem, LspLocation, LspSymbol, ResolveDeps, WorkspaceView } from './resolve';
import { CodeChainTools, clientToolSpecs, type InvokeCall, type ReplySinks, type ToolSinks } from './tools';

const symbolsByUri = fixtures.resolve.symbols as Record<string, LspSymbol[]>;
const existingFiles = new Set(fixtures.resolve.existingFiles as string[]);

const emptyLsp: LspClient = {
	async documentSymbols(uri) {
		return symbolsByUri[uri] ?? [];
	},
	async readText() {
		return '';
	},
	// No workspace index in the tools tests: the `okRoot`/`failingChild`
	// fixtures are chosen so the document-symbol tree alone decides ok vs
	// unresolved. The index fallback itself is covered in resolve.test.
	async workspaceSymbols(): Promise<LspLocation[]> {
		return [];
	},
	async prepareCallHierarchy(): Promise<LspItem[]> {
		return [];
	},
	async outgoingCalls(): Promise<LspItem[]> {
		return [];
	},
	async incomingCalls(): Promise<LspItem[]> {
		return [];
	},
	async prepareTypeHierarchy(): Promise<LspItem[]> {
		return [];
	},
	async subtypes(): Promise<LspItem[]> {
		return [];
	},
};

const workspace: WorkspaceView = {
	folders: () => ['/repo'],
	fileExists: async (abs) => existingFiles.has(abs.replace(/^\/repo\//, '')),
	toUri: (abs) => `file://${abs.startsWith('/') ? '' : '/'}${abs}`,
	toPath: (uri) => (uri.startsWith('file:///') ? `/${uri.slice('file://'.length)}` : null),
};

const deps: ResolveDeps = { lsp: emptyLsp, workspace, mintChainId: () => 'cc-1', now: () => 1 };

function makeSink() {
	const rows = new Map<string, unknown>();
	const sink: ChainStoreSink = {
		get: <T,>(k: string) => rows.get(k) as T | undefined,
		update: (k, v) => {
			if (v === undefined) rows.delete(k);
			else rows.set(k, v);
		},
		delete: (k) => {
			rows.delete(k);
		},
	};
	return { sink, rows };
}

function makeTools() {
	const { sink, rows } = makeSink();
	const store = new ChainStore(sink);
	const shown: CodeChain[] = [];
	const updated: CodeChain[] = [];
	const verbs: unknown[] = [];
	const sinks: ToolSinks = {
		showChain: (c) => shown.push(c),
		updateChain: (c) => updated.push(c),
		verb: (n) => verbs.push(n),
		log: () => undefined,
	};
	const tools = new CodeChainTools(deps, store, sinks);
	function reply() {
		const calls: { content?: string; isError?: boolean; err?: string }[] = [];
		const sinks: ReplySinks = {
			ok: (content, isError) => calls.push({ content, isError }),
			err: (message) => calls.push({ err: message }),
		};
		return { sinks, calls };
	}
	return { tools, store, rows, shown, updated, verbs, reply };
}

const okRoot: ChainNodeDraft = {
	id: 'handler.create',
	label: 'createOrder',
	kind: 'entry',
	file: 'src/order/handler.ts',
	symbol: 'OrderController.createOrder',
	summary: 'HTTP 入口',
};

const failingChild: ChainNodeDraft = {
	id: 'ghost',
	label: 'phantom',
	kind: 'call',
	file: 'src/order/handler.ts',
	symbol: 'no.such.method',
	summary: '幻觉节点',
};

const call = (name: string, input: unknown): InvokeCall => ({ sessionId: 's1', name, input });

function parsed(content: string | undefined): Record<string, unknown> {
	return content ? (JSON.parse(content) as Record<string, unknown>) : {};
}

describe('client tool specs', () => {
	it('register all four, read-only, snake_case-ready', () => {
		const specs = clientToolSpecs();
		expect(specs.map((s) => s.name)).toEqual([
			'GenCodeChain',
			'ExpandCodeChainNode',
			'AnnotateCodeChainNode',
			'RefreshCodeChain',
		]);
		expect(specs.every((s) => s.readOnly === true)).toBe(true);
		// Cross-references between tools use the model-facing prefixed names
		// (§8 Phase 0 revision): the model never sees the bare registration
		// name, so the descriptions must not reference it either.
		expect(specs[1]?.description).toContain('client_AnnotateCodeChainNode');
		expect(specs[2]?.description).toContain('client_ExpandCodeChainNode');
		for (const spec of specs) {
			// A bare (unprefixed) tool name would be a name the model can
			// never call — reject it in every description.
			expect(spec.description).not.toMatch(/(^|[^_A-Za-z])(GenCodeChain|ExpandCodeChainNode|AnnotateCodeChainNode|RefreshCodeChain)(?!_)/);
		}
	});
});

describe('GenCodeChain', () => {
	it('a fully-resolved tree publishes store + panel + journal verb', async () => {
		const { tools, store, shown, verbs, reply } = makeTools();
		const r = reply();
		const handled = await tools.handle(call('GenCodeChain', { title: '流程', question: 'q', root: okRoot }), r.sinks);
		expect(handled).toBe(true);
		const out = r.calls[0];
		expect(out?.err).toBeUndefined();
		expect(out?.isError).toBe(false);
		expect(parsed(out?.content)).toMatchObject({ ok: true, chainId: 'cc-1', nodeCount: 1, unresolvedCount: 0 });
		expect(store.get('cc-1')?.title).toBe('流程');
		expect(shown).toHaveLength(1);
		expect(verbs[0]).toMatchObject({ sessionId: 's1', chainId: 'cc-1', nodeCount: 1 });
	});

	it('routes the prefixed `client_GenCodeChain` name identically (§9.2)', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		const handled = await tools.handle(call('client_GenCodeChain', { title: 't', question: 'q', root: okRoot }), r.sinks);
		expect(handled).toBe(true);
		expect(r.calls[0]?.isError).toBe(false);
	});

	it('a resolution failure answers isError with per-node reasons (§4)', async () => {
		const { tools, shown, reply } = makeTools();
		const r = reply();
		await tools.handle(
			call('GenCodeChain', { title: 't', question: 'q', root: { ...okRoot, children: [failingChild] } }),
			r.sinks,
		);
		const out = r.calls[0];
		expect(out?.isError).toBe(true);
		const body = parsed(out?.content);
		expect(body.ok).toBe(false);
		expect(body.failures).toEqual([{ nodeId: 'ghost', reason: expect.any(String) }]);
		expect(shown).toHaveLength(0); // not published while correcting
	});

	it('after 3 correction rounds renders anyway with a note (§4 upper bound)', async () => {
		const { tools, shown, store, reply } = makeTools();
		const root = { ...okRoot, children: [failingChild] };
		for (let i = 0; i < 4; i += 1) {
			const r = reply();
			await tools.handle(call('GenCodeChain', { title: 't', question: 'q', root }), r.sinks);
			if (i < 3) expect(r.calls[0]?.isError).toBe(true);
		}
		// The 4th attempt (rounds exhausted) publishes with an unresolved note.
		expect(shown).toHaveLength(1);
		expect(store.get('cc-1')?.stats.unresolvedCount).toBe(1);
	});

	it('a malformed draft answers isError without resolving', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		await tools.handle(call('GenCodeChain', { title: 't', root: { id: 'x' } }), r.sinks);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('requires');
	});
});

describe('Expand / Annotate / Refresh', () => {
	async function genOk() {
		const t = makeTools();
		const r = t.reply();
		await t.tools.handle(call('GenCodeChain', { title: 't', question: 'q', root: okRoot }), r.sinks);
		return t;
	}

	it('unknown chainId answers isError pointing at generation', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		await tools.handle(call('ExpandCodeChainNode', { chainId: 'nope', nodeId: 'x', direction: 'callees' }), r.sinks);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('client_GenCodeChain');
	});

	it('expand with no call-hierarchy provider answers the LSP-unavailable error (§10)', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(
			call('ExpandCodeChainNode', { chainId: 'cc-1', nodeId: 'handler.create', direction: 'callees' }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('call hierarchy');
	});

	it('annotate applies summary and updates the open chain (§4)', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(
			call('AnnotateCodeChainNode', { chainId: 'cc-1', nodeId: 'handler.create', summary: '业务入口', edgeNote: 'e' }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(false);
		expect(t.store.get('cc-1')?.root.summary).toBe('业务入口');
		expect(t.updated).toHaveLength(1);
	});

	it('refresh re-resolves and reports buckets (§6.3)', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(call('RefreshCodeChain', { chainId: 'cc-1' }), r.sinks);
		const body = parsed(r.calls[0]?.content);
		expect(r.calls[0]?.isError).toBe(false);
		expect(body).toMatchObject({ ok: true, chainId: 'cc-1' });
		expect(Array.isArray(body.moved)).toBe(true);
		expect(Array.isArray(body.stale)).toBe(true);
		expect(Array.isArray(body.fixed)).toBe(true);
	});

	// Review round-2 (suggestion 5): the old `children === node.children`
	// short-circuit was always false (a fresh array each pass), so even a
	// refresh that moved nothing rebuilt the whole tree and re-pushed it.
	it('a refresh where no position moved re-pushes nothing (review round-2)', async () => {
		const t = await genOk();
		// okRoot resolves to the same range on re-resolve → pure no-op.
		const r = t.reply();
		await t.tools.handle(call('RefreshCodeChain', { chainId: 'cc-1' }), r.sinks);
		expect(r.calls[0]?.isError).toBe(false);
		const body = parsed(r.calls[0]?.content);
		expect(body.moved).toEqual([]);
		expect(body.stale).toEqual([]);
		expect(body.fixed).toEqual([]);
		// `updateChain` (the panel re-push sink) must not fire on a no-op.
		expect(t.updated).toHaveLength(0);
	});

	// Review round-3: the non-ok → non-ok refresh branch compared
	// `hit.location !== node.location` by reference — always true for the
	// fresh objects `resolveSymbol` mints — so any chain carrying an
	// ambiguous/unresolved node rebuilt and re-pushed on every refresh.
	it('a no-op refresh re-pushes nothing on an ambiguous chain (review round-3)', async () => {
		const t = makeTools();
		const r = t.reply();
		await t.tools.handle(
			call('GenCodeChain', {
				title: 't',
				question: 'q',
				root: {
					id: 'inv.deduct',
					label: 'deduct',
					kind: 'call',
					file: 'src/order/service.ts',
					// Two fixture symbols share the bare name → ambiguous.
					symbol: 'deduct',
					summary: '库存扣减',
				},
			}),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(false);
		const stored = t.store.get('cc-1')?.root;
		expect(stored?.location.resolveStatus).toBe('ambiguous');
		expect(stored?.location.candidates?.length).toBeGreaterThan(1);

		const rr = t.reply();
		await t.tools.handle(call('RefreshCodeChain', { chainId: 'cc-1' }), rr.sinks);
		expect(rr.calls[0]?.isError).toBe(false);
		expect(parsed(rr.calls[0]?.content)).toMatchObject({ moved: [], stale: [], fixed: [] });
		expect(t.updated).toHaveLength(0);
	});

	it('an unknown tool name is not handled (caller fail-closes)', async () => {
		const { tools, reply } = makeTools();
		const handled = await tools.handle(call('SomeOtherTool', {}), reply().sinks);
		expect(handled).toBe(false);
	});
});

// Review #5: `handle()` claims the call (returns true), so a non-object or
// chainId-less input MUST still be answered — a silent return would leave
// the server waiting its full 300s (un-cancellable) timeout.
describe('every tool answers non-object / missing-chainId input (review #5)', () => {
	const toolsSuite: [string, unknown][] = [
		['ExpandCodeChainNode', null],
		['AnnotateCodeChainNode', 'a string'],
		['RefreshCodeChain', 42],
		['ExpandCodeChainNode', { chainId: 'nope' }],
		['AnnotateCodeChainNode', {}],
		['RefreshCodeChain', { chainId: 'ghost' }],
	];
	for (const [name, input] of toolsSuite) {
		it(`${name} with input ${JSON.stringify(input)} replies without hanging`, async () => {
			const { tools, reply } = makeTools();
			const r = reply();
			const handled = await tools.handle(call(name, input), r.sinks);
			expect(handled).toBe(true);
			expect(r.calls).toHaveLength(1);
			// Business failures ride Ok { content, isError:true }; a truly
			// unparseable frame may Err — either way, exactly one reply.
			expect(r.calls[0]).toBeTruthy();
		});
	}
});

// Review round-2 (issue): a malformed CHILD node used to be dropped by
// `parseDraft` with no trace, so the model got `ok:true` for a tree that had
// quietly lost nodes — it could never repair what it didn't know was gone.
describe('GenCodeChain reports dropped malformed children', () => {
	it('a child missing `kind` is dropped and surfaced as a failure with a path', async () => {
		const { tools, shown, reply } = makeTools();
		const r = reply();
		await tools.handle(
			call('GenCodeChain', {
				title: 't',
				question: 'q',
				root: {
					...okRoot,
					children: [
						{ id: 'c0', label: 'c0', kind: 'call', file: 'src/order/handler.ts', symbol: 'OrderController.createOrder', summary: 'ok child' },
						{ id: 'c1', label: 'c1', file: 'src/order/handler.ts', symbol: 'x', summary: 'no kind' },
					],
				},
			}),
			r.sinks,
		);
		const out = r.calls[0];
		expect(out?.isError).toBe(true);
		const body = parsed(out?.content);
		expect(shown).toHaveLength(0);
		const failures = body.failures as { nodeId: string }[];
		// The dropped node is identified by a tree path, not silently gone.
		expect(failures.some((f) => f.nodeId.includes('children[1]'))).toBe(true);
	});

	it('a child with an out-of-vocabulary kind is dropped and reported', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		await tools.handle(
			call('GenCodeChain', {
				title: 't',
				question: 'q',
				root: {
					...okRoot,
					children: [{ id: 'w', label: 'w', kind: 'widget', file: 'a.ts', symbol: 'x', summary: 'bad kind' }],
				},
			}),
			r.sinks,
		);
		const body = parsed(r.calls[0]?.content);
		expect(body.failures).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: expect.stringContaining('children[0]') })]));
	});
});

// Review round-2 (critical): once the handle bug is fixed, a genuine `provide*`
// rejection must reach the model as a tool ERROR — never collapse to the
// `{ok:true, note:'no new edges at this level'}` lie.
describe('ExpandCodeChainNode reports provider failures honestly', () => {
	it('a provideOutgoingCalls rejection answers isError (not "no new edges")', async () => {
		const { sink } = makeSink();
		const store = new ChainStore(sink);
		const range = { startLine: 1, startCharacter: 0, endLine: 2, endCharacter: 0 };
		store.save({
			chainId: 'cc-e',
			sessionId: 's1',
			title: 't',
			question: 'q',
			createdAt: 0,
			stats: { nodeCount: 1, unresolvedCount: 0 },
			root: {
				id: 'n1',
				label: 'n1',
				kind: 'call',
				summary: '',
				provenance: 'llm',
				location: { uri: 'file:///repo/src/order/handler.ts', selectionRange: range, range, resolveStatus: 'ok' },
				children: [],
			},
		});
		const lsp: LspClient = {
			async documentSymbols() {
				return [];
			},
			async readText() {
				return '';
			},
			async workspaceSymbols() {
				return [];
			},
			async prepareCallHierarchy(): Promise<LspItem[]> {
				return [{ name: 'n1', uri: 'file:///repo/src/order/handler.ts', range, selectionRange: range, handle: { id: 'real' } }];
			},
			async outgoingCalls(): Promise<LspItem[]> {
				throw new Error('Invalid argument `item` when running vscode.provideOutgoingCalls');
			},
			async incomingCalls(): Promise<LspItem[]> {
				return [];
			},
			async prepareTypeHierarchy() {
				return [];
			},
			async subtypes() {
				return [];
			},
		};
		const updated: CodeChain[] = [];
		const tools = new CodeChainTools(
			{ lsp, workspace, mintChainId: () => 'cc-e', now: () => 0 },
			store,
			{ showChain: () => undefined, updateChain: (c) => updated.push(c), verb: () => undefined, log: () => undefined },
		);
		const calls: { content?: string; isError?: boolean }[] = [];
		await tools.handle(
			{ sessionId: 's1', name: 'ExpandCodeChainNode', input: { chainId: 'cc-e', nodeId: 'n1', direction: 'callees' } },
			{ ok: (content, isError) => calls.push({ content, isError }), err: (message) => calls.push({ content: message }) },
		);
		expect(calls[0]?.isError).toBe(true);
		expect(calls[0]?.content).toContain('provideOutgoingCalls');
		expect(updated).toHaveLength(0);
	});
});
