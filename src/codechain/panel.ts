// CodeChainPanel — the Code Tutor surface as a draggable WebviewView (the
// repo's second webview view, after `manox.chatView`). Contributed into the
// built-in `panel` location so the user can dock it in the bottom panel, drag
// it into the sidebar, or float it — the small-screen / split-screen win over
// the old `createWebviewPanel` editor tab. HTML/nonce/CSP still mirror
// `sidebarProvider.renderHtml` (via `renderPanelHtml`); one view at a time
// shows one chain: opening another chain swaps the content, closing never
// destroys the chain (§6.3: persistence rides `chainStore`, reopen from the
// journal card).
//
// Lifecycle invariants (review #1), restated for the view API:
//   * the provider is registered exactly once (in `ensureCodeChain`); VS Code
//     calls `resolveWebviewView` when the view first opens — the view is never
//     re-created by us, and the dispose handler is identity-guarded so a stale
//     view can never null out a live one;
//   * `retainContextWhenHidden:true` (set on the registration options, not on
//     `WebviewOptions`, which has no such field) keeps the webview alive when
//     the view hides. It is best-effort: VS Code may still discard the context
//     across a window reload, so the bundle posts `{t:'ready'}` on mount and
//     the host answers with a fresh snapshot (chain + tourState + sync). This
//     also carries the current chain to a freshly resolved view after a reload
//     without any separate `context.state` plumbing;
//   * a host push that outruns the view resolve is never dropped: `show` stashes
//     the chain as `pendingChain` (and focuses the view), `update` just refreshes
//     the host-side state, and `resolveWebviewView` drains both. (The old panel
//     silently discarded an `update` while its panel was uncreated — fixed here);
//   * the reverse-sync watcher attaches ONCE (constructor), not per-resolve,
//     and is disposed with the service.
//
// The view is a dumb view over the store: every FromPanel interaction is
// answered either locally (candidate pick) or by re-invoking the tool path
// (`refresh` rides `TOOL_NAMES.refresh` through `CodeChainTools.handle`, so
// the reply contract has exactly one implementation shared with the LLM).

import * as vscode from 'vscode';
import type { ChainStore } from './chainStore';
import { replaceNode, withStats } from './chainStore';
import type { ChainNavigation } from './navigation';
import { renderPanelHtml } from './panelHtml';
import { stepTour, tourOrder } from './tour';
import type { FromPanel, CodeChain, ResolvedNode, ToPanel } from './types';
import { findNode, TOOL_NAMES, type CodeChainTools } from './tools';

/** The contributed webview view id (package.json `contributes.views.panel`).
 * Focus rides the built-in `<viewId>.focus` command. */
const TUTOR_VIEW_ID = 'manox.tutorView';

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

