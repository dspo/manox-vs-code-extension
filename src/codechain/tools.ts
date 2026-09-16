// The four GenCodeChain client tools (§4): their wire specs (what the model
// sees) and the invoke handlers (what the host runs when the server routes
// an `invokeClientTool` ServerCall here).
//
// Reply contract (§9.3, pinned by guards.test): every business outcome —
// success, self-correction feedback, hard failure — answers through
// `reply.ok({content, isError})`. `content` becomes the toolResult journal
// output the model reads; a failure writes human/LLM-readable text with
// `isError: true` so the model can self-correct, never an RPC Err (which
// the server wraps identically but loses the structured payload). The only
// paths that `reply.err` here are frames that never reached a valid tool
// call at all (unknown tool name / non-object input).
//
// Tool naming: registration carries the BARE names; the server prefixes
// `client_` for the model (§9.2). Descriptions and prompt text therefore
// mention the prefixed names; the dispatcher accepts both forms (§Phase 0:
// match on whatever the server's wire name turns out to be).

import { errorText } from '../util';
import type { ChainStore } from './chainStore';
import { replaceNode, withStats } from './chainStore';
import type {
	CodeChain,
	ChainNodeDraft,
	ResolvedNode,
} from './types';
import { MAX_SUMMARY_CHARS } from './types';
import {
	expandNode,
	expansionKey,
	resolveChain,
	resolveSymbol,
	validateDraft,
	type ResolveDeps,
} from './resolve';

// ── wire specs (§8 prompts, verbatim tool names with the `client_` prefix) ─

export interface ToolSpec {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
}

const GEN_CODE_CHAIN_DESCRIPTION =
	"Render an interactive code-reading tour for the user. Call this AFTER you have read the relevant code (with read/grep tools) and can explain a business flow end-to-end. Output a tree: the entry point as root, each child a meaningful step in the flow (calls, implementations, config, domain events). Rules: (1) NEVER report line numbers — give `file` (workspace-relative) and `symbol` (exact name, `Class.method` for methods); the host resolves precise locations via LSP and rejects bad ones, so prefer symbols you have actually seen in the files you read. (2) Every node needs a `summary` explaining its BUSINESS meaning in the user's language, not a restatement of the code. (3) `edgeNote` explains why this step follows its parent. (4) Keep depth <= 5 and <= 40 nodes: cover the main flow, omit logging/error-plumbing unless the user asked. (5) Use kind='note' (no symbol) for conceptual steps that have no single code location. If the host returns resolution errors, fix only the failed nodes and call again.";

const EXPAND_DESCRIPTION =
	"Expand one node of an existing code chain with REAL call-graph edges resolved by the host via LSP call hierarchy — no guessing, no token cost for reading files. Use when the user asks to go deeper (\"这个函数里面还调了什么\"/\"谁调用了它\"). direction='callees' expands what the node calls; 'callers' expands who calls it. Afterwards use client_AnnotateCodeChainNode to add business meaning to the newly added nodes.";

/** The draft-tree JSON Schema (recursion via `$defs`/`$ref` — a JS object
 * literal with a self-reference would break `JSON.stringify` on send). */
const draftTreeSchema = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['title', 'question', 'root'],
	properties: {
		title: { type: 'string', description: 'Short name of the business flow, e.g. "订单创建流程".' },
		question: { type: 'string', description: "The user's original question." },
		root: { $ref: '#/$defs/node' },
	},
	$defs: {
		node: {
			type: 'object',
			required: ['id', 'label', 'kind', 'file', 'summary'],
			properties: {
				id: { type: 'string', description: 'Stable slug, unique in the tree, e.g. "order-service.create".' },
				label: { type: 'string', description: 'Display name (usually the symbol name).' },
				kind: {
					type: 'string',
					enum: ['entry', 'call', 'impl', 'interface', 'config', 'data', 'note'],
				},
				file: { type: 'string', description: 'Workspace-relative path (no absolute paths, no line numbers).' },
				symbol: { type: 'string', description: "Exact symbol name; `Class.method` for members. Omit only for kind='note'." },
				summary: { type: 'string', maxLength: MAX_SUMMARY_CHARS, description: 'Business meaning in the user language.' },
				edgeNote: { type: 'string', description: 'Why this step follows its parent.' },
				children: { type: 'array', items: { $ref: '#/$defs/node' } },
			},
		},
	},
};

