// Transport contract the webview renders against: post typed `ToHost`
// messages out, receive typed relay envelopes in. The VS Code host satisfies
// this interface (the sidebar's postMessage relay); the browser host that
// shared this bundle in the v2 era was retired with the v2 WS gateway.
import type { ToHost, ToWebview, HostNote } from '../../messages';

export interface Bridge {
	post(message: ToHost): void;
	onMessage(listener: (message: ToWebview) => void): () => void;
	/** Observe the transport connection. The VS Code relay owns the AHP
	 * connection (its extension host pumps the napi socket), so it reports a
	 * single stable generation and never fires the callbacks; kept optional
	 * for tests and a future browser surface. */
	onConnection?(onConnected: () => void, onDisconnected: () => void): () => void;
}

export type { HostNote, ToHost, ToWebview };
