// Sidebar host: a transparent relay between the webview renderer and the
// shared agent host. AHP is one connection with one client, so the webview
// no longer owns a connection of its own — it still SPEAKS the protocol
// (it builds the dispatch actions and command params; the webview fold runs
// the same SDK reducers the host runs), and the relay is its transport:
//
//   webview → host : `req` (protocol commands), `dispatch` (write-ahead
//                    action writes), `view` (subscribe + snapshot seed)
//   host → webview : `snapshot` (folded channel state), `event` (every
//                    action envelope + catalogue change), `res` (command
//                    replies keyed by the relay request id)
//
// The ONE mutation the host applies to the stream is workspace scoping:
// `~/.manox` is shared with the desktop app, so session-catalogue events for
// other repositories are dropped (`workspaceFilter.ts`). Out-of-band traffic
// (boot facts, settings pushes, UI verbs, the watchdog heartbeat) never
// enters the protocol relay.
//
// Host-request ownership: the single client answers every `x-manox/*`
// capability request itself (agentHost.ts) — there is no per-consumer
// ServerCall ownership to negotiate, and nothing the webview must shield.

import * as vscode from 'vscode';
import { AgentHost, configuredApprovalMode, resolveWorkspaceCwd } from '../agentHost';
import type { ManoxClient, RelayEvent } from '../client/agentClient';
import {
	codeChainOpenChain,
	codeChainRegisterSession,
	ensureCodeChain,
} from '../codechain/registration';
import { errorText } from '../util';
import { threadsOwnedBy } from './workspaceFilter';

/** Webview → host messages. `req`/`dispatch`/`view` are the protocol faces;
 * the rest is out-of-band. */
