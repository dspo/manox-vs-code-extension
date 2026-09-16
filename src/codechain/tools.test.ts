// The seven client tools' reply contract + self-correction loop (§4, §9.3)
// over the FakeLsp fixture: every business outcome answers `reply.ok
// {content, isError}` — never an RPC Err — so the model reads the structured
// feedback; a successful TutorEntry publishes (store + panel + journal
// verb); the narrative rides its own TutorNarrate call (never the seed);
// bare and `client_`-prefixed names both route.

import { describe, expect, it } from 'vitest';

import fixtures from '../../test-fixtures/codechain-cases.json';
import { ChainStore, type ChainStoreSink } from './chainStore';
import type { CodeChain, ChainNodeDraft } from './types';
import type { LspClient, LspItem, LspLocation, LspSymbol, ResolveDeps, WorkspaceView } from './resolve';
import { CodeChainTools, clientToolSpecs, TOOL_NAMES, type InvokeCall, type ReplySinks, type ToolSinks } from './tools';

const symbolsByUri = fixtures.resolve.symbols as Record<string, LspSymbol[]>;
const existingFiles = new Set(fixtures.resolve.existingFiles as string[]);

const emptyLsp: LspClient = {
	async documentSymbols(uri) {
		return symbolsByUri[uri] ?? [];
	},
	async readText() {
		return '';
	},
	// No workspace index in the tools tests: the `okRoot`/`failingChild`
	// fixtures are chosen so the document-symbol tree alone decides ok vs
	// unresolved. The index fallback itself is covered in resolve.test.
	async workspaceSymbols(): Promise<LspLocation[]> {
		return [];
	},
	async prepareCallHierarchy(): Promise<LspItem[]> {
		return [];
	},
	async outgoingCalls(): Promise<LspItem[]> {
		return [];
	},
	async incomingCalls(): Promise<LspItem[]> {
		return [];
	},
	async prepareTypeHierarchy(): Promise<LspItem[]> {
		return [];
	},
	async subtypes(): Promise<LspItem[]> {
		return [];
	},
};

