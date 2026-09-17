// Sidebar host: a transparent typed relay between the webview renderer and
// the shared agent host. The webview speaks `FromClient` / `FromServer`
// directly: the host forwards the webview's frames to the napi connection and
// relays every guard-parsed `FromServer` frame back — the webview bundle
// (webview-ui/, the React frontend) owns frame interpretation and answers
// adjudication `request` frames itself. The ONE frame the host rewrites is the
// threads registry, which it scopes to this workspace
// (`workspaceFilter.ts`) so the list shows this repository's conversations
// rather than every thread in the shared `~/.manox` store. Session lifecycle
// rides the wire too; the only host→webview out-of-band messages are the boot
// facts, settings pushes, and UI verbs the sandbox cannot fulfill itself.
//
// ServerCall ownership: the webview claims sessions by opening follow
// streams (`streamOpen`); the host registers a no-op handler per claimed
// session so its own fail-closed default does not race the webview's cards.
// Shields accumulate for the panel's lifetime (view switching never drops a
// running thread's cards) and clear at teardown. Sessions nobody follows
// fall back to the host's deny-on-arrival policy. Capability calls
// (clipboardRead / openExternal) are answered by the host interceptor before
// any shield — see agentHost.ts.

import * as vscode from 'vscode';
import { AgentHost, configuredApprovalMode, resolveWorkspaceCwd } from '../agentHost';
import {
	codeChainOpenChain,
	codeChainRegisterSession,
	ensureCodeChain,
} from '../codechain/registration';
import { errorText } from '../util';
import type { FromClient, FromServer } from '../protocol/types';
import { threadsOf, withThreads, WorkspaceThreadFilter } from './workspaceFilter';

/** Webview → host messages: raw protocol frames plus diagnostics. The
 * `viewing` verb is retained as a shield registration for compatibility;
 * `openCodeChain` reopens a stored chain from its journal card (§7); `ping`
 * is the webview watchdog's channel heartbeat, answered with a `pong` —
 * pure out-of-band, it never enters the frame relay. */
