// LSP resolution engine (§5). Pure core + injected `LspClient` seam: the
// vscode API cannot load in vitest's node environment, so every provider
// call rides the interface and `lspClient.ts` supplies the VS Code adapter
// (`vscode.execute*Provider` commands). The core is the tested face — the
// algorithm below never imports vscode.
//
// Contract with the LLM: a draft carries `file` (workspace-relative) and
// `symbol` (exact name, `Class.method` for members), never positions. The
// resolver turns that into a `ResolvedNode` location; hallucinated symbols
// surface as `unresolved`/`ambiguous` with per-node reasons so the tool
// reply can drive a self-correction round (§4).

import type {
	ChainCandidate,
	ChainKind,
	ChainNodeDraft,
	ChainRange,
	CodeChain,
	NodeProvenance,
	ResolvedNode,
} from './types';
import { MAX_CHAIN_DEPTH, MAX_CHAIN_NODES, MAX_SUMMARY_CHARS } from './types';

// ── injected seam ───────────────────────────────────────────────────────────

/** Plain-data mirror of `vscode.DocumentSymbol` (detail/kind are carried for
 * display and overload hints only; ranges are full-range). */
export interface LspSymbol {
	name: string;
	detail?: string;
	range: ChainRange;
	selectionRange?: ChainRange;
	children: LspSymbol[];
}

/** Plain-data mirror of `vscode.CallHierarchyItem` / `TypeHierarchyItem`. */
export interface LspItem {
	name: string;
	uri: string;
	range: ChainRange;
	selectionRange: ChainRange;
}

export interface LspLocation {
	uri: string;
	range: ChainRange;
}

/** The provider surface the engine needs (all async, all failure-tolerant:
 * a provider absence resolves to an empty list, never a throw). */
export interface LspClient {
	documentSymbols(uri: string): Promise<LspSymbol[]>;
	/** Open (without stealing focus) and read a document; '' when unreadable. */
	readText(uri: string): Promise<string>;
	prepareCallHierarchy(uri: string, position: { line: number; character: number }): Promise<LspItem[]>;
	incomingCalls(item: LspItem): Promise<LspItem[]>;
	outgoingCalls(item: LspItem): Promise<LspItem[]>;
	prepareTypeHierarchy(uri: string, position: { line: number; character: number }): Promise<LspItem[]>;
	supertypes(item: LspItem): Promise<LspItem[]>;
	subtypes(item: LspItem): Promise<LspItem[]>;
	references(uri: string, position: { line: number; character: number }): Promise<LspLocation[]>;
	implementations(uri: string, position: { line: number; character: number }): Promise<LspLocation[]>;
}

/** Workspace facts the file-resolution step needs (folders + existence).
 * The VS Code adapter answers from `workspace.workspaceFolders` +
 * `workspace.fs.stat`. */
export interface WorkspaceView {
	/** Absolute paths of the open workspace folders (try order). */
	folders(): string[];
	fileExists(absolutePath: string): Promise<boolean>;
}

export interface ResolveDeps {
	lsp: LspClient;
	workspace: WorkspaceView;
	/** Stable id mint for chains. */
	mintChainId(): string;
	now(): number;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** A match hit's jump range is the FULL symbol range (the panel highlight
 * covers the whole body, §6.3); `selectionRange` rides along only for
 * hierarchy anchors where the full range may span an entire file. */
const rangeOf = (s: LspSymbol): ChainRange => s.range;

/** Flatten the hierarchical symbol list to a walking order. */
export function flattenSymbols(symbols: LspSymbol[]): LspSymbol[] {
	const out: LspSymbol[] = [];
	for (const s of symbols) {
		out.push(s);
		if (s.children.length > 0) out.push(...flattenSymbols(s.children));
	}
	return out;
}

/** Split a `Class.method` draft symbol into its path segments. */
export const symbolPath = (symbol: string): string[] =>
	symbol
		.split('.')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

interface PathHit {
	symbol: LspSymbol;
	path: string[];
}

