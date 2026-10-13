// LSP resolution engine (§5). Pure core + injected `LspClient` seam: the
// vscode API cannot load in vitest's node environment, so every provider
// call rides the interface and `lspClient.ts` supplies the VS Code adapter
// (`vscode.execute*Provider` commands, with timeouts). The core is the
// tested face — the algorithm below never imports vscode, and every value
// that crosses the boundary (uris included, via `WorkspaceView.toUri`) is
// an opaque plain string.
//
// Contract with the LLM: a draft carries `file` (workspace-relative) and
// `symbol` (exact name, `Class.method` for members), never positions. The
// resolver turns that into a `ResolvedNode` location; hallucinated symbols
// surface as `unresolved`/`ambiguous` with per-node reasons so the tool
// reply can drive a self-correction round (§4).
//
// Strength of an `ok` position is what the pipeline actually proved: a
// document-symbol hit is precise; a workspace-symbol hit is precise but
// cross-file; a bare textual match is never `ok` — it lands as `ambiguous`
// with a `weak` marker so the UI shows a picker and a note (review #3).

import { errorText } from '../util';
import type {
	ChainCandidate,
	ChainKind,
	ChainLocation,
	ChainNodeDraft,
	ChainRange,
	CodeChain,
	NodeProvenance,
	ResolvedNode,
} from './types';
import {
	MAX_BEAT_CHARS,
	MAX_CHAIN_DEPTH,
	MAX_CHAIN_NODES,
	MAX_NARRATIVE_CHARS,
	MAX_SUMMARY_CHARS,
} from './types';

// ── injected seams ──────────────────────────────────────────────────────────

/** Plain-data mirror of `vscode.DocumentSymbol` (detail is carried for
 * display/overload hints only). */
export interface LspSymbol {
	name: string;
	detail?: string;
	range: ChainRange;
	selectionRange?: ChainRange;
	children: LspSymbol[];
}

/** Plain-data mirror of `vscode.CallHierarchyItem` / `TypeHierarchyItem`,
 * plus the adapter-owned `handle`: the ONE field the core never reads or
 * rewrites. A real provider item is not structurally forgeable — VS Code's
 * `provide*` commands `instanceof`-check their argument and route on hidden
 * `_sessionId`/`_itemId` fields only a `prepare*` result carries (review
 * round-2, critical). So the adapter stamps `handle` on every item it
 * returns from `prepare*`, and reads it back verbatim on `outgoing`/
 * `incoming`/`subtypes`; any rebuilt plain object would fail VS Code's
 * validation exactly as the old `anchor()` literal did. */
export interface LspItem {
	name: string;
	uri: string;
	range: ChainRange;
	selectionRange: ChainRange;
	handle?: unknown;
}

export interface LspLocation {
	uri: string;
	range: ChainRange;
	selectionRange?: ChainRange;
	/** Symbol name, when the provider carried one (workspace index hits). */
	name?: string;
}

/** One row of the read-only references lookup (the panel's "Find References"
 * drawer): plain data — the core never touches `vscode.Location`, so the
 * query face stays injectable for tests (§19). */
export interface LspReference {
	uri: string;
	range: ChainRange;
	/** Name the provider attached when it volunteered one. */
	name?: string;
}