export type ToHost =
	| { t: 'frame'; frame: FromClient }
	| { t: 'viewing'; sessionId: string | null }
	| { t: 'openCodeChain'; chainId: string }
	| { t: 'ping'; seq: number }
	| { t: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Host → webview messages: raw protocol frames plus host state pushes.
 * The `code_chain` verb is the out-of-band journal-card push (§7: a tool
 * invocation by THIS host has no webview-visible side effect otherwise);
 * `pong` echoes a watchdog `ping`'s seq — the heartbeat reply proving the
 * host→webview postMessage channel still delivers. */
export type ToWebview =
	| { t: 'frame'; frame: FromServer }
	| { t: 'verb'; kind: 'new_session' | 'open_turn_navigator' }
	| { t: 'verb'; kind: 'code_chain'; sessionId: string; chainId: string; title: string; nodeCount: number }
	| { t: 'config'; approvalMode: string }
	| { t: 'boot'; cwd: string; approvalMode: string }
	| { t: 'pong'; seq: number }
	| { t: 'fatal'; message: string };

let activeProvider: ManoxSidebarProvider | null = null;

/** Post a message to the live sidebar webview (no-op when closed). */
export function postToSidebar(message: ToWebview): void {
	activeProvider?.post(message);
}

export function registerManoxSidebar(context: vscode.ExtensionContext): void {
	const provider = new ManoxSidebarProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('manox.chatView', provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('manox.focus', () =>
			vscode.commands.executeCommand('manox.chatView.focus'),
		),
		vscode.commands.registerCommand('manox.newSession', () =>
			postToSidebar({ t: 'verb', kind: 'new_session' }),
		),
		// macOS cmd+m is a minimize accelerator; the extension keybinding
		// contribution routes it here instead, since the webview DOM would
		// never receive the key.
		vscode.commands.registerCommand('manox.openTurnNavigator', () =>
			postToSidebar({ t: 'verb', kind: 'open_turn_navigator' }),
		),
	);
}

class ManoxSidebarProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | null = null;
	private unsubscribeFrames: (() => void) | null = null;
	/** Live follow streams the webview opened: streamId → sessionId. */
	private readonly streams = new Map<string, string>();
	/** Sessions holding a no-op ServerCall shield (webview answers them). */
	private readonly shielded = new Set<string>();
	/** Workspace scoping for the threads list (worktree-aware, memoized). */
	private readonly workspaceFilter = new WorkspaceThreadFilter(undefined, (m) =>
		console.log(`manox sidebar: ${m}`),
	);
	/** Monotonic relay sequence (see `relay`). */
	private relaySeq = 0;

	constructor(private readonly context: vscode.ExtensionContext) {}

	/** Relay one server frame, scoping the threads registry to this workspace.
	 *
	 * The threads list is the ONE frame the extension rewrites: `~/.manox` is
	 * shared with the desktop app, so the raw registry carries every thread on
	 * the machine. See `workspaceFilter.ts` for the rule (this workspace's
	 * repository, worktrees included).
	 *
	 * Ordering: rewriting is async (git lookups), and the registry is a FULL
	 * MIRROR — a `threadsUpdated` frame always replaces the previous list — so
	 * a slow rewrite must not be overtaken by a newer one, or the list would
	 * settle on stale rows. A monotonic sequence drops any frame that lost the
	 * race; the newest frame is always the one that lands. */
	private relay(frame: FromServer): void {
		const rows = threadsOf(frame);
		if (!rows) {
			this.post({ t: 'frame', frame });
			return;
		}
		const seq = ++this.relaySeq;
		void this.workspaceFilter
			.ownedBy(rows, resolveWorkspaceCwd())
			.then((kept) => {
				if (seq !== this.relaySeq) return;
				this.post({
					t: 'frame',
					frame: withThreads(frame, kept) as FromServer,
				});
			})
			.catch((e: unknown) => {
				// Fail OPEN: a filter failure must never blank the sidebar.
				// The unfiltered list is what this extension shipped before,
				// so it is the safe degradation, not a regression.
				console.log(`manox sidebar: workspace filter failed: ${errorText(e)}`);
				if (seq !== this.relaySeq) return;
				this.post({ t: 'frame', frame });
			});
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		activeProvider = this;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};
		webviewView.webview.html = this.renderHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((msg: ToHost) => void this.onWebviewMessage(msg).catch((e) => {
			console.error('manox sidebar: webview message failed:', e);
		}));
		webviewView.onDidDispose(() => {
			this.teardown();
		});

		try {
			const host = AgentHost.shared(this.context);
			// The code-chain service rides the first live host (§9.2 replay
			// needs a connection to observe); idempotent across views.
			ensureCodeChain(this.context, host);
			this.unsubscribeFrames = host.connection.onFrame((frame) => this.relay(frame));
			// Boot facts the webview cannot read from inside its sandbox.
			this.post({
				t: 'boot',
				cwd: resolveWorkspaceCwd(),
				approvalMode: configuredApprovalMode(),
			});
		} catch (e) {
			this.post({ t: 'fatal', message: errorText(e) });
		}
	}

	private async onWebviewMessage(msg: ToHost): Promise<void> {
		switch (msg.t) {
			case 'viewing':
				if (msg.sessionId !== null) this.shield(msg.sessionId);
				return;
			case 'openCodeChain':
				// Journal-card / header-chip click (§7): reopen the stored
				// chain. Evicted rows (LRU cap) get a quiet pointer — the
				// chain regenerates from the transcript.
				if (!codeChainOpenChain(msg.chainId)) {
					void vscode.window.showWarningMessage(
						'manox: this Code Tutor chain is no longer stored — ask the agent to regenerate it (client_TutorEntry).',
					);
				}
				return;
			case 'log':
				console[msg.level](`manox webview: ${msg.message}`);
				return;
			case 'ping':
				// Watchdog heartbeat (webview `state/watchdog.ts`): echo the
				// seq. The reply travels the SAME host→webview postMessage
				// channel whose liveness is in question, which is the point
				// — a stale retained-context iframe never sees the pong and
				// reloads itself. Nothing is relayed to the agent here.
				this.post({ t: 'pong', seq: msg.seq });
				return;
			case 'frame': {
				this.trackStream(msg.frame);
				const host = AgentHost.shared(this.context);
				host.connection.sendRaw(msg.frame);
				return;
			}
		}
	}

	/** Derive ServerCall shields from the webview's follow-stream lifecycle:
	 * a `streamOpen(followSession)` claims the session (the webview renders
	 * its cards); a `streamCancel` releases the claim once no other stream
	 * covers the session. */
	private trackStream(frame: FromClient): void {
		if (frame.kind === 'streamOpen' && frame.streamKind.type === 'followSession') {
			this.streams.set(frame.streamId, frame.streamKind.sessionId);
			this.shield(frame.streamKind.sessionId);
			// Following a session makes it card-capable; the code-chain
			// tools register per (session, clientId) — the replace-on-
			// re-register semantics make this hook free (§9.2).
			codeChainRegisterSession(frame.streamKind.sessionId);
		} else if (frame.kind === 'streamCancel') {
			const sessionId = this.streams.get(frame.streamId);
			if (sessionId === undefined) return;
			this.streams.delete(frame.streamId);
			for (const other of this.streams.values()) {
				if (other === sessionId) return; // still covered
			}
			this.unshield(sessionId);
		}
	}

	/** Register the no-op ServerCall handler that shields a session from the
	 * host's fail-closed default (the webview answers through the relay; the
	 * handler only claims ownership — see module header). */
	private shield(sessionId: string): void {
		if (this.shielded.has(sessionId)) return;
		const host = (() => {
			try {
				return AgentHost.shared(this.context);
			} catch {
				return null;
			}
		})();
		if (!host) return;
		this.shielded.add(sessionId);
		host.connection.setCallHandler(sessionId, () => {});
	}

	private unshield(sessionId: string): void {
		if (!this.shielded.delete(sessionId)) return;
		try {
			AgentHost.shared(this.context).connection.setCallHandler(sessionId, null);
		} catch {
			// Host gone (deactivate race): the handler map died with it.
		}
	}

	post(message: ToWebview): void {
		void this.view?.webview.postMessage(message);
	}

	private teardown(): void {
		this.unsubscribeFrames?.();
		this.unsubscribeFrames = null;
		this.streams.clear();
		for (const sessionId of [...this.shielded]) this.unshield(sessionId);
		if (activeProvider === this) activeProvider = null;
		this.view = null;
	}

	private renderHtml(webview: vscode.Webview): string {
		const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'bundle.js'),
		);
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
