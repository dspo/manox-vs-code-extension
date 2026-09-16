// The six GenCodeChain client tools (§4): their wire specs (what the model
// sees) and the invoke handlers (what the host runs when the server routes
// an `invokeClientTool` ServerCall here). GenCodeChain seeds the spine only;
// NarrateCodeChain commits the business story as its OWN call and
// ExtendCodeChainNode grows the tree in ≤ MAX_EXTEND_NODES chunks, so no
// single payload has to carry a whole business flow AND the story together
// (the real-model evidence: narrative + tree in one GenCodeChain reply blew
// the ~5KB qwen3.8-flash output budget through Bailian and cut the stream
// mid-JSON — splitting the story into a third call keeps every call well
// under its payload guard, which the guards below enforce with shard
// guidance instead of letting the server truncate them silently).
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
import { countNodes, replaceNode, withStats } from './chainStore';
import type {
	ChainCandidate,
	ChainLocation,
	ChainRange,
	CodeChain,
	ChainNodeDraft,
	ResolvedNode,
} from './types';
import {
	MAX_BEAT_CHARS,
	MAX_CHAIN_DEPTH,
	MAX_CHAIN_NODES,
	MAX_EXTEND_NODES,
	MAX_NARRATIVE_CHARS,
	MAX_SUMMARY_CHARS,
} from './types';
import {
	expandNode,
	expansionKey,
	resolveChain,
	resolveFileUri,
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

// Business-first curation rules, in priority order. They replace the old
// generic "meaningful step" wording because, left to itself, the model
// dumps middleware/validators/error plumbing and treats the depth budget as
// the goal instead of the business story. The size numbers mirror types.ts
// (seed guidance stays TIGHTER than the hard host caps — oversized drafts
// are truncated with warnings, not rejected).
const GEN_CODE_CHAIN_DESCRIPTION =
	"Render an interactive code-reading tour of a business flow. Call this AFTER you have read the relevant code (with read/grep tools) and can explain the flow end-to-end. Output the tree SPINE only — NOT the narrative (see rule 5). Curation rules, in priority order: (1) BUSINESS LOOP FIRST: include a node only when the step changes or carries business state data — acceptance -> core validation -> state change -> event/settlement -> outlet. Each `summary` (<= 120 chars) says what happens BUSINESS-wise in the user's language, never a restatement of the code. (2) DO NOT DESCEND INTO BOILERPLATE: middleware chains, request-parameter format validation, idempotency checks, audit logging, error wrapping, and DTO conversion must NOT become nodes; if such a step has a genuine business exception, fold it into the parent's summary or `edgeNote` in one sentence. (3) PRUNE BRANCHES: expand only branches whose alternatives differ in business meaning; summarize all error/rollback paths in at most ONE kind='note' node. (4) SIZE: seed the spine only — <= 8 nodes and <= 3 levels, and keep the WHOLE JSON of this call around ~2.5 KB or less (hard caps: " + MAX_CHAIN_NODES + " nodes / 4 levels, over-tall or over-wide drafts are truncated; larger payloads are rejected by the host). Grow deeper or wider afterwards with client_ExtendCodeChainNode, one chunk of <= " + MAX_EXTEND_NODES + " new nodes per call. (5) NARRATIVE IS A SEPARATE CALL: do NOT put a `narrative` field here — right after this seed succeeds, call client_NarrateCodeChain once with the chainId and the 300-600 character coherent business story in markdown (trigger -> key decisions -> state transitions -> external consequences). Tree nodes are the anchors of THAT story, not a directory listing; the story rides its own call so neither the seed nor the narrative has to fit one payload. Contract (unchanged): NEVER report line numbers — give `file` (workspace-relative) and `symbol` (exact name, `Class.method` for methods); the host resolves precise locations via LSP and rejects bad ones, so prefer symbols you have actually seen in the files you read. Use kind='note' (no symbol) for conceptual steps with no single code location. If the host returns resolution errors, fix only the failed nodes and call again.";

const EXPAND_DESCRIPTION =
	"Expand one node of an existing code chain with REAL call-graph edges resolved by the host via LSP call hierarchy — no guessing, no token cost for reading files. Use when the user asks to go deeper (\"这个函数里面还调了什么\"/\"谁调用了它\") or for a real caller/callee edge you confirmed in code. For a node whose CHILDREN you already read and understood, prefer client_ExtendCodeChainNode (your curated draft subtree, with beats); use this tool when the edge set itself must come from the graph. direction='callees' expands what the node calls; 'callers' expands who calls it. Afterwards use client_AnnotateCodeChainNode to add business meaning to the newly added nodes.";

const ANNOTATE_DESCRIPTION =
	'Attach business semantics (summary / edgeNote) to a node of an existing code chain — typically right after client_ExpandCodeChainNode added LSP-resolved nodes that have no annotation yet (newly drafted nodes carry their own summary/beat through client_ExtendCodeChainNode). Only the named node changes; everything else keeps its state.';

// ── payload guards (progressive-building contract) ─────────────────────────
//
// The server forwards a client-tool input as one serialized frame; an
// oversized draft (the model ignoring the seed caps) would either die
// opaquely in transport or arrive half-truncated. Reject it HERE with the
// actual size + the exact re-shard recipe, so the correction loop can act:
// smaller chunks via client_ExtendCodeChainNode, summaries <= 120 chars,
// NEVER the same payload resent.

const MAX_GEN_PAYLOAD_CHARS = 3_000;
const MAX_EXTEND_PAYLOAD_CHARS = 3_000;
/** The narrative rides its own call (client_NarrateCodeChain); this guard is
 * a headroom ceiling well under the model's ~5KB output budget — a story
 * over MAX_NARRATIVE_CHARS but inside this limit is truncated by the handler,
 * one past it is rejected with a compress-to-1200 instruction. */
const MAX_NARRATE_PAYLOAD_CHARS = 2_000;

const payloadTooLarge = (toolName: string, actual: number, limit: number): string =>
	`payload too large: ${actual} chars exceeds the ${limit} char limit for ${toolName}. Shrink it: keep the whole tree inside one block of <= ${MAX_EXTEND_NODES} new nodes per call (seed the spine with client_GenCodeChain, attach the rest one block at a time via client_ExtendCodeChainNode), keep every \`summary\` <= ${MAX_SUMMARY_CHARS} chars, drop boilerplate steps (middleware, parameter validation, logging, DTO conversion) and the oversized narrative (<= ${MAX_NARRATIVE_CHARS} chars) — NEVER resend the same payload unchanged.`;

/** Draft-node properties, shared by both tree-bearing schemas (Gen's
 * recursive root and Extend's `children` items) so the two wire faces can
 * never drift apart. */
const NODE_PROPERTIES = {
	id: { type: 'string', description: 'Stable slug, unique in the tree, e.g. "order-service.create".' },
	label: { type: 'string', description: 'Display name (usually the symbol name).' },
	kind: {
		type: 'string',
		enum: ['entry', 'call', 'impl', 'interface', 'config', 'data', 'note'],
	},
	file: { type: 'string', description: 'Workspace-relative path (no absolute paths, no line numbers).' },
	symbol: { type: 'string', description: "Exact symbol name; `Class.method` for members. Omit only for kind='note'." },
	summary: { type: 'string', maxLength: MAX_SUMMARY_CHARS, description: 'What happens BUSINESS-wise, in the user language (<= 120 chars).' },
	edgeNote: { type: 'string', description: 'Why this step follows its parent.' },
	beat: { type: 'string', maxLength: MAX_BEAT_CHARS, description: 'This node\'s one story-beat inside the narrative (<= 60 chars).' },
};

/** The draft-tree JSON Schema (recursion via `$defs`/`$ref` — a JS object
 * literal with a self-reference would break `JSON.stringify` on send). No
 * `narrative` here: the business story is committed separately with
 * client_NarrateCodeChain so the seed tree and the story never share one
 * output-budget-bound payload (see the module header). */
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
				...NODE_PROPERTIES,
				children: { type: 'array', items: { $ref: '#/$defs/node' } },
			},
		},
	},
};

