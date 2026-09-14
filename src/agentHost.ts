// The process-wide agent host: owns the napi transport and the host-side
// `AgentConnection` (the webview runs its own connection over the sidebar
// relay — same physical wire, separate correlation namespaces). Started
// lazily on first use so merely having the extension installed never risks
// the extension host (agent init acquires an exclusive `MANOX_HOME` lock and
// manox exits the process on contention).

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { AgentConnection, type Wire } from './client/connection';
import type { ApprovalMode } from './protocol/types';
import { parseFromServer } from './protocol/guards';
import { DEFAULT_STATE_ROOT, NapiTransport, resolveSdkRoot } from './transport/napiTransport';

/** §D.2 Initialize identity: minted once, persisted in globalState, replayed
 * on every activation so window reloads and transport re-inits re-seat the
 * same server-side client instead of registering a new one. */
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
export function configuredApprovalMode(): ApprovalMode {
	const value = vscode.workspace.getConfiguration('manox').get<string>('approvalMode');
	return value === 'read-only' || value === 'danger-full-access' ? value : 'workspace-write';
}

/** The configured state root (`MANOX_HOME`); empty uses the dedicated
 * `~/.manox-vscode` default — never the desktop app's `~/.manox`. */
export function configuredStateRoot(): string {
	const value = vscode.workspace.getConfiguration('manox').get<string>('stateRoot');
	return value && value.trim() !== '' ? value : DEFAULT_STATE_ROOT;
}

function configuredSdkRoot(): string {
	return vscode.workspace.getConfiguration('manox').get<string>('sdkRoot') ?? '';
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
	readonly connection: AgentConnection;

	private constructor(clientId: string, extensionPath: string, private readonly log: vscode.LogOutputChannel) {
		const sdkRoot = resolveSdkRoot(configuredSdkRoot(), process.env.VSCODE_AGENT_HOST_MANOX_SDK_ROOT, extensionPath);
		if (!sdkRoot) {
			throw new Error(
				'manox native binding not found: build it in the dspo/manox repository (script/build-napi) and point the `manox.sdkRoot` setting (or VSCODE_AGENT_HOST_MANOX_SDK_ROOT) at the staged directory.',
			);
		}
		const stateRoot = configuredStateRoot();
		this.log.info(`loading native binding from ${sdkRoot} (MANOX_HOME=${stateRoot})`);
		this.transport = NapiTransport.load({
			sdkRoot,
			stateRoot,
			clientId,
			onDropped: (raw) => this.log.warn(`dropping unparseable frame: ${raw.slice(0, 400)}`),
		});

		// Wire adapter: raw JSON strings → guard-parsed frames. The
		// connection's own dispatch handles routing; unparsable or
		// undeclared-vocabulary frames drop with a log line (L12).
		const wire: Wire = {
			send: (frame) => this.transport.send(JSON.stringify(frame)),
			onFrame: (handler) =>
				this.transport.onRaw((raw) => {
					let parsed: unknown;
					try {
						parsed = JSON.parse(raw);
					} catch {
						this.log.warn(`malformed frame: ${raw.slice(0, 400)}`);
						return;
					}
					const frame = parseFromServer(parsed);
					if (frame === null) {
						this.log.debug(`dropping unknown-vocabulary frame: ${raw.slice(0, 400)}`);
						return;
					}
					handler(frame);
				}),
		};
		this.connection = new AgentConnection(wire, {
			idPrefix: 'host',
			onDroppedFrame: (raw) => this.log.debug(`dropping frame: ${JSON.stringify(raw).slice(0, 400)}`),
		});
	}

	private async dispose(): Promise<void> {
		// Teardown rides the connection drop (the server's Shutdown note is a
		// documented no-op).
		await this.transport.dispose();
		this.log.dispose();
	}
}
