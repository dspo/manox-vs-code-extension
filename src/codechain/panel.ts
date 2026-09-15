// CodeChainPanel — the editor-area webview (`createWebviewPanel`, the repo's
// first; HTML/nonce/CSP mirror `sidebarProvider.renderHtml`). One panel at a
// time shows one chain: opening another chain swaps the content, closing
// never destroys the chain (§6.3: persistence rides `chainStore`, reopen
// from the journal card).
//
// Lifecycle invariants (review #1):
//   * the panel is created exactly once; a hidden tab is `reveal()`ed, never
//     re-created, and the dispose handler is identity-guarded so a stale
//     panel can never null out a live one;
//   * `retainContextWhenHidden:false` means VS Code may discard the webview
//     when the tab hides and reload it empty when shown again — the bundle
//     posts `{t:'ready'}` on mount and the host answers with a fresh
//     snapshot (chain + tourState + sync), so a re-shown tab is never stuck
//     in the empty state;
//   * the reverse-sync watcher attaches ONCE (constructor), not per-create,
//     and is disposed with the service.
//
// The panel is a dumb view over the store: every FromPanel interaction is
// answered either locally (candidate pick) or by re-invoking the tool path
// (`refresh` rides `RefreshCodeChain` through `CodeChainTools.handle`, so
// the reply contract has exactly one implementation shared with the LLM).

import * as vscode from 'vscode';
import type { ChainStore } from './chainStore';
import { replaceNode, withStats } from './chainStore';
import type { ChainNavigation } from './navigation';
import { renderPanelHtml } from './panelHtml';
import { stepTour, tourOrder } from './tour';
import type { FromPanel, CodeChain, ResolvedNode, ToPanel } from './types';
import { findNode, type CodeChainTools } from './tools';

const PANEL_VIEW_TYPE = 'manox.codeChain';

export interface PanelSinks {
	/** `{t:'verb', kind:'compose'}` backfill into the sidebar composer. */
	compose(text: string, sessionId: string): void;
	log(message: string): void;
}

/** The tree state to preserve across a same-chain re-push (§6.3 / review #6):
 * the host re-sends the whole tree after candidate-pick, Expand and
 * Annotate; a fresh generation (new chainId) is the only thing that resets
 * selection / collapse / cursor. */
function reindexTour(tour: ResolvedNode[], previousId: string | null): number {
	if (previousId === null) return -1;
	return tour.findIndex((node) => node.id === previousId);
}

