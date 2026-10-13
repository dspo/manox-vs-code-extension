// Bridge over the VS Code webview API: postMessage out to the extension
// host, window messages in. Selected only when acquireVsCodeApi is present.
//
// The host relay wraps the AHP protocol faces in small envelopes:
//   * `{t:'snapshot', channel, state}` — the fold seed for one channel;
//   * `{t:'event', event}` — every relayed action envelope / catalogue change;
//   * `{t:'res', id, ok, result?, error?}` — a `req` reply;
//   * `{t:'boot', cwd, approvalMode}` / `{t:'config', approvalMode}` —
//     workspace facts for createSession and live settings pushes;
//   * `{t:'verb', kind:'new_session'|'open_turn_navigator'|'code_chain', …}`
//     — host commands the sandbox cannot fulfill itself;
//   * `{t:'fatal', message}` — host-side activation failure (addon missing,
//     handshake refused).
// Outbound, the webview posts the relay faces (`req`/`dispatch`/`view`/
// `refresh`), `{t:'log'}` diagnostics, and the watchdog heartbeat
// `{t:'ping', seq}` (the host echoes `{t:'pong', seq}`; see state/watchdog.ts).
//
// The extension host owns the AHP connection (one `initialize`, one client),
// so the webview sees one stable connection generation — `onConnection` is a
// no-op subscription. That stability is exactly why the watchdog lives HERE:
// with `retainContextWhenHidden`, a graceful extension-host restart can
// silently kill this transport's inbound direction (messages posted by the
// new host never reach the retained iframe), and nothing else in the webview
// can see the difference — so the heartbeat + self-heal reload is a
// transport-liveness concern owned by the transport.
import type { HostNote, ToHost, ToWebview } from '../../messages';
import { createChannelWatchdog } from '../state/watchdog';
import type { Bridge } from './bridge';
import { setBootFacts } from './host-facts';

interface VscodeHostApi {
	postMessage(msg: ToHost | { t: 'log'; level: 'info' | 'warn' | 'error'; message: string }): void;
}

declare function acquireVsCodeApi(): VscodeHostApi;

/** Heartbeat cadence for the channel watchdog (the scheduler interval and
 * the state machine's ping interval are one knob — see createVscodeBridge). */
export const WATCHDOG_PING_INTERVAL_MS = 5_000;

/** Re-push the folded state after a host-side restart signal. The
 * retained-iframe failure mode leaves the outbound webview→host direction
 * working while inbound messages go undelivered, so a fresh `boot`/`config`
 * (re-pushed by a healthy host after an extension install/activation) is a
 * chance to re-seed the store WITHOUT a reload — a `refresh` ask riding the
 * surviving direction; the host answers with fresh snapshot pushes.
 * Dynamic import breaks the static `api/client → api/vscode-bridge` cycle;
 * the module is already loaded at boot (client.ts creates this bridge). */
function resyncRegistries(): void {
	void import('./client')
		.then(({ api }) => {
			api.refresh();
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
	const listeners = new Set<(message: ToWebview) => void>();

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
		window.location.reload(); // iframe rebuild == channel rebuild; the fresh boot re-pushes the fold
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
		const msg = raw.data as ToWebview | undefined;
		if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
		// Liveness evidence for the watchdog: anything that reaches this
		// listener proves the host→webview direction is alive; pongs
		// additionally confirm the ping/pong round trip.
		watchdog.onAnyHostMessage();
		switch (msg.t) {
			case 'snapshot':
			case 'event':
			case 'res':
				for (const listener of listeners) listener(msg);
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
				for (const listener of listeners) listener(msg);
				return;
		}
	});

	return {
		post(message: ToHost) {
			vscode.postMessage(message);
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