export class CodeChainPanel implements vscode.WebviewViewProvider {
	/** The resolved webview view, or null before resolve / after dispose. All
	 * host→webview posts and the dynamic title go through it. */
	private view: vscode.WebviewView | null = null;
	private chain: CodeChain | null = null;
	/** A chain handed to `show` before the view resolved; drained in
	 * `resolveWebviewView` so the very first open (e.g. a tool `showChain`) is
	 * never lost to the resolve race. */
	private pendingChain: CodeChain | null = null;
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
		// reads `this.chain` (only while a view holds a chain) so it is inert
		// until the view resolves with a chain.
		navigation.watchActiveEditor(
			() => (this.view ? this.chain : null),
			(nodeId) => this.post({ t: 'sync', nodeId }),
		);
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
		// The view is owned by VS Code (created/closed via the workbench); the
		// service only frees its own listeners and the reverse-sync watcher.
	}

	/** Reveal with `chain` (focus the view when it is already resolved; when it
	 * is not, stash the chain and trigger the resolve via the focus command). */
	show(chain: CodeChain): void {
		const isNewGeneration = this.chain?.chainId !== chain.chainId;
		if (this.view) {
			this.view.show(true);
			this.setChain(chain, isNewGeneration);
			return;
		}
		// Pre-resolve: hold the chain so `resolveWebviewView` can drain it. Do
		// NOT `setChain` here — that would post into a view that does not exist
		// yet (the old panel discarded exactly this case).
		this.pendingChain = chain;
		void vscode.commands.executeCommand(`${TUTOR_VIEW_ID}.focus`);
	}

	/** Push a newer version of the open chain (tool merges) without reveal.
	 * Updates the host-side state always; posts only when the view is live (a
	 * not-yet-resolved view catches up via `resolveWebviewView` / ready→resend,
	 * so nothing is silently dropped). */
	update(chain: CodeChain): void {
		this.setChain(chain, /* isNewGeneration */ this.chain?.chainId !== chain.chainId);
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
			{ sessionId: this.chain.sessionId, name: TOOL_NAMES.refresh, input: { chainId } },
			{
				ok: (content) => this.post({ t: 'toast', message: summarizeRefresh(content) }),
				err: (message) => this.sinks.log(`refresh failed: ${message}`),
			},
		);
	}

	// ── vscode.WebviewViewProvider ──────────────────────────────────────────

	/** VS Code calls this when the view first opens (and, without
	 * `retainContextWhenHidden`, whenever it needs a fresh context). This is
	 * the old `create()` body, now driven by the resolve callback instead of
	 * `createWebviewPanel`. */
	resolveWebviewView(webviewView: vscode.WebviewView): void {
		// `WebviewOptions` has no `retainContextWhenHidden` field — it lives on
		// the registration's `webviewOptions` (see registration.ts), so only
		// `enableScripts` + `localResourceRoots` are set here.
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};
		webviewView.webview.html = renderPanelHtml(this.panelHtmlInput(webviewView.webview));
		this.view = webviewView;

		webviewView.webview.onDidReceiveMessage((msg: FromPanel) => this.onMessage(msg, webviewView), undefined, this.disposables);
		// Keybinding scope is `focusViewId == manox.tutorView` (package.json) —
		// the precise built-in predicate for a webview VIEW, so alt+left/right
		// only fire while this view holds focus and never steal the workbench
		// back/forward nav (review #13). No context key to manage.
		webviewView.onDidDispose(() => {
			// Identity guard: a late dispose from a replaced view must not
			// clear the current one (review #1).
			if (this.view === webviewView) {
				this.view = null;
				this.chain = null;
				this.tour = [];
				this.tourIndex = -1;
				this.tourNodeId = null;
			}
		});

		if (this.chain) {
			// State survives a re-resolve (e.g. a window reload restored a
			// shown chain, or the view was disposed while `chain` was still
			// live): re-apply the title and re-push so the fresh bundle is not
			// stuck in the empty state (ready→resend is the backstop).
			this.applyTitle(this.chain);
			this.post({ t: 'chain', chain: this.chain });
			this.post({ t: 'tourState', index: this.tourIndex, total: this.tour.length });
		} else if (this.pendingChain) {
			const chain = this.pendingChain;
			this.pendingChain = null;
			this.setChain(chain, /* isNewGeneration */ true);
		}
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
			// view's utilities too — no second stylesheet.
			styleUri: webview.asWebviewUri(
				vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'bundle.css'),
			).toString(),
		};
	}

	/** The dynamic view header: a resolved view shows the open chain's title. */
	private applyTitle(chain: CodeChain): void {
		if (this.view) this.view.title = `⛓ ${chain.title}`;
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
		if (this.view) {
			this.applyTitle(chain);
			this.post({ t: 'chain', chain });
			this.post({ t: 'tourState', index: this.tourIndex, total: this.tour.length });
		}
	}

	/** Answer a bundle (re)mount: the webview context may have been
	 * discarded while hidden, so re-send every slice of current state. */
	private resend(webviewView: vscode.WebviewView): void {
		if (!this.chain || this.view !== webviewView) return;
		webviewView.webview.postMessage({ t: 'chain', chain: this.chain } satisfies ToPanel);
		webviewView.webview.postMessage({ t: 'tourState', index: this.tourIndex, total: this.tour.length } satisfies ToPanel);
		webviewView.webview.postMessage({ t: 'sync', nodeId: this.lastSync } satisfies ToPanel);
	}

	private onMessage(msg: FromPanel, source: vscode.WebviewView): void {
		// A message from a replaced view is dropped outright.
		if (source !== this.view) return;
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
				// The compose prefill is ownership-scoped: it is only ever
				// accepted by the composer showing the owning thread
				// (`shouldApplyComposePrefill`). A note without a real
				// sessionId would be dropped there anyway, so don't send a
				// malformed one (review round-2, issue — `?? ''` used to let
				// an empty owner through).
				if (!this.chain?.sessionId) {
					this.sinks.log('regen dropped: no owning session for the open chain');
					return;
				}
				this.sinks.compose(`/tutor ${msg.question}`, this.chain.sessionId);
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

	/** Tour step for the open chain (view buttons and the contributed
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
		void this.view?.webview.postMessage(message);
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
