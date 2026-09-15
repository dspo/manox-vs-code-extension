// CodeChainPanel — the editor-area webview (`createWebviewPanel`, the repo's
// first; HTML/nonce/CSP mirror `sidebarProvider.renderHtml`). One panel at a
// time shows one chain; opening another chain swaps the content, closing
// never destroys the chain (§6.3: persistence rides `chainStore`, reopen
// from the journal card).
//
// The panel is a dumb view over the store: every FromPanel interaction is
// answered either locally (tour cursor, candidate pick) or by re-invoking
// the tool path (`refresh` rides `RefreshCodeChain` through
// `CodeChainTools.handle`, so the tool reply contract — diff report, stale
// marking — has exactly one implementation shared with the LLM).

import * as vscode from 'vscode';
import type { ChainStore } from './chainStore';
import { replaceNode, withStats } from './chainStore';
import type { ChainNavigation } from './navigation';
import { stepTour, tourOrder } from './tour';
import type { FromPanel, CodeChain, ToPanel } from './types';
import { findNode, type CodeChainTools } from './tools';

const PANEL_VIEW_TYPE = 'manox.codeChain';

export interface PanelSinks {
	/** `{t:'verb', kind:'compose'}` backfill into the sidebar composer. */
	compose(text: string): void;
	log(message: string): void;
}

export class CodeChainPanel {
	private panel: vscode.WebviewPanel | null = null;
	private chain: CodeChain | null = null;
	/** Tour cursor over the current chain's navigable nodes. */
	private tour: CodeChain['root'][] = [];
	private tourIndex = -1;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: ChainStore,
		private readonly navigation: ChainNavigation,
		private readonly tools: () => CodeChainTools,
		private readonly sinks: PanelSinks,
	) {}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
		this.panel?.dispose();
	}

	/** Reveal with `chain` (create the panel on first use). */
	show(chain: CodeChain): void {
		if (!this.panel || this.panel.visible === false) {
			this.create();
		}
		this.setChain(chain);
		this.panel?.reveal(undefined, true);
	}

	/** Push a newer version of the open chain (tool merges) without reveal. */
	update(chain: CodeChain): void {
		if (this.panel && this.chain?.chainId === chain.chainId) this.setChain(chain);
	}

	/** Reopen a stored chain (journal card / plugin chip / command). */
	openChain(chainId: string): boolean {
		const chain = this.store.get(chainId);
		if (!chain) return false;
		this.show(chain);
		return true;
	}

	/** Re-resolve the open chain through the tool path (§6.3 ⟳ button). */
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
		webviewPanel.webview.html = this.renderHtml(webviewPanel.webview);
		webviewPanel.webview.onDidReceiveMessage((msg: FromPanel) => this.onMessage(msg), undefined, this.disposables);
		// Keybinding scope: alt+left/right belong to the tour only while a
		// code-chain panel is the active editor (never hijack the workbench
		// back/forward nav elsewhere).
		this.setContextKey(false);
		webviewPanel.onDidChangeViewState(() => this.setContextKey(webviewPanel.active));
		webviewPanel.onDidDispose(() => {
			this.setContextKey(false);
			this.panel = null;
			this.chain = null;
			this.tour = [];
			this.tourIndex = -1;
		});
		// Reverse sync (§6.3): the panel is the consumer; navigation decides
		// when a hit is meaningful (open chain only).
		this.navigation.watchActiveEditor(
			() => this.chain,
			(nodeId) => this.post({ t: 'sync', nodeId }),
		);
	}

	private setChain(chain: CodeChain): void {
		this.chain = chain;
		this.tour = tourOrder(chain);
		this.tourIndex = -1;
		if (this.panel) {
			this.panel.title = `⛓ ${chain.title}`;
			this.post({ t: 'chain', chain });
			this.post({ t: 'tourState', index: -1, total: this.tour.length });
		}
	}

	private onMessage(msg: FromPanel): void {
		switch (msg?.t) {
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
				this.sinks.compose(`/codechain ${msg.question}`);
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
				resolveStatus: 'ok',
			},
		})).root;
		const next = withStats({ ...this.chain, root });
		this.store.save(next);
		this.setChain(next);
	}

	private setContextKey(active: boolean): void {
		void vscode.commands.executeCommand('setContext', 'manoxCodeChainActive', active);
	}

	private post(message: ToPanel): void {
		void this.panel?.webview.postMessage(message);
	}

	/** CSP/nonce per the sidebar's pattern (§2: repo precedent, not invention). */
	private renderHtml(webview: vscode.Webview): string {
		const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'codechain-bundle.js'),
		);
		// The shared Tailwind sheet covers both surfaces: `tokens.css`
		// @sources the codechain tree (webview-ui/styles), so one `bundle.css`
		// build carries the panel's utilities too — no second stylesheet.
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'bundle.css'),
		);
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="vscode-language" content="${vscode.env.language}">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-inline'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