/** Per-call budget for a provider round-trip: a wedged language server must
 * surface as "no symbols here" (→ unresolved / workspace fallback), never
 * freeze the tool until the server's 300s CALL_TIMEOUT (review #10). */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** Resolve `promise` to `onTimeout` if it is still pending after `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(onTimeout), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** The provider surface the engine needs. Failure tolerance differs by call:
 * resolution probes (`documentSymbols`/`workspaceSymbols`/`readText`) degrade
 * a wedged or absent provider to an empty result so the fallback chain keeps
 * working; HIERARCHY calls do NOT — a `prepare*`/`provide*` rejection must
 * reach the caller so an Expand can report a real failure instead of the
 * false "no edges" (review round-2, critical). */
export interface LspClient {
	documentSymbols(uri: string): Promise<LspSymbol[]>;
	/** Open (without stealing focus) and read a document; '' when unreadable. */
	readText(uri: string): Promise<string>;
	/** §5 zero-hit fallback: the workspace-wide symbol index. */
	workspaceSymbols(query: string): Promise<LspLocation[]>;
	/** References lookup (the panel's FIND-REFERENCES drawer): every LSP
	 * reference at a position, `[]` when the provider is absent / stalled —
	 * a read-only probe must never turn a missing provider into an error. */
	references(uri: string, position: { line: number; character: number }): Promise<LspReference[]>;
	/** Each returned item carries a `handle` the adapter needs to call the
	 * `provide*` commands below — relay it back unchanged. */
	prepareCallHierarchy(uri: string, position: { line: number; character: number }): Promise<LspItem[]>;
	incomingCalls(item: LspItem): Promise<LspItem[]>;
	outgoingCalls(item: LspItem): Promise<LspItem[]>;
	prepareTypeHierarchy(uri: string, position: { line: number; character: number }): Promise<LspItem[]>;
	subtypes(item: LspItem): Promise<LspItem[]>;
}

/** Workspace facts the file-resolution + key-normalization steps need. The
 * VS Code adapter answers from `workspace.workspaceFolders` +
 * `workspace.fs.stat` + `vscode.Uri.file` — path→uri and uri→path platform
 * semantics live ONLY in the adapter (review #9). */
export interface WorkspaceView {
	/** Absolute paths of the open workspace folders (try order). */
	folders(): string[];
	fileExists(absolutePath: string): Promise<boolean>;
	/** Platform-correct `file:` uri for an absolute path. */
	toUri(absolutePath: string): string;
	/** Absolute fs path for a `file:` uri; null for other schemes. */
	toPath(uri: string): string | null;
}

export interface ResolveDeps {
	lsp: LspClient;
	workspace: WorkspaceView;
	/** Stable id mint for chains. */
	mintChainId(): string;
	now(): number;
	/** Host log channel for tolerated-failure probes that must still leave a
	 * trace (review round-3: a silent `.catch(() => [])` once masked a dead
	 * hierarchy path). */
	log?(message: string): void;
}

/** Per-`uri` cap on concurrent provider calls (documentSymbols is memoized
 * per pass, so this bounds distinct files in flight). */
const RESOLVE_CONCURRENCY = 8;

// ── symbol matching ─────────────────────────────────────────────────────────

/** Jump/highlight range for a symbol hit: the FULL range covers the whole
 * body (§6.3); `selectionRange` (identifier span) rides along for
 * hierarchy anchors which need the declaration position itself (review #8). */
const rangeOf = (s: LspSymbol): ChainRange => s.range;
const selectionOf = (s: LspSymbol): ChainRange => s.selectionRange ?? s.range;

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

/** Identifier chars that would extend a name match: a hit whose neighbour
 * continues the identifier is a substring, not the symbol (review #3 —
 * `get` inside `const target =` must NOT match). */
const NAME_CHAR = /[A-Za-z0-9_$]/;

/** Comment lines a textual fallback must never trust: the LLM's phantom
 * name very often lives in a stale comment (`// phantomHelper was
 * removed`) — a match there is evidence of nothing. */
function isCommentLine(line: string, col: number): boolean {
	const before = line.slice(0, col);
	const trimmed = before.trimStart();
	return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** 0-based line ranges of whole-word `name` occurrences outside comments. */
function textMatches(text: string, name: string): ChainRange[] {
	if (!name) return [];
	const out: ChainRange[] = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] as string;
		let from = 0;
		for (;;) {
			const col = line.indexOf(name, from);
			if (col < 0) break;
			const end = col + name.length;
			const beforeOk = col === 0 || !NAME_CHAR.test(line[col - 1] as string);
			const afterOk = end >= line.length || !NAME_CHAR.test(line[end] as string);
			if (beforeOk && afterOk && !isCommentLine(line, col)) {
				out.push({ startLine: i, startCharacter: col, endLine: i, endCharacter: end });
				break; // one hit per line is plenty for a candidate
			}
			from = col + 1;
		}
	}
	return out;
}

// ── symbol resolution ───────────────────────────────────────────────────────

/** One draft node's symbol through the pipeline (§5): document-symbol tree →
 * fuzzy tree match → workspace-symbol index → textual fallback (weak). */
export async function resolveSymbol(
	lsp: LspClient,
	uri: string,
	symbol: string | undefined,
	kind: ChainKind,
): Promise<{ location: ChainLocation; reason?: string }> {
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
	const last = segments[segments.length - 1] as string;
	const tree = await lsp.documentSymbols(uri);
	let hits = dedupeHits(pathHits(tree, segments));
	if (hits.length === 0) hits = dedupeHits(matchFuzzy(tree, segments));
	if (hits.length === 1) {
		const hit = hits[0] as PathHit;
		return {
			location: {
				uri,
				symbolPath: hit.path,
				range: rangeOf(hit.symbol),
				selectionRange: selectionOf(hit.symbol),
				resolveStatus: 'ok',
			},
		};
	}
	if (hits.length > 1) {
		// Multiple matches (overloads, same-name methods): offer the pick.
		return {
			location: {
				uri,
				symbolPath: segments,
				resolveStatus: 'ambiguous',
				candidates: hits.map((hit) => candidateOf(hit, uri)),
			},
		};
	}
	// §5 zero-hit fallback #1: the workspace symbol index. Providers match
	// fuzzily (substring / camel-split), so keep exact-name hits — an exact
	// hit is a provider assertion: unique resolves to it (even in another
	// file), several become candidates for the picker.
	const wsAll = await lsp.workspaceSymbols(last);
	const wsHits = wsAll.filter((loc) => loc.name === undefined || loc.name === last);
	if (wsHits.length === 1) {
		const only = wsHits[0] as LspLocation;
		return {
			location: {
				uri: only.uri,
				symbolPath: segments,
				range: only.range,
				selectionRange: only.selectionRange ?? only.range,
				resolveStatus: 'ok',
			},
		};
	}
	if (wsHits.length > 1) {
		return {
			location: {
				uri,
				symbolPath: segments,
				resolveStatus: 'ambiguous',
				candidates: wsHits.map((loc) => ({
					uri: loc.uri,
					range: loc.range,
					label: `${loc.name ?? last}@${loc.uri.split('/').pop() ?? ''}`,
				})),
			},
		};
	}
	// §5 zero-hit fallback #2: textual presence in the file. A whole-word
	// match outside comments is WEAK evidence (no provider confirmed it is
	// a symbol) — surface it as ambiguous with a note, never `ok`
	// (review #3: the LLM must still confirm/rename the symbol).
	const text = await lsp.readText(uri);
	const textHits = textMatches(text, last);
	if (textHits.length > 0) {
		return {
			location: {
				uri,
				symbolPath: segments,
				resolveStatus: 'ambiguous',
				candidates: textHits.map((range) => ({
					uri,
					range,
					label: `text match · ${last}:${range.startLine + 1}`,
				})),
			},
			reason: `symbol \`${symbol}\` has no provider-reported position in ${uri.split('/').pop()} — text-matched occurrences listed as candidates`,
		};
	}
	return {
		location: { uri, resolveStatus: 'unresolved' },
		reason: `symbol \`${symbol}\` not found in ${uri.split('/').pop()}`,
	};
}