export function clientToolSpecs(): ToolSpec[] {
	return [
		{
			name: 'GenCodeChain',
			description: GEN_CODE_CHAIN_DESCRIPTION,
			inputSchema: draftTreeSchema,
			readOnly: true,
		},
		{
			name: 'ExpandCodeChainNode',
			description: EXPAND_DESCRIPTION,
			inputSchema: {
				type: 'object',
				required: ['chainId', 'nodeId', 'direction'],
				properties: {
					chainId: { type: 'string' },
					nodeId: { type: 'string' },
					direction: { type: 'string', enum: ['callees', 'callers'] },
					depth: { type: 'integer', minimum: 1, maximum: 3, description: 'Levels to expand (v1: 1).' },
				},
			},
			readOnly: true,
		},
		{
			name: 'AnnotateCodeChainNode',
			description:
				'Attach business semantics (summary / edgeNote) to a node of an existing code chain — typically right after client_ExpandCodeChainNode added LSP-resolved nodes that have no annotation yet. Only the named node changes; everything else keeps its state.',
			inputSchema: {
				type: 'object',
				required: ['chainId', 'nodeId'],
				anyOf: [{ required: ['chainId', 'nodeId', 'summary'] }, { required: ['chainId', 'nodeId', 'edgeNote'] }],
				properties: {
					chainId: { type: 'string' },
					nodeId: { type: 'string' },
					summary: { type: 'string', maxLength: MAX_SUMMARY_CHARS },
					edgeNote: { type: 'string' },
				},
			},
			readOnly: true,
		},
		{
			name: 'RefreshCodeChain',
			description:
				'Re-resolve every node of an existing code chain through LSP (symbols move while the user edits). Returns which nodes moved, recovered, or went stale. Call when the user reports a node jumping oddly or before relying on stale positions.',
			inputSchema: {
				type: 'object',
				required: ['chainId'],
				properties: { chainId: { type: 'string' } },
			},
			readOnly: true,
		},
	];
}

// ── invoke handling ─────────────────────────────────────────────────────────

/** Outward sinks: how the tools reach the surfaces they drive. The
 * interceptor answers replies; `showChain`/`updateChain` own the panel;
 * `verb` posts the out-of-band journal-card push to the sidebar (§7). */
export interface ToolSinks {
	/** Reveal (or update + keep) the panel for `chain`. */
	showChain(chain: CodeChain): void;
	/** Update an open panel for `chain` without revealing. */
	updateChain(chain: CodeChain): void;
	/** Out-of-band sidebar note (`{t:'verb', kind:'code_chain', …}`). */
	verb(note: { sessionId: string; chainId: string; title: string; nodeCount: number }): void;
	log(message: string): void;
}

export interface InvokeCall {
	sessionId: string;
	name: string;
	input: unknown;
}

export interface ReplySinks {
	ok(content: string, isError: boolean): void;
	err(message: string): void;
}

/** Self-correction round cap (§4): after this many GenCodeChain calls that
 * still report failures, render with a warning instead of rejecting. */
const MAX_CORRECTION_ROUNDS = 3;

const ok = (reply: ReplySinks, payload: Record<string, unknown>): void =>
	reply.ok(JSON.stringify(payload), false);
const fail = (reply: ReplySinks, payload: Record<string, unknown>): void =>
	reply.ok(JSON.stringify(payload), true);
const failText = (reply: ReplySinks, message: string): void =>
	reply.ok(message, true);

export class CodeChainTools {
	/** Failed GenCodeChain attempts keyed by `session:rootId` (the model is
	 * iterating on one chain; a new root id starts fresh). */
	private readonly correctionAttempts = new Map<string, number>();

	constructor(
		private readonly deps: ResolveDeps,
		private readonly store: ChainStore,
		private readonly sinks: ToolSinks,
	) {}

	/** Route one `invokeClientTool`. Returns false for names that are not
	 * ours (the caller keeps its fail-closed path); true when the reply
	 * sinks have been (or will synchronously be) answered. */
	async handle(call: InvokeCall, reply: ReplySinks): Promise<boolean> {
		// Match the bare or the server-prefixed name — the processor is
		// agnostic to which form the wire carries (Phase 0 conclusion).
		const name = call.name.startsWith('client_') ? call.name.slice('client_'.length) : call.name;
		try {
			switch (name) {
				case 'GenCodeChain':
					await this.genCodeChain(call, reply);
					return true;
				case 'ExpandCodeChainNode':
					await this.expand(call, reply);
					return true;
				case 'AnnotateCodeChainNode':
					this.annotate(call, reply);
					return true;
				case 'RefreshCodeChain':
					await this.refresh(call, reply);
					return true;
				default:
					return false;
			}
		} catch (e) {
			// A host-side crash is still a tool failure the model can read;
			// never let it stall the 300s reply window.
			failText(reply, `client tool \`${call.name}\` failed: ${errorText(e)}`);
			return true;
		}
	}