const workspace: WorkspaceView = {
	folders: () => ['/repo'],
	fileExists: async (abs) => existingFiles.has(abs.replace(/^\/repo\//, '')),
	toUri: (abs) => `file://${abs.startsWith('/') ? '' : '/'}${abs}`,
	toPath: (uri) => (uri.startsWith('file:///') ? `/${uri.slice('file://'.length)}` : null),
};

const deps: ResolveDeps = { lsp: emptyLsp, workspace, mintChainId: () => 'cc-1', now: () => 1 };

function makeSink() {
	const rows = new Map<string, unknown>();
	const sink: ChainStoreSink = {
		get: <T,>(k: string) => rows.get(k) as T | undefined,
		update: (k, v) => {
			if (v === undefined) rows.delete(k);
			else rows.set(k, v);
		},
		delete: (k) => {
			rows.delete(k);
		},
	};
	return { sink, rows };
}

function makeTools() {
	const { sink, rows } = makeSink();
	const store = new ChainStore(sink);
	const shown: CodeChain[] = [];
	const updated: CodeChain[] = [];
	const verbs: unknown[] = [];
	const sinks: ToolSinks = {
		showChain: (c) => shown.push(c),
		updateChain: (c) => updated.push(c),
		verb: (n) => verbs.push(n),
		log: () => undefined,
	};
	const tools = new CodeChainTools(deps, store, sinks);
	function reply() {
		const calls: { content?: string; isError?: boolean; err?: string }[] = [];
		const sinks: ReplySinks = {
			ok: (content, isError) => calls.push({ content, isError }),
			err: (message) => calls.push({ err: message }),
		};
		return { sinks, calls };
	}
	return { tools, store, rows, shown, updated, verbs, reply };
}

const okRoot: ChainNodeDraft = {
	id: 'handler.create',
	label: 'createOrder',
	kind: 'entry',
	file: 'src/order/handler.ts',
	symbol: 'OrderController.createOrder',
	summary: 'HTTP 入口',
};

const failingChild: ChainNodeDraft = {
	id: 'ghost',
	label: 'phantom',
	kind: 'call',
	file: 'src/order/handler.ts',
	symbol: 'no.such.method',
	summary: '幻觉节点',
};

const call = (name: string, input: unknown): InvokeCall => ({ sessionId: 's1', name, input });

function parsed(content: string | undefined): Record<string, unknown> {
	return content ? (JSON.parse(content) as Record<string, unknown>) : {};
}

describe('client tool specs', () => {
	it('register all seven, read-only, snake_case-ready', () => {
		const specs = clientToolSpecs();
		expect(specs.map((s) => s.name)).toEqual([
			TOOL_NAMES.entry,
			TOOL_NAMES.narrate,
			TOOL_NAMES.extend,
			TOOL_NAMES.add,
			TOOL_NAMES.expand,
			TOOL_NAMES.annotate,
			TOOL_NAMES.refresh,
		]);
		expect(specs.every((s) => s.readOnly === true)).toBe(true);
		// Cross-references between tools use the model-facing prefixed names
		// (§8 Phase 0 revision): the model never sees the bare registration
		// name, so the descriptions must not reference it either. The
		// progressive chain-building path (entry ↔ add ↔ extend → narrate, per TOOL_NAMES) must
		// point at each other, and the semantics pair (Expand ↔ Annotate ↔
		// Extend) too.
		expect(specs[0]?.description).toContain(`client_${TOOL_NAMES.extend}`);
		// The seed no longer carries the story — it must send the model to the
		// dedicated narrative tool instead.
		expect(specs[0]?.description).toContain(`client_${TOOL_NAMES.narrate}`);
		// The default build path is node-by-node: the seed points the model at
		// Add for every following step.
		expect(specs[0]?.description).toContain(`client_${TOOL_NAMES.add}`);
		// The seed schema dropped the top-level narrative field entirely (the
		// word still appears inside a node `beat` description — check the shape,
		// not the string).
		const genSchema = specs[0]?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
		expect(genSchema.properties?.narrative).toBeUndefined();
		expect(genSchema.required ?? []).not.toContain('narrative');
		// The seed `root` is a SINGLE entry node, not a recursive tree: it
		// points at `$defs.entryNode`, which carries NO `children` (that
		// recursive face was the residual mid-JSON truncation source — the
		// model kept packing a multi-node spine into the one seed call).
		const entrySchema = specs[0]?.inputSchema as {
			properties?: { root?: { $ref?: string } };
			$defs?: Record<string, { properties?: Record<string, unknown> }>;
		};
		expect(entrySchema.properties?.root?.$ref).toBe('#/$defs/entryNode');
		expect(entrySchema.$defs?.entryNode?.properties?.children).toBeUndefined();
		expect(entrySchema.$defs?.node).toBeUndefined();
		expect(specs[1]?.description).toContain(`client_${TOOL_NAMES.entry}`);
		expect(specs[2]?.description).toContain(`client_${TOOL_NAMES.entry}`);
		// Add (index 3) is the default one-node-per-call path and must
		// cross-reference the whole-tree tools it replaces + the narrator it
		// hands off to.
		expect(specs[3]?.description).toContain('ONE node');
		expect(specs[3]?.description).toContain(`client_${TOOL_NAMES.entry}`);
		expect(specs[3]?.description).toContain(`client_${TOOL_NAMES.extend}`);
		expect(specs[3]?.description).toContain(`client_${TOOL_NAMES.narrate}`);
		expect(specs[4]?.description).toContain(`client_${TOOL_NAMES.annotate}`);
		expect(specs[4]?.description).toContain(`client_${TOOL_NAMES.extend}`);
		expect(specs[5]?.description).toContain(`client_${TOOL_NAMES.expand}`);
		expect(specs[5]?.description).toContain(`client_${TOOL_NAMES.extend}`);
		for (const spec of specs) {
			// A bare (unprefixed) tool name would be a name the model can
			// never call — reject it in every description.
			expect(spec.description).not.toMatch(new RegExp(`(^|[^_A-Za-z])(${Object.values(TOOL_NAMES).join('|')})(?!_)`));
		}
	});
});

describe('TutorEntry (chain seed)', () => {
	it('a single entry node publishes store + panel + journal verb', async () => {
		const { tools, store, shown, verbs, reply } = makeTools();
		const r = reply();
		const handled = await tools.handle(call(TOOL_NAMES.entry, { title: '流程', question: 'q', root: okRoot }), r.sinks);
		expect(handled).toBe(true);
		const out = r.calls[0];
		expect(out?.err).toBeUndefined();
		expect(out?.isError).toBe(false);
		expect(parsed(out?.content)).toMatchObject({
			ok: true,
			chainId: 'cc-1',
			nodeId: 'handler.create',
			nodeCount: 1,
			unresolvedCount: 0,
			nextStep: expect.stringContaining(`client_${TOOL_NAMES.narrate}`),
		});
		// The next step is the node-by-node path, not a whole tree.
		expect(parsed(out?.content).nextStep).toContain(`client_${TOOL_NAMES.add}`);
		expect(store.get('cc-1')?.title).toBe('流程');
		expect(store.get('cc-1')?.root.children).toEqual([]);
		expect(shown).toHaveLength(1);
		expect(verbs[0]).toMatchObject({ sessionId: 's1', chainId: 'cc-1', nodeCount: 1 });
	});

	it('routes the prefixed `client_TutorEntry` name identically (§9.2)', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		const handled = await tools.handle(call(`client_${TOOL_NAMES.entry}`, { title: 't', question: 'q', root: okRoot }), r.sinks);
		expect(handled).toBe(true);
		expect(r.calls[0]?.isError).toBe(false);
	});

	// The structural fix (real-model root cause): qwen3.8-flash's per-call
	// valid JSON space is under 1KB (observed cut points 3423 / 5334 columns),
	// so a `root` that ALLOWS a tree trains the model to pack a multi-node
	// spine into the seed call and truncate mid-JSON. The schema now exposes
	// only a single entry node and the handler REJECTS `children` outright — a
	// lenient drop would hide the misuse, so rejection is the contract.
	it('a `root` carrying children answers isError with the single-node recipe', async () => {
		const { tools, shown, store, reply } = makeTools();
		const r = reply();
		const handled = await tools.handle(
			call(TOOL_NAMES.entry, {
				title: 't',
				question: 'q',
				root: { ...okRoot, children: [okChildWithId('second')] },
			}),
			r.sinks,
		);
		expect(handled).toBe(true);
		expect(r.calls[0]?.err).toBeUndefined();
		expect(r.calls[0]?.isError).toBe(true);
		const msg = r.calls[0]?.content ?? '';
		expect(msg).toContain(`client_${TOOL_NAMES.entry}`);
		expect(msg).toContain('SINGLE entry node');
		expect(msg).toContain('children');
		expect(msg).toContain(`client_${TOOL_NAMES.add}`);
		// Rejected before resolving: nothing published, nothing stored.
		expect(shown).toHaveLength(0);
		expect(store.get('cc-1')).toBeUndefined();
	});

	it('an empty `children` array on `root` is rejected too (a lenient drop would not train sharding)', async () => {
		const { tools, shown, reply } = makeTools();
		const r = reply();
		await tools.handle(
			call(TOOL_NAMES.entry, { title: 't', question: 'q', root: { ...okRoot, children: [] } }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('SINGLE entry node');
		expect(shown).toHaveLength(0);
	});

	it('a single entry node whose symbol fails drives the correction loop with a single-node hint (§4)', async () => {
		const { tools, shown, reply } = makeTools();
		const r = reply();
		await tools.handle(
			call(TOOL_NAMES.entry, { title: 't', question: 'q', root: { ...failingChild, kind: 'entry' } }),
			r.sinks,
		);
		const out = r.calls[0];
		expect(out?.isError).toBe(true);
		const body = parsed(out?.content);
		expect(body.ok).toBe(false);
		expect(body.failures).toEqual([{ nodeId: 'ghost', reason: expect.any(String) }]);
		expect(body.hint).toContain('single corrected entry node');
		expect(shown).toHaveLength(0); // not published while correcting
	});

	it('after 3 correction rounds renders anyway with a note (§4 upper bound)', async () => {
		const { tools, shown, store, reply } = makeTools();
		const root = { ...failingChild, kind: 'entry' as const };
		for (let i = 0; i < 4; i += 1) {
			const r = reply();
			await tools.handle(call(TOOL_NAMES.entry, { title: 't', question: 'q', root }), r.sinks);
			if (i < 3) expect(r.calls[0]?.isError).toBe(true);
			else expect(r.calls[0]?.isError).toBe(false);
		}
		// The 4th attempt (rounds exhausted) publishes with an unresolved note.
		expect(shown).toHaveLength(1);
		expect(store.get('cc-1')?.stats.unresolvedCount).toBe(1);
	});

	it('a malformed draft answers isError without resolving', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		await tools.handle(call(TOOL_NAMES.entry, { title: 't', root: { id: 'x' } }), r.sinks);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('requires');
	});

	// The tightened seed budget (6000 → 3000): a ~3.5KB draft now trips the
	// guard where the old limit would have let it through and blown the model's
	// ~5KB output budget once the reply came back.
	it('a 3.5KB seed draft is rejected under the tightened 3000-char budget', async () => {
		const { tools, shown, reply } = makeTools();
		const r = reply();
		await tools.handle(
			call(TOOL_NAMES.entry, { title: 't', question: 'q', root: { ...okRoot, summary: 's'.repeat(3_400) } }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('payload too large');
		expect(r.calls[0]?.content).toContain('3000 char limit');
		expect(shown).toHaveLength(0);
	});

	it('rejects a stray `narrative` field and routes the model to client_TutorNarrate', async () => {
		const { tools, shown, store, reply } = makeTools();
		const r = reply();
		await tools.handle(
			call(TOOL_NAMES.entry, {
				title: 't',
				question: 'q',
				narrative: '用户发起下单，系统先校验库存再落库广播。',
				root: okRoot,
			}),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain(`client_${TOOL_NAMES.narrate}`);
		// Rejected before resolving: nothing published.
		expect(shown).toHaveLength(0);
		expect(store.get('cc-1')).toBeUndefined();
	});

	it('seeds a single entry node with NO narrative — the field stays off the chain (split flow)', async () => {
		const { tools, store, reply } = makeTools();
		const r = reply();
		await tools.handle(call(TOOL_NAMES.entry, { title: 't', question: 'q', root: okRoot }), r.sinks);
		expect(r.calls[0]?.isError).toBe(false);
		expect('narrative' in (store.get('cc-1') ?? {})).toBe(false);
	});
});

// The business story is its own call (the real-model fix: a narrative + tree
// in one entry-tool reply blew the ~5KB output budget mid-JSON). Narrate
// runs no resolution — it just sets `chain.narrative`, re-saves, and re-pushes
// the open panel; over-cap stories truncate with a warning, an oversized
// payload is refused with a compress-to-cap instruction.
describe('TutorNarrate', () => {
	async function genOk() {
		const t = makeTools();
		const r = t.reply();
		await t.tools.handle(call(TOOL_NAMES.entry, { title: 't', question: 'q', root: okRoot }), r.sinks);
		expect(r.calls[0]?.isError).toBe(false);
		return t;
	}

	it('commits the narrative on the chain AND the panel update (no re-resolve)', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(
			call(`client_${TOOL_NAMES.narrate}`, { chainId: 'cc-1', narrative: '用户发起下单，系统先校验库存再落库广播。' }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(false);
		expect(parsed(r.calls[0]?.content)).toMatchObject({ ok: true, chainId: 'cc-1', narrativeChars: 20 });
		expect(t.store.get('cc-1')?.narrative).toBe('用户发起下单，系统先校验库存再落库广播。');
		// The update sink fires (panel refresh); Gen's show was NOT repeated.
		expect(t.updated).toHaveLength(1);
		expect(t.updated[0]?.narrative).toBe('用户发起下单，系统先校验库存再落库广播。');
		expect(t.shown).toHaveLength(1);
	});

	it('truncates an over-cap story to MAX_NARRATIVE_CHARS with a warning', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.narrate, { chainId: 'cc-1', narrative: 'x'.repeat(1_500) }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(false);
		const body = parsed(r.calls[0]?.content);
		expect(body.narrativeChars).toBe(1_200);
		expect((body.warnings as string[]).some((w) => w.includes('narrative truncated'))).toBe(true);
		expect(t.store.get('cc-1')?.narrative?.length).toBe(1_200);
	});

	it('a payload past the 2000-char headroom guard answers the compress-to-cap instruction', async () => {
		const t = await genOk();
		const r = t.reply();
		// ~1990-char narrative: serialized payload >2000 chars (chainId + json
		// overhead), past the headroom guard even though it is inside 1200… no,
		// it is over 1200 too — the guard fires FIRST, before truncation.
		await t.tools.handle(
			call(TOOL_NAMES.narrate, { chainId: 'cc-1', narrative: 'y'.repeat(1_990) }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		const msg = r.calls[0]?.content ?? '';
		expect(msg).toContain('payload too large');
		expect(msg).toContain('2000 char limit');
		expect(msg).toContain('Compress');
		// Rejected before touching the chain.
		expect(t.store.get('cc-1')?.narrative).toBeUndefined();
	});

	it('missing chainId answers without hanging (review #5)', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		const handled = await tools.handle(call(TOOL_NAMES.narrate, { narrative: '故事' }), r.sinks);
		expect(handled).toBe(true);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('chainId');
	});

	it('an empty narrative answers isError', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(call(TOOL_NAMES.narrate, { chainId: 'cc-1', narrative: '   ' }), r.sinks);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('narrative');
	});
});

// Progressive chain building (§ plan): TutorExtend attaches a ≤8-node
// block under an existing parent, reusing the self-correction gate; the
// payload guards turn an oversized draft into an actionable re-shard
// instruction instead of a silent transport failure.
describe('TutorExtend', () => {
	const okChild: ChainNodeDraft = {
		id: 'service.create',
		label: 'create',
		kind: 'call',
		file: 'src/order/service.ts',
		symbol: 'OrderService.create',
		summary: '核心下单逻辑',
		beat: '库存与风控校验',
	};

	async function genOk() {
		const t = makeTools();
		const r = t.reply();
		await t.tools.handle(call(TOOL_NAMES.entry, { title: 't', question: 'q', root: okRoot }), r.sinks);
		expect(r.calls[0]?.isError).toBe(false);
		return t;
	}

	it('attaches resolved children under the parent, recomputes stats, and pushes the panel update', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(
			call(`client_${TOOL_NAMES.extend}`, { chainId: 'cc-1', parentId: 'handler.create', children: [okChild] }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(false);
		expect(parsed(r.calls[0]?.content)).toMatchObject({ ok: true, chainId: 'cc-1', added: ['service.create'], nodeCount: 2, unresolvedCount: 0 });
		const stored = t.store.get('cc-1');
		expect(stored?.root.children[0]?.id).toBe('service.create');
		// The block's beat survives resolution (draft → ResolvedNode).
		expect(stored?.root.children[0]?.beat).toBe('库存与风控校验');
		// Whole-tree stats recomputed from the new tree.
		expect(stored?.stats).toEqual({ nodeCount: 2, unresolvedCount: 0 });
		// Update (NOT reveal — the panel stays where it was) rides once.
		expect(t.updated).toHaveLength(1);
		expect(t.shown).toHaveLength(1); // only the original gen
	});

	it('an unknown parentId answers isError with up to 10 available ids', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.extend, { chainId: 'cc-1', parentId: 'ghost.node', children: [okChild] }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		const body = parsed(r.calls[0]?.content);
		expect(body.error).toContain('ghost.node');
		expect(body.availableIds).toEqual(expect.arrayContaining([expect.stringContaining('handler.create')]));
		expect((body.availableIds as string[]).length).toBeLessThanOrEqual(10);
	});

	it('a failing node drives the self-correction loop, then a fixed retry attaches (round 1 fail → round 2 ok)', async () => {
		const t = await genOk();
		const r1 = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.extend, { chainId: 'cc-1', parentId: 'handler.create', children: [failingChild] }),
			r1.sinks,
		);
		expect(r1.calls[0]?.isError).toBe(true);
		const body = parsed(r1.calls[0]?.content);
		expect(body.failures).toEqual([{ nodeId: 'ghost', reason: expect.any(String) }]);
		// Nothing published or stored while correcting.
		expect(t.updated).toHaveLength(0);
		expect(t.store.get('cc-1')?.root.children).toHaveLength(0);

		const r2 = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.extend, { chainId: 'cc-1', parentId: 'handler.create', children: [okChild] }),
			r2.sinks,
		);
		expect(r2.calls[0]?.isError).toBe(false);
		expect(t.store.get('cc-1')?.root.children[0]?.id).toBe('service.create');
		expect(t.updated).toHaveLength(1);
	});

	it('an Extend block may still replace the chain story; an omitted one keeps it', async () => {
		const eventChild: ChainNodeDraft = {
			id: 'event.emitted',
			label: 'emitOrderCreated',
			kind: 'data',
			file: 'src/order/events.ts',
			symbol: 'emitOrderCreated',
			summary: '领域事件广播',
		};
		const t = makeTools();
		const g = t.reply();
		await t.tools.handle(call(TOOL_NAMES.entry, { title: 't', question: 'q', root: okRoot }), g.sinks);
		// Seed the story through the dedicated narrative tool, not Gen.
		const gn = t.reply();
		await t.tools.handle(call(TOOL_NAMES.narrate, { chainId: 'cc-1', narrative: '旧版故事' }), gn.sinks);
		expect(gn.calls[0]?.isError).toBe(false);
		// No narrative on the block → the stored story is untouched.
		const r1 = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.extend, { chainId: 'cc-1', parentId: 'handler.create', children: [okChild] }),
			r1.sinks,
		);
		expect(r1.calls[0]?.isError).toBe(false);
		expect(t.store.get('cc-1')?.narrative).toBe('旧版故事');
		// With narrative → overwritten on the store AND the panel push.
		const r2 = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.extend, {
				chainId: 'cc-1',
				parentId: 'handler.create',
				children: [eventChild],
				narrative: '新版故事',
			}),
			r2.sinks,
		);
		expect(r2.calls[0]?.isError).toBe(false);
		expect(t.store.get('cc-1')?.narrative).toBe('新版故事');
		// updated[0] = the Narrate push, updated[1] = first extend, updated[2] =
		// this extend (carrying the new story).
		expect(t.updated[2]?.narrative).toBe('新版故事');
	});

	it('payload guard: an oversized TutorEntry draft answers with the size + shard recipe', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		await tools.handle(
			call(TOOL_NAMES.entry, {
				title: 't',
				question: 'q',
				root: { ...okRoot, summary: 's'.repeat(7_000) },
			}),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		const msg = r.calls[0]?.content ?? '';
		expect(msg).toContain('payload too large');
		expect(msg).toMatch(/7\d{3} chars/); // the ACTUAL serialized size
		expect(msg).toContain('3000 char limit'); // the TIGHTENED seed budget
		expect(msg).toContain(`client_${TOOL_NAMES.extend}`);
		expect(msg).toContain('120'); // summary cap in the recipe
	});

	it('payload guard: an oversized Extend block answers with the size + shard recipe', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.extend, {
				chainId: 'cc-1',
				parentId: 'handler.create',
				children: [{ ...okChild, summary: 'x'.repeat(5_000) }],
			}),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		const msg = r.calls[0]?.content ?? '';
		expect(msg).toContain('payload too large');
		expect(msg).toMatch(/5\d{3} chars/);
		expect(msg).toContain('3000 char limit'); // the TIGHTENED extend budget
		expect(msg).toContain(`client_${TOOL_NAMES.extend}`);
		// The guard rejects BEFORE resolving: no panel update.
		expect(t.updated).toHaveLength(0);
	});
});

