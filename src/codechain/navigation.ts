// Editor navigation + highlight + reverse sync (§6.3). All jumps go through
// `showTextDocument` with `preserveFocus` so the tour can walk code without
// stealing the panel; the decoration type mirrors VS Code's own reference
// highlight (theme colors only — the panel and the editor follow the user's
// theme). Reverse sync watches ACTIVE editor changes, not document changes:
// the panel highlights the node whose range the cursor's visible block
// overlaps (§10: drift is handled at click time / refresh, not by
// re-rendering the tour on every keystroke).

import * as vscode from 'vscode';
import type { LspClient } from './resolve';
import type { ChainRange, CodeChain, ResolvedNode, ToPanel } from './types';
import { findNode } from './tools';

/** One row of the panel's references drawer — the wire row the host posts in
 * `{t:'references'}`, kept structurally identical to `ToPanel`'s member by
 * the type below (so the two can never drift). */
export type ReferenceHit = Extract<ToPanel, { t: 'references' }>['hits'][number];

export const toVsRange = (r: ChainRange): vscode.Range =>
	new vscode.Range(r.startLine, r.startCharacter, r.endLine, r.endCharacter);

/** Best jump position for a node: the first ambiguity candidate stands in
 * for an `ambiguous` node (the panel still shows the picker); `stale` /
 * `ok` use the stored range; anything else is not navigable. */
export const nodeRange = (node: ResolvedNode): ChainRange | undefined =>
	node.location.range ?? node.location.candidates?.[0]?.range;

/** The LSP anchor for a node: the symbol NAME (`selectionRange`), which is
 * what reference providers expect — a span spanning the whole body often
 * yields nothing. Falls back to the full range, then to the best jump
 * position, so an older stored chain still resolves. `undefined` when the
 * node carries no location at all (note / unresolved). */
export const nodeAnchor = (node: ResolvedNode): { range: ChainRange; uri: string } | undefined => {
	const range = node.location.selectionRange ?? node.location.range ?? node.location.candidates?.[0]?.range;
	const uri = node.location.uri || node.location.candidates?.[0]?.uri || '';
	if (!range || uri === '') return undefined;
	return { range, uri };
};

