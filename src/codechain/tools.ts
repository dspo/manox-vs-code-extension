// The seven Code Tutor client tools (§4): their wire specs (what the model
// sees) and the invoke handlers (what the host runs when the server routes
// an `invokeClientTool` ServerCall here). All seven names come from the
// `TOOL_NAMES` constants below — the single source for tool naming. The
// DEFAULT build path is now node-by-node — `TOOL_NAMES.add` appends exactly
// ONE node per call, which
// keeps a single tool_use around ~300 chars, the only size a small-output-
// budget model (qwen3.8-flash via Bailian, ~2K output tokens shared across
// thinking/text/tool JSON) reliably clears even after the ≤8-node Extend
// chunking still truncated it mid-JSON (the real-model cut point tracked the
// budget: 5334 → 3251 chars, proving a multi-node payload is out of reach for
// such a model, not just a too-long story). `TOOL_NAMES.entry` now seeds the
// chain with a SINGLE entry node (no children — the recursive tree face was
// the residual truncation source: even documenting a one-node seed, the schema
// still ALLOWED a whole tree, so the model kept packing a multi-node spine
// into the entry call and cut mid-JSON), and `TOOL_NAMES.extend` (a ≤8-node
// block) stays a large-budget shortcut for models that can hold more than one
// node per call;
// `TOOL_NAMES.narrate` commits the business story as its OWN call so no
// payload carries a whole flow AND
// the story together. The payload guards below enforce each tool's budget with
// re-shard guidance (and, for Add, a one-node-per-call instruction) instead of
// letting the server truncate a call silently.
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

// ── tool naming (Tutor brand — the SINGLE source for every tool name) ──────
//
// Spec definitions, the `client_`-prefixed description cross-references, the
// invoke-route matcher and the tests all reference these constants; a
// string-literal tool name anywhere else is a bug. The model sees the names
// with the server's `client_` prefix (§9.2); registration carries the bare
// constant values. The old GenCodeChain-era names are gone: historical
// journals still display them but nothing routes by them any more.

export const TOOL_NAMES = {
	entry: 'TutorEntry',
	add: 'TutorAdd',
	extend: 'TutorExtend',
	expand: 'TutorExpand',
	annotate: 'TutorAnnotate',
	narrate: 'TutorNarrate',
	refresh: 'TutorRefresh',
} as const;

/** The seven bare tool names, for the invoke-route membership test. */
const ROUTE_NAMES: ReadonlySet<string> = new Set<string>(Object.values(TOOL_NAMES));

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
	"Render an interactive code-reading tour of a business flow. Call this AFTER you have read the relevant code (with read/grep tools) and can explain the flow end-to-end. client_" +
	TOOL_NAMES.entry +
	" creates the chain with a `title` and ONE entry node (the business trigger, e.g. the route handler) — NO children in `root`. Build the rest of the chain with client_" +
	TOOL_NAMES.add +
	", one node per call, in narrative order: the entry node is the seed, every following step is its own single-node call. This keeps each tool_use JSON tiny (a few hundred chars) — the only shape a small-output-budget model can emit without its tool JSON truncating mid-stream (the real-model evidence: a qwen3.8-flash reply through Bailian on a ~2K-token output budget cut at 5334 then 3251 chars, tracking the budget down whenever a call carried more than one node). The ≤" +
	MAX_EXTEND_NODES +
	"-node client_" +
	TOOL_NAMES.extend +
	" block stays a large-budget shortcut for a whole sub-area that must land together. Curation rules, in priority order: (1) BUSINESS LOOP FIRST: include a node only when the step changes or carries business state data — acceptance -> core validation -> state change -> event/settlement -> outlet. Each `summary` (<= " +
	MAX_SUMMARY_CHARS +
	" chars) says what happens BUSINESS-wise in the user's language, never a restatement of the code. (2) DO NOT DESCEND INTO BOILERPLATE: middleware chains, request-parameter format validation, idempotency checks, audit logging, error wrapping, and DTO conversion must NOT become nodes; if such a step has a genuine business exception, fold it into the parent's summary or `edgeNote` in one sentence. (3) PRUNE BRANCHES: expand only branches whose alternatives differ in business meaning; summarize all error/rollback paths in at most ONE kind='note' node. (4) ONE ENTRY NODE HERE, NO TREE: `root` is a SINGLE entry node with NO `children` and no `edgeNote` (it has no parent edge) — do not pack the rest of the flow into it (that is exactly the multi-node payload that truncates; the host rejects a `root` carrying `children`). The host records this node as the chain's entry regardless of the `kind` you send, so point `file`/`symbol` at where the flow starts (the route handler / the business trigger). Grow the chain one node at a time with client_" +
	TOOL_NAMES.add +
	", or attach a whole sub-area as one <= " +
	MAX_EXTEND_NODES +
	"-node block with client_" +
	TOOL_NAMES.extend +
	" when your model has a large output budget. (hard caps the host enforces across the whole chain: " +
	MAX_CHAIN_NODES +
	" nodes / " +
	MAX_CHAIN_DEPTH +
	" levels, over-tall or over-wide drafts are truncated; larger payloads are rejected). (5) NARRATIVE IS A SEPARATE CALL: do NOT put a `narrative` field here — once the chain is built (this entry node + client_" +
	TOOL_NAMES.add +
	" steps), call client_" +
	TOOL_NAMES.narrate +
	" once with the chainId and the 300-600 character coherent business story in markdown (trigger -> key decisions -> state transitions -> external consequences). Tree nodes are the anchors of THAT story, not a directory listing; the story rides its own call so neither the seed node nor the narrative has to fit one payload. Contract (unchanged): NEVER report line numbers — give `file` (workspace-relative) and `symbol` (exact name, `Class.method` for methods); the host resolves precise locations via LSP and rejects bad ones, so prefer symbols you have actually seen in the files you read. Use kind='note' (no symbol) for conceptual steps with no single code location. If the host returns resolution errors, fix only the failed nodes and call again.";