// TutorAdd is the node-by-node DEFAULT path: every call carries ONE
// node (~300 chars), the only tool JSON a small-output-budget model can emit
// without truncating. It seeds a new chain from a first node, appends under a
// parentId, rejects a packed `children` array with the "one per call" recipe,
// and reuses the shared self-correction gate keyed by session + chain + node.
describe('TutorAdd (node-by-node default)', () => {
	const eventNode: ChainNodeDraft = {
		id: 'event.emitted',
		label: 'emitOrderCreated',
		kind: 'data',
		file: 'src/order/events.ts',
		symbol: 'emitOrderCreated',
		summary: '领域事件广播',
		beat: '订单创建后广播',
	};

	it('create mode: a first node with no chainId/parentId seeds a chain (root = the node, title = label + " 代码导游")', async () => {
		const { tools, store, shown, verbs, reply } = makeTools();
		const r = reply();
		const handled = await tools.handle(
			call(`client_${TOOL_NAMES.add}`, { node: { ...okRoot, children: undefined } }),
			r.sinks,
		);
		expect(handled).toBe(true);
		expect(r.calls[0]?.err).toBeUndefined();
		expect(r.calls[0]?.isError).toBe(false);
		expect(parsed(r.calls[0]?.content)).toMatchObject({
			ok: true,
			chainId: 'cc-1',
			nodeId: 'handler.create',
			nodeCount: 1,
			unresolvedCount: 0,
			nextHint: expect.stringContaining(`client_${TOOL_NAMES.narrate}`),
		});
		const created = store.get('cc-1');
		expect(created?.title).toBe('createOrder 代码导游');
		expect(created?.root.id).toBe('handler.create');
		// Seed publishes like Gen: panel reveal + journal verb.
		expect(shown).toHaveLength(1);
		expect(verbs[0]).toMatchObject({ sessionId: 's1', chainId: 'cc-1', nodeCount: 1 });
	});

	it('append mode: a node with parentId attaches under it, recomputes stats, and pushes an update (not a reveal)', async () => {
		const t = makeTools();
		const g = t.reply();
		await t.tools.handle(
			call(`client_${TOOL_NAMES.add}`, { node: { ...okRoot, children: undefined } }),
			g.sinks,
		);
		expect(g.calls[0]?.isError).toBe(false);
		const r = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.add, { chainId: 'cc-1', parentId: 'handler.create', node: { ...eventNode, children: undefined } }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(false);
		expect(parsed(r.calls[0]?.content)).toMatchObject({
			ok: true,
			chainId: 'cc-1',
			nodeId: 'event.emitted',
			nodeCount: 2,
			unresolvedCount: 0,
		});
		const stored = t.store.get('cc-1');
		expect(stored?.root.children[0]?.id).toBe('event.emitted');
		// The single node's beat survives resolution.
		expect(stored?.root.children[0]?.beat).toBe('订单创建后广播');
		expect(stored?.stats).toEqual({ nodeCount: 2, unresolvedCount: 0 });
		// Append rides the update sink, not a second reveal.
		expect(t.updated).toHaveLength(1);
		expect(t.shown).toHaveLength(1); // only the seed
	});

	it('an unknown parentId answers isError with available ids', async () => {
		const t = makeTools();
		const g = t.reply();
		await t.tools.handle(call(TOOL_NAMES.add, { node: { ...okRoot, children: undefined } }), g.sinks);
		const r = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.add, { chainId: 'cc-1', parentId: 'ghost.node', node: { ...eventNode, children: undefined } }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		const body = parsed(r.calls[0]?.content);
		expect(body.error).toContain('ghost.node');
		expect(body.availableIds).toEqual(expect.arrayContaining([expect.stringContaining('handler.create')]));
		expect((body.availableIds as string[]).length).toBeLessThanOrEqual(10);
	});

	it('a node carrying `children` answers isError and tells the model to add one node per call', async () => {
		const t = makeTools();
		const g = t.reply();
		await t.tools.handle(call(TOOL_NAMES.add, { node: { ...okRoot, children: undefined } }), g.sinks);
		const r = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.add, {
				chainId: 'cc-1',
				parentId: 'handler.create',
				node: { ...eventNode, children: [okChildWithId('extra')] },
			}),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('ONE node');
		expect(r.calls[0]?.content).toContain('children');
		// Rejected before attaching: still a one-node chain.
		expect(t.store.get('cc-1')?.root.children).toHaveLength(0);
	});

	it('a failing symbol drives the self-correction loop, then a fixed node attaches (round 1 fail → round 2 ok)', async () => {
		const t = makeTools();
		const g = t.reply();
		await t.tools.handle(call(TOOL_NAMES.add, { node: { ...okRoot, children: undefined } }), g.sinks);
		const r1 = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.add, { chainId: 'cc-1', parentId: 'handler.create', node: { ...failingChild, children: undefined } }),
			r1.sinks,
		);
		expect(r1.calls[0]?.isError).toBe(true);
		const body = parsed(r1.calls[0]?.content);
		expect(body.failures).toEqual([{ nodeId: 'ghost', reason: expect.any(String) }]);
		// Nothing appended while correcting.
		expect(t.updated).toHaveLength(0);
		expect(t.store.get('cc-1')?.root.children).toHaveLength(0);
		const r2 = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.add, { chainId: 'cc-1', parentId: 'handler.create', node: { ...eventNode, children: undefined } }),
			r2.sinks,
		);
		expect(r2.calls[0]?.isError).toBe(false);
		expect(t.store.get('cc-1')?.root.children[0]?.id).toBe('event.emitted');
		expect(t.updated).toHaveLength(1);
	});

	it('an oversized single-node payload trips the tightened 1200-char guard with the one-per-call recipe', async () => {
		const t = makeTools();
		const g = t.reply();
		await t.tools.handle(call(TOOL_NAMES.add, { node: { ...okRoot, children: undefined } }), g.sinks);
		const r = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.add, { chainId: 'cc-1', parentId: 'handler.create', node: { ...eventNode, summary: 'x'.repeat(1_400), children: undefined } }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		const msg = r.calls[0]?.content ?? '';
		expect(msg).toContain('payload too large');
		expect(msg).toMatch(/1\d{3} chars/);
		expect(msg).toContain('1200 char limit');
		expect(msg).toContain('ONE node');
		expect(msg).toContain('per call');
		// The guard rejects BEFORE resolving: no panel update.
		expect(t.updated).toHaveLength(0);
	});

	it('an unknown chainId answers isError (does not seed)', async () => {
		const { tools, shown, reply } = makeTools();
		const r = reply();
		await tools.handle(call(TOOL_NAMES.add, { chainId: 'ghost', node: { ...eventNode, children: undefined } }), r.sinks);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('unknown chainId');
		expect(shown).toHaveLength(0);
	});

	it('missing `node` answers isError', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		await tools.handle(call(TOOL_NAMES.add, { chainId: 'cc-1' }), r.sinks);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('node');
	});

	it('routes the prefixed `client_TutorAdd` name identically (§9.2)', async () => {
		const { tools, store, reply } = makeTools();
		const r = reply();
		const handled = await tools.handle(call(`client_${TOOL_NAMES.add}`, { node: { ...okRoot, children: undefined } }), r.sinks);
		expect(handled).toBe(true);
		expect(r.calls[0]?.isError).toBe(false);
		expect(store.get('cc-1')?.root.id).toBe('handler.create');
	});
});

