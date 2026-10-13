// The process-wide agent host: owns the napi transport and the single AHP
// `ManoxClient` (AHP is one connection with one `initialize`, so the
// extension host owns the only client; the webview folds the relayed
// envelopes — see sidebarProvider.ts). Started lazily on first use so merely
// having the extension installed never risks the extension host.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ensureCodeChainCommand, resolveProvisionRoot } from './codechain/command';
import { invokeCodeChainTool } from './codechain/registration';
import { ManoxClient, type RelayEvent } from './client/agentClient';
import { EXT_REQUESTS } from './protocol/xmanox';
import { DEFAULT_STATE_ROOT, NapiTransport, resolveSdkRoot } from './transport/napiTransport';
import { errorText } from './util';

/** Persisted host identity: minted once, replayed on every activation so
 * window reloads re-seat the same agent-host identity. (This seeds the
 * embedded runtime's own identity — VS Code vs. the desktop app; the AHP
 * handshake carries its own clientId.) */
const CLIENT_ID_KEY = 'manox.clientId';

function ensureClientId(context: vscode.ExtensionContext): string {
	const existing = context.globalState.get<string>(CLIENT_ID_KEY);
	if (typeof existing === 'string' && existing.startsWith('vscode-')) return existing;
	const clientId = `vscode-${randomUUID()}`;
	void context.globalState.update(CLIENT_ID_KEY, clientId);
	return clientId;
}

/** Workspace folder the agent operates on; falls back to HOME, then cwd. */
export function resolveWorkspaceCwd(): string {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return folder ?? process.env.HOME ?? process.cwd();
}

/** Configured tool-authorization policy; unset falls back to workspace-write. */
export function configuredApprovalMode(): string {
	const value = vscode.workspace.getConfiguration('manox').get<string>('approvalMode');
	return value === 'read-only' || value === 'danger-full-access' ? value : 'workspace-write';
}

/** The configured state root (`MANOX_HOME`); empty uses the shared
 * `~/.manox` default — the desktop app's home, so threads/models/provider
 * config are one surface. Concurrent instances are safe (the gateway lease
 * is the only flock, and contention there is a no-op). */
export function configuredStateRoot(): string {
	const value = vscode.workspace.getConfiguration('manox').get<string>('stateRoot');
	return value && value.trim() !== '' ? value : DEFAULT_STATE_ROOT;
}

function configuredSdkRoot(): string {
	return vscode.workspace.getConfiguration('manox').get<string>('sdkRoot') ?? '';
}

/** Host-owned capability answers (the `x-manox/*` server requests declared in
 * the AHP handshake — process capabilities, never webview cards):
 *
 * - clipboardRead → the clipboard TEXT or null (the kernel fails closed on
 *   non-text, so anything not expressible as UTF-8 answers null).
 * - openExternal → `vscode.env.openExternal`; the agent's Open tool is
 *   approval-gated upstream, so the request arrives already authorized.
 * - invokeTool → the Code Tutor host tools: `invokeCodeChainTool` answers
 *   with the `{content, isError}` contract — business outcomes (including
 *   self-correction feedback) answer content with `isError: true` so the
 *   model can read them. */
function hostRequestHandlers(
	log: vscode.LogOutputChannel,
	sessionForToolCall: (toolCallId: string) => string,
): {
	clipboardRead(): Promise<string | null>;
	openExternal(url: string): Promise<void>;
	invokeTool(params: {
		clientId: string;
		toolCallId: string;
		name: string;
		input: unknown;
	}): Promise<{ content: string; isError?: boolean }>;
} {
	return {
		async clipboardRead() {
			const text = await vscode.env.clipboard.readText();
			return text === '' ? null : text;
		},
		async openExternal(url) {
			let uri: vscode.Uri;
			try {
				uri = vscode.Uri.parse(url, true);
			} catch (e) {
				throw new Error(`manox: unparseable external URL: ${errorText(e)}`);
			}
			const opened = await vscode.env.openExternal(uri);
			if (!opened) throw new Error(`manox: no handler for external URL: ${url}`);
		},
		async invokeTool({ toolCallId, name, input }) {
			// `x-manox/invokeTool` names no session; the caller attributes the
			// call through the folded chat state (the Code Tutor's chain store
			// keys by session). Unattributable calls run with an empty session
			// id and fail closed in the tool layer.
			const sessionId = sessionForToolCall(toolCallId);
			let settled: { content: string; isError?: boolean } | null = null;
			const handled = await invokeCodeChainTool(
				{ sessionId, name, input },
				{
					ok: (content, isError) => {
						settled = { content, isError };
					},
					err: (message) => {
						settled = { content: message, isError: true };
					},
				},
			);
			if (!handled || settled === null) {
				throw new Error(`manox: client tool '${name}' is not served by this host`);
			}
			return settled;
		},
	};
}

export class AgentHost {
	private static instance: AgentHost | null = null;

	static shared(context: vscode.ExtensionContext): AgentHost {
		if (!AgentHost.instance) {
			AgentHost.instance = new AgentHost(
				ensureClientId(context),
				context.extensionPath,
				vscode.window.createOutputChannel('manox', { log: true }),
			);
		}
		return AgentHost.instance;
	}

	static async disposeShared(): Promise<void> {
		const instance = AgentHost.instance;
		AgentHost.instance = null;
		if (instance) await instance.dispose();
	}

	readonly transport: NapiTransport;
	/** The single AHP client. Assigned asynchronously in `ready`. */
	manox: ManoxClient | null = null;
	/** Resolves once the AHP handshake completed. */
	readonly ready: Promise<ManoxClient>;
	readonly clientId: string;
	readonly log: vscode.LogOutputChannel;
	/** Relay handlers buffered until the handshake completes (the Code Tutor
	 * registrar and the sidebar attach during startup, before `ready`).
	 * `includeActions`: the sidebar wants action envelopes too; catalogue
	 * consumers (the registrar) do not. */
	private readonly pendingSessionEvents: { handler: Parameters<ManoxClient['onEvent']>[0]; includeActions: boolean }[] = [];

