// Transport backed by the manox napi native binding: the agent server runs
// in-process on its own tokio runtime, and `FromServer` frames arrive through
// a napi threadsafe function in Node callback style `(err, eventJson)`.
//
// The Rust pump forwards every `FromServer` variant verbatim — v2
// stream/host frames included — and `sendCommand` accepts every `FromClient`
// variant. The binding is NOT bundled with the extension: it is staged by
// `script/build-napi` in the dspo/manox repository and located through
// `manox.sdkRoot` / `VSCODE_AGENT_HOST_MANOX_SDK_ROOT` / `<extension>/native/`.
//
// State-root isolation: manox holds an exclusive process lock on
// `<MANOX_HOME>/runtime.lock` and *exits the process* on contention, so this
// loader pins `MANOX_HOME` to a dedicated root (default `~/.manox-vscode`)
// before the addon loads — never the desktop app's `~/.manox`.

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Transport } from './transport';

/** The napi binding surface (crates/manox-napi in dspo/manox). */
interface NapiBinding {
	ping(): string;
	start(clientId: string, callback: (err: Error | null, event: string) => void): void;
	sendCommand(command: string): void;
	shutdown(): void;
}

/** Default state root when `manox.stateRoot` is unset. */
export const DEFAULT_STATE_ROOT = path.join(os.homedir(), '.manox-vscode');

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
	 * Load the binding and start the agent server connection. `clientId` is
	 * the persisted host identity (§D.2 Initialize) the extension mints once
	 * (globalState) and replays on every re-init so the server re-seats the
	 * same client; an empty string falls back to the legacy `"vscode"` pin.
	 * `onDropped` receives raw frames this host's guards cannot parse
	 * (version skew — logged, never fatal).
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
				return;
			}
			transport.events.emit('raw', raw);
		});
		return transport;
	}

	get ready(): Promise<void> {
		return this.readyPromise;
	}

	/** Raw JSON relay — the Wire adapter's guards are the parse face. */
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