export class CodeChainPanel {
	private panel: vscode.WebviewPanel | null = null;
	private chain: CodeChain | null = null;
	/** Tour cursor over the current chain's navigable nodes. */
	private tour: ResolvedNode[] = [];
	private tourIndex = -1;
	private tourNodeId: string | null = null;
	private lastSync: string | null = null;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: ChainStore,
		private readonly navigation: ChainNavigation,
		private readonly tools: () => CodeChainTools,
		private readonly sinks: PanelSinks,
	) {
		// Reverse sync attaches once for the service lifetime; the callback
		// reads `this.chain` so it is inert until a panel holds a chain.
		navigation.watchActiveEditor(
			() => (this.panel ? this.chain : null),
			(nodeId) => this.post({ t: 'sync', nodeId }),
		);
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
		this.panel?.dispose();
	}

	/** Reveal with `chain` (create the panel on the very first use). */
	show(chain: CodeChain): void {
		if (!this.panel) this.create();
		this.setChain(chain, /* isNewGeneration */ this.chain?.chainId !== chain.chainId);
		this.panel?.reveal(undefined, true);
	}

	/** Push a newer version of the open chain (tool merges) without reveal. */
	update(chain: CodeChain): void {
		if (this.panel) this.setChain(chain, /* isNewGeneration */ this.chain?.chainId !== chain.chainId);
	}

	/** Reopen a stored chain (journal card / plugin chip / command). */
	openChain(chainId: string): boolean {
		const chain = this.store.get(chainId);
		if (!chain) return false;
		this.show(chain);
		return true;
	}

	/** The refresh button rides the tool reply; report the human summary. */
	private refresh(): void {
		if (!this.chain) return;
		const chainId = this.chain.chainId;
		this.tools().handle(
			{ sessionId: this.chain.sessionId, name: 'RefreshCodeChain', input: { chainId } },
			{
				ok: (content) => this.post({ t: 'toast', message: summarizeRefresh(content) }),
				err: (message) => this.sinks.log(`refresh failed: ${message}`),
			},
		);
	}

	private create(): void {
		const webviewPanel = vscode.window.createWebviewPanel(
			PANEL_VIEW_TYPE,
			'Code Chain',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [this.context.extensionUri],
			},
		);
		this.panel = webviewPanel;
		webviewPanel.webview.html = renderPanelHtml(this.panelHtmlInput(webviewPanel.webview));
		webviewPanel.webview.onDidReceiveMessage((msg: FromPanel) => this.onMessage(msg, webviewPanel), undefined, this.disposables);
		// Keybinding scope is `activeWebviewPanelId == manox.codeChain`
		// (package.json) — the precise built-in predicate, so alt+left/right
		// only fire while this panel holds focus and never steal the
		// workbench back/forward nav (review #13). No context key to manage.
		webviewPanel.onDidDispose(() => {
			// Identity guard: a late dispose from a replaced panel must not
			// clear the current one (review #1).
			if (this.panel === webviewPanel) {
				this.panel = null;
				this.chain = null;
				this.tour = [];
				this.tourIndex = -1;
				this.tourNodeId = null;
			}
		});
	}

	private panelHtmlInput(webview: vscode.Webview) {
		const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
		return {
			nonce,
			cspSource: webview.cspSource,
			language: vscode.env.language,
			scriptUri: webview.asWebviewUri(
				vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'codechain-bundle.js'),
			).toString(),
			// The shared Tailwind sheet covers both surfaces: `tokens.css`
			// @sources the codechain tree, so one `bundle.css` carries the
			// panel's utilities too — no second stylesheet.
			styleUri: webview.asWebviewUri(
				vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'bundle.css'),
			).toString(),
		};
	}

	private setChain(chain: CodeChain, isNewGeneration: boolean): void {
		// Preserve the tour cursor by node id across a same-chain re-push;
		// only a genuinely new chain generation resets view state (§6.3,
		// review #6 — candidate-pick / Expand / Annotate re-send the whole
		// tree and must NOT kick the user back to the root).
		const keepCursor = isNewGeneration ? null : this.tourNodeId;
		this.chain = chain;
		this.tour = tourOrder(chain);
		if (isNewGeneration) {
			this.tourIndex = -1;
			this.tourNodeId = null;
		} else {
			const reindexed = reindexTour(this.tour, keepCursor);
			this.tourIndex = reindexed;
			this.tourNodeId = reindexed >= 0 ? keepCursor : null;
		}
		if (this.panel) {
			this.panel.title = `⛓ ${chain.title}`;
			this.post({ t: 'chain', chain });
			this.post({ t: 'tourState', index: this.tourIndex, total: this.tour.length });
		}
	}

	/** Answer a bundle (re)mount: the webview context may have been
	 * discarded while hidden, so re-send every slice of current state. */
	private resend(webviewPanel: vscode.WebviewPanel): void {
		if (!this.chain || this.panel !== webviewPanel) return;
		webviewPanel.webview.postMessage({ t: 'chain', chain: this.chain } satisfies ToPanel);
		webviewPanel.webview.postMessage({ t: 'tourState', index: this.tourIndex, total: this.tour.length } satisfies ToPanel);
		webviewPanel.webview.postMessage({ t: 'sync', nodeId: this.lastSync } satisfies ToPanel);
	}

	private onMessage(msg: FromPanel, source: vscode.WebviewPanel): void {
		// A message from a replaced panel is dropped outright.
		if (source !== this.panel) return;
		switch (msg?.t) {
			case 'ready':
				this.resend(source);
				return;
			case 'nodeClick':
				void this.clickNode(msg.nodeId, msg.focus);
				return;
			case 'tour':
				this.stepTour(msg.dir);
				return;
			case 'refresh':
				this.refresh();
				return;
			case 'pickCandidate':
				this.pickCandidate(msg.nodeId, msg.index);
				return;
			case 'findRefs':
				if (this.chain) void this.navigation.findReferences(this.chain, msg.nodeId);
				return;
			case 'regen':
				this.sinks.compose(`/codechain ${msg.question}`, this.chain?.sessionId ?? '');
				return;
			case 'log':
				this.sinks.log(`panel[${msg.level}]: ${msg.message}`);
				return;
			default:
				return; // unknown vocabulary drops (L12 discipline)
		}
	}

	private async clickNode(nodeId: string, focus: boolean): Promise<void> {
		if (!this.chain) return;
		const jumped = await this.navigation.showNode(this.chain, nodeId, focus);
		if (!jumped) this.post({ t: 'toast', message: 'node has no resolved location — refresh or pick a candidate' });
	}

	/** Tour step for the open chain (panel buttons and the contributed
	 * `alt+left/right` keybinding share this cursor). */
	stepTour(dir: 'prev' | 'next'): void {
		const step = stepTour(this.tour, this.tourIndex, dir);
		if (!step || !this.chain) return;
		this.tourIndex = step.index;
		this.tourNodeId = step.node.id;
		this.post({ t: 'tourState', index: step.index, total: this.tour.length });
		void this.navigation.showNode(this.chain, step.node.id, false);
	}

	private pickCandidate(nodeId: string, index: number): void {
		if (!this.chain) return;
		const node = findNode(this.chain.root, nodeId);
		const candidate = node?.location.candidates?.[index];
		if (!node || !candidate) return;
		const root = replaceNode(this.chain.root, nodeId, (n) => ({
			...n,
			location: {
				uri: candidate.uri || n.location.uri,
				file: n.location.file,
				symbolPath: n.location.symbolPath,
				range: candidate.range,
				// The picked candidate is a full symbol/text range; the
				// selection anchor cannot be recovered from it, so it
				// collapses onto the range (still name-precise enough for a
				// user-chosen position).
				selectionRange: candidate.range,
				resolveStatus: 'ok',
			},
		})).root;
		const next = withStats({ ...this.chain, root });
		this.store.save(next);
		this.setChain(next, /* isNewGeneration */ false);
	}

	private post(message: ToPanel): void {
		if (message.t === 'sync') this.lastSync = message.nodeId;
		void this.panel?.webview.postMessage(message);
	}
}

/** The refresh button rides the tool reply; show the human-facing summary
 * (counts per bucket) rather than the raw JSON. */
function summarizeRefresh(content: string): string {
	try {
		const parsed = JSON.parse(content) as {
			moved?: string[];
			stale?: string[];
			fixed?: string[];
		};
		const parts: string[] = [];
		if (parsed.moved?.length) parts.push(`${parsed.moved.length} moved`);
		if (parsed.stale?.length) parts.push(`${parsed.stale.length} stale`);
		if (parsed.fixed?.length) parts.push(`${parsed.fixed.length} recovered`);
		return parts.length > 0 ? `refresh: ${parts.join(', ')}` : 'refresh: positions unchanged';
	} catch {
		return 'refresh: done';
	}
}