/** Walk the symbol tree for `segments` in order: a match is a node whose
 * name equals the next segment, at-or-below the current depth (children
 * first, then any later sibling at the current level — the LLM's path is a
 * hint, not a strict containment claim; strictness would break on LSPs that
 * flatten anonymous namespaces). */
function matchSegments(
	symbols: LspSymbol[],
	segments: string[],
	prefix: string[],
	hits: PathHit[],
): void {
	if (segments.length === 0) return;
	const head = segments[0] as string;
	const rest = segments.slice(1);
	for (const symbol of symbols) {
		if (symbol.name !== head) continue;
		const here = [...prefix, symbol.name];
		if (rest.length === 0) {
			hits.push({ symbol, path: here });
		} else {
			matchSegments(symbol.children, rest, here, hits);
			// Tolerant descent: providers may surface members directly under
			// the file root; keep looking for the rest in the whole subtree.
			matchSegments(flattenSymbols(symbol.children).slice(1), rest, here, hits);
		}
	}
	// Siblings at this level were covered by the loop; deeper containment is
	// covered by the tolerant descent above. No recursion into children for
	// `head` alone: `Class.method` says the method follows the class.
}

/** Fuzzy fallback: last path segment matches a symbol name anywhere in the
 * tree (providers differ on whether `Foo.bar` is a single name). */
function matchFuzzy(rootSymbols: LspSymbol[], segments: string[]): PathHit[] {
	const last = segments[segments.length - 1];
	if (last === undefined) return [];
	const flat = flattenSymbols(rootSymbols);
	const joined = segments.join('.');
	return flat
		.filter((s) => s.name === last || s.name === joined)
		.map((s) => ({ symbol: s, path: [s.name] }));
}

function dedupeHits(hits: PathHit[]): PathHit[] {
	const seen = new Set<string>();
	const out: PathHit[] = [];
	for (const h of hits) {
		const key = `${h.symbol.range.startLine}:${h.symbol.range.startCharacter}:${h.symbol.name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(h);
	}
	return out;
}

const candidateOf = (hit: PathHit, uri: string): ChainCandidate => ({
	uri,
	range: rangeOf(hit.symbol),
	label: hit.path.join('.'),
});

/** One draft node's location through the resolution pipeline (§5). Returns
 * the location fields + a failure reason when anything is set. */
export async function resolveSymbol(
	lsp: LspClient,
	uri: string,
	symbol: string | undefined,
	kind: ChainKind,
): Promise<{ location: ResolvedNode['location']; reason?: string }> {
	if (kind === 'note') {
		// Conceptual step: no symbol expected, never a failure.
		return { location: { uri, resolveStatus: 'ok' } };
	}
	if (!symbol || symbol.trim() === '') {
		return {
			location: { uri: '', resolveStatus: 'unresolved' },
			reason: 'missing `symbol` (non-note nodes need an exact symbol name)',
		};
	}
	const segments = symbolPath(symbol);
	const tree = await lsp.documentSymbols(uri);
	let hits = dedupeHits(matchPath(tree, segments));
	if (hits.length === 0) {
		// Line-based fallback: the symbol appears in the text itself. A
		// single textual match is `ok` — the tour click then uses the
		// selection line (the LLM only guarantees name presence, not an
		// LSP-visible symbol); zero textual hits is the hard miss.
		hits = dedupeHits(matchFuzzy(tree, segments));
		if (hits.length === 0) {
			const text = await lsp.readText(uri);
			const textHits = textMatches(text, segments[segments.length - 1] as string);
			if (textHits.length === 1) {
				return {
					location: {
						uri,
						symbolPath: segments,
						range: textHits[0] as ChainRange,
						resolveStatus: 'ok',
					},
				};
			}
			return {
				location: { uri, resolveStatus: 'unresolved' },
				reason: `symbol \`${symbol}\` not found in ${uri.split('/').pop()} (no ${
					textHits.length > 0 ? 'unique' : 'any'
				} match)`,
			};
		}
	}
	if (hits.length === 1) {
		const hit = hits[0] as PathHit;
		return {
			location: {
				uri,
				symbolPath: hit.path,
				range: rangeOf(hit.symbol),
				resolveStatus: 'ok',
			},
		};
	}
	// Multiple matches (overloads, same-name methods): offer the pick.
	const candidates: ChainCandidate[] = hits.map((hit) => candidateOf(hit, uri));
	return {
		location: { uri, symbolPath: segments, resolveStatus: 'ambiguous', candidates },
	};
}

