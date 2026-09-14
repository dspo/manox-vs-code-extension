// ChatParticipant handler: drives a dedicated agent session per @manox
// request and projects its journal stream onto the native chat stream. The
// sidebar runs its own sessions over the same host; the two never share a
// turn.
//
// The participant has no interactive approval surface: authorizations are
// denied at once with a pointer to the sidebar, where approval cards can be
// decided interactively (fail-closed, mirroring the agent's own default).

import * as vscode from 'vscode';
import { AgentHost, configuredApprovalMode, resolveWorkspaceCwd } from './agentHost';
import { errorText } from './util';
import type { SessionHandle } from './client/connection';
import type { MsgId, ServerCall } from './protocol/types';

/** Turns are model-driven and unbounded; the guard exists so a stuck stream
 * cannot pin the chat request forever. */
const TURN_TIMEOUT_MS = 10 * 60_000;
/** A turn that stops producing journal entries for this long is over (e.g. a
 * slash command that never started a turn). */
const QUIET_TIMEOUT_MS = 45_000;

export function registerManoxParticipant(context: vscode.ExtensionContext): void {
	const participant = vscode.chat.createChatParticipant('manox', (request, _ctx, stream, token) =>
		runParticipantTurn(context, request.prompt, stream, token),
	);
	participant.iconPath = {
		light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg'),
		dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg'),
	};
	context.subscriptions.push(participant);
}

async function runParticipantTurn(
	context: vscode.ExtensionContext,
	prompt: string,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
	let host: AgentHost;
	try {
		host = AgentHost.shared(context);
	} catch (e) {
		stream.markdown(`**Error:** ${e instanceof Error ? e.message : String(e)}`);
		return { errorDetails: { message: 'native binding unavailable' } };
	}

	let handle: SessionHandle | null = null;
	let sessionId = '';
	try {
		await host.connection.ready;
		sessionId = await host.connection.createSession({
			cwd: resolveWorkspaceCwd(),
			approvalMode: configuredApprovalMode(),
		});
	} catch (e) {
		stream.markdown(`**Error:** manox core unavailable (${errorText(e)})`);
		return { errorDetails: { message: 'core unavailable' } };
	}

	// Per-turn wiring: follow the session, auto-deny adjudications, project
	// the journal onto the chat stream.
	const finish = trackTurnEnd();
	const disposables: vscode.Disposable[] = [];
	try {
		handle = host.connection.follow(sessionId);
		host.connection.setCallHandler(sessionId, (call, id) =>
			answerServerCall(host, call, id, stream),
		);
		projectOntoChat(handle, stream, finish);

		disposables.push(
			token.onCancellationRequested(() => {
				host.connection.send({ method: 'cancelTurn', sessionId });
				finish.resolve();
			}),
		);

		await host.connection.submit(sessionId, prompt);
		await finish.done();
		return { metadata: { participant: 'manox' } };
	} catch (e) {
		stream.markdown(`\n**Error:** ${errorText(e)}`);
		return { errorDetails: { message: errorText(e) } };
	} finally {
		for (const d of disposables) d.dispose();
		host.connection.setCallHandler(sessionId, null);
		handle?.close();
		host.connection.send({ method: 'disposeSession', sessionId });
	}
}

/** Answer a ServerCall with the participant's fail-closed policy: approvals
 * are denied with a pointer to the sidebar; everything else rejects so the
 * waterfall cancels. */
function answerServerCall(
	host: AgentHost,
	call: ServerCall,
	id: MsgId,
	stream: vscode.ChatResponseStream,
): void {
	if (call.method === 'approve') {
		host.connection.sendRaw({ kind: 'reply', id, outcome: { Ok: { allow: false } } });
		stream.markdown(
			`\n\n_⚠️ \`${call.toolName}\` requires approval — denied in chat. Open the **manox sidebar** and re-run there to approve interactively._`,
		);
		return;
	}
	if (call.method === 'planVerdict' || call.method === 'askUserQuestion') {
		host.connection.sendRaw({
			kind: 'reply',
			id,
			outcome: { Err: { code: -1, message: 'no interactive surface in chat; use the manox sidebar', data: null } },
		});
		stream.markdown('\n\n_⚠️ This needs interactive input — open the **manox sidebar**._');
		return;
	}
	host.connection.sendRaw({
		kind: 'reply',
		id,
		outcome: { Err: { code: -1, message: `unsupported in chat: ${call.method}`, data: null } },
	});
}

/**
 * Project the session's transcript onto the chat stream: assistant text
 * streams as markdown deltas, thinking and tool activity as progress, and
 * terminal journal edges (turnFinish / stop / error) resolve the turn. The
 * emitted-prefix bookkeeping keeps delta emission monotonic across store
 * rebuilds (the fold replaces streamed drafts with authoritative rows).
 */
function projectOntoChat(
	handle: SessionHandle,
	stream: vscode.ChatResponseStream,
	finish: TurnTracker,
): void {
	const emitted = new Map<string, number>();
	const toolSeen = new Set<string>();
	handle.onChange(() => {
		for (const item of handle.store.transcript) {
			if (item.kind === 'assistant') {
				const prior = emitted.get(item.id) ?? 0;
				if (item.text.length > prior) {
					stream.markdown(item.text.slice(prior));
					emitted.set(item.id, item.text.length);
				}
			} else if (item.kind === 'thinking' && item.text.trim()) {
				stream.progress(item.text.trim().slice(-120));
			} else if (item.kind === 'tool' && !toolSeen.has(item.tool.id)) {
				toolSeen.add(item.tool.id);
				stream.progress(`🔧 ${item.tool.title || item.tool.name} …`);
			}
		}
		const side = handle.store.side;
		if (side.threadError) stream.markdown(`\n**Error:** ${side.threadError}`);
		if (side.turnFinished || side.stop || side.threadError) finish.resolve();
		finish.notifyActivity();
	});
}

interface TurnTracker {
	notifyActivity: () => void;
	resolve: () => void;
	done(): Promise<void>;
}

/** Turn-completion tracker: resolves when the journal reports a terminal
 * edge (via `resolve`), with quiet + hard timeouts as guards so a stuck or
 * command-only turn cannot pin the chat request forever. */
function trackTurnEnd(): TurnTracker {
	let settled = false;
	let resolveDone!: () => void;
	const donePromise = new Promise<void>((resolve) => (resolveDone = resolve));
	const resolve = (): void => {
		if (!settled) {
			settled = true;
			if (quietTimer !== null) clearTimeout(quietTimer);
			resolveDone();
		}
	};
	let quietTimer: ReturnType<typeof setTimeout> | null = null;
	const armQuiet = (): void => {
		if (quietTimer !== null) clearTimeout(quietTimer);
		quietTimer = setTimeout(resolve, QUIET_TIMEOUT_MS);
	};
	return {
		notifyActivity: armQuiet,
		resolve,
		done: () => {
			armQuiet();
			setTimeout(resolve, TURN_TIMEOUT_MS);
			return donePromise;
		},
	};
}

