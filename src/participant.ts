// ChatParticipant handler: drives a dedicated agent session per @manox
// request and projects the folded AHP chat state onto the native chat
// stream. The sidebar runs its own sessions over the same host; the two
// never share a turn.
//
// The participant has no interactive approval surface: AHP settles
// authorizations through channel state, so pending confirmations and input
// requests are answered at once — denied/declined with a pointer to the
// sidebar, where cards can be decided interactively (fail-closed, mirroring
// the agent's own default).

import * as vscode from 'vscode';
import type { ChatState } from '@microsoft/agent-host-protocol';
import { AgentHost, configuredApprovalMode, resolveWorkspaceCwd } from './agentHost';
import { codeChainRegisterSession, ensureCodeChain } from './codechain/registration';
import { errorText } from './util';

/** Turns are model-driven and unbounded; the guard exists so a stuck stream
 * cannot pin the chat request forever. */
const TURN_TIMEOUT_MS = 10 * 60_000;
/** A turn that stops producing state changes for this long is over (e.g. a
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

	let manox: Awaited<AgentHost['ready']>;
	let sessionUri = '';
	let chatUri = '';
	try {
		manox = await host.ready;
		// Client-tool contribution rides the code-chain service (§9.2):
		// install it against this host, then contribute to the fresh session
		// before submit so the first turn already assembles the tools.
		ensureCodeChain(context, host);
		const created = await manox.createSession({
			cwd: resolveWorkspaceCwd(),
			approvalMode: configuredApprovalMode(),
		});
		sessionUri = created.sessionUri;
		chatUri = created.chatUri;
		await manox.viewChat(sessionUri, chatUri);
		codeChainRegisterSession(sessionUri);
	} catch (e) {
		stream.markdown(`**Error:** manox core unavailable (${errorText(e)})`);
		return { errorDetails: { message: 'core unavailable' } };
	}

	// Per-turn wiring: project the folded chat state onto the stream, and
	// answer every interactive requirement with the sidebar pointer.
	const finish = trackTurnEnd();
	try {
		const unsubscribe = manox.onChange(() => {
			const state = manox.chat(chatUri);
			if (!state) return;
			projectChatState(state, stream, finish);
			denyInteractiveRequests(manox, chatUri, state, stream);
		});

		disposeOnCancel(token, () => {
			manox.cancelTurn(chatUri);
			finish.resolve();
		});

		manox.submit(chatUri, prompt);
		await finish.done();
		return { metadata: { participant: 'manox' } };
	} catch (e) {
		stream.markdown(`\n**Error:** ${errorText(e)}`);
		return { errorDetails: { message: errorText(e) } };
	} finally {
		finish.dispose();
		if (sessionUri) void manox.disposeSession(sessionUri).catch(() => {});
	}
}

/** Project the folded chat state onto the chat stream: assistant text streams
 * as markdown deltas, thinking and tool activity as progress. The
 * emitted-prefix bookkeeping keeps delta emission monotonic across fold
 * updates. */
function projectChatState(state: ChatState, stream: vscode.ChatResponseStream, finish: TurnTracker): void {
	const emitted = finish.emitted;
	const toolSeen = finish.toolSeen;
	for (const part of state.activeTurn?.responseParts ?? []) {
		const record = part as {
			kind?: string;
			content?: unknown;
			text?: string;
			id?: string;
			toolCall?: { id?: string; name?: string; title?: string };
		};
		if (record.kind === 'markdown' && typeof record.text === 'string' && record.id) {
			const prior = emitted.get(record.id) ?? 0;
			if (record.text.length > prior) {
				stream.markdown(record.text.slice(prior));
				emitted.set(record.id, record.text.length);
			}
		} else if (record.kind === 'reasoning' && typeof record.content === 'string' && record.content.trim()) {
			stream.progress(record.content.trim().slice(-120));
		} else if (record.kind === 'toolCall' && record.toolCall?.id && !toolSeen.has(record.toolCall.id)) {
			toolSeen.add(record.toolCall.id);
			stream.progress(`🔧 ${record.toolCall.title || record.toolCall.name || 'tool'} …`);
		}
	}
	// Turn completion: the active turn folds away into `turns`.
	const turnDone = state.activeTurn === undefined && state.turns.length > 0;
	const errored = typeof state.status === 'number' && (state.status & 2) !== 0; // SessionStatus.Error
	if (errored) stream.markdown('\n**Error:** the agent reported an error.');
	if (turnDone || errored) finish.resolve();
	finish.notifyActivity();
}