	// ── GenCodeChain ────────────────────────────────────────────────────────

	private async genCodeChain(call: InvokeCall, reply: ReplySinks): Promise<void> {
		const input = asRecord(call.input);
		if (!input) return failText(reply, 'GenCodeChain input must be an object');
		const title = asString(input.title);
		const question = asString(input.question) ?? '';
		const rootParse = parseDraft(input.root, '');
		if (!title || !rootParse.draft) {
			return failText(
				reply,
				'GenCodeChain requires `title` and a `root` node with {id,label,kind,file,summary}; every child needs the same shape',
			);
		}
		const { draft, warnings } = validateDraft(rootParse.draft);
		// Malformed nodes `parseDraft` dropped are reported as failures so the
		// model can repair them (review round-2, issue: they used to vanish
		// silently while the reply still claimed the tree was fine).
		const dropped: { id: string; reason: string }[] = rootParse.dropped.map((where) => ({
			id: where,
			reason: `dropped \`${where}\` — missing/invalid id, label, or kind (see the tool schema)`,
		}));
		const key = `${call.sessionId}:${draft.id}`;
		const { chain, failures } = await resolveChain(this.deps, {
			sessionId: call.sessionId,
			title,
			question,
			root: draft,
		});
		if (dropped.length > 0) {
			failures.unshift(...dropped);
		}
		if (failures.length > 0) {
			const attempts = (this.correctionAttempts.get(key) ?? 0) + 1;
			this.correctionAttempts.set(key, attempts);
			if (attempts <= MAX_CORRECTION_ROUNDS) {
				// Self-correction loop: every failure names its node.
				return fail(reply, {
					ok: false,
					attempt: attempts,
					maxAttempts: MAX_CORRECTION_ROUNDS + 1,
					failures: failures.map((f) => ({ nodeId: f.id, reason: f.reason })),
					hint: 'Fix ONLY the listed nodes (file/symbol you have actually read) and call client_GenCodeChain again with the whole tree.',
				});
			}
			this.correctionAttempts.delete(key);
		} else {
			this.correctionAttempts.delete(key);
		}
		this.publish(chain);
		return ok(reply, {
			ok: true,
			chainId: chain.chainId,
			title: chain.title,
			nodeCount: chain.stats.nodeCount,
			unresolvedCount: chain.stats.unresolvedCount,
			panelOpened: true,
			...(warnings.length > 0 ? { warnings } : {}),
			...(failures.length > 0
				? { note: `${failures.length} node(s) stayed unresolved after ${MAX_CORRECTION_ROUNDS} correction rounds; they render as warnings` }
				: {}),
		});
	}

	private publish(chain: CodeChain): void {
		this.store.save(chain);
		this.sinks.showChain(chain);
		this.sinks.verb({
			sessionId: chain.sessionId,
			chainId: chain.chainId,
			title: chain.title,
			nodeCount: chain.stats.nodeCount,
		});
	}

	// ── ExpandCodeChainNode ─────────────────────────────────────────────────

	private async expand(call: InvokeCall, reply: ReplySinks): Promise<void> {
		const loaded = this.chainOf(call, reply, 'ExpandCodeChainNode');
		if (!loaded) return;
		const { input, chain } = loaded;
		const nodeId = asString(input.nodeId);
		const direction = asString(input.direction);
		if (!nodeId || (direction !== 'callees' && direction !== 'callers')) {
			return failText(reply, 'ExpandCodeChainNode requires {chainId, nodeId, direction: "callees"|"callers"}');
		}
		const target = findNode(chain.root, nodeId);
		if (!target) return fail(reply, { ok: false, error: `no node \`${nodeId}\` in chain \`${chain.chainId}\`` });
		// Dedup identity (§resolve.expansionKey): `label@<relative-path>` —
		// the LLM slugs and the `callees:`-prefixed expansion ids share no
		// structure, so only the normalized graph key can match.
		const existing = new Set<string>();
		for (const node of flatten(chain.root)) {
			if (node.location.uri) existing.add(expansionKey(this.deps.workspace, node.label, node.location.uri));
		}
		const outcome = await expandNode(this.deps.lsp, this.deps.workspace, target, direction, existing);
		if (outcome.error) return fail(reply, { ok: false, error: outcome.error });
		if (outcome.added.length === 0) {
			return ok(reply, { ok: true, chainId: chain.chainId, added: [], note: 'no new edges at this level' });
		}
		const depth = typeof input.depth === 'number' ? Math.max(1, Math.min(3, input.depth)) : 1;
		// `depth > 1` is a documented v1 clamp: one real expansion per call.
		// The hierarchy item's `range` is already its selectionRange.
		const addedNodes: ResolvedNode[] = outcome.added.map((a) => ({
			id: a.id,
			label: a.label,
			kind: 'call' as const,
			summary: '',
			edgeNote: direction === 'callees' ? 'real call edge' : 'real caller edge',
			provenance: a.provenance,
			location: {
				uri: a.uri,
				range: a.range,
				selectionRange: a.range,
				resolveStatus: 'ok' as const,
			},
			children: [],
		}));
		const next = withStats({
			...chain,
			root: replaceNode(chain.root, nodeId, (node) => ({ ...node, children: [...node.children, ...addedNodes] })).root,
		});
		this.store.save(next);
		this.sinks.updateChain(next);
		return ok(reply, {
			ok: true,
			chainId: next.chainId,
			added: addedNodes.map((n) => ({ nodeId: n.id, label: n.label, file: uriToLabel(n.location.uri) })),
			depthClamped: depth > 1 ? 1 : undefined,
			hint: 'Add business summaries with client_AnnotateCodeChainNode.',
		});
	}