const EXPAND_DESCRIPTION =
	'Expand one node of an existing code chain with REAL call-graph edges resolved by the host via LSP call hierarchy — no guessing, no token cost for reading files. Use when the user asks to go deeper ("这个函数里面还调了什么"/"谁调用了它") or for a real caller/callee edge you confirmed in code. For a node whose CHILDREN you already read and understood, prefer client_' +
	TOOL_NAMES.extend +
	" (your curated draft subtree, with beats); use this tool when the edge set itself must come from the graph. direction='callees' expands what the node calls; 'callers' expands who calls it. Afterwards use client_" +
	TOOL_NAMES.annotate +
	' to add business meaning to the newly added nodes.';

const ANNOTATE_DESCRIPTION =
	'Attach business semantics (summary / edgeNote) to a node of an existing code chain — typically right after client_' +
	TOOL_NAMES.expand +
	' added LSP-resolved nodes that have no annotation yet (newly drafted nodes carry their own summary/beat through client_' +
	TOOL_NAMES.extend +
	'). Only the named node changes; everything else keeps its state.';

// The default chain-building path: ONE node per call, in the order the story
// happens. It exists because a small-output-budget model (qwen3.8-flash via
// Bailian, ~2K output tokens shared across thinking / text / tool JSON)
// truncated its tool_use even at a ~2.5KB-per-shard protocol — the real-model
// evidence showed the cut point tracking the budget down (5334 → 3251 chars),
// proving such a model cannot reliably emit a multi-node payload at all. One
// ~300-char node per call clears the <1KB usable-tool-JSON floor every model
// can meet, so node-by-node is recommended to ALL models and the whole-tree
// seed is demoted to a large-budget-only shortcut.
const ADD_CODE_CHAIN_NODE_DESCRIPTION =
	'Add exactly ONE node to a code chain — call it once per step of the business story, in narrative order (this node\'s moment comes after the node named by `parentId`). This is the DEFAULT way to build a chain and the only one a small-output-budget model can finish: each call\'s JSON stays around ~300 chars, well under what those models can emit without truncating. Omit `chainId` to append to this session\'s most recently created/updated chain; to START a chain call it with just a first node (kind=\'entry\', no `chainId` and no `parentId`) — the reply returns the new `chainId` to use for every later node. Set `parentId` to the id of the node this step follows (from the previous reply\'s `nodeId`); omit it to attach to the root of a just-seeded chain. The node carries the same fields as client_' +
	TOOL_NAMES.entry +
	"'s entry node: `summary` (<= " +
	MAX_SUMMARY_CHARS +
	" chars, what happens BUSINESS-wise in the user language) and `beat` (<= " +
	MAX_BEAT_CHARS +
	" chars, this step's one moment in the story); NEVER report line numbers — give `file` (workspace-relative) and `symbol` (exact name, `Class.method` for methods) you have actually seen, and use kind='note' (no symbol) for a conceptual step with no single code location. NEVER put a `children` array here — one node per call; call again for the next step. Only when a node's subtree must land together and the model has a large output budget, prefer client_" +
	TOOL_NAMES.extend +
	' (a <= ' +
	MAX_EXTEND_NODES +
	'-node block); otherwise keep adding single nodes. When the story is complete, commit it with client_' +
	TOOL_NAMES.narrate +
	'. If the host returns symbol-resolution errors, fix ONLY this node and call client_' +
	TOOL_NAMES.add +
	' again.';

// ── payload guards (progressive-building contract) ─────────────────────────
//
// The server forwards a client-tool input as one serialized frame; an
// oversized draft (the model ignoring the seed caps) would either die
// opaquely in transport or arrive half-truncated. Reject it HERE with the
// actual size + the exact re-shard recipe, so the correction loop can act:
// smaller chunks via the extend tool (`TOOL_NAMES.extend`), summaries <= 120
// chars, NEVER the same payload resent.

const MAX_GEN_PAYLOAD_CHARS = 3_000;
const MAX_EXTEND_PAYLOAD_CHARS = 3_000;
/** `TOOL_NAMES.add` carries exactly ONE node per call, so its whole payload
 * is a single node object (~300 chars in the happy path). 1200 is generous
 * headroom for one node whose summary/beat ride at their caps plus a longer
 * file path, and still sits under the <1KB-usable-tool-JSON floor the
 * small-output-budget models (qwen3.8-flash via Bailian, ~2K total output
 * tokens shared across thinking/text/tool JSON) proved they could not clear
 * even at a ~2.5KB per-shard protocol — a node that overruns this guard is a
 * model that packed more than one node into the call, so the fix is "one node
 * per call", not "a smaller summary". */
const MAX_ADD_PAYLOAD_CHARS = 1_200;
/** The narrative rides its own call (`TOOL_NAMES.narrate`); this guard is
 * a headroom ceiling well under the model's ~5KB output budget — a story
 * over MAX_NARRATIVE_CHARS but inside this limit is truncated by the handler,
 * one past it is rejected with a compress-to-1200 instruction. */
