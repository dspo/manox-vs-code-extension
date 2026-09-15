// Message plumbing for the code-chain panel webview — a strict subset of
// the sidebar relay's envelope discipline (same `{t:*}` wrapping, same
// "unknown vocabulary drops" rule): the host wraps `ToPanel` in
// `{t:'chain'…}` verbatim, and the panel posts bare `FromPanel` shapes.
// The `FromPanel`/`ToPanel`/chain model types live with the host contract
// in `src/codechain/types.ts` — this file only adds the transport envelope.

import type { FromPanel, ToPanel } from '../../../src/codechain/types';

/** Host → panel envelope (mirror of panel.ts's `post`). */
export type PanelHostEnvelope = ToPanel;

/** Panel → host message. */
export type PanelToHostMessage = FromPanel;

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export interface PanelBridge {
	post(message: FromPanel): void;
	onMessage(handler: (message: ToPanel) => void): () => void;
}

/** The only transport the panel bundle speaks; a test can substitute the
 * recorder without faking `acquireVsCodeApi` globals. */
export function createVscodePanelBridge(): PanelBridge {
	const api = acquireVsCodeApi();
	const listeners = new Set<(message: ToPanel) => void>();
	window.addEventListener('message', (raw: MessageEvent) => {
		const msg = raw.data as PanelHostEnvelope | undefined;
		if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
		// Vocabulary is closed (`t` tags below); unknown shapes drop (L12).
		switch (msg.t) {
			case 'chain':
			case 'sync':
			case 'tourState':
			case 'toast':
				for (const listener of listeners) listener(msg);
				return;
			default:
				return;
		}
	});
	return {
		post: (message) => api.postMessage(message),
		onMessage: (handler) => {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
	};
}

/** Test seam: a bridge that records posts and feeds host messages by hand. */
export function createRecordingBridge(): PanelBridge & {
	sent: FromPanel[];
	feed: (message: ToPanel) => void;
} {
	const sent: FromPanel[] = [];
	const listeners = new Set<(message: ToPanel) => void>();
	return {
		sent,
		post: (message) => sent.push(message),
		onMessage: (handler) => {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		feed: (message) => {
			for (const listener of listeners) listener(message);
		},
	};
}