	// ── AnnotateCodeChainNode ───────────────────────────────────────────────

	private annotate(call: InvokeCall, reply: ReplySinks): void {
		const loaded = this.chainOf(call, reply, 'AnnotateCodeChainNode');
		if (!loaded) return;
		const { input, chain } = loaded;
		const nodeId = asString(input.nodeId);
		const summary = asString(input.summary);
		const edgeNote = asString(input.edgeNote);
		if (!nodeId || (summary === null && edgeNote === null)) {
			return failText(reply, 'AnnotateCodeChainNode requires {chainId, nodeId} and at least one of summary/edgeNote');
		}
		const target = findNode(chain.root, nodeId);
		if (!target) return fail(reply, { ok: false, error: `no node \`${nodeId}\` in chain \`${chain.chainId}\`` });
		const next = withStats({
			...chain,
			root: replaceNode(chain.root, nodeId, (node) => ({
				...node,
				...(summary !== null ? { summary: summary.slice(0, MAX_SUMMARY_CHARS) } : {}),
				...(edgeNote !== null ? { edgeNote } : {}),
			})).root,
		});
		this.store.save(next);
		this.sinks.updateChain(next);
		ok(reply, { ok: true, chainId: next.chainId, nodeId });
	}

	// ── RefreshCodeChain ────────────────────────────────────────────────────

	/** Re-run symbol resolution on every node (§6.3 diff report): ok→ok with
	 * a moved range reports as moved; ok→miss reports as stale; anything→hit
	 * reports as fixed. Positions the model never claimed are untouched. */
	private async refresh(call: InvokeCall, reply: ReplySinks): Promise<void> {
		const loaded = this.chainOf(call, reply, 'RefreshCodeChain');
		if (!loaded) return;
		const { chain } = loaded;
		const moved: string[] = [];
		const stale: string[] = [];
		const fixed: string[] = [];
		const reroll = async (node: ResolvedNode): Promise<ResolvedNode> => {
			const children: ResolvedNode[] = [];
			// `children === node.children` is never true (a fresh array each
			// pass), so a structural no-op can't be detected by reference —
			// compare the re-resolved children element-wise instead (review
			// round-2, suggestion 5).
			let childrenChanged = false;
			for (const [i, child] of node.children.entries()) {
				const next = await reroll(child);
				if (next !== child) childrenChanged = true;
				children.push(next);
			}
			// A node with no claimed position (note, or file-miss) has
			// nothing to re-resolve — re-locating by text would invent one.
			if (
				node.kind === 'note' ||
				node.location.uri === '' ||
				node.location.symbolPath === undefined ||
				node.location.symbolPath.length === 0
			) {
				return childrenChanged ? { ...node, children } : node;
			}
			const symbol = node.location.symbolPath.join('.');
			const hit = await resolveSymbol(this.deps.lsp, node.location.uri, symbol, node.kind);
			const same =
				!!hit.location.range &&
				!!node.location.range &&
				hit.location.range.startLine === node.location.range.startLine &&
				hit.location.range.endLine === node.location.range.endLine;
			if (node.location.resolveStatus === 'ok') {
				// Position unchanged: only rebuild if a descendant moved, else
				// hand back the SAME node so a no-op refresh re-pushes nothing.
				if (same) return childrenChanged ? { ...node, children } : node;
				if (hit.location.resolveStatus === 'ok') {
					moved.push(node.id);
					return { ...node, children, location: { ...hit.location, file: node.location.file } };
				}
				stale.push(node.id);
				return { ...node, children, location: { ...node.location, resolveStatus: 'stale' as const } };
			}
			if (hit.location.resolveStatus === 'ok') {
				fixed.push(node.id);
				return { ...node, children, location: { ...hit.location, file: node.location.file } };
			}
			return childrenChanged || hit.location !== node.location
				? { ...node, children, location: hit.location }
				: node;
		};
		const root = await reroll(chain.root);
		const next = withStats({ ...chain, root });
		if (root !== chain.root) {
			this.store.save(next);
			this.sinks.updateChain(next);
		}
		return ok(reply, {
			ok: true,
			chainId: next.chainId,
			moved,
			stale,
			fixed,
			unresolvedCount: next.stats.unresolvedCount,
		});
	}

