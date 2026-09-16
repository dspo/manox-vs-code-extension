// Chain registry + persistence (§7). Chains outlive their session: the
// journal cards and the Regenerate affordance reopen a panel from the stored
// row alone, so the store keeps whole `CodeChain` records keyed by chainId.
//
// The backing map is injected (`ChainStoreSink`) so the pure fold — keying,
// caps, LRU eviction, list order, and SHAPE VALIDATION of read rows — is
// testable without vscode; the host wires it to `Memento` (workspaceState).
// §10: reopening a card after its session was disposed — nothing here
//
// Read-time validation matters because workspaceState is durable ACROSS
// extension versions (review #11): a partially-written row, or one saved by
// an older codechain build whose `CodeChain` shape has since changed, would
// otherwise blind-cast to `CodeChain` and throw a TypeError the moment the
// panel / quick-pick touches `chain.root.children` or `chain.stats`. Such a
// row is dropped (and swept from the index) rather than crashing every
// reopen path at once.

import type { ChainLocation, ChainRange, CodeChain, ResolvedNode } from './types';

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

type Log = (message: string) => void;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const aStr = (v: unknown): v is string => typeof v === 'string';
const aNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Structural validity of a stored range/location/node, defensively: the
 * shape a live `CodeChain` guarantees, verified field-by-field so a bad row
 * fails closed (→ dropped) rather than throwing at first touch. */
function validRange(v: unknown): v is ChainRange {
	return (
		isRecord(v) &&
		aNum(v.startLine) &&
		aNum(v.startCharacter) &&
		aNum(v.endLine) &&
		aNum(v.endCharacter)
	);
}

function validLocation(v: unknown): v is ChainLocation {
	if (!isRecord(v) || !aStr(v.uri)) return false;
	const status = v.resolveStatus;
	if (
		status !== 'ok' &&
		status !== 'ambiguous' &&
		status !== 'unresolved' &&
		status !== 'stale'
	) {
		return false;
	}
	if (v.range !== undefined && !validRange(v.range)) return false;
	if (v.selectionRange !== undefined && !validRange(v.selectionRange)) return false;
	if (v.symbolPath !== undefined && !Array.isArray(v.symbolPath)) return false;
	if (v.candidates !== undefined) {
		if (!Array.isArray(v.candidates)) return false;
		for (const c of v.candidates) {
			if (!isRecord(c) || !aStr(c.uri) || !validRange(c.range)) return false;
		}
	}
	return true;
}

function validNode(v: unknown): v is ResolvedNode {
	if (!isRecord(v) || !aStr(v.id) || !aStr(v.label) || !aStr(v.kind) || !aStr(v.summary)) return false;
	if (!validLocation(v.location)) return false;
	if (!Array.isArray(v.children)) return false;
	return v.children.every(validNode);
}

function validChain(v: unknown): v is CodeChain {
	if (!isRecord(v)) return false;
	if (!aStr(v.chainId) || !aStr(v.sessionId) || !aStr(v.title) || !aStr(v.question)) return false;
	if (!aNum(v.createdAt) || !isRecord(v.stats)) return false;
	if (!aNum(v.stats.nodeCount) || !aNum(v.stats.unresolvedCount)) return false;
	return validNode(v.root);
}

/** Index rows are append-order; the summary list renders newest-first. */
function readIndex(sink: ChainStoreSink): string[] {
	const raw = sink.get<unknown>(INDEX_KEY);
	return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
}

export class ChainStore {
	constructor(
		private readonly sink: ChainStoreSink,
		private readonly log: Log = () => undefined,
	) {}

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

	/** Read one chain, verifying the stored shape; a corrupt / stale-version
	 * row is dropped + swept from the index rather than returned (review #11). */
	get(chainId: string): CodeChain | undefined {
		const key = `${CHAIN_KEY_PREFIX}${chainId}`;
		const raw = this.sink.get<unknown>(key);
		if (raw === undefined) return undefined;
		if (!validChain(raw)) {
			this.log(`dropping corrupt stored chain ${chainId} (shape mismatch)`);
			void this.sink.delete(key);
			const index = readIndex(this.sink).filter((id) => id !== chainId);
			this.sink.update(INDEX_KEY, index);
			return undefined;
		}
		return raw;
	}

	list(sessionId?: string): ChainSummary[] {
		const out: ChainSummary[] = [];
		for (const chainId of readIndex(this.sink)) {
			const chain = this.get(chainId); // validates + self-heals bad rows
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
	root: ResolvedNode,
	nodeId: string,
	next: (node: ResolvedNode) => ResolvedNode,
): { root: ResolvedNode; found: boolean } {
	if (root.id === nodeId) return { root: next(root), found: true };
	const walk = (node: ResolvedNode): { value: ResolvedNode; found: boolean } => {
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
	const walk = (node: ResolvedNode): void => {
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
