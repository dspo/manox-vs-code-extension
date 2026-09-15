// Editor navigation + highlight + reverse sync (§6.3). All jumps go through
// `showTextDocument` with `preserveFocus` so the tour can walk code without
// stealing the panel; the decoration type mirrors VS Code's own reference
// highlight (theme colors only — the panel and the editor follow the user's
// theme). Reverse sync watches ACTIVE editor changes, not document changes:
// the panel highlights the node whose range the cursor's visible block
// overlaps (§10: drift is handled at click time / refresh, not by
// re-rendering the tour on every keystroke).

import * as vscode from 'vscode';
import type { ChainRange, CodeChain, ResolvedNode } from './types';
import { findNode } from './tools';

export const toVsRange = (r: ChainRange): vscode.Range =>
	new vscode.Range(r.startLine, r.startCharacter, r.endLine, r.endCharacter);

/** Best jump position for a node: the first ambiguity candidate stands in
 * for an `ambiguous` node (the panel still shows the picker); `stale` /
 * `ok` use the stored range; anything else is not navigable. */
export const nodeRange = (node: ResolvedNode): ChainRange | undefined =>
	node.location.range ?? node.location.candidates?.[0]?.range;

export class ChainNavigation {
	private readonly highlightType: vscode.TextEditorDecorationType;
	private readonly disposables: vscode.Disposable[] = [];
	private syncTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly log: (message: string) => void) {
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
	 * this; here they jump to the last known position. */
	async showNode(chain: CodeChain, nodeId: string, focus: boolean): Promise<boolean> {
		const node = findNode(chain.root, nodeId);
		const range = node ? nodeRange(node) : undefined;
		if (!node || !range || node.location.uri === '') return false;
		try {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.location.uri));
			const editor = await vscode.window.showTextDocument(doc, {
				preserveFocus: !focus,
				viewColumn: vscode.ViewColumn.Beside,
			});
			editor.revealRange(toVsRange(range), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			this.highlight(editor, range);
			return true;
		} catch (e) {
			this.log(`navigation failed for ${nodeId}: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	/** Open `references` on the node's symbol position (hover-menu "查找引
	 * 用": the built-in references-view command, like the agent's own). */
	async findReferences(chain: CodeChain, nodeId: string): Promise<void> {
		const node = findNode(chain.root, nodeId);
		const range = node ? nodeRange(node) : undefined;
		if (!node || !range || node.location.uri === '') return;
		const position = new vscode.Position(range.startLine, range.startCharacter);
		await vscode.commands
			.executeCommand(
				'showReferences',
				vscode.Uri.parse(node.location.uri),
				position,
				{ includeDeclaration: true },
			)
			.then(undefined, (e: unknown) => this.log(`showReferences failed: ${String(e)}`));
	}

	private highlight(editor: vscode.TextEditor, range: ChainRange): void {
		// One editor per hop: decorations live on the editor instance that
		// answered the jump, and stale marks on other editors would clutter.
		for (const visible of vscode.window.visibleTextEditors) {
			if (visible !== editor) visible.setDecorations(this.highlightType, []);
		}
		editor.setDecorations(this.highlightType, [toVsRange(range)]);
	}

	/** Start reverse sync. The callback fires with the node the current
	 * editor has landed on, or null when the editor left every node.
	 * Throttled because active-editor changes fire on rapid tab flips. */
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