	// ── shared plumbing ─────────────────────────────────────────────────────

	/** Validate the object-input + chainId and load the stored chain, or
	 * answer `reply` and return null. Every non-object / missing-chainId
	 * path MUST reply: `handle()` has already claimed the call, so a silent
	 * `return` here would leave the server waiting the full 300s
	 * (un-cancellable per §9.3) — review #5. */
	private chainOf(call: InvokeCall, reply: ReplySinks, toolName: string): { input: Record<string, unknown>; chain: CodeChain } | null {
		const input = asRecord(call.input);
		if (!input) {
			failText(reply, `${toolName} input must be an object`);
			return null;
		}
		const chainId = asString(input.chainId);
		if (!chainId) {
			failText(reply, `${toolName} needs a \`chainId\` from the client_GenCodeChain result`);
			return null;
		}
		const chain = this.store.get(chainId);
		if (!chain) {
			fail(reply, { ok: false, error: `unknown chainId \`${chainId}\` — generate one first with client_GenCodeChain` });
			return null;
		}
		return { input, chain };
	}
}

// ── draft parsing (input face) ──────────────────────────────────────────────

const KINDS: ReadonlySet<string> = new Set([
	'entry',
	'call',
	'impl',
	'interface',
	'config',
	'data',
	'note',
]);

/** Parse one draft node recursively. The caps are `validateDraft`'s job —
 * this only enforces required vocabulary so the resolver never sees a junk
 * kind, and it REPORTS every child it has to drop: a silently-omitted node
 * reads back to the model as a successful tree (review round-2, issue).
 * `dropped` carries a path locating each discarded node (e.g.
 * `root/children[2]`), accumulating from the root down. */
function parseDraft(raw: unknown, path: string): { draft: ChainNodeDraft | null; dropped: string[] } {
	const dropped: string[] = [];
	const node = asRecord(raw);
	if (!node) return { draft: null, dropped };
	const id = asString(node.id);
	const label = asString(node.label);
	const kind = asString(node.kind);
	const file = asString(node.file) ?? '';
	const summary = asString(node.summary) ?? '';
	if (!id || !label || !kind || !KINDS.has(kind)) return { draft: null, dropped };
	const children: ChainNodeDraft[] = [];
	if (Array.isArray(node.children)) {
		for (const [i, child] of node.children.entries()) {
			const childPath = `${path}/${id}/children[${i}]`;
			const childResult = parseDraft(child, childPath);
			dropped.push(...childResult.dropped);
			if (childResult.draft) children.push(childResult.draft);
			else dropped.push(childPath);
		}
	}
	const draft: ChainNodeDraft = {
		id,
		label,
		kind: kind as ChainNodeDraft['kind'],
		file,
		...(asString(node.symbol) !== null ? { symbol: asString(node.symbol) as string } : {}),
		summary,
		...(asString(node.edgeNote) !== null ? { edgeNote: asString(node.edgeNote) as string } : {}),
		children,
	};
	return { draft, dropped };
}

// ── tree helpers (shared with panel/navigation via the store) ───────────────

export function findNode(root: ResolvedNode, id: string): ResolvedNode | null {
	if (root.id === id) return root;
	for (const child of root.children) {
		const hit = findNode(child, id);
		if (hit) return hit;
	}
	return null;
}

export function* flatten(root: ResolvedNode): Generator<ResolvedNode> {
	yield root;
	for (const child of root.children) yield* flatten(child);
}

/** Last path segment for compact reply payloads. */
const uriToLabel = (uri: string): string => uri.split('/').pop() ?? uri;

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asRecord = (v: unknown): Record<string, unknown> | null =>
	typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