const MAX_NARRATE_PAYLOAD_CHARS = 2_000;

const payloadTooLarge = (toolName: string, actual: number, limit: number): string =>
	`payload too large: ${actual} chars exceeds the ${limit} char limit for ${toolName}. Shrink it: seed the chain with just the entry node via client_${TOOL_NAMES.entry} (NO \`children\`), then add the rest ONE node per call via client_${TOOL_NAMES.add} — or, when a whole sub-area must land together and you have a large output budget, attach it as one block of <= ${MAX_EXTEND_NODES} new nodes via client_${TOOL_NAMES.extend}; keep every \`summary\` <= ${MAX_SUMMARY_CHARS} chars, drop boilerplate steps (middleware, parameter validation, logging, DTO conversion) and the oversized narrative (<= ${MAX_NARRATIVE_CHARS} chars) — NEVER resend the same payload unchanged.`;

/** Draft-node properties, shared by every tree-bearing schema face (the entry
 * seed node, Extend's `children` items) so the wire faces can never drift
 * apart. The seed's `entryNode` deliberately omits `children` — a single entry
 * node cannot carry a tree. */
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

/** The seed node's properties: `NODE_PROPERTIES` minus `edgeNote`. The root
 * has no parent edge, so the field could only ever describe nothing — and
 * `edgeNote` is noise on a face whose whole point is "this is one node, not a
 * tree". Extend's children keep it: they really do follow a parent. */
const { edgeNote: _entryHasNoParentEdge, ...ENTRY_NODE_PROPERTIES } = NODE_PROPERTIES;

/** `TOOL_NAMES.entry` input: the chain `title` + `question` and a SINGLE
 * entry node as `root`. `root` points at `$defs.entryNode` — the shared node
 * fields MINUS `children` — so the schema itself cannot invite a multi-node
 * tree into the one seed call. That was the residual truncation source: even
 * after TutorAdd went single-node, the recursive `root` let a small-output
 * model keep packing a whole spine into the entry reply and cut it mid-JSON.
 * The handler additionally REJECTS any `root.children` (see `genCodeChain`) so
 * the only remaining shape is one node here + one node per
 * `TOOL_NAMES.add` call. No `narrative` here: the business story is committed
 * separately with `TOOL_NAMES.narrate` (see the module header). */
const entrySchema = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['title', 'question', 'root'],
	properties: {
		title: { type: 'string', description: 'Short name of the business flow, e.g. "订单创建流程".' },
		question: { type: 'string', description: "The user's original question." },
		root: { $ref: '#/$defs/entryNode' },
	},
	$defs: {
		entryNode: {
			type: 'object',
			required: ['id', 'label', 'kind', 'file', 'summary'],
			// `additionalProperties:false` is deliberately NOT set: the handler
			// reads `root.children` itself so it can answer an actionable
			// "single entry node, then add the rest one node per
			// client_TutorAdd call" isError instead of the model silently
			// dropping a whole subtree it tried to send.
			properties: {
				...ENTRY_NODE_PROPERTIES,
			},
		},
	},
};

/** `TOOL_NAMES.extend` input: one parent + a ≤ MAX_EXTEND_NODES chunk of
 * new children under it (the shared recursive node shape). */
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

/** `TOOL_NAMES.narrate` input: the chain id plus the business story alone.
 * Its own schema (no tree) so the narrative never shares a payload with a
 * draft. */
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

/** `TOOL_NAMES.add` input: exactly ONE node (the small-output-budget path —
 * build the whole chain one narrative step per call, so a single tool_use
 * JSON stays ~300 chars, well under the <1KB usable-tool-JSON floor those
 * models proved). The `node` reuses the shared NODE_PROPERTIES face but
 * deliberately has NO `children` — the sub-schema cannot recurse (that is
 * the whole point: the handler rejects any `children` and tells the model to
 * call again). `chainId` and `parentId` are optional so the same tool can
 * seed a new chain from its first node (both omitted, no prior chain) and
 * append to an existing one; defaults resolve in the handler. */
const addSchema = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['node'],
	properties: {
		chainId: {
			type: 'string',
			description: 'Existing chain to append to. Omit to append to this session\'s most recently created/updated chain, or — when no chain exists and `parentId` is also omitted — to CREATE a new chain from this node.',
		},
		parentId: {
			type: 'string',
			description: 'Existing node the new node attaches under. Omit to attach to the root (reasonable only for a just-seeded chain or a single-root story).',
		},
		node: {
			type: 'object',
			required: ['id', 'label', 'kind', 'file', 'summary'],
			// `additionalProperties:false` is NOT set here: the handler reads
			// `children` itself so it can answer an actionable "one node per
			// call" isError instead of the model silently dropping a whole
			// subtree it tried to send.
			properties: {
				...NODE_PROPERTIES,
				children: {
					type: 'array',
					description:
						'NOT accepted by client_' + TOOL_NAMES.add + ' — it adds exactly one node; call it once per step of the story.',
				},
			},
		},
	},
};