/** ExtendCodeChainNode input: one parent + a ≤ MAX_EXTEND_NODES chunk of
 * new children under it (same recursive node shape as the seed tree). */
const extendSchema = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['chainId', 'parentId', 'children'],
	properties: {
		chainId: { type: 'string' },
		parentId: { type: 'string', description: 'Existing node the children attach under.' },
		narrative: {
			type: 'string',
			maxLength: MAX_NARRATIVE_CHARS,
			description: 'Optional replacement for the chain narrative (pass the UPDATED story when this chunk changes it; omit to keep the current one).',
		},
		children: {
			type: 'array',
			maxItems: MAX_EXTEND_NODES,
			items: { $ref: '#/$defs/node' },
		},
	},
	$defs: {
		node: {
			type: 'object',
			required: ['id', 'label', 'kind', 'file', 'summary'],
			properties: {
				...NODE_PROPERTIES,
				children: { type: 'array', items: { $ref: '#/$defs/node' } },
			},
		},
	},
};

/** NarrateCodeChain input: the chain id plus the business story alone. Its
 * own schema (no tree) so the narrative never shares a payload with a draft. */
const narrateSchema = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['chainId', 'narrative'],
	properties: {
		chainId: { type: 'string' },
		narrative: {
			type: 'string',
			maxLength: MAX_NARRATIVE_CHARS,
			description: 'The coherent business story this chain anchors (markdown, 300-600 chars, <= 1200 hard cap).',
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
			name: 'NarrateCodeChain',
			description:
				'Commit the business story of an existing code chain — call this right AFTER client_GenCodeChain seeds the spine (the seed call itself carries NO narrative; the story rides this separate call so neither payload has to fit the model output budget together). Pass the `chainId` from the client_GenCodeChain reply and ONLY the narrative text: a 300-600 character coherent business story in markdown (trigger -> key decisions -> state transitions -> external consequences), in the user language, <= ' +
				MAX_NARRATIVE_CHARS +
				' chars (longer is truncated). The tree nodes are the anchors of THAT story; write what the spine you just seeded adds up to, not a directory listing. This only sets the narrative — the tree is untouched; re-call to replace the story.',
			inputSchema: narrateSchema,
			readOnly: true,
		},
		{
			name: 'ExtendCodeChainNode',
			description:
				"Grow an existing code chain: attach a block of <= " + MAX_EXTEND_NODES + " NEW draft nodes under an existing one (parentId = chain node id from client_GenCodeChain or an earlier client_ExtendCodeChainNode reply). Use this after the seed to go deeper or wider, one business sub-area per call — read the parent function first and keep every node on the business loop (boilerplate stays out, same curation rules as client_GenCodeChain). Each new node carries its own `summary` and optional `beat`; pass an UPDATED `narrative` only when this block changes the story. The host resolves every symbol through LSP and runs the same self-correction loop, so submit only symbols you have actually seen.",
			inputSchema: extendSchema,
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
			description: ANNOTATE_DESCRIPTION,
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
				case 'NarrateCodeChain':
					this.narrateCodeChain(call, reply);
					return true;
				case 'ExtendCodeChainNode':
					await this.extendCodeChain(call, reply);
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
		if (this.guardPayload(reply, call.input, MAX_GEN_PAYLOAD_CHARS, 'GenCodeChain')) return;
		const title = asString(input.title);
		const question = asString(input.question) ?? '';
		// The narrative moved to its own call (client_NarrateCodeChain) — the
		// seed payload must not carry the story too (real-model evidence: a
		// narrative + tree in one GenCodeChain reply blew the ~5KB output
		// budget and cut the stream mid-JSON). Reject a stray `narrative`
		// field so the model self-corrects to the documented split flow.
		if (input.narrative !== undefined) {
			return failText(
				reply,
				'GenCodeChain no longer accepts a `narrative` field. Seed the spine here, then commit the business story with a separate client_NarrateCodeChain call ({chainId, narrative}) using this reply\'s chainId.',
			);
		}
		const rootParse = parseDraft(input.root, '');
		if (!title || !rootParse.draft) {
			return failText(
				reply,
				'GenCodeChain requires `title` and a `root` node with {id,label,kind,file,summary}; every child needs the same shape (the narrative is committed separately with client_NarrateCodeChain)',
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
			// The spine is up but the story is not: point the model at the two
			// follow-up calls that stay within one output budget each.
			nextStep: 'call client_NarrateCodeChain with the business story, then extend with client_ExtendCodeChainNode',
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

	// ── NarrateCodeChain ──────────────────────────────────────────────────────

	/** Commit the chain's business story on its own — the third payload of the
	 * progressive flow (seed → narrate → extend), split out so the narrative
	 * never shares a model-output budget with the tree. Runs NO resolution:
	 * it just sets `chain.narrative` and re-pushes. `stats` ignore the
	 * narrative, so `withStats` is a no-op here and a plain spread suffices.
	 * Over-cap stories are truncated (with a warning) rather than rejected;
	 * a payload past the headroom guard is refused with a compress-to-cap
	 * instruction (the story alone must fit this call). */
	private narrateCodeChain(call: InvokeCall, reply: ReplySinks): void {
		const loaded = this.chainOf(call, reply, 'NarrateCodeChain');
		if (!loaded) return;
		const { input, chain } = loaded;
		const raw = asString(input.narrative);
		if (raw === null || raw.trim() === '') {
			return failText(reply, 'NarrateCodeChain requires a non-empty `narrative` string (the 300-600 char business story)');
		}
		// The story ALONE rides this payload; if even that overruns the
		// headroom guard there is nothing to re-shard — the fix is to compress
		// the narrative to the cap, not to split the tree (that was Gen's job).
		const actual = JSON.stringify(call.input ?? null)?.length ?? 0;
		if (actual > MAX_NARRATE_PAYLOAD_CHARS) {
			return failText(
				reply,
				`payload too large: ${actual} chars exceeds the ${MAX_NARRATE_PAYLOAD_CHARS} char limit for NarrateCodeChain. Compress the \`narrative\` to <= ${MAX_NARRATIVE_CHARS} chars (a tight 300-600 char business story) — the narrative rides this call alone, so there is nothing to re-shard; NEVER resend the same payload unchanged.`,
			);
		}
		const warnings: string[] = [];
		let narrative = raw;
		if (raw.length > MAX_NARRATIVE_CHARS) {
			narrative = `${raw.slice(0, MAX_NARRATIVE_CHARS - 1)}…`;
			warnings.push(`narrative truncated to ${MAX_NARRATIVE_CHARS} chars`);
		}
		const next = { ...chain, narrative };
		this.store.save(next);
		this.sinks.updateChain(next);
		ok(reply, {
			ok: true,
			chainId: next.chainId,
			narrativeChars: narrative.length,
			...(warnings.length > 0 ? { warnings } : {}),
		});
	}

	// ── payload guard (shared by the two draft-bearing tools) ───────────────

	/** Answer a shard-guidance failure when the raw input serializes past
	 * `limit`; returns true (caller must stop) when it did. The size is
	 * measured on `JSON.stringify(input)` — the shape that travels the wire,
	 * so the number in the message matches what the model actually sent. */
	private guardPayload(reply: ReplySinks, input: unknown, limit: number, toolName: string): boolean {
		const actual = JSON.stringify(input ?? null)?.length ?? 0;
		if (actual <= limit) return false;
		// `reply.ok(content, isError:true)` = the fail-text channel; the model
		// reads the guidance and re-shards, never an RPC Err (§9.3).
		failText(reply, payloadTooLarge(toolName, actual, limit));
		return true;
	}

	// ── ExtendCodeChainNode ─────────────────────────────────────────────────

	/** Attach a chunk of ≤ MAX_EXTEND_NODES new draft children under an
	 * existing node. Resolution runs per-call (fresh memos, same self-
	 * correct gate as GenCodeChain keyed by session + chain + parent). */
	private async extendCodeChain(call: InvokeCall, reply: ReplySinks): Promise<void> {
		const loaded = this.chainOf(call, reply, 'ExtendCodeChainNode');
		if (!loaded) return;
		if (this.guardPayload(reply, call.input, MAX_EXTEND_PAYLOAD_CHARS, 'ExtendCodeChainNode')) return;
		const { input, chain } = loaded;
		const parentId = asString(input.parentId);
		if (!parentId) return failText(reply, 'ExtendCodeChainNode requires `parentId` (an existing chain node id)');
		if (!Array.isArray(input.children) || input.children.length === 0) {
			return failText(reply, 'ExtendCodeChainNode requires a non-empty `children` array (<= ' + MAX_EXTEND_NODES + ' new nodes per call)');
		}
		const parent = findNode(chain.root, parentId);
		if (!parent) {
			const ids = [...flatten(chain.root)].slice(0, 10).map((n) => `\`${n.id}\``);
			return fail(reply, {
				ok: false,
				error: `no node \`${parentId}\` in chain \`${chain.chainId}\``,
				availableIds: ids,
			});
		}
		// The block is validated as a subtree whose root is the parent itself:
		// the caps (depth / node budget / summary / beat) then count against
		// the WHOLE chain, not just the new chunk. The wrapper is never
		// persisted — only `draft.children` attach.
		const blockParse = parseDraft(
			{ id: parentId, label: parent.label, kind: parent.kind, file: parent.location.file ?? '', summary: parent.summary, children: input.children },
			parentId,
		);
		if (!blockParse.draft) return failText(reply, 'ExtendCodeChainNode children must be valid draft nodes {id,label,kind,file,summary}');
		const { draft, warnings, narrative: validatedNarrative } = validateDraft(blockParse.draft, asString(input.narrative) ?? undefined);
		const children = draft.children ?? [];
		const dropped: { id: string; reason: string }[] = blockParse.dropped.map((where) => ({
			id: where,
			reason: `dropped \`${where}\` — missing/invalid id, label, or kind (see the tool schema)`,
		}));

		// Per-call memoization (mirrors resolveChain's own caches, which never
		// cross calls): a wedged provider cannot poison later calls, and a
		// chunk touching one file pays a single round-trip per symbol.
		const fileCache = new Map<string, string>();
		const symbolCache = new Map<string, Promise<{ location: ChainLocation; reason?: string }>>();
		const failures: { id: string; reason: string }[] = [];

		const resolveFile = async (file: string): Promise<string> => {
			let hit = fileCache.get(file);
			if (hit === undefined) {
				const resolved = await resolveFileUri(this.deps.workspace, file);
				hit = resolved.uri ?? `ERR ${resolved.reason ?? 'unresolvable file'}`;
				fileCache.set(file, hit);
			}
			return hit;
		};
		const cachedResolve = (uri: string, symbol: string | undefined, kind: ChainNodeDraft['kind']) => {
			const key = `${uri}#${symbol ?? ''}#${kind}`;
			let hit = symbolCache.get(key);
			if (!hit) {
				hit = resolveSymbol(this.deps.lsp, uri, symbol, kind);
				symbolCache.set(key, hit);
			}
			return hit;
		};
		const resolveDraft = async (node: ChainNodeDraft, depth: number): Promise<ResolvedNode> => {
			let location: ChainLocation;
			if (!node.file || node.file.trim() === '') {
				location = node.kind === 'note'
					? { uri: '', resolveStatus: 'ok' }
					: { uri: '', resolveStatus: 'unresolved' };
				if (node.kind !== 'note') failures.push({ id: node.id, reason: 'missing `file`' });
			} else {
				const fileHit = await resolveFile(node.file);
				if (fileHit.startsWith('ERR ')) {
					location = { uri: '', resolveStatus: 'unresolved' };
					failures.push({ id: node.id, reason: fileHit.slice(4) });
				} else {
					const hit = await cachedResolve(fileHit, node.symbol, node.kind);
					location = hit.location;
					if (hit.reason) failures.push({ id: node.id, reason: hit.reason });
				}
			}
			// Defensive re-check of the whole-chain caps: validateDraft already
			// enforces them, but the budget here counts the EXISTING chain,
			// and a node at the ceiling must never slip through and blow the
			// panel's ≤48-node scaling envelope.
			const overDepth = depth + 1 > MAX_CHAIN_DEPTH;
			const overBudget = countNodes(chain.root) + this.countDraftTree(node) > MAX_CHAIN_NODES;
			const children =
				overDepth || overBudget
					? []
					: await Promise.all((node.children ?? []).map((child) => resolveDraft(child, depth + 1)));
			if (overDepth) warnings.push(`${node.id}: children dropped — chain exceeds ${MAX_CHAIN_DEPTH} levels`);
			if (overBudget) warnings.push(`${node.id}: children dropped — chain exceeds ${MAX_CHAIN_NODES} nodes`);
			return {
				id: node.id,
				label: node.label,
				kind: node.kind,
				summary: node.summary,
				edgeNote: node.edgeNote,
				beat: node.beat,
				provenance: 'llm',
				location: { ...location, ...(node.file ? { file: node.file } : {}) },
				children,
			};
		};

		const resolvedChildren = await Promise.all(children.map((child) => resolveDraft(child, parentDepth(chain.root, parentId))));
		if (dropped.length > 0) failures.unshift(...dropped);
		// Self-correction state is keyed by the iteration unit: the model
		// retries ONE parent's block, so attempts accumulate per
		// session + chain + parent (mirrors Gen's session + rootId key).
		const key = `${call.sessionId}:${chain.chainId}:${parentId}`;
		if (failures.length > 0) {
			const attempts = (this.correctionAttempts.get(key) ?? 0) + 1;
			this.correctionAttempts.set(key, attempts);
			if (attempts <= MAX_CORRECTION_ROUNDS) {
				return fail(reply, {
					ok: false,
					attempt: attempts,
					maxAttempts: MAX_CORRECTION_ROUNDS + 1,
					failures: failures.map((f) => ({ nodeId: f.id, reason: f.reason })),
					hint: 'Fix ONLY the listed nodes (file/symbol you have actually read) and call client_ExtendCodeChainNode again with the whole block.',
				});
			}
			this.correctionAttempts.delete(key);
		} else {
			this.correctionAttempts.delete(key);
		}

		const next = withStats({
			...chain,
			root: replaceNode(chain.root, parentId, (node) => ({ ...node, children: [...node.children, ...resolvedChildren] })).root,
			...(validatedNarrative !== undefined ? { narrative: validatedNarrative } : {}),
		});
		this.store.save(next);
		this.sinks.updateChain(next);
		return ok(reply, {
			ok: true,
			chainId: next.chainId,
			added: resolvedChildren.map((n) => n.id),
			nodeCount: next.stats.nodeCount,
			unresolvedCount: next.stats.unresolvedCount,
			...(failures.length > 0
				? { note: `${failures.length} node(s) stayed unresolved after ${MAX_CORRECTION_ROUNDS} correction rounds; they render as warnings` }
				: {}),
			...(warnings.length > 0 ? { warnings } : {}),
		});
	}

	/** Node count of a draft tree (cap re-check side of the extend path). */
	private countDraftTree(node: ChainNodeDraft): number {
		return 1 + (node.children ?? []).reduce((sum, c) => sum + this.countDraftTree(c), 0);
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
			// Non-ok → non-ok (ambiguous/unresolved/stale): rebuild only when
			// the re-resolved location actually differs by value — every pass
			// mints fresh objects, so reference comparison is always "changed"
			// and a no-op refresh would re-push ambiguous/unresolved chains
			// (review round-3).
			return childrenChanged || !locationEqual(hit.location, node.location)
				? { ...node, children, location: { ...hit.location, file: node.location.file } }
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
		...(asString(node.beat) !== null ? { beat: asString(node.beat) as string } : {}),
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

/** The 1-based level of `id` in a resolved tree (root = 1); 0 when absent.
 * Extend resolves its new nodes with this as the parent depth, so the §3
 * depth cap counts the WHOLE chain (seed + earlier chunks), not just the
 * current chunk — `validateDraft` alone can only count the chunk relative
 * to its synthetic wrapper. */
function parentDepth(root: ResolvedNode, id: string): number {
	const walk = (node: ResolvedNode, depth: number): number => {
		if (node.id === id) return depth;
		for (const child of node.children) {
			const hit = walk(child, depth + 1);
			if (hit > 0) return hit;
		}
		return 0;
	};
	return walk(root, 1);
}

export function* flatten(root: ResolvedNode): Generator<ResolvedNode> {
	yield root;
	for (const child of root.children) yield* flatten(child);
}

/** Value equality for re-resolved locations: `resolveSymbol` mints a fresh
 * object every pass, so `!==` is always true and a no-op refresh on a chain
 * with ambiguous/unresolved nodes would rebuild + re-push the whole tree
 * (review round-3). `file` is display-only and re-attached from the old node,
 * so it is excluded here. */
function locationEqual(a: ChainLocation, b: ChainLocation): boolean {
	return (
		a.uri === b.uri &&
		a.resolveStatus === b.resolveStatus &&
		rangeEqual(a.range, b.range) &&
		rangeEqual(a.selectionRange, b.selectionRange) &&
		candidatesEqual(a.candidates, b.candidates)
	);
}

function rangeEqual(a: ChainRange | undefined, b: ChainRange | undefined): boolean {
	if (!a || !b) return a === b;
	return (
		a.startLine === b.startLine &&
		a.startCharacter === b.startCharacter &&
		a.endLine === b.endLine &&
		a.endCharacter === b.endCharacter
	);
}

function candidatesEqual(a: ChainCandidate[] | undefined, b: ChainCandidate[] | undefined): boolean {
	if (!a || !b) return a === b;
	return (
		a.length === b.length &&
		a.every((c, i) => {
			const other = b[i];
			return !!other && c.uri === other.uri && c.label === other.label && rangeEqual(c.range, other.range);
		})
	);
}

/** Last path segment for compact reply payloads. */
const uriToLabel = (uri: string): string => uri.split('/').pop() ?? uri;

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asRecord = (v: unknown): Record<string, unknown> | null =>
	typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