/** Run the strict path descent for `segments` and collect the hits. */
function pathHits(symbols: LspSymbol[], segments: string[]): PathHit[] {
	const hits: PathHit[] = [];
	matchSegments(symbols, segments, [], hits);
	return hits;
}

/** Test-visible tree-match face (§11): the exact path then the fuzzy pass,
 * mirroring `resolveSymbol`'s order. */
export function matchPath(symbols: LspSymbol[], segments: string[]): PathHit[] {
	const exact = pathHits(symbols, segments);
	return exact.length > 0 ? exact : dedupeHits(matchFuzzy(symbols, segments));
}

// ── file resolution ─────────────────────────────────────────────────────────

/** Normalize + workspace-check a draft `file` (§5, review #2):
 * dot-segments (especially `..`) are rejected outright — the folder join is
 * pure string concatenation and `..` would survive into a real fs path
 * outside every folder; the post-join `withinFolder` re-check is
 * defense-in-depth for absolute inputs that slipped past it. */
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
	const segments = clean.split(/[\\/]/);
	if (segments.some((s) => s === '..')) {
		return { reason: `\`${file}\` walks outside the workspace (.. segments are rejected)` };
	}
	const isAbsolute = clean.startsWith('/') || /^[A-Za-z]:[\\/]/.test(clean);
	const candidates: string[] = [];
	if (isAbsolute) {
		// Absolute drafts must live under some workspace folder.
		const inside = folders.find((f) => withinFolder(f, clean));
		if (!inside) return { reason: `\`${file}\` is outside every workspace folder` };
		candidates.push(clean);
	} else {
		for (const f of folders) {
			const joined = `${f.replace(/\/+$/, '')}/${clean}`;
			if (withinFolder(f, joined)) candidates.push(joined);
		}
	}
	for (const abs of candidates) {
		if (await workspace.fileExists(abs)) return { uri: workspace.toUri(abs) };
	}
	return { reason: `file \`${file}\` not found in the workspace` };
}

