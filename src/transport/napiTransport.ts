// Transport backed by the manox napi native binding (dspo/manox v0.3.0): the
// agent runtime runs in-process on its own tokio runtime, and the binding is
// a raw AHP transport bridge — one end of an in-process JSON-RPC connection.
// Host→client messages arrive through a napi threadsafe function invoked as
// `callback(jsonRpcText)` (single argument; the v0.2 `(err, event)` Node
// style is gone with protocol v2). The protocol itself — channels,
// subscriptions, request correlation — lives in the AHP client layer
// (`src/client/agentClient.ts`), not here.
//
// The binding is NOT bundled with the extension: it is staged by
// `script/build-napi` in the dspo/manox repository and located through
// `manox.sdkRoot` / `VSCODE_AGENT_HOST_MANOX_SDK_ROOT` / `<extension>/native/`.
//
// State root: shared with the desktop app by default (`~/.manox`) so both
// surfaces see the same threads, models and provider config. Concurrent
// instances are safe — the old exclusive `runtime.lock` is gone; the only
// remaining flock is the WS gateway lease (`gateway.lock`), whose
// contention is a loud no-op (second gateway simply does not start), never
// a process exit.

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Transport } from './transport';

/** The napi binding surface (crates/manox-napi in dspo/manox, v0.3.0): a raw
 * AHP JSON-RPC transport bridge. The `start` callback keeps the napi-rs
 * threadsafe-function convention — Node style `(err, text)`, err null on a
 * delivered frame. (The lib.rs doc comment says "one JSON string"; the
 * runtime delivers `(null, string)` — probe-verified against the v0.3.0
 * addon, and the same convention the v0.2 binding used.) */
interface NapiBinding {
	ping(): string;
	start(clientId: string, callback: (err: Error | null, event: string) => void): void;
	sendCommand(command: string): void;
	shutdown(): void;
}

/** Default state root when `manox.stateRoot` is unset: the desktop app's
 * home, so threads/models/provider config are shared (see the exclusivity
 * note above). */
export const DEFAULT_STATE_ROOT = path.join(os.homedir(), '.manox');

/**
 * Resolve the native binding's directory: the `manox.sdkRoot` setting, then
 * the `VSCODE_AGENT_HOST_MANOX_SDK_ROOT` environment variable, then
 * `<extensionRoot>/native/`. Exported for testability and diagnostics.
 */
export function resolveSdkRoot(configured?: string, envValue?: string, extensionRoot?: string): string | undefined {
	for (const candidate of [configured, envValue, extensionRoot ? path.join(extensionRoot, 'native') : undefined]) {
		if (candidate && candidate.trim() !== '' && fs.existsSync(path.join(candidate, 'manox_napi.node'))) {
			return candidate;
		}
	}
	return undefined;
}

/** Load the addon, pinning `MANOX_HOME` first (the lock is acquired during
 * `manox_agent::init()` inside `start()`; the env must be set before then —
 * setting it before `require()` covers any read path). */
function loadBinding(sdkRoot: string, stateRoot: string): NapiBinding {
	if (!process.env.MANOX_HOME) {
		process.env.MANOX_HOME = stateRoot;
	}
	fs.mkdirSync(stateRoot, { recursive: true });
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(path.join(sdkRoot, 'manox_napi.node')) as NapiBinding;
}

export class NapiTransport implements Transport {
	private readonly events = new EventEmitter();
	private readonly readyPromise: Promise<void>;
	private disposed = false;

	private constructor(private readonly binding: NapiBinding) {
		this.events.setMaxListeners(0);
		this.readyPromise = Promise.resolve();
	}

	/**
	 * Load the binding and connect the in-process AHP transport. `clientId`
	 * is the persisted host identity the extension mints once (globalState)
	 * and replays on every activation so the server re-seats the same
	 * client; it seeds the agent host's own identity (VS Code vs. desktop) —
	 * the AHP handshake itself carries the protocol-level clientId. Raw
	 * JSON-RPC text frames flow through `onRaw`; the AHP client layer is
	 * the parse face. `onDropped` receives callback errors (logged, never
	 * fatal — the next frame proves liveness).
	 */
	static load(options: {
		sdkRoot: string;
		stateRoot: string;
		clientId: string;
		onDropped?: (raw: string) => void;
	}): NapiTransport {
		const transport = new NapiTransport(loadBinding(options.sdkRoot, options.stateRoot));
		transport.binding.start(options.clientId, (err, raw) => {
			if (err) {
				console.error('manox transport error:', err);
				options.onDropped?.(String(err));
				return;
			}
			transport.events.emit('raw', raw);
		});
		return transport;
	}

	get ready(): Promise<void> {
		return this.readyPromise;
	}

	/** Raw JSON-RPC relay — the AHP client layer is the parse face. */
	onRaw(handler: (raw: string) => void): () => void {
		this.events.on('raw', handler);
		return () => this.events.off('raw', handler);
	}

	send(command: string): void {
		if (this.disposed) throw new Error('manox transport is disposed');
		this.binding.sendCommand(command);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.binding.shutdown();
		this.events.removeAllListeners();
	}
}
