// Chain store persistence fold (§11): a Map-backed fake for the Memento
// sink — save/get/list ordering, the LRU cap, and the copy-on-write tree
// rewrites (`replaceNode` / `withStats`) the panel + tools share. No vscode.

import { describe, expect, it } from 'vitest';

import fixtures from '../../test-fixtures/codechain-cases.json';
import { ChainStore, MAX_STORED_CHAINS, replaceNode, withStats } from './chainStore';
import type { ChainStoreSink } from './chainStore';
import type { CodeChain, ResolvedNode } from './types';

function fakeSink(): ChainStoreSink & { rows: Map<string, unknown> } {
	const rows = new Map<string, unknown>();
	return {
		rows,
		get: <T>(key: string) => rows.get(key) as T | undefined,
		update: (key, value) => {
			if (value === undefined) rows.delete(key);
			else rows.set(key, value);
		},
		delete: (key) => {
			rows.delete(key);
		},
	};
}

const baseChain = fixtures.chain as unknown as CodeChain;

function chain(id: string, at: number): CodeChain {
	return { ...baseChain, chainId: id, createdAt: at };
}

describe('ChainStore over a fake Memento sink', () => {
	it('round-trips a saved chain whole (serialization fidelity)', () => {
		const store = new ChainStore(fakeSink());
		store.save(baseChain);
		expect(store.get(baseChain.chainId)).toEqual(baseChain);
	});

	it('lists newest-first and filters by session', () => {
		const store = new ChainStore(fakeSink());
		store.save(chain('a', 1));
		store.save(chain('b', 2));
		store.save({ ...chain('c', 3), sessionId: 'other' });
		expect(store.list('s1').map((s) => s.chainId)).toEqual(['b', 'a']);
		expect(store.list().map((s) => s.chainId)).toEqual(['c', 'b', 'a']);
	});

	it('a re-save of the same id replaces (no duplicate index rows)', () => {
		const store = new ChainStore(fakeSink());
		store.save(chain('a', 1));
		store.save({ ...chain('a', 5), title: 'updated' });
		expect(store.list('s1')).toHaveLength(1);
		expect(store.get('a')?.title).toBe('updated');
	});

	it('evicts oldest-first past the cap (§ cap keeps recent tours reopenable)', () => {
		const sink = fakeSink();
		const store = new ChainStore(sink);
		for (let i = 0; i < MAX_STORED_CHAINS + 3; i += 1) {
			store.save(chain(`cc-${i}`, i));
		}
		expect(store.list().length).toBe(MAX_STORED_CHAINS);
		expect(store.get('cc-0')).toBeUndefined();
		expect(store.get(`cc-${MAX_STORED_CHAINS + 2}`)).toBeDefined();
		// The evicted row's payload is deleted too, not just its index entry.
		expect(sink.rows.has('manox.codechain.cc-0')).toBe(false);
	});

	it('delete drops the index row and the payload', () => {
		const store = new ChainStore(fakeSink());
		store.save(chain('a', 1));
		store.delete('a');
		expect(store.get('a')).toBeUndefined();
		expect(store.list()).toEqual([]);
	});
});

describe('tree rewrite helpers', () => {
	it('replaceNode rebuilds the spine to a nested node and leaves siblings', () => {
		const root = baseChain.root;
		const { root: next, found } = replaceNode(root, 'stock.validate', (node) => ({
			...node,
			summary: 'rewritten',
		}));
		expect(found).toBe(true);
		const changed = find(next, 'stock.validate');
		const untouched = find(next, 'event.emitted');
		expect(changed?.summary).toBe('rewritten');
		// Identity is preserved for every node the rewrite did not touch.
		expect(untouched).toBe(find(root, 'event.emitted'));
		expect(find(next, 'broken.hallucinated')).toBe(find(root, 'broken.hallucinated'));
	});

	it('replaceNode on an unknown id is a no-op', () => {
		const { root, found } = replaceNode(baseChain.root, 'nope', (n) => ({ ...n, summary: 'x' }));
		expect(found).toBe(false);
		expect(root).toBe(baseChain.root);
	});

	it('withStats recomputes counts and is referential when unchanged', () => {
		const withExtra = withStats({
			...baseChain,
			root: { ...baseChain.root, children: [...baseChain.root.children, { ...baseChain.root.children[0] as ResolvedNode }] },
		});
		expect(withExtra.stats.nodeCount).toBeGreaterThan(baseChain.stats.nodeCount);
		expect(withStats(baseChain)).toBe(baseChain); // counts already correct
	});
});

function find(node: ResolvedNode, id: string): ResolvedNode | undefined {
	if (node.id === id) return node;
	for (const child of node.children) {
		const hit = find(child, id);
		if (hit) return hit;
	}
	return undefined;
}

// Review #11: workspaceState is durable across versions, so a partial write
// or an older-row shape must degrade to "not present" (and be swept), never
// throw when the panel / quick-pick touches the row.
describe('ChainStore row validation (corrupt / stale-version rows)', () => {
	it('a malformed row is dropped + swept from the index, and the log fires', () => {
		const sink = fakeSink();
		const logs: string[] = [];
		const store = new ChainStore(sink, (m) => logs.push(m));
		// Hand-plant a broken row: index lists it, payload has no `root`.
		sink.update('manox.codechain.index', ['bad']);
		sink.update('manox.codechain.bad', { chainId: 'bad', sessionId: 's1', title: 'x' });
		expect(store.get('bad')).toBeUndefined();
		expect(logs.some((l) => l.includes('corrupt'))).toBe(true);
		// The index no longer lists the bad row.
		expect(store.list()).toEqual([]);
		expect((sink.rows.get('manox.codechain.index') as string[])).toEqual([]);
	});

	it('a location with a bad resolveStatus invalidates the whole row', () => {
		const sink = fakeSink();
		const store = new ChainStore(sink, () => undefined);
		const broken = JSON.parse(JSON.stringify(baseChain)) as {
			root: { location: { resolveStatus: string } };
		};
		broken.root.location.resolveStatus = 'wat';
		store.save(broken as unknown as typeof baseChain);
		expect(store.get(baseChain.chainId)).toBeUndefined();
	});

	it('a valid row round-trips unchanged', () => {
		const store = new ChainStore(fakeSink());
		store.save(baseChain);
		expect(store.get(baseChain.chainId)).toEqual(baseChain);
	});
});