const withinFolder = (folder: string, abs: string): boolean => {
	const base = folder.replace(/[\\/]+$/, '');
	return abs === base || abs.startsWith(`${base}/`) || abs.startsWith(`${base}\\`);
};

/** The stable cross-dedup key for a graph node: `Name@<workspace-relative
 * path>` (full directory, not the basename — monorepo `src/order/events.ts`
 * vs `src/audit/events.ts` must not collide, review #7). Falls back to the
 * raw uri for paths the core cannot relativize. The adapter does uri→path;
 * the key separators are normalized to `/`. */
export function expansionKey(workspace: WorkspaceView, name: string, uri: string): string {
	const abs = workspace.toPath(uri);
	let rel = uri;
	if (abs !== null) {
		const folders = workspace.folders();
		for (const f of folders) {
			const base = f.replace(/[\\/]+$/, '');
			const norm = abs.replace(/\\/g, '/');
			if (norm === base || norm.startsWith(`${base}/`) || norm.startsWith(`${base}\\`)) {
				rel = norm.slice(base.length + 1);
				break;
			}
		}
	}
	return `${name}@${rel.replace(/\\/g, '/')}`;
}

// ── whole-tree caps (draft validation) ──────────────────────────────────────

export interface DraftValidation {
	/** Caps applied by truncation/clamping are reported here (§3): they inform
	 * the model but never gate the self-correction loop — an over-tall or
	 * over-wide draft is shortened and rendered, not rejected. */
	warnings: string[];
	/** The draft with every §3 cap enforced. */
	draft: ChainNodeDraft;
	/** The optional chain narrative as passed in, clamped to
	 * MAX_NARRATIVE_CHARS when it was over (a cut also adds a warning).
	 * Undefined when the caller had no narrative. */
	narrative?: string;
}

/** Enforce §3 caps over the submitted tree — depth, node budget, summary /
 * beat length, and the optional chain narrative — truncating rather than
 * rejecting, and reporting every cut so the model knows what happened.
 *
 * The narrative rides here (not on the draft) because it is a chain-level
 * companion text the tools pass alongside the tree: when provided it is
 * clamped to MAX_NARRATIVE_CHARS and echoed back on the result, so the
 * caller persists exactly what this face validated (the same one-stop
 * contract as `summary` — `resolveChain` itself never re-clamps). As of the
 * narrate split, the only tree-bearing caller still passing one is
 * `TOOL_NAMES.extend`'s optional replacement path — `TOOL_NAMES.entry` seeds
 * the spine with a SINGLE node and carries no story (`TOOL_NAMES.narrate`
 * commits it on its own call) — so the parameter is optional by design and a
 * caller may omit it.
 *
 * There is no `errors` channel here by design: a cap violation is a
 * truncation (a `warning`), and a malformed node is a `parseDraft` drop —
 * neither is a resolution failure, so none belongs in the self-correct gate
 * (review round-2, suggestion 4).
 *
 * Depth semantics (review #17): `MAX_CHAIN_DEPTH` counts **levels**, root =
 * level 1. A chain survives with at most MAX_CHAIN_DEPTH levels — i.e. the
 * root's descendant edge count is ≤ MAX_CHAIN_DEPTH − 1. */
