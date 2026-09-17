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
// Outbound, the webview posts `FromClient` frames (wrapped as `{t:'frame'}`),
// `{t:'log'}` diagnostics, and the watchdog heartbeat `{t:'ping', seq}` (the
// host echoes `{t:'pong', seq}`; see state/watchdog.ts). Session lifecycle
// rides the wire — there are no host-only verbs any more; the relay is
// transparent.
//
// T7: the extension host owns the napi connection (and the v2 frame guards),
// so the webview sees one stable connection generation — `onConnection` is a
// no-op subscription (no reseat loop on this transport). That stability is
// exactly why the watchdog lives HERE: with `retainContextWhenHidden`, a
// graceful extension-host restart can silently kill this transport's inbound
// direction (frames posted by the new host never reach the retained iframe),
// and nothing else in the webview can see the difference — so the heartbeat
// + self-heal reload is a transport-liveness concern owned by the transport.
import type { FromClient, FromServer } from '../../../protocol';
import type { HostNote, ToHost } from '../../messages';
import { createChannelWatchdog } from '../state/watchdog';
import type { Bridge } from './bridge';
import { setBootFacts } from './host-facts';

/** Host → webview envelope (mirror of the extension's ToWebview). */
type HostEnvelope =
	| { t: 'frame'; frame: FromServer }
	| { t: 'verb'; kind: 'new_session' }
	| { t: 'verb'; kind: 'open_turn_navigator' }
	| { t: 'verb'; kind: 'code_chain'; sessionId: string; chainId: string; title: string; nodeCount: number }
	| { t: 'config'; approvalMode: string }
	| { t: 'boot'; cwd: string; approvalMode: string }
	| { t: 'pong'; seq: number }
	| { t: 'fatal'; message: string };

/** Webview → host envelope. Protocol frames ride `{t:'frame'}`; anything
 * already carrying a `t` tag (the code-chain `openCodeChain` ask) is
 * passed through verbatim — the host mirrors this union in its ToHost. */
type WebviewEnvelope =
	| ({ t: string } & Record<string, unknown>)
	| { t: 'frame'; frame: FromClient }
	| { t: 'log'; level: 'info' | 'warn' | 'error'; message: string };

interface VscodeHostApi {
	postMessage(msg: WebviewEnvelope): void;
}

declare function acquireVsCodeApi(): VscodeHostApi;

/** Heartbeat cadence for the channel watchdog (the scheduler interval and
 * the state machine's ping interval are one knob — see createVscodeBridge). */
export const WATCHDOG_PING_INTERVAL_MS = 5_000;

/** Re-request the global registries after a host-side restart signal. The
 * retained-iframe failure mode leaves the outbound webview→host direction
 * working while inbound frames go undelivered, so a fresh `boot`/`config`
 * (re-pushed by a healthy host after an extension install/activation) is a
 * chance to refetch models/threads WITHOUT a reload — idempotent wire
 * requests riding the surviving direction; the receipts restore a store
 * frozen at pre-restart state. (The §D.2 reference is the request/receipt
 * correlation the pending table uses; receipts are plain refreshes.)
 * `ready` is deliberately not posted: the sidebar host relay has no
 * `{t:'ready'}` inbound case (the code-chain panel owns that handshake), so
 * it would be a tolerated unknown out — pointless as a restart probe.
 * Dynamic import breaks the static `api/client → api/vscode-bridge` cycle;
 * the module is already loaded at boot (client.ts creates this bridge). */
function resyncRegistries(): void {
	void import('./client')
		.then(({ api }) => {
			api.requestModels();
			api.listThreads();
		})
		.catch(() => undefined);
}

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

	// Heartbeat watchdog over the host→webview channel (state/watchdog.ts).
	// The scheduler is deliberately coarse (one tick per ping interval): a
	// miss is counted only when the next ping comes due, so the default
	// timing = declare stale after ~3 unanswered pings, i.e. ~15-20s of
	// silence. The scheduler interval MUST match the watchdog's ping
	// interval — passing it explicitly rather than relying on the factory
	// default keeps that coupling visible. The watchdog stamps the ping seq
	// (wall-clock seeded), so a pong echoing a pre-reload ping can never
	// resurrect the fresh page's watchdog.
	const watchdog = createChannelWatchdog({ pingIntervalMs: WATCHDOG_PING_INTERVAL_MS, now: () => Date.now() });
	const sendPing = (): void => {
		vscode.postMessage({ t: 'ping', seq: watchdog.lastPingSeq() });
	};
	const reloadSelf = (): void => {
		clearInterval(heartbeat);
		document.removeEventListener('visibilitychange', onVisibility);
		window.location.reload(); // iframe rebuild == channel rebuild; the fresh boot re-requests models/threads
	};
	const heartbeat = setInterval(() => {
		if (watchdog.tick() === 'ping') sendPing();
		if (!watchdog.isStale()) return;
		// A hidden retainContextWhenHidden iframe receives no messages
		// legitimately — reloading then would loop while the tab is away,
		// so the verdict waits for the view to come back (visibilitychange
		// below re-checks; a still-stale watchdog reloads on show).
		if (document.visibilityState === 'hidden') return;
		// The warn rides the suspected-dead OUTBOUND direction as a
		// best-effort breadcrumb (the host console shows it when the
		// webview→host side is still alive — the common failure shape);
		// the reload never waits on it.
		vscode.postMessage({ t: 'log', level: 'warn', message: 'channel stale — reloading webview' });
		reloadSelf();
	}, WATCHDOG_PING_INTERVAL_MS);
	const onVisibility = () => {
		if (document.visibilityState !== 'hidden' && watchdog.isStale()) reloadSelf();
	};
	document.addEventListener('visibilitychange', onVisibility);

	// Heartbeat from frame zero: catch a dead-on-arrival channel without
	// waiting one interval.
	if (watchdog.onMount() === 'ping') sendPing();
	window.addEventListener('message', (raw: MessageEvent) => {
		const msg = raw.data as HostEnvelope | undefined;
		if (!msg || typeof msg !== 'object') return;
		// Liveness evidence for the watchdog: anything that reaches this
		// listener proves the host→webview direction is alive; pongs
		// additionally confirm the ping/pong round trip.
		watchdog.onAnyHostMessage();
		switch (msg.t) {
			case 'frame':
				for (const listener of listeners) listener(msg.frame);
				return;
			case 'boot':
				setBootFacts({ cwd: msg.cwd, approvalMode: msg.approvalMode });
				resyncRegistries();
				return;
			case 'config':
				setBootFacts({ approvalMode: msg.approvalMode });
				resyncRegistries();
				return;
			case 'pong':
				// Pure heartbeat echo — never surfaced to listeners/store.
				watchdog.onPong(msg.seq);
				return;
			case 'verb': {
				// Surface host commands as UI notes (the api layer routes
				// them: new_session starts the draft flow; code_chain parks
				// a journal card; compose prefills the composer). Payloads
				// ride the note; only the `t` envelope tag is stripped.
				const { t: _envelopeTag, ...note } = msg;
				for (const listener of listeners) listener(note as HostNote);
				return;
			}
			case 'fatal':
				// Render through the ordinary error-banner path: a global
				// error note the store folds into `error`.
				resyncRegistries();
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
			// The code-chain card click (`{t:'openCodeChain'}`) is a
			// first-class host affordance, not a protocol frame — pass it
			// through on its own `t` tag; the host relay mirrors the union
			// in `sidebarProvider.ToHost`. Everything else is a `FromClient`
			// wrapped in the `{t:'frame'}` envelope.
			if ('t' in message) {
				vscode.postMessage(message);
				return;
			}
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