// A minimal valid child node for the "children rejected" test (identity does
// not matter — the handler rejects the payload before resolving the children).
function okChildWithId(id: string): ChainNodeDraft {
	return { id, label: id, kind: 'call', file: 'src/order/service.ts', symbol: 'OrderService.create', summary: '附带子节点' };
}

describe('Expand / Annotate / Refresh', () => {
	async function genOk() {
		const t = makeTools();
		const r = t.reply();
		await t.tools.handle(call(TOOL_NAMES.entry, { title: 't', question: 'q', root: okRoot }), r.sinks);
		return t;
	}

	it('unknown chainId answers isError pointing at generation', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		await tools.handle(call(TOOL_NAMES.expand, { chainId: 'nope', nodeId: 'x', direction: 'callees' }), r.sinks);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain(`client_${TOOL_NAMES.entry}`);
	});

	it('expand with no call-hierarchy provider answers the LSP-unavailable error (§10)', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.expand, { chainId: 'cc-1', nodeId: 'handler.create', direction: 'callees' }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('call hierarchy');
	});

	it('annotate applies summary and updates the open chain (§4)', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.annotate, { chainId: 'cc-1', nodeId: 'handler.create', summary: '业务入口', edgeNote: 'e' }),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(false);
		expect(t.store.get('cc-1')?.root.summary).toBe('业务入口');
		expect(t.updated).toHaveLength(1);
	});

	it('refresh re-resolves and reports buckets (§6.3)', async () => {
		const t = await genOk();
		const r = t.reply();
		await t.tools.handle(call(TOOL_NAMES.refresh, { chainId: 'cc-1' }), r.sinks);
		const body = parsed(r.calls[0]?.content);
		expect(r.calls[0]?.isError).toBe(false);
		expect(body).toMatchObject({ ok: true, chainId: 'cc-1' });
		expect(Array.isArray(body.moved)).toBe(true);
		expect(Array.isArray(body.stale)).toBe(true);
		expect(Array.isArray(body.fixed)).toBe(true);
	});

	// Review round-2 (suggestion 5): the old `children === node.children`
	// short-circuit was always false (a fresh array each pass), so even a
	// refresh that moved nothing rebuilt the whole tree and re-pushed it.
	it('a refresh where no position moved re-pushes nothing (review round-2)', async () => {
		const t = await genOk();
		// okRoot resolves to the same range on re-resolve → pure no-op.
		const r = t.reply();
		await t.tools.handle(call(TOOL_NAMES.refresh, { chainId: 'cc-1' }), r.sinks);
		expect(r.calls[0]?.isError).toBe(false);
		const body = parsed(r.calls[0]?.content);
		expect(body.moved).toEqual([]);
		expect(body.stale).toEqual([]);
		expect(body.fixed).toEqual([]);
		// `updateChain` (the panel re-push sink) must not fire on a no-op.
		expect(t.updated).toHaveLength(0);
	});

	// Review round-3: the non-ok → non-ok refresh branch compared
	// `hit.location !== node.location` by reference — always true for the
	// fresh objects `resolveSymbol` mints — so any chain carrying an
	// ambiguous/unresolved node rebuilt and re-pushed on every refresh.
	it('a no-op refresh re-pushes nothing on an ambiguous chain (review round-3)', async () => {
		const t = makeTools();
		const r = t.reply();
		await t.tools.handle(
			call(TOOL_NAMES.entry, {
				title: 't',
				question: 'q',
				root: {
					id: 'inv.deduct',
					label: 'deduct',
					kind: 'call',
					file: 'src/order/service.ts',
					// Two fixture symbols share the bare name → ambiguous.
					symbol: 'deduct',
					summary: '库存扣减',
				},
			}),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(false);
		const stored = t.store.get('cc-1')?.root;
		expect(stored?.location.resolveStatus).toBe('ambiguous');
		expect(stored?.location.candidates?.length).toBeGreaterThan(1);

		const rr = t.reply();
		await t.tools.handle(call(TOOL_NAMES.refresh, { chainId: 'cc-1' }), rr.sinks);
		expect(rr.calls[0]?.isError).toBe(false);
		expect(parsed(rr.calls[0]?.content)).toMatchObject({ moved: [], stale: [], fixed: [] });
		expect(t.updated).toHaveLength(0);
	});

	it('an unknown tool name is not handled (caller fail-closes)', async () => {
		const { tools, reply } = makeTools();
		const handled = await tools.handle(call('SomeOtherTool', {}), reply().sinks);
		expect(handled).toBe(false);
	});
});