export function clientToolSpecs(): ToolSpec[] {
	return [
		{
			name: TOOL_NAMES.entry,
			description: GEN_CODE_CHAIN_DESCRIPTION,
			inputSchema: entrySchema,
			readOnly: true,
		},
		{
			name: TOOL_NAMES.narrate,
			description:
				'Commit the business story of an existing code chain — call this right AFTER client_' +
				TOOL_NAMES.entry +
				' seeds the chain with its single entry node (the seed call itself carries NO narrative; the story rides this separate call so neither payload has to fit the model output budget together). Pass the `chainId` from the client_' +
				TOOL_NAMES.entry +
				' reply and ONLY the narrative text: a 300-600 character coherent business story in markdown (trigger -> key decisions -> state transitions -> external consequences), in the user language, <= ' +
				MAX_NARRATIVE_CHARS +
				' chars (longer is truncated). The tree nodes are the anchors of THAT story; write what the chain you built adds up to, not a directory listing. This only sets the narrative — the tree is untouched; re-call to replace the story.',
			inputSchema: narrateSchema,
			readOnly: true,
		},
		{
			name: TOOL_NAMES.extend,
			description:
				'Grow an existing code chain: attach a block of <= ' +
				MAX_EXTEND_NODES +
				' NEW draft nodes under an existing one (parentId = chain node id from client_' +
				TOOL_NAMES.entry +
				' or an earlier client_' +
				TOOL_NAMES.extend +
				' reply). Use this after the seed to go deeper or wider, one business sub-area per call — read the parent function first and keep every node on the business loop (boilerplate stays out, same curation rules as client_' +
				TOOL_NAMES.entry +
				'). Each new node carries its own `summary` and optional `beat`; pass an UPDATED `narrative` only when this block changes the story. The host resolves every symbol through LSP and runs the same self-correction loop, so submit only symbols you have actually seen.',
			inputSchema: extendSchema,
			readOnly: true,
		},
		{
			name: TOOL_NAMES.add,
			description: ADD_CODE_CHAIN_NODE_DESCRIPTION,
			inputSchema: addSchema,
			readOnly: true,
		},
		{
			name: TOOL_NAMES.expand,
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
			name: TOOL_NAMES.annotate,
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
			name: TOOL_NAMES.refresh,
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

/** Self-correction round cap (§4): after this many entry-tool calls that
 * still report failures, render with a warning instead of rejecting. */
const MAX_CORRECTION_ROUNDS = 3;

const ok = (reply: ReplySinks, payload: Record<string, unknown>): void =>
	reply.ok(JSON.stringify(payload), false);
const fail = (reply: ReplySinks, payload: Record<string, unknown>): void =>
	reply.ok(JSON.stringify(payload), true);
const failText = (reply: ReplySinks, message: string): void =>
	reply.ok(message, true);

export class CodeChainTools {
	/** Failed entry-tool (chain seed) attempts keyed by `session:rootId` (the model is
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
		// agnostic to which form the wire carries (Phase 0 conclusion). The
		// route is gated on the `TOOL_NAMES` set so a name outside the Tutor
		// seven (including every pre-rebrand one) fails closed to the caller.
		const name = call.name.startsWith('client_') ? call.name.slice('client_'.length) : call.name;
		if (!ROUTE_NAMES.has(name)) return false;
		try {
			switch (name) {
				case TOOL_NAMES.entry:
					await this.genCodeChain(call, reply);
					return true;
				case TOOL_NAMES.narrate:
					this.narrateCodeChain(call, reply);
					return true;
				case TOOL_NAMES.extend:
					await this.extendCodeChain(call, reply);
					return true;
				case TOOL_NAMES.add:
					await this.addCodeChainNode(call, reply);
					return true;
				case TOOL_NAMES.expand:
					await this.expand(call, reply);
					return true;
				case TOOL_NAMES.annotate:
					this.annotate(call, reply);
					return true;
				case TOOL_NAMES.refresh:
					await this.refresh(call, reply);
					return true;
				default:
					// Unreachable: ROUTE_NAMES is exactly the switch's arms.
					return false;
			}
		} catch (e) {
			// A host-side crash is still a tool failure the model can read;
			// never let it stall the 300s reply window.
			failText(reply, `client tool \`${call.name}\` failed: ${errorText(e)}`);
			return true;
		}
	}

	// ── TutorEntry (chain seed — a SINGLE entry node) ───────────────────────

	/** Seed a chain from exactly ONE entry node: the chain `title`, the user's
	 * `question`, and `root` = a single entry node with NO children. The whole
	 * point of this revision is that the seed call carries a single node, not a
	 * tree: the recursive `root` was the residual truncation source — even after
	 * TutorAdd went single-node, the model kept packing a multi-node spine into
	 * the entry reply (a schema that ALLOWS children trains that behavior) and
	 * cut it mid-JSON, because a small-output-budget model (qwen3.8-flash via
	 * Bailian, <1KB usable tool JSON) cannot emit a tree in one tool_use. So
	 * the schema drops `children` and the handler REJECTS any `root.children`
	 * (never tolerant — rejection is what trains the model to shard node-by-node
	 * via client_TutorAdd, one node per call, in narrative order). The business
	 * story is committed on its own client_TutorNarrate call. */
	private async genCodeChain(call: InvokeCall, reply: ReplySinks): Promise<void> {
		const input = asRecord(call.input);
		if (!input) return failText(reply, `${TOOL_NAMES.entry} input must be an object`);
		if (this.guardPayload(reply, call.input, MAX_GEN_PAYLOAD_CHARS, TOOL_NAMES.entry)) return;
		const title = asString(input.title);
		const question = asString(input.question) ?? '';
		// The narrative moved to its own call (`TOOL_NAMES.narrate`) — the
		// seed payload must not carry the story too (real-model evidence: a
		// narrative + tree in one entry-tool reply blew the ~5KB output
		// budget and cut the stream mid-JSON). Reject a stray `narrative`
		// field so the model self-corrects to the documented split flow.
		if (input.narrative !== undefined) {
			return failText(
				reply,
				`${TOOL_NAMES.entry} no longer accepts a \`narrative\` field. Seed the single entry node here, then commit the business story with a separate client_${TOOL_NAMES.narrate} call ({chainId, narrative}) using this reply's chainId.`,
			);
		}
		// The seed is ONE node. A `children` field on `root` means the model
		// packed a tree into the entry call — the exact failure this revision
		// exists to stop — so reject it with the sharding recipe instead of
		// resolving a multi-node subtree (a tree here truncates the same way a
		// tree anywhere else does). Check the raw `root`, not the parsed draft:
		// `parseDraft` always emits a `children: []`, so only the input can tell
		// "no children" apart from "an empty children field"; and reject the
		// field even when empty, because silently dropping it would not teach
		// the model to stop sending a tree.
		const rootRec = asRecord(input.root);
		if (rootRec && rootRec.children !== undefined) {
			return failText(
				reply,
				`client_${TOOL_NAMES.entry} takes a SINGLE entry node without \`children\`. Call it with just the entry, then add the rest one node per client_${TOOL_NAMES.add} call.`,
			);
		}
		const rootParse = parseDraft(input.root, '');
		if (!title || !rootParse.draft) {
			return failText(
				reply,
				`${TOOL_NAMES.entry} requires \`title\` and a single \`root\` entry node with {id,label,kind,file,summary} and NO \`children\` (add the rest of the chain one node per client_${TOOL_NAMES.add} call; commit the narrative separately with client_${TOOL_NAMES.narrate})`,
			);
		}
		// The seed call is the ONE moment that decides the root's kind, and
		// the schema cannot enforce it (the enum legitimately spans all kinds,
		// because the same properties face is what Extend reuses). Normalize
		// rather than trust: a root is the chain's entry by construction, and a
		// model that labels it 'call' would only paint the wrong dot on it.
		// `kind` also drives resolution — an 'entry' with no symbol resolves
		// like a note — so this must land BEFORE `validateDraft`/`resolveChain`.
		const { draft, warnings } = validateDraft({ ...rootParse.draft, kind: 'entry' });
		const key = `${call.sessionId}:${draft.id}`;
		const { chain, failures } = await resolveChain(this.deps, {
			sessionId: call.sessionId,
			title,
			question,
			root: draft,
		});
		if (failures.length > 0) {
			const attempts = (this.correctionAttempts.get(key) ?? 0) + 1;
			this.correctionAttempts.set(key, attempts);
			if (attempts <= MAX_CORRECTION_ROUNDS) {
				// Self-correction loop: the single entry node failed to resolve.
				return fail(reply, {
					ok: false,
					attempt: attempts,
					maxAttempts: MAX_CORRECTION_ROUNDS + 1,
					failures: failures.map((f) => ({ nodeId: f.id, reason: f.reason })),
					hint: `Fix ONLY the entry node's \`file\`/\`symbol\` (a symbol you have actually read) and call client_${TOOL_NAMES.entry} again with the single corrected entry node.`,
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
			nodeId: chain.root.id,
			nodeCount: chain.stats.nodeCount,
			unresolvedCount: chain.stats.unresolvedCount,
			panelOpened: true,
			// The single entry node is up but the chain is not, and neither is
			// the story: point the model at the node-by-node build path, then
			// the narrative call — each stays within one output budget.
			nextStep: `add the rest of the chain one node per client_${TOOL_NAMES.add} call (parentId = the entry node's nodeId), then commit the business story with client_${TOOL_NAMES.narrate}`,
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

	// ── TutorNarrate ──────────────────────────────────────────────────────────

	/** Commit the chain's business story on its own — the third payload of the
	 * progressive flow (seed → narrate → extend), split out so the narrative
	 * never shares a model-output budget with the tree. Runs NO resolution:
	 * it just sets `chain.narrative` and re-pushes. `stats` ignore the
	 * narrative, so `withStats` is a no-op here and a plain spread suffices.
	 * Over-cap stories are truncated (with a warning) rather than rejected;
	 * a payload past the headroom guard is refused with a compress-to-cap
	 * instruction (the story alone must fit this call). */
	private narrateCodeChain(call: InvokeCall, reply: ReplySinks): void {
		const loaded = this.chainOf(call, reply, TOOL_NAMES.narrate);
		if (!loaded) return;
		const { input, chain } = loaded;
		const raw = asString(input.narrative);
		if (raw === null || raw.trim() === '') {
			return failText(reply, `${TOOL_NAMES.narrate} requires a non-empty \`narrative\` string (the 300-600 char business story)`);
		}
		// The story ALONE rides this payload; if even that overruns the
		// headroom guard there is nothing to re-shard — the fix is to compress
		// the narrative to the cap, not to split the tree (that was Gen's job).
		const actual = JSON.stringify(call.input ?? null)?.length ?? 0;
		if (actual > MAX_NARRATE_PAYLOAD_CHARS) {
			return failText(
				reply,
				`payload too large: ${actual} chars exceeds the ${MAX_NARRATE_PAYLOAD_CHARS} char limit for ${TOOL_NAMES.narrate}. Compress the \`narrative\` to <= ${MAX_NARRATIVE_CHARS} chars (a tight 300-600 char business story) — the narrative rides this call alone, so there is nothing to re-shard; NEVER resend the same payload unchanged.`,
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

	// ── TutorExtend ─────────────────────────────────────────────────────────

	/** Attach a chunk of ≤ MAX_EXTEND_NODES new draft children under an
	 * existing node. Resolution runs per-call (fresh memos, same self-
	 * correct gate as the entry tool keyed by session + chain + parent). */
	private async extendCodeChain(call: InvokeCall, reply: ReplySinks): Promise<void> {
		const loaded = this.chainOf(call, reply, TOOL_NAMES.extend);
		if (!loaded) return;
		if (this.guardPayload(reply, call.input, MAX_EXTEND_PAYLOAD_CHARS, TOOL_NAMES.extend)) return;
		const { input, chain } = loaded;
		const parentId = asString(input.parentId);
		if (!parentId) return failText(reply, `${TOOL_NAMES.extend} requires \`parentId\` (an existing chain node id)`);
		if (!Array.isArray(input.children) || input.children.length === 0) {
			return failText(reply, `${TOOL_NAMES.extend} requires a non-empty \`children\` array (<= ${MAX_EXTEND_NODES} new nodes per call)`);
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
		if (!blockParse.draft) return failText(reply, `${TOOL_NAMES.extend} children must be valid draft nodes {id,label,kind,file,summary}`);
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
					hint: `Fix ONLY the listed nodes (file/symbol you have actually read) and call client_${TOOL_NAMES.extend} again with the whole block.`,
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

	// ── TutorAdd (the node-by-node default path) ──────────────────────────────

	/** Append exactly ONE node to a chain — the small-output-budget default.
	 * client_`TOOL_NAMES.extend` still asks a model to emit a ≤8-node block in
	 * one tool_use, which a ~2K-token-output model (qwen3.8-flash via Bailian)
	 * cannot do without its JSON truncating mid-stream (the real-model cut point
	 * tracked the budget: 5334 → 3251 chars); client_`TOOL_NAMES.entry` is now a
	 * SINGLE entry node for the same reason. One ~300-char node per call stays
	 * under the <1KB usable-tool-JSON floor every model clears, so this is the
	 * recommended build path; the ≤8-node Extend block remains a large-budget
	 * shortcut. The three shapes this one handler covers, decided by which ids
	 * the caller passed:
	 *   - `chainId` + `parentId` present → append under that node.
	 *   - both omitted → append to the session's newest chain, at root.
	 *   - both omitted AND no chain exists → SEED a new chain whose root is
	 *     this node (title = `<label> 代码导游`); the reply's `chainId` is then
	 *     passed back for every following call.
	 * Resolution runs per-call with a fresh memo (same self-correct gate as
	 * Gen/Extend, keyed by session + chain + this node's id). */
	private async addCodeChainNode(call: InvokeCall, reply: ReplySinks): Promise<void> {
		const input = asRecord(call.input);
		if (!input) return failText(reply, `${TOOL_NAMES.add} input must be an object`);
		// Add-specific guard: the shared `payloadTooLarge` recipe points at
		// Extend re-sharding, but for a ONE-node call the only fix is "you
		// packed more than one node — split it into one node per call", so this
		// message is written for that. The size still rides `JSON.stringify` so
		// the number matches the serialized frame.
		const addSize = JSON.stringify(call.input ?? null)?.length ?? 0;
		if (addSize > MAX_ADD_PAYLOAD_CHARS) {
			return failText(
				reply,
				`payload too large: ${addSize} chars exceeds the ${MAX_ADD_PAYLOAD_CHARS} char limit for ${TOOL_NAMES.add} — it adds exactly ONE node, so a payload this big packed more than one step. Send a single node {id,label,kind,file,summary[,symbol,beat,edgeNote]} per call (summary <= ${MAX_SUMMARY_CHARS} chars, beat <= ${MAX_BEAT_CHARS} chars) and call again for the next step of the story — NEVER resend the same payload unchanged.`,
			);
		}

		// Exactly one node. A `children` field means the model packed a subtree
		// into the single-node call — the very failure mode this tool exists to
		// avoid — so reject it with the "call again per step" recipe instead of
		// silently dropping the children (a dropped subtree reads back as a
		// successful one-node add).
		const nodeRec = asRecord(input.node);
		if (!nodeRec) {
			return failText(
				reply,
				`${TOOL_NAMES.add} requires a \`node\` object {id,label,kind,file,summary[,symbol,beat,edgeNote]} — one node per call, call again for the next step`,
			);
		}
		if (nodeRec.children !== undefined) {
			return failText(
				reply,
				`${TOOL_NAMES.add} adds exactly ONE node and does not accept \`children\` — drop it and call client_${TOOL_NAMES.add} once per step of the story, in narrative order.`,
			);
		}

		const chainIdArg = asString(input.chainId);
		const parentIdArg = asString(input.parentId);

		// Resolve the target chain (explicit id must exist; otherwise the
		// session's most recently created/updated one). `null` here means
		// "no chain yet" → the seed-new-chain path.
		let chain: CodeChain | null = null;
		if (chainIdArg !== null) {
			const found = this.store.get(chainIdArg);
			if (!found) {
				return fail(reply, {
					ok: false,
					error: `unknown chainId \`${chainIdArg}\` — omit \`chainId\` to append to this session's latest chain, or pass a first node with neither \`chainId\` nor \`parentId\` to start one`,
				});
			}
			chain = found;
		} else {
			const latest = this.store.list(call.sessionId)[0];
			chain = latest ? this.store.get(latest.chainId) ?? null : null;
		}

		const parse = parseDraft(input.node, '');
		if (!parse.draft) {
			return failText(
				reply,
				`${TOOL_NAMES.add} needs a valid node {id,label,kind,file,summary}; every field per the tool schema (kind one of entry/call/impl/interface/config/data/note)`,
			);
		}
		// `validateDraft` on a single (children-free) node only clamps this
		// node's summary/beat — the whole-tree caps are re-checked explicitly
		// below against the EXISTING chain, since the draft alone can never
		// trip them.
		const { draft, warnings } = validateDraft(parse.draft);

		// ── append to an existing chain ──
		if (chain) {
			const parentId = parentIdArg ?? chain.root.id;
			const parent = findNode(chain.root, parentId);
			if (!parent) {
				const ids = [...flatten(chain.root)].slice(0, 10).map((n) => `\`${n.id}\``);
				return fail(reply, {
					ok: false,
					error: `no node \`${parentId}\` in chain \`${chain.chainId}\``,
					availableIds: ids,
					hint: `Set \`parentId\` to the id from the previous client_${TOOL_NAMES.add} reply (the node this step follows).`,
				});
			}
			if (findNode(chain.root, draft.id)) {
				return fail(reply, {
					ok: false,
					error: `node id \`${draft.id}\` already exists in chain \`${chain.chainId}\` — ids must be unique; use a different id for this step`,
				});
			}
			const overDepth = parentDepth(chain.root, parentId) + 1 > MAX_CHAIN_DEPTH;
			const overBudget = countNodes(chain.root) + 1 > MAX_CHAIN_NODES;
			if (overDepth || overBudget) {
				return failText(
					reply,
					`${TOOL_NAMES.add} rejected: the chain already hits the ${overBudget ? `${MAX_CHAIN_NODES}-node` : `${MAX_CHAIN_DEPTH}-level`} cap, so this node cannot attach without truncating the tour — prune a node first, or start a tighter chain (client_${TOOL_NAMES.entry} seeds a single entry node, then add fewer, higher-value steps with client_${TOOL_NAMES.add}).`,
				);
			}
			const resolved = await this.resolveSingle(draft);
			const failures = resolved.failures;
			const key = `${call.sessionId}:${chain.chainId}:${draft.id}`;
			if (this.correctionGate(reply, key, failures)) return;

			const next = withStats({
				...chain,
				root: replaceNode(chain.root, parentId, (node) => ({ ...node, children: [...node.children, resolved.node] })).root,
			});
			this.store.save(next);
			this.sinks.updateChain(next);
			return this.okAdd(reply, next, draft.id, failures, warnings);
		}

		// ── seed a new chain from this node ──
		if (parentIdArg !== null) {
			return failText(
				reply,
				`${TOOL_NAMES.add} cannot attach to a parent before a chain exists — to start a chain pass neither \`chainId\` nor \`parentId\` (this first node becomes the root, typically kind='entry'), then set \`parentId\` on every following call.`,
			);
		}
		const title = `${draft.label} 代码导游`;
		const question = asString(input.question) ?? '';
		const newChain = await this.resolveChainFromRoot(draft, {
			sessionId: call.sessionId,
			title,
			question,
		});
		const failures = newChain.failures;
		const key = `${call.sessionId}:${newChain.chain.chainId}:${draft.id}`;
		if (this.correctionGate(reply, key, failures)) return;

		const next = withStats(newChain.chain);
		this.publish(next);
		return this.okAdd(reply, next, draft.id, failures, warnings);
	}

	/** Shared success reply for both add-tool shapes. `nodeCount` /
	 * `unresolvedCount` come from the recomputed stats; `nextHint` keeps the
	 * model on the narrative loop (add the next step, or narrate when done). */
	private okAdd(
		reply: ReplySinks,
		chain: CodeChain,
		nodeId: string,
		failures: { id: string; reason: string }[],
		warnings: string[],
	): void {
		ok(reply, {
			ok: true,
			chainId: chain.chainId,
			nodeId,
			nodeCount: chain.stats.nodeCount,
			unresolvedCount: chain.stats.unresolvedCount,
			nextHint: `continue adding nodes in narrative order, or client_${TOOL_NAMES.narrate} when the story is complete`,
			...(failures.length > 0
				? { failures: failures.map((f) => ({ nodeId: f.id, reason: f.reason })), note: `${failures.length} node(s) stayed unresolved after ${MAX_CORRECTION_ROUNDS} correction rounds; they render as warnings` }
				: {}),
			...(warnings.length > 0 ? { warnings } : {}),
		});
	}

	/** Advance the per-node self-correction counter. Returns true (the caller
	 * must stop) when a round was spent; false when there are no failures or
	 * the rounds are exhausted (the node is then rendered with a warning).
	 * Mirrors Gen/Extend: attempts accumulate per session + chain + this
	 * node's id, and the counter clears once the node stops failing. */
	private correctionGate(reply: ReplySinks, key: string, failures: { id: string; reason: string }[]): boolean {
		if (failures.length === 0) {
			this.correctionAttempts.delete(key);
			return false;
		}
		const attempts = (this.correctionAttempts.get(key) ?? 0) + 1;
		this.correctionAttempts.set(key, attempts);
		if (attempts <= MAX_CORRECTION_ROUNDS) {
			fail(reply, {
				ok: false,
				attempt: attempts,
				maxAttempts: MAX_CORRECTION_ROUNDS + 1,
				failures: failures.map((f) => ({ nodeId: f.id, reason: f.reason })),
				hint: `Fix ONLY this node (file/symbol you have actually read) and call client_${TOOL_NAMES.add} again with the corrected single node.`,
			});
			return true;
		}
		this.correctionAttempts.delete(key);
		return false;
	}

	/** Resolve one draft node's file + symbol through LSP (a fresh per-call
	 * lookup — no cache needed for a single node, and nothing crosses calls
	 * the way `resolveChain`'s per-uri memos do). Mirrors the per-node branch
	 * of `extendCodeChain`'s inline `resolveDraft` (including the interface
	 * subtype hint, which that path — and thus the whole Extend face — also
	 * leaves to `resolveChain`, so it is intentionally not re-implemented
	 * here): non-note nodes need a resolvable file+symbol, and every failure
	 * carries a reason the correction loop relays. */
	private async resolveSingle(
		node: ChainNodeDraft,
	): Promise<{ node: ResolvedNode; failures: { id: string; reason: string }[] }> {
		const failures: { id: string; reason: string }[] = [];
		let location: ChainLocation;
		if (!node.file || node.file.trim() === '') {
			location = node.kind === 'note'
				? { uri: '', resolveStatus: 'ok' }
				: { uri: '', resolveStatus: 'unresolved' };
			if (node.kind !== 'note') failures.push({ id: node.id, reason: 'missing `file`' });
		} else {
			const fileHit = await resolveFileUri(this.deps.workspace, node.file);
			if (!fileHit.uri) {
				location = { uri: '', resolveStatus: 'unresolved' };
				failures.push({ id: node.id, reason: fileHit.reason ?? 'unresolvable file' });
			} else {
				const hit = await resolveSymbol(this.deps.lsp, fileHit.uri, node.symbol, node.kind);
				location = hit.location;
				if (hit.reason) failures.push({ id: node.id, reason: hit.reason });
			}
		}
		return {
			node: {
				id: node.id,
				label: node.label,
				kind: node.kind,
				summary: node.summary,
				edgeNote: node.edgeNote,
				beat: node.beat,
				provenance: 'llm',
				location: { ...location, ...(node.file ? { file: node.file } : {}) },
				children: [],
			},
			failures,
		};
	}

	/** Seed a new one-node chain: resolve `root` and build the `CodeChain`
	 * skeleton (mint chainId, stamp createdAt) that `resolveChain` would have
	 * produced for a single-node tree, so the seed path shares the append
	 * path's per-node resolution rather than a whole-tree call. */
	private async resolveChainFromRoot(
		root: ChainNodeDraft,
		meta: { sessionId: string; title: string; question: string },
	): Promise<{ chain: CodeChain; failures: { id: string; reason: string }[] }> {
		const resolved = await this.resolveSingle(root);
		return {
			chain: {
				chainId: this.deps.mintChainId(),
				sessionId: meta.sessionId,
				title: meta.title,
				question: meta.question,
				createdAt: this.deps.now(),
				root: resolved.node,
				stats: { nodeCount: 1, unresolvedCount: resolved.node.location.resolveStatus === 'unresolved' ? 1 : 0 },
			},
			failures: resolved.failures,
		};
	}

	// ── TutorExpand ─────────────────────────────────────────────────────────

	private async expand(call: InvokeCall, reply: ReplySinks): Promise<void> {
		const loaded = this.chainOf(call, reply, TOOL_NAMES.expand);
		if (!loaded) return;
		const { input, chain } = loaded;
		const nodeId = asString(input.nodeId);
		const direction = asString(input.direction);
		if (!nodeId || (direction !== 'callees' && direction !== 'callers')) {
			return failText(reply, `${TOOL_NAMES.expand} requires {chainId, nodeId, direction: "callees"|"callers"}`);
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
			hint: `Add business summaries with client_${TOOL_NAMES.annotate}`,
		});
	}

	// ── TutorAnnotate ───────────────────────────────────────────────────────

	private annotate(call: InvokeCall, reply: ReplySinks): void {
		const loaded = this.chainOf(call, reply, TOOL_NAMES.annotate);
		if (!loaded) return;
		const { input, chain } = loaded;
		const nodeId = asString(input.nodeId);
		const summary = asString(input.summary);
		const edgeNote = asString(input.edgeNote);
		if (!nodeId || (summary === null && edgeNote === null)) {
			return failText(reply, `${TOOL_NAMES.annotate} requires {chainId, nodeId} and at least one of summary/edgeNote`);
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

	// ── TutorRefresh ────────────────────────────────────────────────────────

	/** Re-run symbol resolution on every node (§6.3 diff report): ok→ok with
	 * a moved range reports as moved; ok→miss reports as stale; anything→hit
	 * reports as fixed. Positions the model never claimed are untouched. */
	private async refresh(call: InvokeCall, reply: ReplySinks): Promise<void> {
		const loaded = this.chainOf(call, reply, TOOL_NAMES.refresh);
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
			failText(reply, `${toolName} needs a \`chainId\` from the client_${TOOL_NAMES.entry} result`);
			return null;
		}
		const chain = this.store.get(chainId);
		if (!chain) {
			fail(reply, { ok: false, error: `unknown chainId \`${chainId}\` — generate one first with client_${TOOL_NAMES.entry}` });
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
