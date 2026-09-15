// GenCodeChain service assembly + the `registerSessionTools` lifecycle
// (§4, §9.2). One process-wide instance, installed lazily on the surface
// that first holds an `AgentHost` (participant turn, sidebar resolve, panel
// command) — activation never touches the runtime, so nothing here may run
// before the host exists; `ensureCodeChain` is idempotent.
//
// Registration replay (§9.2: registration is in-memory, session-scoped, and
// a FULL REPLACE per (session, clientId) — replaying the complete set is
// therefore the idempotent recovery for every lifecycle edge):
//   - every session the host creates (participant: explicit call; others:
//     the `sessionCreated` ServerNote, observed on the frame bus);
//   - every session the sidebar follows (`streamOpen(followSession)` — the
//     webview's open path, hooked from the sidebar provider);
//   - everything the thread registry reports, once `connection.ready` lands
//     (host restart: the server hands back the sessions it still has).
//
// The no-workspace-folder case (§10) skips registration with a log: the
// tools would fail every file resolution anyway, and an unregistered tool
// set keeps the LLM on its documented no-client-tool paths.

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ExtensionContext, Memento } from 'vscode';
import type { AgentHost } from '../agentHost';
import { postToSidebar } from '../sidebar/sidebarProvider';
import { clientToolSpec, registerSessionTools } from '../protocol/builders';
import { ChainStore } from './chainStore';
import { CodeChainPanel } from './panel';
import { vscodeWorkspaceView, VscodeLspClient } from './lspClient';
import { ChainNavigation } from './navigation';
import { clientToolSpecs, CodeChainTools, type InvokeCall, type ReplySinks } from './tools';
import type { ResolveDeps } from './resolve';

interface CodeChainService {
	readonly tools: CodeChainTools;
	registerSession(sessionId: string): void;
	openChain(chainId: string): boolean;
	stepTour(dir: 'prev' | 'next'): void;
	listChains(): ReturnType<ChainStore['list']>;
}

let service: CodeChainService | null = null;

/** Invoke sink for the host's `invokeClientTool` interceptor branch
 * (agentHost.ts). Returns false when the name is not a code-chain tool. */
export async function invokeCodeChainTool(call: InvokeCall, reply: ReplySinks): Promise<boolean> {
	if (!service) return false;
	return service.tools.handle(call, reply);
}

/** Build (once) the code-chain service over `host`. Safe to call from every
 * surface that has just resolved `AgentHost.shared`. */
export function ensureCodeChain(context: ExtensionContext, host: AgentHost): void {
	if (service) return;

	const log = (message: string): void => {
		host.log.info(`codechain: ${message}`);
	};

	// §10: tools are useless without a workspace; skip registration, keep
	// the open/replay surfaces alive (old chains still render).
	const hasWorkspace = (): boolean => (vscode.workspace.workspaceFolders?.length ?? 0) > 0;

	const store = new ChainStore(toSink(context.workspaceState));
	const deps: ResolveDeps = {
		lsp: new VscodeLspClient(),
		workspace: vscodeWorkspaceView(),
		mintChainId: () => `cc-${randomUUID()}`,
		now: () => Date.now(),
	};
	const navigation = new ChainNavigation(log);

	let tools: CodeChainTools;
	let panel: CodeChainPanel;
	tools = new CodeChainTools(deps, store, {
		showChain: (chain) => panel.show(chain),
		updateChain: (chain) => panel.update(chain),
		verb: (note) => postToSidebar({ t: 'verb', kind: 'code_chain', ...note }),
		log,
	});
	panel = new CodeChainPanel(context, store, navigation, () => tools, {
		compose: (text) => {
			void vscode.commands.executeCommand('manox.chatView.focus');
			postToSidebar({ t: 'verb', kind: 'compose', text });
		},
		log,
	});

	const registered = new Set<string>();
	const registerSession = (sessionId: string): void => {
		if (!sessionId) return;
		if (!hasWorkspace()) {
			log('no workspace folder — client tools not registered');
			return;
		}
		if (registered.has(sessionId)) return;
		registered.add(sessionId);
		void host.connection
			.call(
				registerSessionTools(
					sessionId,
					host.clientId,
					clientToolSpecs().map(clientToolSpec),
				),
			)
			.then(
				(receipt) => log(`client tools registered for ${sessionId}: ${JSON.stringify(receipt)}`),
				(e) => {
					registered.delete(sessionId); // a retry (next lifecycle edge) may succeed
					log(`registerSessionTools(${sessionId}) failed: ${String(e)}`);
				},
			);
	};

	service = {
		tools,
		registerSession,
		openChain: (chainId) => panel.openChain(chainId),
		stepTour: (dir) => panel.stepTour(dir),
		listChains: () => store.list(),
	};

	// Lifecycle edges (module header). `sessionCreated` covers every session
	// on the bus — including the webview's own, which never touches the host
	// participant path.
	void host.connection.ready.then(() => replayReady(host, registerSession, log));
	host.connection.onFrame((frame) => {
		if (frame.kind === 'notification' && frame.note.method === 'sessionCreated') {
			registerSession(frame.note.sessionId);
		}
	});

	context.subscriptions.push({
		dispose: () => {
			navigation.dispose();
			panel.dispose();
			service = null;
		},
	});
	log('service installed');
}

/** Re-pull the thread registry after `ready`: registration accepts sessions
 * the server already owns (and idempotent replaces make re-registering
 * free), which covers both host restarts and sessions created while the
 * extension host was down (§9.2 replay rule). */
async function replayReady(
	host: AgentHost,
	registerSession: (sessionId: string) => void,
	log: (message: string) => void,
): Promise<void> {
	try {
		const threads = await host.connection.listThreads();
		for (const thread of threads) registerSession(thread.id);
		log(`ready replay: ${threads.length} session(s)`);
	} catch (e) {
		log(`ready replay failed: ${String(e)}`);
	}
}

/** Sidebar follow-stream claim hook (sidebarProvider.trackStream): the
 * webview's openSession+streamOpen path materializes session ownership
 * there — hooking it keeps registration aligned with every card-capable
 * session even if the `sessionCreated` note raced installation. */
export function codeChainRegisterSession(sessionId: string): void {
	service?.registerSession(sessionId);
}

export function codeChainOpenChain(chainId: string): boolean {
	return service?.openChain(chainId) ?? false;
}

export function codeChainStepTour(dir: 'prev' | 'next'): void {
	service?.stepTour(dir);
}

/** Newest-first summaries for the palette quick-pick (extension.ts). */
export function codeChainListChains(): ReturnType<ChainStore['list']> {
	return service?.listChains() ?? [];
}

/** `vscode.Memento` → the ChainStore sink face (workspaceState survives
 * reloads; delete is best-effort via an undefined value write). */
function toSink(memento: Memento): {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
	delete(key: string): Thenable<void>;
} {
	return {
		get: <T,>(key: string) => memento.get<T>(key),
		update: (key, value) => memento.update(key, value),
		delete: (key) => memento.update(key, undefined),
	};
}
