// Resolution-engine conformance over a FakeLspClient + the shared fixture
// symbol map (§11): unique path match, fuzzy ambiguity, unresolved symbol,
// note-without-symbol, file-outside-workspace, the §3 depth/node caps, and
// the call-hierarchy expansion path (including its unavailable-provider
// error the LLM falls back on).

import { describe, expect, it } from 'vitest';

import fixtures from '../../test-fixtures/codechain-cases.json';
import type { ChainNodeDraft, CodeChain } from './types';
import { MAX_CHAIN_DEPTH, MAX_CHAIN_NODES } from './types';
import {
	type LspClient,
	type LspItem,
	type LspSymbol,
	type ResolveDeps,
	type WorkspaceView,
	expandNode,
	resolveChain,
	validateDraft,
} from './resolve';

const symbolsByUri = fixtures.resolve.symbols as Record<string, LspSymbol[]>;
const existingFiles = new Set(fixtures.resolve.existingFiles as string[]);
const folders = fixtures.resolve.workspaceFolders as string[];

/** Provider-less fake: symbol tree + file existence only. */
class FakeLsp implements LspClient {
	calls: { outgoing: number; incoming: number } = { outgoing: 0, incoming: 0 };
	constructor(
		private readonly symbols: Record<string, LspSymbol[]> = symbolsByUri,
		private readonly calleeEdges: Record<string, LspItem[]> = {},
		private readonly callerEdges: Record<string, LspItem[]> = {},
	) {}

	async documentSymbols(uri: string): Promise<LspSymbol[]> {
		return this.symbols[uri] ?? [];
	}
	async readText(): Promise<string> {
		return '';
	}
	async prepareCallHierarchy(uri: string): Promise<LspItem[]> {
		const tree = this.symbols[uri] ?? [];
		// Any symbol resolves a call-hierarchy anchor for the fake.
		const first = tree[0];
		return first ? [{ name: first.name, uri, range: first.range, selectionRange: first.range }] : [];
	}
	async outgoingCalls(item: LspItem): Promise<LspItem[]> {
		this.calls.outgoing += 1;
		return this.calleeEdges[item.uri + item.name] ?? [];
	}
	async incomingCalls(item: LspItem): Promise<LspItem[]> {
		this.calls.incoming += 1;
		return this.callerEdges[item.uri + item.name] ?? [];
	}
	async prepareTypeHierarchy(): Promise<LspItem[]> {
		return [];
	}
	async supertypes(): Promise<LspItem[]> {
		return [];
	}
	async subtypes(): Promise<LspItem[]> {
		return [];
	}
	async references(): Promise<[]> {
		return [];
	}
	async implementations(): Promise<[]> {
		return [];
	}
}