function matchPath(symbols: LspSymbol[], segments: string[]): PathHit[] {
	const hits: PathHit[] = [];
	matchSegments(symbols, segments, [], hits);
	return hits;
}

/** 1-based line ranges of `Name` occurrences in `text`. */
function textMatches(text: string, name: string): ChainRange[] {
	if (!name) return [];
	const out: ChainRange[] = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] as string;
		const col = line.indexOf(name);
		if (col < 0) continue;
		// Whole-word-ish: the char after the match must not continue the name.
		const end = col + name.length;
		if (end < line.length && /[A-Za-z0-9_$]/.test(line[end] as string)) continue;
		out.push({ startLine: i, startCharacter: col, endLine: i, endCharacter: end });
	}
	return out;
}

// ── file resolution ─────────────────────────────────────────────────────────

/** Map a draft `file` to a document uri through the workspace folders (§5:
 * relative paths try each folder in order; absolute paths must stay inside
 * one; anything else is refused). */
export async function resolveFileUri(
	workspace: WorkspaceView,
	file: string,
): Promise<{ uri?: string; reason?: string }> {
	const folders = workspace.folders();
	if (folders.length === 0) {
		return { reason: 'no workspace folder is open — cannot resolve files' };
	}
	const clean = file.trim().replace(/^\.\//, '');
	if (clean === '') return { reason: 'empty `file`' };
	const isAbsolute = clean.startsWith('/') || /^[A-Za-z]:[\\/]/.test(clean);
	const candidates: string[] = [];
	if (isAbsolute) {
		// Must live under some folder (越界拒绝).
		const inside = folders.find((f) => withinFolder(f, clean));
		if (!inside) return { reason: `\`${file}\` is outside every workspace folder` };
		candidates.push(clean);
	} else {
		for (const f of folders) candidates.push(`${f.replace(/\/+$/, '')}/${clean}`);
	}
	for (const abs of candidates) {
		if (await workspace.fileExists(abs)) return { uri: pathToUri(abs) };
	}
	return { reason: `file \`${file}\` not found in the workspace` };
}

const withinFolder = (folder: string, abs: string): boolean => {
	const base = folder.replace(/\/+$/, '');
	return abs === base || abs.startsWith(`${base}/`) || abs.startsWith(`${base}\\`);
};

/** Minimal posix-path file uri (vscode's Uri.file does the platform work in
 * the adapter; tests use plain `file:///…` strings through the seam). */
export const pathToUri = (absolutePath: string): string =>
	absolutePath.startsWith('file://') ? absolutePath : `file://${absolutePath.startsWith('/') ? '' : '/'}${absolutePath}`;

// ── whole-tree resolution ───────────────────────────────────────────────────

export interface DraftValidation {
	ok: boolean;
	/** Per-node failure lines for the tool reply (LLM self-correction). */
	errors: string[];
	/** Truncated/clamped draft tree (caps enforced here, §3). */
	draft: ChainNodeDraft;
	warnings: string[];
}

/** Enforce §3 caps over the submitted tree: depth, node budget, summary
 * length — truncating rather than rejecting, and reporting every cut so the
 * model knows what happened. */
export function validateDraft(draft: ChainNodeDraft): DraftValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const budget = { left: MAX_CHAIN_NODES };

	const walk = (node: ChainNodeDraft, depth: number, path: string): ChainNodeDraft => {
		// The caller has already spent a budget unit for THIS node (root
		// excepted); children are walked only while budget remains.
		const summary =
			node.summary.length > MAX_SUMMARY_CHARS
				? `${node.summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`
				: node.summary;
		if (node.summary.length > MAX_SUMMARY_CHARS) {
			warnings.push(`${path}: summary truncated to ${MAX_SUMMARY_CHARS} chars`);
		}
		const children: ChainNodeDraft[] = [];
		const atDepthCap = depth >= MAX_CHAIN_DEPTH;
		for (const [i, child] of (node.children ?? []).entries()) {
			if (atDepthCap) {
				warnings.push(`${path}: children of depth ${depth} dropped (max depth ${MAX_CHAIN_DEPTH})`);
				break;
			}
			if (budget.left <= 0) {
				// Truncation informs the model (§3) but is not a resolution
				// failure — it rides `warnings`, never the self-correct gate.
				warnings.push(`${path}: ${((node.children?.length ?? 0) - i)} node(s) dropped — the chain exceeds ${MAX_CHAIN_NODES}`);
				break;
			}
			budget.left -= 1;
			children.push(walk(child, depth + 1, `${path}/${child.id || `#${i}`}`));
		}
		return { ...node, summary, children };
	};

	budget.left -= 1; // the root itself
	const clamped = walk(draft, 0, draft.id || 'root');
	return { ok: errors.length === 0, errors, warnings, draft: clamped };
}

/** Resolve a (validated) draft tree into a renderable chain. Every node
 * gets a `resolveStatus`; failures carry reasons the tool reply relays. */
export async function resolveChain(
	deps: ResolveDeps,
	input: { chainId?: string; sessionId: string; title: string; question: string; root: ChainNodeDraft },
): Promise<{ chain: CodeChain; failures: { id: string; reason: string }[] }> {
	const failures: { id: string; reason: string }[] = [];
	let nodeCount = 0;

	const resolveNode = async (node: ChainNodeDraft): Promise<ResolvedNode> => {
		nodeCount += 1;
		let location: ResolvedNode['location'];
		if (!node.file || node.file.trim() === '') {
			location = node.kind === 'note'
				? { uri: '', resolveStatus: 'ok' }
				: { uri: '', resolveStatus: 'unresolved' };
			if (node.kind !== 'note') failures.push({ id: node.id, reason: 'missing `file`' });
		} else {
			const fileHit = await resolveFileUri(deps.workspace, node.file);
			if (!fileHit.uri) {
				location = { uri: '', resolveStatus: 'unresolved' };
				failures.push({ id: node.id, reason: fileHit.reason ?? 'unresolvable file' });
			} else {
				const hit = await resolveSymbol(deps.lsp, fileHit.uri, node.symbol, node.kind);
				location = hit.location;
				if (hit.reason) failures.push({ id: node.id, reason: hit.reason });
				// §5: an interface node piggybacks one subtypes query so the
				// panel can offer the implementations as expansion seeds.
				if (node.kind === 'interface' && location.resolveStatus === 'ok' && location.range) {
					const impls = await subtypeHints(deps.lsp, location);
					if (impls.length > 0) location.candidates = impls;
				}
			}
		}
		const children: ResolvedNode[] = [];
		for (const child of node.children ?? []) children.push(await resolveNode(child));
		return {
			id: node.id,
			label: node.label,
			kind: node.kind,
			summary: node.summary,
			edgeNote: node.edgeNote,
			provenance: 'llm',
			// Draft path rides the location for display; resolution
			// rewrites never drop it (pick-candidate / refresh keep it).
			location: { ...location, ...(node.file ? { file: node.file } : {}) },
			children,
		};
	};

	const root = await resolveNode(input.root);
	const unresolved = countStatus(root, 'unresolved');
	return {
		chain: {
			chainId: input.chainId ?? deps.mintChainId(),
			sessionId: input.sessionId,
			title: input.title,
			question: input.question,
			createdAt: deps.now(),
			root,
			stats: { nodeCount, unresolvedCount: unresolved },
		},
		failures,
	};
}

async function subtypeHints(lsp: LspClient, location: ResolvedNode['location']): Promise<ChainCandidate[]> {
	if (!location.range) return [];
	const items = await lsp
		.prepareTypeHierarchy(location.uri, { line: location.range.startLine, character: location.range.startCharacter })
		.catch(() => [] as LspItem[]);
	const first = items[0];
	if (!first) return [];
	const subtypes = await lsp.subtypes(first).catch(() => [] as LspItem[]);
	return subtypes.map((s) => ({ uri: s.uri, range: s.selectionRange, label: s.name }));
}

const countStatus = (node: ResolvedNode, status: ResolvedNode['location']['resolveStatus']): number => {
	let n = node.location.resolveStatus === status ? 1 : 0;
	for (const child of node.children) n += countStatus(child, status);
	return n;
};

// ── call/type hierarchy expansion (§4: ExpandCodeChainNode, no LLM) ───────

export interface ExpandOutcome {
	/** Newly merged child drafts (provenance-stamped), for the LLM to
	 * annotate and the panel to render after the reply. */
	added: { id: string; label: string; uri: string; range: ChainRange; provenance: NodeProvenance }[];
	error?: string;
}

/** Expand `node` by one hierarchy level: real LSP edges. Deduplication keys
 * on `label@file` — the ids in the tree are LLM slugs, the new nodes get
 * `callees:`/`callers:` prefixed ids, so identity can only be the human one
 * (two nodes pointing at the same symbol in the same file are the same
 * step, whichever produced them). */
export async function expandNode(
	lsp: LspClient,
	node: ResolvedNode,
	direction: 'callees' | 'callers',
	existingIds: Set<string>,
): Promise<ExpandOutcome> {
	if (node.location.resolveStatus !== 'ok' || !node.location.range) {
		return { added: [], error: `node \`${node.id}\` has no resolved position to expand from` };
	}
	const pos = { line: node.location.range.startLine, character: node.location.range.startCharacter };
	const items = await lsp.prepareCallHierarchy(node.location.uri, pos).catch(() => [] as LspItem[]);
	const anchor = items[0];
	if (!anchor) {
		return { added: [], error: 'call hierarchy is unavailable for this node (no language provider)' };
	}
	const related =
		direction === 'callees'
			? await lsp.outgoingCalls(anchor).catch(() => [] as LspItem[])
			: await lsp.incomingCalls(anchor).catch(() => [] as LspItem[]);
	const added: ExpandOutcome['added'] = [];
	const seen = new Set<string>();
	for (const item of related) {
		const file = item.uri.split('/').pop() ?? item.uri;
		const dedupKey = `${item.name}@${file}`;
		const id = `${direction}:${dedupKey}`;
		if (existingIds.has(dedupKey) || seen.has(dedupKey)) continue;
		seen.add(dedupKey);
		added.push({ id, label: item.name, uri: item.uri, range: item.selectionRange, provenance: 'callHierarchy' });
	}
	return { added };
}

/** Type-hierarchy expansion for `interface` nodes (§5 candidate seeds). */
export async function expandImplementations(
	lsp: LspClient,
	node: ResolvedNode,
): Promise<ExpandOutcome> {
	if (!node.location.range) return { added: [], error: `node \`${node.id}\` is unresolved` };
	const pos = { line: node.location.range.startLine, character: node.location.range.startCharacter };
	const items = await lsp.prepareTypeHierarchy(node.location.uri, pos).catch(() => [] as LspItem[]);
	const anchor = items[0];
	if (!anchor) return { added: [], error: 'type hierarchy unavailable' };
	const subs = await lsp.subtypes(anchor).catch(() => [] as LspItem[]);
	return {
		added: subs.map((s) => ({
			id: `impl:${s.name}@${s.uri.split('/').pop() ?? s.uri}`,
			label: s.name,
			uri: s.uri,
			range: s.selectionRange,
			provenance: 'typeHierarchy' as NodeProvenance,
		})),
	};
}
