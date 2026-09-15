// Chain registry + persistence (§7). Chains outlive their session: the
// journal cards and the "重新生成" affordance reopen a panel from the stored
// row alone, so the store keeps whole `CodeChain` records keyed by chainId.
//
// The backing map is injected (`ChainStoreSink`) so the pure fold — keying,
// caps, LRU eviction, list order — is testable without vscode; the host
// wires it to `Memento` (workspaceState). §10: "会话销毁后点旧卡片" — nothing
// here consults liveness.

import type { CodeChain } from './types';

/** Minimal Memento face (vscode.Memento satisfies it structurally). */
export interface ChainStoreSink {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void> | void;
	delete(key: string): Thenable<void> | void;
	keys?(): readonly string[];
}

/** Workspace-wide chain cap: a busy project should be able to reopen its
 * recent tours; ancient ones evict oldest-first (creation order, LRU-lite). */
export const MAX_STORED_CHAINS = 20;

export const CHAIN_KEY_PREFIX = 'manox.codechain.';
const INDEX_KEY = 'manox.codechain.index';

export interface ChainSummary {
	chainId: string;
	sessionId: string;
	title: string;
	nodeCount: number;
	unresolvedCount: number;
	createdAt: number;
}

/** Index rows are append-order; the summary list renders newest-first. */
function readIndex(sink: ChainStoreSink): string[] {
	const raw = sink.get<unknown>(INDEX_KEY);
	return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
}

export class ChainStore {
	constructor(private readonly sink: ChainStoreSink) {}

	/** Insert or replace a chain; evicts oldest rows past the cap. The
	 * update promise is fire-and-forget (Memento writes are durable-async;
	 * the in-memory copy is the read face). */
	save(chain: CodeChain): void {
		const index = readIndex(this.sink);
		const next = index.filter((id) => id !== chain.chainId);
		next.push(chain.chainId);
		this.sink.update(`${CHAIN_KEY_PREFIX}${chain.chainId}`, chain);
		while (next.length > MAX_STORED_CHAINS) {
			const oldest = next.shift() as string;
			void this.sink.delete(`${CHAIN_KEY_PREFIX}${oldest}`);
		}
		this.sink.update(INDEX_KEY, next);
	}

	get(chainId: string): CodeChain | undefined {
		return this.sink.get<CodeChain>(`${CHAIN_KEY_PREFIX}${chainId}`);
	}

	list(sessionId?: string): ChainSummary[] {
		const out: ChainSummary[] = [];
		for (const chainId of readIndex(this.sink)) {
			const chain = this.get(chainId);
			if (!chain) continue;
			if (sessionId !== undefined && chain.sessionId !== sessionId) continue;
			out.push({
				chainId: chain.chainId,
				sessionId: chain.sessionId,
				title: chain.title,
				nodeCount: chain.stats.nodeCount,
				unresolvedCount: chain.stats.unresolvedCount,
				createdAt: chain.createdAt,
			});
		}
		return out.sort((a, b) => b.createdAt - a.createdAt);
	}

	delete(chainId: string): void {
		const index = readIndex(this.sink).filter((id) => id !== chainId);
		this.sink.update(INDEX_KEY, index);
		void this.sink.delete(`${CHAIN_KEY_PREFIX}${chainId}`);
	}
}

/** A copy-on-write tree walker: rebuild the spine to `nodeId` and replace
 * that node. Used by candidate-pick and annotation merges without a full
 * refold. Returns the new root plus the replaced node (null id → no-op).
 * Ids are unique per §4 validation, so the first DFS hit is THE node. */
export function replaceNode(
	root: CodeChain['root'],
	nodeId: string,
	next: (node: CodeChain['root']) => CodeChain['root'],
): { root: CodeChain['root']; found: boolean } {
	if (root.id === nodeId) return { root: next(root), found: true };
	const walk = (node: CodeChain['root']): { value: CodeChain['root']; found: boolean } => {
		let found = false;
		const children = node.children.map((child) => {
			const hit = child.id === nodeId ? { value: next(child), found: true } : walk(child);
			if (hit.found) found = true;
			return hit.value;
		});
		return { value: found ? { ...node, children } : node, found };
	};
	const spine = walk(root);
	return { root: spine.value, found: spine.found };
}

/** Recompute `stats` from the tree (§3: nodeCount/unresolvedCount). */
export function withStats(chain: CodeChain): CodeChain {
	let nodeCount = 0;
	let unresolvedCount = 0;
	const walk = (node: CodeChain['root']): void => {
		nodeCount += 1;
		if (node.location.resolveStatus === 'unresolved') unresolvedCount += 1;
		for (const child of node.children) walk(child);
	};
	walk(chain.root);
	if (chain.stats.nodeCount === nodeCount && chain.stats.unresolvedCount === unresolvedCount) {
		return chain;
	}
	return { ...chain, stats: { nodeCount, unresolvedCount } };
}