export function validateDraft(draft: ChainNodeDraft, narrative?: string): DraftValidation {
	const warnings: string[] = [];
	const budget = { left: MAX_CHAIN_NODES };

	const walk = (node: ChainNodeDraft, depth: number, path: string): ChainNodeDraft => {
		// `depth` is this node's 1-based level; children would land on
		// depth+1, which must stay within MAX_CHAIN_DEPTH levels.
		const summary =
			node.summary.length > MAX_SUMMARY_CHARS
				? `${node.summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`
				: node.summary;
		if (node.summary.length > MAX_SUMMARY_CHARS) {
			warnings.push(`${path}: summary truncated to ${MAX_SUMMARY_CHARS} chars`);
		}
		// Beats get the same clamp-and-report treatment as summaries.
		let beat: string | undefined;
		if (typeof node.beat === 'string' && node.beat.length > MAX_BEAT_CHARS) {
			beat = `${node.beat.slice(0, MAX_BEAT_CHARS - 1)}…`;
			warnings.push(`${path}: beat truncated to ${MAX_BEAT_CHARS} chars`);
		} else {
			beat = node.beat;
		}
		const children: ChainNodeDraft[] = [];
		const atDepthCap = depth + 1 > MAX_CHAIN_DEPTH;
		for (const [i, child] of (node.children ?? []).entries()) {
			if (atDepthCap) {
				warnings.push(`${path}: children dropped — chain exceeds ${MAX_CHAIN_DEPTH} levels`);
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
		return { ...node, summary, beat, children };
	};

	budget.left -= 1; // the root itself
	const clamped = walk(draft, 1, draft.id || 'root');
	let clampedNarrative = narrative;
	if (typeof narrative === 'string' && narrative.length > MAX_NARRATIVE_CHARS) {
		clampedNarrative = `${narrative.slice(0, MAX_NARRATIVE_CHARS - 1)}…`;
		warnings.push(`narrative truncated to ${MAX_NARRATIVE_CHARS} chars`);
	}
	return { warnings, draft: clamped, narrative: clampedNarrative };
}

/** Count tree levels (root alone = 1). */
export function treeDepth(root: ChainNodeDraft): number {
	let max = 1;
	const walk = (node: ChainNodeDraft, depth: number): void => {
		if (depth > max) max = depth;
		for (const child of node.children ?? []) walk(child, depth + 1);
	};
	walk(root, 1);
	return max;
}

// ── whole-tree resolution ───────────────────────────────────────────────────

/** Resolve a (validated) draft tree into a renderable chain. Every node
 * gets a `resolveStatus`; failures carry reasons the tool reply relays.
 * Resolution is bounded-concurrent across files (provider calls memoized
 * per uri+symbol), so a wedged language server surfaces via the adapter
 * timeout per node and 48 nodes no longer serialize behind it (review #10).
 *
 * The optional `narrative` rides straight onto the chain — caps are
 * validateDraft's job (§3), so this face persists what it is given. */
export async function resolveChain(
	deps: ResolveDeps,
	input: {
		chainId?: string;
		sessionId: string;
		title: string;
		question: string;
		root: ChainNodeDraft;
		narrative?: string;
	},
): Promise<{ chain: CodeChain; failures: { id: string; reason: string }[] }> {
	const failures: { id: string; reason: string }[] = [];
	// Memoization faces: file → uri (or `ERR <reason>`), and symbol lookup
	// keyed by uri+symbol+kind so a file touched by many nodes pays one
	// provider round-trip per distinct symbol.
	const fileCache = new Map<string, string>();
	const symbolCache = new Map<string, Promise<{ location: ChainLocation; reason?: string }>>();

	const cachedResolve = (
		uri: string,
		symbol: string | undefined,
		kind: ChainKind,
	): Promise<{ location: ChainLocation; reason?: string }> => {
		const key = `${uri}#${symbol ?? ''}#${kind}`;
		let hit = symbolCache.get(key);
		if (!hit) {
			hit = resolveSymbol(deps.lsp, uri, symbol, kind);
			symbolCache.set(key, hit);
		}
		return hit;
	};

	const resolveFile = async (file: string): Promise<string> => {
		let hit = fileCache.get(file);
		if (hit === undefined) {
			const resolved = await resolveFileUri(deps.workspace, file);
			hit = resolved.uri ?? `ERR ${resolved.reason ?? 'unresolvable file'}`;
			fileCache.set(file, hit);
		}
		return hit;
	};

	const resolveNode = async (node: ChainNodeDraft): Promise<ResolvedNode> => {
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
				// A `reason` rides every non-ok outcome: unresolved is a hard
				// failure; the text-match weak hit reports as a correction
				// need too (the LLM should name a real symbol, review #3).
				if (hit.reason) failures.push({ id: node.id, reason: hit.reason });
				// §5: an interface node piggybacks one subtypes query so the
				// panel can offer the implementations as expansion seeds.
				if (node.kind === 'interface' && location.resolveStatus === 'ok') {
					const impls = await subtypeHints(deps.lsp, location, deps.log);
					if (impls.length > 0) location = { ...location, candidates: impls };
				}
			}
		}
		const children = await mapPool(node.children ?? [], resolveNode, RESOLVE_CONCURRENCY);
		return {
			id: node.id,
			label: node.label,
			kind: node.kind,
			summary: node.summary,
			edgeNote: node.edgeNote,
			beat: node.beat,
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
			stats: { nodeCount: countNodes(root), unresolvedCount: unresolved },
			...(input.narrative !== undefined ? { narrative: input.narrative } : {}),
		},
		failures,
	};
}