const workspace: WorkspaceView = {
	folders: () => folders,
	fileExists: async (abs) => existingFiles.has(abs.replace(/^\/repo\//, '')),
};

const deps = (lsp: LspClient): ResolveDeps => ({
	lsp,
	workspace,
	mintChainId: () => 'cc-fixed',
	now: () => 0,
});

async function resolveCase(draft: ChainNodeDraft): Promise<CodeChain['root']> {
	const { chain } = await resolveChain(deps(new FakeLsp()), {
		sessionId: 's1',
		title: 't',
		question: 'q',
		root: draft,
	});
	return chain.root;
}

describe('resolveSymbol pipeline (fixture cases)', () => {
	for (const testCase of fixtures.resolve.cases as {
		name: string;
		draft: ChainNodeDraft;
		status: string;
	}[]) {
		it(`${testCase.name} → ${testCase.status}`, async () => {
			const resolved = await resolveCase(testCase.draft);
			expect(resolved.location.resolveStatus).toBe(testCase.status);
		});
	}

	it('a unique path match carries the symbol range + path (§5)', async () => {
		const resolved = await resolveCase({
			id: 'a',
			label: 'createOrder',
			kind: 'entry',
			file: 'src/order/handler.ts',
			symbol: 'OrderController.createOrder',
			summary: '入口',
		});
		expect(resolved.location.range).toEqual({ startLine: 9, startCharacter: 2, endLine: 18, endCharacter: 3 });
		expect(resolved.location.symbolPath).toEqual(['OrderController', 'createOrder']);
		expect(resolved.location.file).toBe('src/order/handler.ts');
	});

	it('ambiguous records every candidate for the picker', async () => {
		const resolved = await resolveCase({
			id: 'b',
			label: 'deduct',
			kind: 'call',
			file: 'src/order/service.ts',
			symbol: 'deduct',
			summary: '扣减',
		});
		expect(resolved.location.resolveStatus).toBe('ambiguous');
		expect(resolved.location.candidates?.length).toBeGreaterThan(0);
	});

	it('an unresolved draft fails the whole-chain gate with a reason (§4)', async () => {
		const { chain, failures } = await resolveChain(deps(new FakeLsp()), {
			sessionId: 's1',
			title: 't',
			question: 'q',
			root: {
				id: 'r',
				label: 'root',
				kind: 'entry',
				file: 'src/order/handler.ts',
				symbol: 'no.such.symbol',
				summary: 'x',
			},
		});
		expect(failures).toHaveLength(1);
		expect(failures[0]?.id).toBe('r');
		expect(chain.stats.unresolvedCount).toBe(1);
	});
});

describe('§3 caps', () => {
	it('truncates depth beyond MAX_CHAIN_DEPTH', () => {
		let node: ChainNodeDraft = { id: 'leaf', label: 'leaf', kind: 'call', file: '', summary: 's' };
		for (let depth = MAX_CHAIN_DEPTH + 2; depth >= 0; depth -= 1) {
			node = { id: `n${depth}`, label: 'n', kind: 'call', file: '', summary: 's', children: [node] };
		}
		const { draft, warnings } = validateDraft(node);
		expect(warnings.some((w) => w.includes('depth'))).toBe(true);
		// Deepest surviving node is at the cap.
		let seen = 0;
		let cur: ChainNodeDraft | undefined = draft;
		while (cur && cur.children?.length) {
			seen += 1;
			cur = cur.children[0];
		}
		expect(seen).toBeLessThan(MAX_CHAIN_DEPTH + 1);
	});

	it('truncates the node budget to MAX_CHAIN_NODES', () => {
		const breadth = MAX_CHAIN_NODES + 20;
		const wide: ChainNodeDraft = {
			id: 'root',
			label: 'root',
			kind: 'entry',
			file: '',
			summary: 's',
			children: Array.from({ length: breadth }, (_, i) => ({
				id: `c${i}`,
				label: `c${i}`,
				kind: 'call' as const,
				file: '',
				summary: 's',
			})),
		};
		const { draft } = validateDraft(wide);
		const count = (n: ChainNodeDraft): number => 1 + (n.children ?? []).reduce((a, c) => a + count(c), 0);
		expect(count(draft)).toBeLessThanOrEqual(MAX_CHAIN_NODES);
	});
});

describe('call-hierarchy expansion (§4, no LLM)', () => {
	const anchorUri = 'file:///repo/src/order/service.ts';

	it('callees merge real edges, deduped against the tree', async () => {
		const lsp = new FakeLsp(
			symbolsByUri,
			{ [`${anchorUri}OrderService`]: [
				{ name: 'persistOrder', uri: anchorUri, range: rng(70), selectionRange: rng(70) },
				{ name: 'emitOrderCreated', uri: 'file:///repo/src/order/events.ts', range: rng(5), selectionRange: rng(5) },
			] },
		);
		const target = {
			id: 'service.create',
			label: 'create',
			kind: 'call' as const,
			summary: '',
			provenance: 'llm' as const,
			location: { uri: anchorUri, range: rng(41), resolveStatus: 'ok' as const },
			children: [],
		};
		const outcome = await expandNode(lsp, target, 'callees', new Set(['emitOrderCreated@events.ts']));
		expect(outcome.error).toBeUndefined();
		// `emitOrderCreated` was in existingIds (as `label@file`) → deduped.
		expect(outcome.added.map((a) => a.label)).toEqual(['persistOrder']);
		expect(outcome.added[0]?.provenance).toBe('callHierarchy');
	});

	it('reports the LSP-unavailable error when no anchor resolves', async () => {
		const lsp = new FakeLsp({});
		const target = {
			id: 'x',
			label: 'x',
			kind: 'call' as const,
			summary: '',
			provenance: 'llm' as const,
			location: { uri: anchorUri, range: rng(1), resolveStatus: 'ok' as const },
			children: [],
		};
		const outcome = await expandNode(lsp, target, 'callers', new Set());
		expect(outcome.error).toContain('call hierarchy');
	});
});

const rng = (line: number) => ({ startLine: line, startCharacter: 0, endLine: line, endCharacter: 5 });