export type ToHost =
	| { t: 'req'; id: string; method: string; params?: unknown }
	| { t: 'dispatch'; channel: string; action: unknown }
	| { t: 'view'; sessionUri: string; chatUri?: string }
	| { t: 'refresh' }
	| { t: 'viewing'; sessionUri: string | null }
	| { t: 'openCodeChain'; chainId: string }
	| { t: 'ping'; seq: number }
	| { t: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Host → webview messages. `snapshot` seeds the webview fold for a channel;
 * `event` keeps it current; `res` answers a `req`. */
export type ToWebview =
	| { t: 'snapshot'; channel: string; state: unknown }
	| { t: 'event'; event: RelayEvent }
	| { t: 'res'; id: string; ok: boolean; result?: unknown; error?: string }
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
	private unsubscribeEvents: (() => void) | null = null;
	/** Workspace scoping for the session catalogue (worktree-aware). */
	private readonly workspaceToken = resolveWorkspaceCwd();

	constructor(private readonly context: vscode.ExtensionContext) {}

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
			// needs a client to observe); idempotent across views.
			ensureCodeChain(this.context, host);
			// Protocol fan-out: every relayed event, workspace-scoped. The
			// snapshots for channels subscribed BEFORE the view existed ride
			// the boot push below; `view` requests seed their own.
			this.unsubscribeEvents = host.onRelayEvent((event) => {
				void this.scope(event).then((scoped) => {
					if (scoped) this.post({ t: 'event', event: scoped });
				});
			});
			// Boot facts the webview cannot read from inside its sandbox. The
			// folded-state push happens once the handshake resolves; after
			// that the relayed events keep the webview current, and a
			// `{t:'refresh'}` ask re-pushes (the models-settle planner).
			this.post({
				t: 'boot',
				cwd: resolveWorkspaceCwd(),
				approvalMode: configuredApprovalMode(),
			});
			void host.ready
				.then(() => this.pushBootState())
				.catch((e) => {
					this.post({ t: 'fatal', message: errorText(e) });
				});
		} catch (e) {
			this.post({ t: 'fatal', message: errorText(e) });
		}
	}

	/** Push the current folded state for every channel the webview renders:
	 * the root registry (agents → the model picker), the session catalogue
	 * (workspace-scoped), the two catalogues, and any session/chat already
	 * subscribed. Idempotent — the webview replaces its fold per channel. */
	private pushBootState(): void {
		const host = this.hostOrNull();
		if (!host) return;
		void host.ready
			.then(async (manox) => {
				// The root registry rides FIRST: the model picker renders from
				// it, and the provider registration that fills `agents[]`
				// completes async — the webview must not miss whatever is
				// already folded at push time (later deltas arrive as
				// relayed `root/agentsChanged` actions).
				this.post({ t: 'snapshot', channel: 'ahp-root://', state: manox.root });
				const rows = await threadsOwnedBy(
					manox.rows().map((row) => row.summary),
					this.workspaceToken,
				);
				for (const summary of rows) {
					this.post({ t: 'snapshot', channel: summary.resource, state: summary });
					const bag = manox.row(summary.resource)?.bag;
					if (bag) {
						this.post({ t: 'snapshot', channel: threadBagChannel(summary.resource), state: bag });
					}
					const sessionState = manox.sessionState(summary.resource);
					if (sessionState) {
						this.post({ t: 'snapshot', channel: sessionStateChannel(summary.resource), state: sessionState });
					}
				}
				this.post({
					t: 'snapshot',
					channel: 'x-manox-commands://',
					state: { entries: manox.commandCatalogue },
				});
				this.post({
					t: 'snapshot',
					channel: 'x-manox-workspaces://',
					state: manox.workspaceCatalogue,
				});
			})
			.catch((e) => this.post({ t: 'fatal', message: errorText(e) }));
	}

	/** Workspace-scope catalogue events. Per-session events are dropped per
	 * row: another repository's conversations never surface. Fail OPEN on
	 * filter errors — the unfiltered list is the pre-AHP behavior, so it is
	 * the safe degradation. */
	private async scope(event: RelayEvent): Promise<RelayEvent | null> {
		if (event.type === 'sessionAdded') {
			return (await this.owned(event.summary)) ? event : null;
		}
		if (event.type === 'sessionSummaryChanged') {
			return (await this.ownedByUri(event.session)) ? event : null;
		}
		return event;
	}

	private async owned(summary: { resource: string; title?: string; workingDirectories?: string[] }): Promise<boolean> {
		try {
			const kept = await threadsOwnedBy([summary], this.workspaceToken);
			return kept.length > 0;
		} catch (e) {
			console.log(`manox sidebar: workspace filter failed: ${errorText(e)}`);
			return true;
		}
	}

	private async ownedByUri(uri: string): Promise<boolean> {
		const host = this.hostOrNull();
		const summary = host?.manox?.row(uri as never)?.summary;
		return summary ? this.owned(summary) : true;
	}

	private hostOrNull(): AgentHost | null {
		try {
			return AgentHost.shared(this.context);
		} catch {
			return null;
		}
	}

	private async onWebviewMessage(msg: ToHost): Promise<void> {
		switch (msg.t) {
			case 'refresh':
				this.pushBootState();
				return;
			case 'view': {
				const host = this.hostOrNull();
				if (!host) return;
				const manox = await host.ready;
				if (msg.chatUri) {
					await manox.viewChat(msg.sessionUri as never, msg.chatUri as never);
					const chat = manox.chat(msg.chatUri as never);
					if (chat) this.post({ t: 'snapshot', channel: msg.chatUri, state: chat });
				} else {
					await manox.view(msg.sessionUri as never);
					const state = manox.sessionState(msg.sessionUri as never);
					if (state) this.post({ t: 'snapshot', channel: sessionStateChannel(msg.sessionUri), state });
				}
				return;
			}
			case 'req': {
				const host = this.hostOrNull();
				if (!host) {
					this.post({ t: 'res', id: msg.id, ok: false, error: 'manox host unavailable' });
					return;
				}
				try {
					const manox = await host.ready;
					let result: unknown;
					if (msg.method === 'listSessions') {
						result = {
							items: await threadsOwnedBy(
								manox.rows().map((row) => row.summary),
								this.workspaceToken,
							),
						};
					} else {
						result = await manox.requestProtocol(msg.method, msg.params);
					}
					this.post({ t: 'res', id: msg.id, ok: true, result });
				} catch (e) {
					this.post({ t: 'res', id: msg.id, ok: false, error: errorText(e) });
				}
				return;
			}
			case 'dispatch': {
				const host = this.hostOrNull();
				if (!host) return;
				try {
					const manox = await host.ready;
					manox.dispatchProtocol(msg.channel as never, msg.action);
				} catch (e) {
					console.log(`manox sidebar: dispatch refused: ${errorText(e)}`);
				}
				return;
			}
			case 'viewing':
				// The webview's claim: a viewed session is card-capable, so its
				// client tools are contributed (replace-per-register makes the
				// repeat harmless). The claim also feeds the workspace view.
				if (msg.sessionUri !== null) codeChainRegisterSession(msg.sessionUri);
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
				// channel whose liveness is in question, which is the point —
				// a stale retained-context iframe never sees the pong and
				// reloads itself. Nothing is relayed to the agent here.
				this.post({ t: 'pong', seq: msg.seq });
				return;
		}
	}

	post(message: ToWebview): void {
		void this.view?.webview.postMessage(message);
	}

	private teardown(): void {
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = null;
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

/** The `x-manox-thread:/<id>` bag channel for a session URI. */
function threadBagChannel(sessionUri: string): string {
	return `x-manox-thread:/${sessionUri.slice('ahp-session:/'.length)}`;
}

/** The full `ahp-session:/<id>` state channel for a session URI. */
function sessionStateChannel(sessionUri: string): string {
	return sessionUri;
}