/** The participant's fail-closed policy, statefully: deny pending tool
 * confirmations and decline input requests (questions / plan reviews) with a
 * pointer to the sidebar, each exactly once. */
function denyInteractiveRequests(
	manox: { confirmToolCall(chatUri: string, toolCallId: string, approved: boolean): void; declineInput(chatUri: string, requestId: string): void },
	chatUri: string,
	state: ChatState,
	stream: vscode.ChatResponseStream,
): void {
	for (const part of state.activeTurn?.responseParts ?? []) {
		const record = part as {
			kind?: string;
			toolCall?: { id?: string; status?: string; name?: string };
		};
		if (record.kind === 'toolCall' && record.toolCall?.id && record.toolCall.status === 'pending-confirmation') {
			manox.confirmToolCall(chatUri, record.toolCall.id, false);
			stream.markdown(
				`\n\n_⚠️ \`${record.toolCall.name ?? 'tool'}\` requires approval — denied in chat. Open the **manox sidebar** and re-run there to approve interactively._`,
			);
		}
	}
	// Elicitations (questions, plan reviews) ride the chat's input-request
	// surface; decline with the pointer. The request id arrives from the
	// inputRequest response part (field `request`; `response` carries the
	// settlement once answered).
	for (const part of state.activeTurn?.responseParts ?? []) {
		const record = part as { kind?: string; request?: { id?: string }; response?: string };
		const request = record?.request;
		if (record.kind === 'inputRequest' && request?.id && record.response === undefined) {
			manox.declineInput(chatUri, request.id);
			stream.markdown('\n\n_⚠️ This needs interactive input — open the **manox sidebar**._');
		}
	}
}

function disposeOnCancel(token: vscode.CancellationToken, cancel: () => void): vscode.Disposable {
	return token.onCancellationRequested(cancel);
}

interface TurnTracker {
	/** Delta-emission bookkeeping: response-part id → emitted prefix length. */
	readonly emitted: Map<string, number>;
	/** Tool calls already announced (one progress line each). */
	readonly toolSeen: Set<string>;
	notifyActivity: () => void;
	resolve: () => void;
	done(): Promise<void>;
	dispose(): void;
}

/** Turn-completion tracker: resolves when the fold reports a terminal edge
 * (via `resolve`), with quiet + hard timeouts as guards so a stuck or
 * command-only turn cannot pin the chat request forever. Carries the
 * projection bookkeeping (emitted prefixes, seen tools). */
function trackTurnEnd(): TurnTracker {
	let settled = false;
	let resolveDone!: () => void;
	const donePromise = new Promise<void>((resolve) => (resolveDone = resolve));
	let quietTimer: ReturnType<typeof setTimeout> | null = null;
	let hardTimer: ReturnType<typeof setTimeout> | null = null;
	const clearTimers = (): void => {
		if (quietTimer !== null) clearTimeout(quietTimer);
		if (hardTimer !== null) clearTimeout(hardTimer);
		quietTimer = hardTimer = null;
	};
	const resolve = (): void => {
		if (!settled) {
			settled = true;
			clearTimers();
			resolveDone();
		}
	};
	const tracker: TurnTracker = {
		emitted: new Map<string, number>(),
		toolSeen: new Set<string>(),
		notifyActivity: () => {
			if (quietTimer !== null) clearTimeout(quietTimer);
			quietTimer = setTimeout(resolve, QUIET_TIMEOUT_MS);
		},
		resolve,
		done: () => {
			tracker.notifyActivity();
			hardTimer = setTimeout(resolve, TURN_TIMEOUT_MS);
			return donePromise;
		},
		dispose: clearTimers,
	};
	return tracker;
}
