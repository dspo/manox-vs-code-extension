// Code Tutor service assembly + the client-tool contribution lifecycle
// (§4, §9.2). One process-wide instance, installed lazily on the surface
// that first holds an `AgentHost` (participant turn, sidebar resolve, panel
// command) — activation never touches the runtime, so nothing here may run
// before the host exists; `ensureCodeChain` is idempotent.
//
// Registration replay (§9.2: registration is in-memory, session-scoped, and
// a FULL REPLACE per (session, clientId) — replaying the complete set is
// therefore the idempotent recovery for every lifecycle edge):
//   - every session the host creates (participant: explicit call; others:
//     the `sessionAdded` relay event, observed on the event bus);
//   - every session the sidebar claims (hooked from the sidebar provider);
//   - everything the session catalogue already holds, once `ready` lands.
//
// The `registered` guard is deliberately NOT a permanent set (review #4):
// server-side registration is in-memory and a session can be disposed and
// cold-reopened under the SAME id, which must re-register. The controller
// keeps only an in-flight guard plus a failed-retry tombstone, and clears on
// `sessionRemoved`. The whole replace-per-register makes redundant calls
// harmless, so this errs toward re-sending.
//
// The registrar is extracted (`SessionToolRegistrar`) and vscode-free so a
// unit test can drive the exact lifecycle against a fake host (#19).
//
// The no-workspace-folder case (§10) skips registration with a log: the
// tools would fail every file resolution anyway, and an unregistered tool
// set keeps the LLM on its documented no-client-tool paths.

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ExtensionContext, Memento } from 'vscode';
import type { ToolDefinition } from '@microsoft/agent-host-protocol';
import type { AgentHost } from '../agentHost';
import { postToSidebar } from '../sidebar/sidebarProvider';
import { ChainStore } from './chainStore';
import { CodeChainPanel } from './panel';
import { vscodeWorkspaceView, VscodeLspClient } from './lspClient';
import { ChainNavigation } from './navigation';
import { SessionToolRegistrar, toToolDefinition } from './sessionRegistrar';
import { clientToolSpecs, CodeChainTools, type InvokeCall, type ReplySinks } from './tools';
import type { ResolveDeps } from './resolve';

// ── process-wide service ────────────────────────────────────────────────────

interface CodeChainService {
	readonly tools: CodeChainTools;
	registerSession(sessionUri: string): void;
	openChain(chainId: string): boolean;
	stepTour(dir: 'prev' | 'next'): void;
	listChains(): ReturnType<ChainStore['list']>;
}

let service: (CodeChainService & { dispose(): void }) | null = null;

/** Invoke sink for the host's `x-manox/invokeTool` handler (agentHost.ts).
 * Returns false when the name is not a code-chain tool. */
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
	const hasWorkspace = (): boolean => (vscode.workspace.workspaceFolders?.length ?? 0) > 0;

	const store = new ChainStore(toSink(context.workspaceState), log);
	const deps: ResolveDeps = {
		lsp: new VscodeLspClient(log),
		workspace: vscodeWorkspaceView(),
		mintChainId: () => `cc-${randomUUID()}`,
		now: () => Date.now(),
		log,
	};
	const navigation = new ChainNavigation(log, deps.lsp);

	const panel = new CodeChainPanel(context, store, navigation, () => tools, { log });
	// The Code Tutor surface is a draggable webview VIEW (contributes.views.
	// panel → manox.tutorView), not an editor tab: it registers alongside the
	// service. `retainContextWhenHidden` lives on the registration's
	// webviewOptions (WebviewOptions itself has no such field); the ready→
	// resend handshake still backstops a context discard (window reload).
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('manox.tutorView', panel, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	const tools = new CodeChainTools(deps, store, {
		showChain: (chain) => panel.show(chain),
		updateChain: (chain) => panel.update(chain),
		verb: (note) => postToSidebar({ t: 'verb', kind: 'code_chain', ...note }),
		log,
	});

	const registrar = new SessionToolRegistrar({
		send: (sessionUri, toolsToContribute) =>
			host.ready.then((manox) => manox.setActiveClientTools(sessionUri as never, toolsToContribute)),
		hasWorkspace,
		log,
		tools: () => clientToolSpecs().map(toToolDefinition),
	});

	const replayReady = async (): Promise<void> => {
		try {
			const manox = await host.ready;
			for (const row of manox.rows()) registrar.registerSession(row.uri);
			log(`ready replay: ${manox.rows().length} session(s)`);
		} catch (e) {
			log(`ready replay failed: ${String(e)}`);
		}
	};
	void host.ready.then(replayReady);

	// Lifecycle edges on the event bus (module header). `sessionAdded`
	// covers every creator including the webview's own sessions;
	// `sessionRemoved` frees the registrar so a same-id re-open re-registers.
	const unsubEvents = host.onSessionEvent((event) => {
		if (event.type === 'sessionAdded') {
			registrar.registerSession((event.summary as { resource: string }).resource);
		} else if (event.type === 'sessionRemoved') {
			registrar.onSessionDisposed(event.session as string);
		}
	});

	// The reverse-sync watcher attaches inside the panel constructor (once
	// for the service lifetime); nothing else to wire per panel.

	service = {
		tools,
		registerSession: (uri) => registrar.registerSession(uri),
		openChain: (chainId) => panel.openChain(chainId),
		stepTour: (dir) => panel.stepTour(dir),
		listChains: () => store.list(),
		dispose: () => {
			unsubEvents();
			navigation.dispose();
			panel.dispose();
			service = null;
		},
	};
	context.subscriptions.push({ dispose: () => service?.dispose() });
	log('service installed');
}

/** Sidebar claim hook (sidebarProvider): a session the webview claims is
 * card-capable, so its tool set must be contributed. */
export function codeChainRegisterSession(sessionUri: string): void {
	service?.registerSession(sessionUri);
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
