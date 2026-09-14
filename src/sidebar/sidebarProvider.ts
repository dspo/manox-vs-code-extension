// Sidebar host: a transparent typed relay between the webview renderer and
// the shared agent host. The webview speaks `FromClient` / `FromServer`
// directly: the host forwards the webview's frames to the napi connection and
// relays EVERY guard-parsed `FromServer` frame back unfiltered — the webview
// bundle owns frame interpretation and answers `request` (ServerCall) frames
// itself. The only intercepted messages are the few host-only verbs the
// webview cannot fulfill from inside its sandbox.
//
// ServerCall ownership: the webview announces the session it is viewing
// (`viewing` verb); the host registers a no-op handler for it so its own
// fail-closed default does not race the webview's card. Sessions without an
// active viewer fall back to the host's deny-on-arrival policy.

import * as vscode from 'vscode';
import { AgentHost, configuredApprovalMode, resolveWorkspaceCwd } from '../agentHost';
import { errorText } from '../util';
import type { FromClient, FromServer } from '../protocol/types';

/** Webview → host messages: raw protocol frames plus host-only verbs. */
export type ToHost =
	| { t: 'frame'; frame: FromClient }
	| { t: 'viewing'; sessionId: string | null }
	| { t: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Host → webview messages: raw protocol frames plus host state pushes. */
export type ToWebview =
	| { t: 'frame'; frame: FromServer }
	| { t: 'verb'; kind: 'new_session' }
	| { t: 'config'; approvalMode: string }
	| { t: 'boot'; cwd: string; approvalMode: string }
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
	);
}

class ManoxSidebarProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | null = null;
	private unsubscribeFrames: (() => void) | null = null;
	/** The session whose ServerCalls the webview currently answers. */
	private viewedSession: string | null = null;

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
			this.unsubscribeFrames = host.connection.onFrame((frame) =>
				this.post({ t: 'frame', frame }),
			);
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
				this.setViewing(msg.sessionId);
				return;
			case 'log':
				console[msg.level](`manox webview: ${msg.message}`);
				return;
			case 'frame': {
				const host = AgentHost.shared(this.context);
				host.connection.sendRaw(msg.frame);
				return;
			}
		}
	}

	/** Register/clear the no-op ServerCall handler that shields the viewed
	 * session from the host's fail-closed default. */
	private setViewing(sessionId: string | null): void {
		const host = (() => {
			try {
				return AgentHost.shared(this.context);
			} catch {
				return null;
			}
		})();
		if (!host) return;
		if (this.viewedSession && this.viewedSession !== sessionId) {
			host.connection.setCallHandler(this.viewedSession, null);
		}
		this.viewedSession = sessionId;
		// The webview answers through the relay; the handler only claims
		// ownership (see module header).
		if (sessionId !== null) host.connection.setCallHandler(sessionId, () => {});
	}

	post(message: ToWebview): void {
		void this.view?.webview.postMessage(message);
	}

	private teardown(): void {
		this.unsubscribeFrames?.();
		this.unsubscribeFrames = null;
		if (this.viewedSession) this.setViewing(null);
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
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
	}
}

