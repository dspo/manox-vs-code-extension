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

/** Zero-based character offsets — the LSP `Range` shape, kept plain so the
 * webview and the store never see vscode classes. (The `textMatches` helper
 * in resolve.ts emits these 0-based; display code adds the +1.) */
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
	/** The one story-beat this node plays in the chain-level `narrative`
	 * (≤ MAX_BEAT_CHARS). Optional: older drafts and host-expanded nodes
	 * carry none, and the panel only renders it when present. */
	beat?: string;
	children?: ChainNodeDraft[];
}

/** A resolved node's trusted position. Split out so the store validator
 * (chainStore) and the panel share one shape definition. */
export interface ChainLocation {
	/** Document uri; empty for unresolved / note nodes with no file hit. */
	uri: string;
	/** Draft-relative path kept for display + the expansion dedup key
	 * (`src/order/service.ts`); absent for host-expanded nodes. */
	file?: string;
	/** Symbol path used for live re-resolution (§10 click-time retry). */
	symbolPath?: string[];
	/** Full symbol range — present only when resolution succeeded; the
	 * editor highlight covers the whole body (§6.3). Click-time re-parse may
	 * refresh it. */
	range?: ChainRange;
	/** Name-only range (identifier span) when an LSP supplied it. The
	 * call/type-hierarchy anchors resolve at this position: the full-range
	 * start can sit on a JSDoc / decorator line where `prepareCallHierarchy`
	 * returns nothing (review #8). Falls back to `range` when absent. */
	selectionRange?: ChainRange;
	resolveStatus: ResolveStatus;
	/** Non-empty only for `ambiguous` (or the interface subtype seeds, §5). */
	candidates?: ChainCandidate[];
}

/** Host output: every field the panel renders, positions LSP-verified. */
export interface ResolvedNode {
	id: string;
	label: string;
	kind: ChainKind;
	summary: string;
	edgeNote?: string;
	/** Story-beat annotation carried through from the draft (optional; the
	 * panel renders it only when present). */
	beat?: string;
	provenance: NodeProvenance;
	location: ChainLocation;
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
	/** The chain's coherent business story in the user's language (markdown,
	 * ≤ MAX_NARRATIVE_CHARS). Optional for wire compatibility: chains saved
	 * before the narrative rollout carry none, and the panel renders no
	 * story block for them. */
	narrative?: string;
}

// ── structural caps (§3: enforced by the host, relayed back to the LLM) ────

/** Whole-tree depth budget. A seed draft stays shallow (spine ≤ 3 levels)
 * and goes deeper via ExtendCodeChainNode chunks; 4 is the hard ceiling. */
export const MAX_CHAIN_DEPTH = 4;
/** Whole-tree node budget. Smaller than the original 80 on purpose: large
 * trees are built progressively (one ≤ MAX_EXTEND_NODES chunk per call),
 * so no single payload has to carry the whole chain. */
export const MAX_CHAIN_NODES = 48;
export const MAX_SUMMARY_CHARS = 120;
/** `CodeChain.narrative` length cap — a 300–600 char story, truncated at
 * 1200 if the model overshoots. */
export const MAX_NARRATIVE_CHARS = 1200;
/** Per-node story-beat cap (the node's role inside the narrative). */
export const MAX_BEAT_CHARS = 60;
/** Children one ExtendCodeChainNode call may attach — the chunk size the
 * payload guard assumes for shard guidance. */
export const MAX_EXTEND_NODES = 8;

// ── panel message vocabulary (§6.4) ────────────────────────────────────────

/** Host → panel. `chain` is the whole-tree message (open / refresh /
 * re-render / reveal-after-reload); `sync` marks the node the active editor
 * landed on; `tourState` mirrors the tour cursor; `toast` surfaces a
 * one-line status.
 *
 * DEVIATION from §6.4: the incremental `{t:'patch',ops}` channel was cut in
 * v1 — every update re-sends the whole tree (≤48 nodes). The panel keeps
 * selection / collapse / cursor across a re-send (§6.3 state preservation),
 * so the full-tree push is behaviorally equivalent for its consumers. */
export type ToPanel =
	| { t: 'chain'; chain: CodeChain }
	| { t: 'sync'; nodeId: string | null }
	| { t: 'tourState'; index: number; total: number }
	| { t: 'toast'; message: string };

/** Panel → host. `nodeClick` jumps the editor (focus=false keeps it in the
 * panel); `tour` steps the DFS cursor; `pickCandidate` resolves an
 * ambiguity; `findRefs` opens a references lookup; `regen` backfills the
 * chain's question into the sidebar composer (§10 read-only reopen path);
 * `ready` is emitted once at bundle mount — the host answers by re-sending
 * the current snapshot, because `retainContextWhenHidden:false` lets VS
 * Code discard the webview when the tab hides and a re-shown tab reloads to
 * an empty React tree (review #1); `log` relays console diagnostics. */
export type FromPanel =
	| { t: 'ready' }
	| { t: 'nodeClick'; nodeId: string; focus: boolean }
	| { t: 'tour'; dir: 'prev' | 'next' }
	| { t: 'refresh' }
	| { t: 'pickCandidate'; nodeId: string; index: number }
	| { t: 'findRefs'; nodeId: string }
	| { t: 'regen'; question: string }
	| { t: 'log'; level: 'info' | 'warn' | 'error'; message: string };
