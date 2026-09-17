// ChainNavigation's references query (§19). The vscode surface is mocked the
// same way `panel.test.ts` mocks it — the module touches vscode only at call
// sites — so this pins the two things the panel's drawer depends on and a
// review could not see from the panel test alone:
//   * the LSP anchor is the symbol's NAME (`selectionRange`), not the full
//     body range, because reference providers answer nothing for a
//     body-spanning position;
//   * every hit's `preview` is read from ITS OWN file exactly once, and an
//     unreadable file degrades to an empty preview instead of failing the
//     whole lookup.

import { describe, expect, it, vi } from 'vitest';

import * as vscode from 'vscode';
import { ChainNavigation, nodeAnchor } from './navigation';
import type { LspClient, LspReference } from './resolve';
import type { ChainRange, CodeChain, ResolvedNode } from './types';

vi.mock('vscode', () => ({
	Range: class {
		constructor(
			public startLine: number,
			public startCharacter: number,
			public endLine: number,
			public endCharacter: number,
		) {}
	},
	Position: class {
		constructor(
			public line: number,
			public character: number,
		) {}
	},
	Uri: { parse: (s: string) => ({ toString: () => s }) },
	ThemeColor: class {
		constructor(public id: string) {}
	},
	DecorationRangeBehavior: { OpenOpen: 1 },
	TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
	ViewColumn: { One: 1, Beside: -2 },
	window: {
		createTextEditorDecorationType: () => ({ dispose: () => undefined }),
		visibleTextEditors: [],
		tabGroups: { all: [] },
		activeTextEditor: undefined,
		showTextDocument: vi.fn(),
		onDidChangeActiveTextEditor: () => ({ dispose: () => undefined }),
		onDidChangeTextEditorSelection: () => ({ dispose: () => undefined }),
	},
	workspace: { openTextDocument: vi.fn() },
	commands: { executeCommand: vi.fn() },
}));

const rng = (line: number): ChainRange => ({
	startLine: line,
	startCharacter: 2,
	endLine: line + 6,
	endCharacter: 0,
});

/** A node whose symbol name sits on line 4 while its body spans 4..10. */
function nodeWith(overrides: Partial<ResolvedNode['location']> = {}): ResolvedNode {
	return {
		id: 'n1',
		label: 'createOrder',
		kind: 'call',
		summary: '',
		provenance: 'llm',
		location: {
			uri: 'file:///repo/src/a.ts',
			range: rng(4),
			selectionRange: { startLine: 4, startCharacter: 9, endLine: 4, endCharacter: 20 },
			resolveStatus: 'ok',
			...overrides,
		},
		children: [],
	};
}

const chainOf = (root: ResolvedNode): CodeChain => ({
	chainId: 'cc-1',
	sessionId: 's1',
	title: 't',
	question: 'q',
	createdAt: 0,
	root,
	stats: { nodeCount: 1, unresolvedCount: 0 },
});

function makeNavigation(overrides: Partial<LspClient> = {}) {
	const lsp: LspClient = {
		documentSymbols: async () => [],
		readText: async () => '',
		workspaceSymbols: async () => [],
		references: async () => [],
		prepareCallHierarchy: async () => [],
		incomingCalls: async () => [],
		outgoingCalls: async () => [],
		prepareTypeHierarchy: async () => [],
		subtypes: async () => [],
		...overrides,
	};
	const logs: string[] = [];
	return { navigation: new ChainNavigation((m) => logs.push(m), lsp), logs, lsp };
}

describe('nodeAnchor', () => {
	it('anchors on the symbol NAME (selectionRange), not the body range', () => {
		expect(nodeAnchor(nodeWith())).toEqual({
			uri: 'file:///repo/src/a.ts',
			range: { startLine: 4, startCharacter: 9, endLine: 4, endCharacter: 20 },
		});
	});

	it('falls back to the range, then to the first candidate', () => {
		const noSelection = nodeWith({ selectionRange: undefined });
		expect(nodeAnchor(noSelection)?.range).toEqual(rng(4));

		const ambiguous = nodeWith({
			selectionRange: undefined,
			range: undefined,
			resolveStatus: 'ambiguous',
			uri: '',
			candidates: [{ uri: 'file:///repo/src/b.ts', range: rng(1), label: 'b' }],
		});
		expect(nodeAnchor(ambiguous)).toEqual({ uri: 'file:///repo/src/b.ts', range: rng(1) });
	});

	it('is undefined for a node with no usable location (note / unresolved)', () => {
		expect(nodeAnchor(nodeWith({ range: undefined, selectionRange: undefined, uri: '' }))).toBeUndefined();
	});
});

describe('ChainNavigation.listReferences', () => {
	it('queries the LSP at the symbol name and returns uri + range rows', async () => {
		const hit: LspReference = { uri: 'file:///repo/src/b.ts', range: rng(20) };
		const references = vi.fn(async () => [hit]);
		const { navigation } = makeNavigation({
			references,
			readText: async () => 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\nu\nv',
		});
		const hits = await navigation.listReferences(chainOf(nodeWith()), 'n1');
		// The position is the NAME's start, not the body's.
		expect(references).toHaveBeenCalledWith('file:///repo/src/a.ts', { line: 4, character: 9 });
		expect(hits[0]).toMatchObject({ uri: hit.uri, range: hit.range });
	});

	it('reads each file once and fills preview from the hit\'s own line', async () => {
		const readText = vi.fn(async (uri: string) =>
			uri.endsWith('b.ts') ? 'zero\none\n  const x = useIt();\n' : 'alpha\n  return useIt();\n',
		);
		const { navigation } = makeNavigation({
			references: async () => [
				{ uri: 'file:///repo/src/b.ts', range: { startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 3 } },
				{ uri: 'file:///repo/src/c.ts', range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 3 } },
				// A second hit in the SAME file must not trigger a second read.
				{ uri: 'file:///repo/src/b.ts', range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 3 } },
			],
			readText,
		});
		const hits = await navigation.listReferences(chainOf(nodeWith()), 'n1');
		expect(hits.map((h) => h.preview)).toEqual(['const x = useIt();', 'return useIt();', 'zero']);
		expect(readText).toHaveBeenCalledTimes(2);
	});

	it('degrades an unreadable file to an empty preview instead of failing', async () => {
		const { navigation } = makeNavigation({
			references: async () => [
				{ uri: 'file:///repo/src/gone.ts', range: { startLine: 3, startCharacter: 0, endLine: 3, endCharacter: 4 } },
			],
			readText: async () => {
				throw new Error('no such file');
			},
		});
		const hits = await navigation.listReferences(chainOf(nodeWith()), 'n1');
		expect(hits).toEqual([
			{
				uri: 'file:///repo/src/gone.ts',
				range: { startLine: 3, startCharacter: 0, endLine: 3, endCharacter: 4 },
				preview: '',
			},
		]);
	});

	it('answers empty for a node id that is not in the chain', async () => {
		const references = vi.fn(async () => [] as LspReference[]);
		const { navigation } = makeNavigation({ references });
		expect(await navigation.listReferences(chainOf(nodeWith()), 'nope')).toEqual([]);
		expect(references).not.toHaveBeenCalled();
	});
});

// `vscode.window.tabGroups` is read by `jumpColumn`; keeping the import
// referenced also documents that this module is the only vscode-facing seam.
void vscode;
