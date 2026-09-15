// The process-wide agent host: owns the napi transport and the host-side
// `AgentConnection` (the webview runs its own connection over the sidebar
// relay — same physical wire, separate correlation namespaces). Started
// lazily on first use so merely having the extension installed never risks
// the extension host (agent init acquires an exclusive `MANOX_HOME` lock and
// manox exits the process on contention).

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ensureCodeChainCommand, resolveProvisionRoot } from './codechain/command';
import { invokeCodeChainTool } from './codechain/registration';
import { clientToolReplyPayload } from './protocol/builders';
import { AgentConnection, type HostCallInterceptor, type Wire } from './client/connection';
import type { ApprovalMode } from './protocol/types';
import { parseFromServer } from './protocol/guards';
import { DEFAULT_STATE_ROOT, NapiTransport, resolveSdkRoot } from './transport/napiTransport';
import { errorText } from './util';

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

/** Host-owned capability answers (manox #792: the napi edge declares
 * ClipboardRead / OpenExternal / ClientTool for this host, so the server now
 * routes those ServerCalls here — they are process capabilities, never
 * webview cards).
 *
 * - clipboardRead → text-only bridge per the server contract: `{data: base64,
 *   mimeType}` or null when empty (the kernel fails closed on non-text, so
 *   anything we cannot express as UTF-8 text answers null).
 * - openExternal → `vscode.env.openExternal`, reply `{}`. The agent's Open
 *   tool is approval-gated upstream (host_tools), so the wire call arrives
 *   already authorized by the user.
 * - clientTool → the GenCodeChain host tools (§4): `invokeClientTool` MUST
 *   be answered here, before any per-session shield claims the delivery —
 *   a viewed session's no-op handler would otherwise swallow the call into
 *   the server's 300s wait, and a per-session handler could not keep the
 *   sidebar's approval-card answering alive. The reply payload is the
 *   `{content, isError}` contract (§9.3): business outcomes — including
 *   self-correction feedback — answer Ok with `isError: true` so the model
 *   can read them; the sinks below build the payload shape. */
function hostCallInterceptor(log: vscode.LogOutputChannel): HostCallInterceptor {
	return (call, _id, reply) => {
		switch (call.method) {
			case 'clipboardRead': {
				void vscode.env.clipboard.readText().then(
					(text) => {
						if (text === '') reply.ok(null);
						else reply.ok({ data: Buffer.from(text, 'utf8').toString('base64'), mimeType: 'text/plain' });
					},
					(e) => reply.err(`manox: clipboard read failed: ${errorText(e)}`),
				);
				return true;
			}
			case 'openExternal': {
				let uri: vscode.Uri;
				try {
					uri = vscode.Uri.parse(call.url, true);
				} catch (e) {
					reply.err(`manox: unparseable external URL: ${errorText(e)}`);
					return true;
				}
				void vscode.env.openExternal(uri).then(
					(opened) => {
						if (opened) reply.ok({});
						else reply.err(`manox: no handler for external URL: ${call.url}`);
					},
					(e) => reply.err(`manox: openExternal failed: ${errorText(e)}`),
				);
				return true;
			}
			case 'invokeClientTool': {
				void invokeCodeChainTool(
					{ sessionId: call.sessionId, name: call.name, input: call.input },
					{
						// Route the payload through the guards-tested
						// `clientToolReplyPayload` so the `{content,isError}`
						// shape pinned in guards.test is the SAME object the
						// live path emits (review #19).
						ok: (content, isError) => reply.ok(clientToolReplyPayload(content, isError)),
						err: (message) => reply.err(message),
					},
				).then(
					(handled) => {
						if (!handled) {
							reply.err(`manox: client tool '${call.name}' is not served by this host`);
						}
					},
					(e) => reply.err(`manox: client tool dispatch failed: ${errorText(e)}`),
				);
				return true;
			}
			default:
				log.debug(`host interceptor: not a host capability: ${call.method}`);
				return false;
		}
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
	readonly connection: AgentConnection;
	/** §D.2 identity — `registerSessionTools` frames must name it (and the
	 * server only routes `invokeClientTool` back to its owner). */
	readonly clientId: string;
	readonly log: vscode.LogOutputChannel;

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
		// Provision `/codechain` BEFORE the runtime starts: manox's command
		// registry scans `<MANOX_HOME>/commands` once inside
		// `napiBinding.start()` (this call), so the file must already exist —
		// hence synchronous, and honoring the same `MANOX_HOME`-over-setting
		// precedence the transport itself uses (review #12). A failure here
		// must not abort activation: a missing command degrades to the
		// model's documented no-command path.
		const provisionRoot = resolveProvisionRoot(stateRoot, process.env.MANOX_HOME, (m) => this.log.warn(m));
		try {
			const wrote = ensureCodeChainCommand(provisionRoot);
			this.log.info(`/codechain command ${wrote} (${join(provisionRoot, 'commands')})`);
		} catch (e) {
			this.log.warn(`failed to provision /codechain: ${errorText(e)}`);
		}
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
			hostCalls: hostCallInterceptor(this.log),
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