	private constructor(clientId: string, extensionPath: string, log: vscode.LogOutputChannel) {
		this.clientId = clientId;
		this.log = log;
		const sdkRoot = resolveSdkRoot(configuredSdkRoot(), process.env.VSCODE_AGENT_HOST_MANOX_SDK_ROOT, extensionPath);
		if (!sdkRoot) {
			throw new Error(
				'manox native binding not found: build it in the dspo/manox repository (script/build-napi) and point the `manox.sdkRoot` setting (or VSCODE_AGENT_HOST_MANOX_SDK_ROOT) at the staged directory.',
			);
		}
		const stateRoot = configuredStateRoot();
		// Provision `/tutor` BEFORE the runtime starts: manox's command
		// registry scans `<MANOX_HOME>/commands` once inside
		// `napiBinding.start()` (this call), so the file must already exist —
		// hence synchronous, and honoring the same `MANOX_HOME`-over-setting
		// precedence the transport itself uses. A failure here must not abort
		// activation: a missing command degrades to the model's documented
		// no-command path.
		const provisionRoot = resolveProvisionRoot(stateRoot, process.env.MANOX_HOME, (m) => this.log.warn(m));
		try {
			const wrote = ensureCodeChainCommand(provisionRoot);
			this.log.info(`/tutor command ${wrote} (${join(provisionRoot, 'commands')})`);
		} catch (e) {
			this.log.warn(`failed to provision /tutor: ${errorText(e)}`);
		}
		this.log.info(`loading native binding from ${sdkRoot} (MANOX_HOME=${stateRoot})`);
		this.transport = NapiTransport.load({ sdkRoot, stateRoot, clientId });
		// Late-bound: the client does not exist until the handshake resolves,
		// but an invokeTool request can only arrive after it did.
		let sessionForToolCall: (toolCallId: string) => string = () => '';
		this.ready = ManoxClient.start(this.transport, hostRequestHandlers(log, (id) => sessionForToolCall(id)), {
			clientId,
			log: (level, message) => (log[level] as (m: string) => void)(message),
		})
			.then((manox) => {
				this.manox = manox;
				sessionForToolCall = (toolCallId) =>
					(manox.sessionForToolCall(toolCallId) ?? '').slice('ahp-session:/'.length);
				// Replays of the catalogue arrive with the handshake; route the
				// buffered subscribers first, then subscribe future events.
				const buffered = this.pendingSessionEvents.splice(0);
				for (const entry of buffered) {
					manox.onEvent(entry.includeActions ? entry.handler : (event) => {
						if (event.type !== 'action') entry.handler(event);
					});
				}
				this.log.info(
					`AHP ready (protocol ${manox.protocolVersion ?? '?'}, x-manox ext v${manox.extVersion ?? '?'})`,
				);
				return manox;
			})
			.catch((e) => {
				this.log.error(`AHP handshake failed: ${errorText(e)}`);
				throw e;
			});
	}

	private async dispose(): Promise<void> {
		try {
			const manox = await this.ready.catch(() => null);
			await manox?.dispose();
		} catch {
			// Transport already gone.
		}
		this.log.dispose();
	}

	/** Subscribe to session-catalogue lifecycle events (`sessionAdded` /
	 * `sessionRemoved` / `sessionSummaryChanged`). Handlers attached before
	 * the handshake completes receive everything from the start — events are
	 * buffered per handler until `ready` (the initial catalogue replay rides
	 * the handshake itself, and the registrar replays `rows()` on ready, so
	 * only the tail can buffer). */
	onSessionEvent(handler: (event: { type: string; [key: string]: unknown }) => void): () => void {
		const wrapped = handler as (event: RelayEvent) => void;
		this.pendingSessionEvents.push({ handler: wrapped, includeActions: false });
		let unsubscribe: (() => void) | null = null;
		void this.ready.then((manox) => {
			unsubscribe = manox.onEvent((event) => {
				if (event.type !== 'action') handler(event);
			});
		});
		return () => {
			const at = this.pendingSessionEvents.findIndex((e) => e.handler === wrapped);
			if (at >= 0) this.pendingSessionEvents.splice(at, 1);
			unsubscribe?.();
		};
	}

	/** Subscribe to every relay event (actions included) — the sidebar's
	 * fan-out. Same buffering discipline as `onSessionEvent`. */
	onRelayEvent(handler: (event: RelayEvent) => void): () => void {
		this.pendingSessionEvents.push({ handler, includeActions: true });
		let unsubscribe: (() => void) | null = null;
		void this.ready.then((manox) => {
			unsubscribe = manox.onEvent(handler);
		});
		return () => {
			const at = this.pendingSessionEvents.findIndex((e) => e.handler === handler);
			if (at >= 0) this.pendingSessionEvents.splice(at, 1);
			unsubscribe?.();
		};
	}

	/** Coarse fold-change notification (any state mutation on the client). */
	onFoldChanged(listener: () => void): () => void {
		let unsubscribe: (() => void) | null = null;
		void this.ready.then((manox) => {
			unsubscribe = manox.onChange(listener);
		});
		return () => unsubscribe?.();
	}
}

/** The x-manox request method names this host declares (diagnostics/tests):
 * everything except browserOp (no embedded browser in VS Code). */
export const declaredHostRequests = (): string[] => [
	EXT_REQUESTS.clipboardRead,
	EXT_REQUESTS.openExternal,
	EXT_REQUESTS.invokeTool,
];