function countNodes(node: ResolvedNode): number {
	let n = 1;
	for (const child of node.children) n += countNodes(child);
	return n;
}

async function subtypeHints(
	lsp: LspClient,
	location: ChainLocation,
	log?: (message: string) => void,
): Promise<ChainCandidate[]> {
	const anchor = anchorPosition(location);
	if (!anchor) return [];
	// Best-effort hints (the interface node itself stays `ok`), but a failure
	// must leave a trace: silently answering `[]` is exactly how the round-2
	// critical (dead hierarchy path) stayed invisible (review round-3).
	const items = await lsp
		.prepareTypeHierarchy(location.uri, anchor)
		.catch((e: unknown) => {
			log?.(`type hierarchy prepare failed for ${location.uri}: ${errorText(e)}`);
			return [] as LspItem[];
		});
	const first = items[0];
	if (!first) return [];
	const subtypes = await lsp.subtypes(first).catch((e: unknown) => {
		log?.(`subtypes lookup failed for ${location.uri}: ${errorText(e)}`);
		return [] as LspItem[];
	});
	return subtypes.map((s) => ({ uri: s.uri, range: s.range, label: s.name }));
}

const countStatus = (node: ResolvedNode, status: ChainLocation['resolveStatus']): number => {
	let n = node.location.resolveStatus === status ? 1 : 0;
	for (const child of node.children) n += countStatus(child, status);
	return n;
};

/** Bounded-concurrency map preserving input order in the result. */
async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
	const out = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (;;) {
			const i = cursor;
			cursor += 1;
			if (i >= items.length) return;
			out[i] = await fn(items[i] as T);
		}
	});
	await Promise.all(workers);
	return out;
}

// ── call/type hierarchy expansion (§4: `TOOL_NAMES.expand`, no LLM) ──────

export interface ExpandOutcome {
	/** Newly merged child drafts (provenance-stamped), for the LLM to
	 * annotate and the panel to render after the reply. */
	added: { id: string; label: string; uri: string; range: ChainRange; provenance: NodeProvenance }[];
	error?: string;
}

/** Hierarchy anchors sit on the symbol's name (`selectionRange`), not the
 * full range start — providers routinely return an empty prepare for a
 * JSDoc / decorator line, and the failure would be misreported as "no
 * provider" (review #8). */
export function anchorPosition(location: ChainLocation): { line: number; character: number } | null {
	const r = location.selectionRange ?? location.range;
	return r ? { line: r.startLine, character: r.startCharacter } : null;
}

/** Expand `node` by one hierarchy level: real LSP edges. */
export async function expandNode(
	lsp: LspClient,
	workspace: WorkspaceView,
	node: ResolvedNode,
	direction: 'callees' | 'callers',
	existingKeys: Set<string>,
): Promise<ExpandOutcome> {
	const pos = anchorPosition(node.location);
	if (node.location.resolveStatus !== 'ok' || !pos) {
		return { added: [], error: `node \`${node.id}\` has no resolved position to expand from` };
	}
	let items: LspItem[];
	try {
		items = await lsp.prepareCallHierarchy(node.location.uri, pos);
	} catch (e) {
		return { added: [], error: `call hierarchy preparation failed: ${errorText(e)}` };
	}
	const anchor = items[0];
	if (!anchor) {
		return { added: [], error: 'call hierarchy is unavailable for this node (no language provider)' };
	}
	// A rejection from `provide*` is a real failure, not an empty level: turn
	// it into an `error` so the tool reports it, instead of a silent
	// `{added:[]}` the model reads as "no edges here" (review round-2,
	// critical).
	let related: LspItem[];
	try {
		related = direction === 'callees' ? await lsp.outgoingCalls(anchor) : await lsp.incomingCalls(anchor);
	} catch (e) {
		const edge = direction === 'callees' ? 'outgoing' : 'incoming';
		return { added: [], error: `${edge} call expansion failed: ${errorText(e)}` };
	}
	const added: ExpandOutcome['added'] = [];
	const seen = new Set<string>();
	for (const item of related) {
		const key = expansionKey(workspace, item.name, item.uri);
		if (existingKeys.has(key) || seen.has(key)) continue;
		seen.add(key);
		added.push({
			id: `${direction}:${key}`,
			label: item.name,
			uri: item.uri,
			range: item.selectionRange,
			provenance: 'callHierarchy',
		});
	}
	return { added };
}
