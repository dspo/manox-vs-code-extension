// Webview entry point: acquires the vscode-webview API, builds the app over
// the host relay, and processes host messages (boot facts, config pushes,
// verbs, fatal errors). Protocol frames reach the app's connection through
// its own `message` listener (see ChatApp's wire).

import './app.css';
import { createRenderer } from './render';
import { ChatApp, type HostToWebview } from './store';

declare function acquireVsCodeApi(): {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
};

const api = acquireVsCodeApi();
const app = new ChatApp(api, {
	render: () => {
		renderer.render();
	},
});
const renderer = createRenderer(app);

window.addEventListener('message', (event) => {
	const msg = event.data as HostToWebview | undefined;
	if (!msg || typeof msg !== 'object') return;
	switch (msg.t) {
		case 'boot':
			app.boot(msg);
			return;
		case 'config':
			app.handleConfig(msg.approvalMode);
			return;
		case 'verb':
			app.handleVerb(msg.kind);
			return;
		case 'fatal':
			app.handleFatal(msg.message);
			return;
		default:
			return;
	}
});

renderer.render();