// Review #5: `handle()` claims the call (returns true), so a non-object or
// chainId-less input MUST still be answered — a silent return would leave
// the server waiting its full 300s (un-cancellable) timeout.
describe('every tool answers non-object / missing-chainId input (review #5)', () => {
	const toolsSuite: [string, unknown][] = [
		[TOOL_NAMES.expand, null],
		[TOOL_NAMES.extend, null],
		[TOOL_NAMES.annotate, 'a string'],
		[TOOL_NAMES.refresh, 42],
		[TOOL_NAMES.expand, { chainId: 'nope' }],
		[TOOL_NAMES.extend, { chainId: 'ghost' }],
		[TOOL_NAMES.annotate, {}],
		[TOOL_NAMES.refresh, { chainId: 'ghost' }],
	];
	for (const [name, input] of toolsSuite) {
		it(`${name} with input ${JSON.stringify(input)} replies without hanging`, async () => {
			const { tools, reply } = makeTools();
			const r = reply();
			const handled = await tools.handle(call(name, input), r.sinks);
			expect(handled).toBe(true);
			expect(r.calls).toHaveLength(1);
			// Business failures ride Ok { content, isError:true }; a truly
			// unparseable frame may Err — either way, exactly one reply.
			expect(r.calls[0]).toBeTruthy();
		});
	}
});

