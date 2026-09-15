// Bridge over the VS Code webview API: postMessage out to the extension
// host, window messages in. Selected only when acquireVsCodeApi is present.
//
// The host relay wraps protocol frames in small envelopes (`{t:'frame'}`)
// and adds host-state pushes the sandbox cannot read itself:
//   * `{t:'boot', cwd, approvalMode}` — workspace facts for CreateSession;
//   * `{t:'config', approvalMode}` — settings changes while live;
//   * `{t:'verb', kind:'new_session'}` — the host command / title-bar button;
//   * `{t:'fatal', message}` — host-side activation failure (addon missing,
//     state-root lock contention).
// Outbound, the webview posts `FromClient` frames (wrapped as `{t:'frame'}`)
// and `{t:'log'}` diagnostics. Session lifecycle rides the wire — there are
// no host-only verbs any more; the relay is transparent.
//
// T7: the extension host owns the napi connection (and the v2 frame guards),
// so the webview sees one stable connection generation — `onConnection` is a
// no-op subscription (no reseat loop on this transport).
import type { FromClient, FromServer } from '../../../protocol';
import type { HostNote, ToHost } from '../../messages';
import type { Bridge } from './bridge';
import { setBootFacts } from './host-facts';

/** Host → webview envelope (mirror of the extension's ToWebview). */
type HostEnvelope =
	| { t: 'frame'; frame: FromServer }
	| { t: 'verb'; kind: 'new_session' }
	| { t: 'config'; approvalMode: string }
	| { t: 'boot'; cwd: string; approvalMode: string }
	| { t: 'fatal'; message: string };

/** Webview → host envelope (mirror of the extension's ToHost). */
type WebviewEnvelope =
	| { t: 'frame'; frame: FromClient }
	| { t: 'log'; level: 'info' | 'warn' | 'error'; message: string };

interface VscodeHostApi {
	postMessage(msg: WebviewEnvelope): void;
}

declare function acquireVsCodeApi(): VscodeHostApi;

export function isVscodeHost(): boolean {
	return typeof acquireVsCodeApi === 'function';
}

/** acquireVsCodeApi throws on the second call — singleton. */
let hostApi: VscodeHostApi | null = null;
function host(): VscodeHostApi {
	if (!hostApi) hostApi = acquireVsCodeApi();
	return hostApi;
}

export function createVscodeBridge(): Bridge {
	const vscode = host();
	const listeners = new Set<(message: FromServer | HostNote) => void>();

	window.addEventListener('message', (raw: MessageEvent) => {
		const msg = raw.data as HostEnvelope | undefined;
		if (!msg || typeof msg !== 'object') return;
		switch (msg.t) {
			case 'frame':
				for (const listener of listeners) listener(msg.frame);
				return;
			case 'boot':
				setBootFacts({ cwd: msg.cwd, approvalMode: msg.approvalMode });
				return;
			case 'config':
				setBootFacts({ approvalMode: msg.approvalMode });
				return;
			case 'verb':
				// Surface host commands as UI notes (the api layer routes
				// them: new_session starts the draft flow).
				for (const listener of listeners) listener({ kind: msg.kind });
				return;
			case 'fatal':
				// Render through the ordinary error-banner path: a global
				// error note the store folds into `error`.
				for (const listener of listeners) {
					listener({
						kind: 'notification',
						note: { method: 'error', sessionId: null, message: msg.message },
					} as FromServer);
				}
				return;
		}
	});

	return {
		post(message: ToHost) {
			vscode.postMessage({ t: 'frame', frame: message });
		},
		onMessage(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onConnection() {
			// The extension relay is the connection owner; the webview's
			// postMessage channel is always live once the panel exists.
			return () => undefined;
		},
	};
}
