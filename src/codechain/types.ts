// GenCodeChain data model — the wire contract between the LLM tool inputs,
// the host resolver, the panel, and the chain store. Vscode-free on purpose:
// `resolve.ts`'s pure core, `chainStore.ts`, and the webview bundle all
// import these types (the webview re-uses this file the way
// `webview-ui/src/protocol.ts` re-uses `src/protocol/types.ts`).
//
// Draft vs resolved is the central split (§3): the LLM submits a
// `ChainNodeDraft` tree with file+symbol references and NO positions; the
// host resolves every symbol through LSP into a `ResolvedNode` whose
// `location.range` is trusted by the panel. A hallucinated position can
// never enter the tree — only a failing `resolveStatus` the model can
// self-correct against.

export type Json = unknown;

/** Node roles in the tour. `note` is the escape hatch for conceptual steps
 * with no single code location (no symbol required, never resolved). */
export type ChainKind = 'entry' | 'call' | 'impl' | 'interface' | 'config' | 'data' | 'note';

/** How the node entered the graph: the LLM asserted it, or the host derived
 * it from a real LSP hierarchy edge. Edges carry their source for trust. */
export type NodeProvenance = 'llm' | 'callHierarchy' | 'typeHierarchy' | 'references';

export type ResolveStatus =
	/** Range resolved and unique; clicking jumps straight to it. */
	| 'ok'
	/** Several symbol matches; `candidates` lets the user pick (§6.3). */
	| 'ambiguous'
	/** No symbol found (or no workspace file match); tour skips these. */
	| 'unresolved'
	/** Was `ok`, but a refresh / re-open re-parse failed — code drifted.
	 * Clicking attempts a live re-resolve before falling back (§10). */
	| 'stale';

/** Zero-based, character offsets — the LSP `Range` shape, kept plain so the
 * webview and the store never see vscode classes. */
export interface ChainRange {
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

/** One disambiguation option for an `ambiguous` node. */
export interface ChainCandidate {
	uri: string;
	range: ChainRange;
	/** Optional display hint (containing symbol name) for the picker row. */
	label?: string;
}

/** What the LLM submits per node (GenCodeChain input). */
export interface ChainNodeDraft {
	/** Stable slug, e.g. "order-service.create". */
	id: string;
	label: string;
	kind: ChainKind;
	/** Workspace-relative path; absolute paths outside any folder reject. */
	file: string;
	/** Exact symbol name; `Class.method` path form for members. Empty for
	 * kind='note'. */
	symbol?: string;
	/** Business meaning in the user's language (LLM-written). */
	summary: string;
	/** Why this step follows its parent. */
	edgeNote?: string;
	children?: ChainNodeDraft[];
}

/** Host output: every field the panel renders, positions LSP-verified. */
export interface ResolvedNode {
	id: string;
	label: string;
	kind: ChainKind;
	summary: string;
	edgeNote?: string;
	provenance: NodeProvenance;
	location: {
		/** Document uri; empty for unresolved / note nodes with no file hit. */
		uri: string;
		/** Draft-relative path kept for display (`src/order/service.ts`);
		 * absent for host-expanded nodes (filename falls back). */
		file?: string;
		/** Symbol path used for live re-resolution (§10 click-time retry). */
		symbolPath?: string[];
		/** Present only when resolution succeeded; click-time re-parse may
		 * refresh it. */
		range?: ChainRange;
		resolveStatus: ResolveStatus;
		/** Non-empty only for `ambiguous`. */
		candidates?: ChainCandidate[];
	};
	children: ResolvedNode[];
}

/** A persisted, renderable chain (§7: survives session disposal; the panel
 * re-opens from the workspaceState row alone). */
export interface CodeChain {
	chainId: string;
	sessionId: string;
	title: string;
	question: string;
	createdAt: number;
	root: ResolvedNode;
	stats: { nodeCount: number; unresolvedCount: number };
}

// ── structural caps (§3: enforced by the host, relayed back to the LLM) ────

export const MAX_CHAIN_DEPTH = 5;
export const MAX_CHAIN_NODES = 80;
export const MAX_SUMMARY_CHARS = 200;

// ── panel message vocabulary (§6.4) ────────────────────────────────────────

/** Host → panel. `chain` is the whole-tree message (open / refresh /
 * re-render); `sync` marks the node the active editor landed on; `tourState`
 * mirrors the tour cursor; `toast` surfaces a one-line status. */
export type ToPanel =
	| { t: 'chain'; chain: CodeChain }
	| { t: 'sync'; nodeId: string | null }
	| { t: 'tourState'; index: number; total: number }
	| { t: 'toast'; message: string };

/** Panel → host. `nodeClick` jumps the editor (focus=false keeps it in the
 * panel); `tour` steps the DFS cursor; `pickCandidate` resolves an
 * ambiguity; `findRefs` opens a references lookup; `regen` backfills the
 * chain's question into the sidebar composer (§10 read-only reopen path);
 * `log` relays console diagnostics through the host log channel. */
export type FromPanel =
	| { t: 'nodeClick'; nodeId: string; focus: boolean }
	| { t: 'tour'; dir: 'prev' | 'next' }
	| { t: 'refresh' }
	| { t: 'pickCandidate'; nodeId: string; index: number }
	| { t: 'findRefs'; nodeId: string }
	| { t: 'regen'; question: string }
	| { t: 'log'; level: 'info' | 'warn' | 'error'; message: string };