// TutorEntry now refuses a tree outright, so the review-round-2 "silently-
// dropped malformed child" failure mode is structurally gone: any `root`
// carrying `children` — well-formed or not — is rejected BEFORE resolution
// with the single-entry-node recipe, so the model never sees a false `ok:true`
// for a tree it thought it seeded.
describe('TutorEntry rejects any children instead of silently dropping them', () => {
	it('a malformed child no longer vanishes — the whole call is refused with the single-node guidance', async () => {
		const { tools, shown, reply } = makeTools();
		const r = reply();
		await tools.handle(
			call(TOOL_NAMES.entry, {
				title: 't',
				question: 'q',
				root: {
					...okRoot,
					children: [
						{ id: 'c0', label: 'c0', kind: 'call', file: 'src/order/handler.ts', symbol: 'OrderController.createOrder', summary: 'ok child' },
						{ id: 'c1', label: 'c1', file: 'src/order/handler.ts', symbol: 'x', summary: 'no kind' },
					],
				},
			}),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('SINGLE entry node');
		expect(r.calls[0]?.content).toContain(`client_${TOOL_NAMES.add}`);
		expect(shown).toHaveLength(0);
	});

	it('an out-of-vocabulary kind is refused the same way (whole-tree rejection, not a per-node drop report)', async () => {
		const { tools, reply } = makeTools();
		const r = reply();
		await tools.handle(
			call(TOOL_NAMES.entry, {
				title: 't',
				question: 'q',
				root: {
					...okRoot,
					children: [{ id: 'w', label: 'w', kind: 'widget', file: 'a.ts', symbol: 'x', summary: 'bad kind' }],
				},
			}),
			r.sinks,
		);
		expect(r.calls[0]?.isError).toBe(true);
		expect(r.calls[0]?.content).toContain('children');
	});
});

// Review round-2 (critical): once the handle bug is fixed, a genuine `provide*`
// rejection must reach the model as a tool ERROR — never collapse to the
// `{ok:true, note:'no new edges at this level'}` lie.
describe('TutorExpand reports provider failures honestly', () => {
	it('a provideOutgoingCalls rejection answers isError (not "no new edges")', async () => {
		const { sink } = makeSink();
		const store = new ChainStore(sink);
		const range = { startLine: 1, startCharacter: 0, endLine: 2, endCharacter: 0 };
		store.save({
			chainId: 'cc-e',
			sessionId: 's1',
			title: 't',
			question: 'q',
			createdAt: 0,
			stats: { nodeCount: 1, unresolvedCount: 0 },
			root: {
				id: 'n1',
				label: 'n1',
				kind: 'call',
				summary: '',
				provenance: 'llm',
				location: { uri: 'file:///repo/src/order/handler.ts', selectionRange: range, range, resolveStatus: 'ok' },
				children: [],
			},
		});
		const lsp: LspClient = {
			async documentSymbols() {
				return [];
			},
			async readText() {
				return '';
			},
			async workspaceSymbols() {
				return [];
			},
			async prepareCallHierarchy(): Promise<LspItem[]> {
				return [{ name: 'n1', uri: 'file:///repo/src/order/handler.ts', range, selectionRange: range, handle: { id: 'real' } }];
			},
			async outgoingCalls(): Promise<LspItem[]> {
				throw new Error('Invalid argument `item` when running vscode.provideOutgoingCalls');
			},
			async incomingCalls(): Promise<LspItem[]> {
				return [];
			},
			async prepareTypeHierarchy() {
				return [];
			},
			async subtypes() {
				return [];
			},
		};
		const updated: CodeChain[] = [];
		const tools = new CodeChainTools(
			{ lsp, workspace, mintChainId: () => 'cc-e', now: () => 0 },
			store,
			{ showChain: () => undefined, updateChain: (c) => updated.push(c), verb: () => undefined, log: () => undefined },
		);
		const calls: { content?: string; isError?: boolean }[] = [];
		await tools.handle(
			{ sessionId: 's1', name: TOOL_NAMES.expand, input: { chainId: 'cc-e', nodeId: 'n1', direction: 'callees' } },
			{ ok: (content, isError) => calls.push({ content, isError }), err: (message) => calls.push({ content: message }) },
		);
		expect(calls[0]?.isError).toBe(true);
		expect(calls[0]?.content).toContain('provideOutgoingCalls');
		expect(updated).toHaveLength(0);
	});
});

// ── Tutor naming invariants (the rebrand's guard rails) ─────────────────────
//
// `TOOL_NAMES` is the single source for every model-visible tool name, so the
// brand itself is pinned here: seven distinct PascalCase names, disjoint from
// the harness' built-in tools. This is ALSO the one place the pre-rebrand
// names may appear — historical journals display them, so the list doubles as
// a regression guard that nothing ROUTES by them any more.

describe('TOOL_NAMES', () => {
	const names = Object.values(TOOL_NAMES);

	it('holds exactly seven names, all distinct', () => {
		expect(names).toHaveLength(7);
		expect(new Set(names).size).toBe(7);
	});

	it('every name is PascalCase ^[A-Z][A-Za-z]+$', () => {
		for (const name of names) {
			expect(name).toMatch(/^[A-Z][A-Za-z]+$/);
		}
	});

	it('collides with no built-in tool name (Read/Write/Edit/Bash/Grep/Glob/Ls)', () => {
		const builtins = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Ls'];
		expect(names.filter((n) => builtins.includes(n))).toEqual([]);
	});

	it('routes none of the pre-rebrand names (bare or client_-prefixed)', async () => {
		const { tools } = makeTools();
		const nullReply: ReplySinks = { ok: () => undefined, err: () => undefined };
		for (const legacy of [
			'GenCodeChain',
			'AddCodeChainNode',
			'ExtendCodeChainNode',
			'ExpandCodeChainNode',
			'AnnotateCodeChainNode',
			'NarrateCodeChain',
			'RefreshCodeChain',
		]) {
			expect(await tools.handle(call(legacy, { chainId: 'cc-none' }), nullReply)).toBe(false);
			expect(await tools.handle(call(`client_${legacy}`, { chainId: 'cc-none' }), nullReply)).toBe(false);
		}
	});
});