export class ChainNavigation {
	private readonly highlightType: vscode.TextEditorDecorationType;
	private readonly disposables: vscode.Disposable[] = [];
	private syncTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly log: (message: string) => void,
		private readonly lsp: LspClient,
	) {
		this.highlightType = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
			rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
		});
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
		this.disposables.length = 0;
		this.highlightType.dispose();
	}

	/** Jump to a node and decorate its full symbol range. Returns false when
	 * the node has no location (note / unresolved) — the caller toasts.
	 * `stale` nodes are re-resolved by the caller (panel refresh) BEFORE
	 * this; here they jump to the last known position.
	 *
	 * The target column is chosen up front: a fixed `Beside` would build a
	 * THIRD column once one already exists (the panel docks bottom or right,
	 * so a "beside" editor is routinely column 2), squeezing the code into a
	 * sliver — the tour falls back to the active/first group instead. */
	async showNode(chain: CodeChain, nodeId: string, focus: boolean): Promise<boolean> {
		const node = findNode(chain.root, nodeId);
		const range = node ? nodeRange(node) : undefined;
		if (!node || !range || node.location.uri === '') return false;
		return this.showLocation(node.location.uri, range, focus);
	}

	/** Reveal an arbitrary location (a reference row, a candidate). Returns
	 * false when the jump itself fails, so the caller can toast. */
	async showLocation(uri: string, range: ChainRange, focus: boolean): Promise<boolean> {
		try {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
			const editor = await vscode.window.showTextDocument(doc, {
				preserveFocus: !focus,
				viewColumn: this.jumpColumn(),
			});
			editor.revealRange(toVsRange(range), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			this.highlight(editor, range);
			return true;
		} catch (e) {
			this.log(`navigation failed for ${uri}: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	/** The editor column a jump should land in: the active editor's group
	 * when it is not already the chain's own code pane, the first group when
	 * the tour only owns columns 2+ (always at least two columns free), and
	 * plain `Beside` on an empty workbench. */
	private jumpColumn(): vscode.ViewColumn {
		const active = vscode.window.activeTextEditor?.viewColumn;
		if (active === vscode.ViewColumn.One) return active;
		if (active !== undefined && vscode.window.tabGroups.all.length >= 2) return active;
		if (vscode.window.tabGroups.all.length >= 2) return vscode.ViewColumn.One;
		return vscode.ViewColumn.Beside;
	}

	/** Every reference the language server reports for a node's symbol —
	 * plain data, and the ONE place the LSP reference provider is reached
	 * from (the panel's drawer renders what this returns; nothing in the
	 * webview touches VS Code APIs). Empty on a missing / wedged provider or
	 * a node with no resolved location, never a rejection: the drawer's
	 * "no references" answer and its "unavailable" answer are the same
	 * read-only outcome for the user. */
	async listReferences(chain: CodeChain, nodeId: string): Promise<ReferenceHit[]> {
		const node = findNode(chain.root, nodeId);
		const anchor = node ? nodeAnchor(node) : undefined;
		if (!anchor) return [];
		const hits = await this.lsp.references(anchor.uri, {
			line: anchor.range.startLine,
			character: anchor.range.startCharacter,
		});
		// The provider answers positions; the drawer wants something readable.
		// One document read per distinct file (not per hit) supplies the code
		// line; an unreadable document degrades to the row's position alone.
		const lines = new Map<string, string[]>();
		const out: ReferenceHit[] = [];
		for (const hit of hits) {
			let docLines = lines.get(hit.uri);
			if (docLines === undefined) {
				docLines = await this.lsp.readText(hit.uri).then(
					(text) => text.split('\n'),
					() => [] as string[],
				);
				lines.set(hit.uri, docLines);
			}
			out.push({
				uri: hit.uri,
				range: hit.range,
				preview: (docLines[hit.range.startLine] ?? '').trim().slice(0, 200),
			});
		}
		return out;
	}

	private highlight(editor: vscode.TextEditor, range: ChainRange): void {
		// One editor per hop: decorations live on the editor instance that
		// answered the jump, and stale marks on other editors would clutter.
		for (const visible of vscode.window.visibleTextEditors) {
			if (visible !== editor) visible.setDecorations(this.highlightType, []);
		}
		editor.setDecorations(this.highlightType, [toVsRange(range)]);
	}

	/** Start reverse sync (called exactly once, from the panel constructor —
	 * the panel no longer re-creates itself, so this can never stack a
	 * second pair of listeners; the service `dispose()` tears them down).
	 * The callback fires with the node the current editor has landed on, or
	 * null when the editor left every node. Throttled because active-editor
	 * changes fire on rapid tab flips. */
	watchActiveEditor(getChain: () => CodeChain | null, onNode: (nodeId: string | null) => void): void {
		let last = '';
		const emit = (nodeId: string | null): void => {
			const key = nodeId ?? '';
			if (key === last) return;
			last = key;
			onNode(nodeId);
		};
		const evaluate = (): void => {
			const chain = getChain();
			const editor = vscode.window.activeTextEditor;
			if (!chain || !editor) return emit(null);
			const uri = editor.document.uri.toString();
			const line = editor.selection.active.line;
			// Deepest (largest-range-first walk) containing node wins; ties
			// break toward the later DFS position (deeper nesting).
			let hit: ResolvedNode | null = null;
			let hitSpan = Number.POSITIVE_INFINITY;
			const walk = (node: ResolvedNode): void => {
				if (node.location.uri === uri) {
					const range = node.location.range;
					if (range && range.startLine <= line && line <= range.endLine) {
						const span = range.endLine - range.startLine;
						if (span <= hitSpan) {
							hit = node;
							hitSpan = span;
						}
					}
				}
				for (const child of node.children) walk(child);
			};
			walk(chain.root);
			emit(hit ? (hit as ResolvedNode).id : null);
		};
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => {
				if (this.syncTimer !== null) clearTimeout(this.syncTimer);
				this.syncTimer = setTimeout(evaluate, 60);
			}),
			vscode.window.onDidChangeTextEditorSelection(() => {
				if (this.syncTimer !== null) clearTimeout(this.syncTimer);
				this.syncTimer = setTimeout(evaluate, 120);
			}),
		);
		evaluate();
	}
}
