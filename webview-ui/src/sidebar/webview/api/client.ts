// Typed bridge to the host relay. The webview speaks the AHP protocol
// through the host's single connection: outbound, `req` (protocol commands)
// and `dispatch` (write-ahead action writes); inbound, `snapshot` (fold
// seeds) / `event` (action envelopes + catalogue deltas) / `res` (command
// replies keyed by the relay request id).
//
// The correlation ids (`webui-*`) live HERE, one hop above the relay — the
// relay's own `req.id` namespace — so a reply can only ever settle the
// request that minted it. Unknown relay messages drop with a log (L12).

import type { ConversationInfo, ImageAttachment, RelayToWebview } from '../../../protocol';
import type { ToWebview } from '../../messages';
import { getBootFacts } from './host-facts';
import type { Bridge } from './bridge';
import { createVscodeBridge, isVscodeHost } from './vscode-bridge';
import type { StoreEffects } from '../state/store';

// Pick the host transport at runtime: VS Code injects acquireVsCodeApi as a
// global. (The browser host that shared this bundle in the v2 era was
// retired with the v2 WS gateway; a future browser surface would plug in
// here over the SDK's WebSocketTransport.) Lazy so tests can inject a
// recorded bridge before the first post; outside VS Code the default is a
// silent null bridge (the webview renders, nothing reaches a host).
let bridgeInstance: Bridge | null = null;
let bridgeOverride: Bridge | null = null;

/** Test seam: install a bridge before any api call (the inbound pump
 * re-attaches, so replies sent through the fake reach the pending table). */
export function setBridge(installed: Bridge): void {
	bridgeOverride = installed;
	installed.onMessage(pump);
}

function bridge(): Bridge {
	if (bridgeOverride) return bridgeOverride;
	if (!bridgeInstance) {
		bridgeInstance = isVscodeHost() ? createVscodeBridge() : nullBridge();
	}
	return bridgeInstance;
}

function nullBridge(): Bridge {
	return {
		post: () => undefined,
		onMessage: () => () => undefined,
	};
}

const navigatorListeners = new Set<() => void>();

/** The store surface the api layer drives (structurally typed so tests can
 * inject fakes). */
interface StoreSink {
	relay(msg: RelayToWebview): void;
	conversationInfo(sessionUri: string): ConversationInfo | null;
	setClientModelRef(sessionUri: string, modelRef: string): void;
	modelsReady(): boolean;
	openRemote(sessionUri: string): void;
	confirmDraft(localId: string, serverId: string): void;
	attachEffects(effects: StoreEffects): void;
	addCodeChain(sessionUri: string, card: { chainId: string; title: string; nodeCount: number }): void;
	setChatUri(sessionUri: string, chatUri: string | null): void;
	chatUriOf(sessionUri: string): string | null;
	whenChatReady(sessionUri: string, timeoutMs?: number): Promise<string>;
	echoUser(sessionUri: string, text: string, images?: UserImageLike[], opts?: EchoOptions): void;
}
export interface UserImageLike {
	mimeType: string;
	data: string | null;
	byteLen: number | null;
}
export interface EchoOptions {
	queued?: boolean;
	/** The client-minted turn id the submission dispatches (echo retirement
	 * key — the folded turn carrying the same id retires the echo). */
	originRpc?: string;
	steerPendingId?: string;
}
let storeSink: StoreSink | null = null;

// ── per-`req.id` pending-request table ─────────────────────────────────────
interface Pending {
	resolve(value: Record<string, unknown> | null): void;
	reject(reason: string): void;
}
const pending = new Map<string, Pending>();

/** A protocol command through the relay. */
function request(method: string, params?: unknown): Promise<Record<string, unknown> | null> {
	return new Promise((resolve, reject) => {
		const id = nextId();
		pending.set(id, { resolve, reject });
		bridge().post({ t: 'req', id, method, params });
	});
}

/** A write-ahead action dispatch through the relay (fire-and-forget; a
 * refusal surfaces as the echoed envelope's `rejectionReason` in the fold). */
function dispatch(channel: string, action: unknown): void {
	bridge().post({ t: 'dispatch', channel, action });
}

/** The inbound pump — named so a test-injected bridge re-attaches it. */
function pump(message: ToWebview): void {
	// Host UI notes never reach the agent wire.
	if (message.t === 'verb' && message.kind === 'open_turn_navigator') {
		for (const listener of navigatorListeners) listener();
		return;
	}
	if (message.t === 'verb' && message.kind === 'new_session') {
		// Host command (manox.newSession / title-bar button): start the same
		// draft flow the home composer uses.
		void api.newSession({});
		return;
	}
	if (message.t === 'verb' && message.kind === 'code_chain') {
		// A Code Tutor chain succeeded out-of-band (§7): park its journal card
		// on the owning session. The note carries the identity the panel
		// reopen needs; the chain DATA lives host-side (workspaceState).
		storeSink?.addCodeChain(message.sessionId, {
			chainId: message.chainId,
			title: message.title,
			nodeCount: message.nodeCount,
		});
		return;
	}
	if (message.t === 'res') {
		const handler = pending.get(message.id);
		if (!handler) return; // orphan: already settled or never sent
		pending.delete(message.id);
		if (message.ok) handler.resolve((message.result ?? {}) as Record<string, unknown>);
		else handler.reject(message.error ?? 'relay request failed');
		return;
	}
	if (message.t === 'snapshot' || message.t === 'event' || message.t === 'fatal') {
		storeSink?.relay(message);
		return;
	}
	// boot/config/pong — consumed by the bridge/host-facts/watchdog.
}

// Attach the pump to the real bridge at load; `setBridge` re-attaches it.
bridge().onMessage(pump);

/** §E.3 metrics read seam: the aggregate streams as the metrics bag's
 * `sessionInfo` (channel state), so the "pull" reads the store's fold. The
 * plugin still refreshes on committed-message edges (the same refresh-edge
 * signal as v2), it just no longer round-trips the wire. */
export async function getConversationInfo(
	sessionId: string,
): Promise<ConversationInfo | null> {
	return storeSink?.conversationInfo(sessionId) ?? null;
}

/** Subscribe to host-requested turn-navigator toggles (macOS cmd+m, where
 * the OS minimize accelerator would swallow the key before the DOM). */
export function onOpenTurnNavigator(listener: () => void): () => void {
	navigatorListeners.add(listener);
	return () => navigatorListeners.delete(listener);
}

/** Wire the store: install the transport effects seam (the api layer owns
 * the outbound calls the store makes — `view` / `fetchTurns`) and become the
 * relay sink. The §E.3 metrics pull lives with its consumer: the
 * conversation-info plugin reads the metrics bag through the store. */
export function connectStore(store: StoreSink): void {
	storeSink = store;
	store.attachEffects({
		view(sessionUri) {
			bridge().post({ t: 'view', sessionUri });
		},
		viewChat(sessionUri, chatUri) {
			bridge().post({ t: 'view', sessionUri, chatUri });
		},
		async fetchTurns(chatUri, cursor): Promise<boolean> {
			try {
				await request('fetchTurns', { channel: chatUri, ...(cursor ? { cursor } : {}) });
				return true;
			} catch {
				return false;
			}
		},
	});
}

let msgSeq = 0;
const nextId = (): string => `webui-${Date.now().toString(36)}-${++msgSeq}`;

/** A fresh id correlating an optimistic echo with the turn that retires it. */
export const mintRpcId = (): string => globalThis.crypto.randomUUID();

/** The AHP session URI a draft session id names (AHP createSession is
 * client-chosen, so the webview mints the URI itself). */
const sessionUriOf = (id: string): string =>
	id.startsWith('ahp-session:/') ? id : `ahp-session:/${id}`;

/** Per-thread command surface; one instance per live session id. */
export class ThreadApi {
	constructor(readonly sessionId: string) {}

	/** The chat channel this session's default turn traffic targets. Waits
	 * for the view round-trip when the edge is not known yet — a first
	 * message can race the session snapshot home (the store queues on the
	 * fold instead of throwing). */
	private chatChannel(): Promise<string> {
		const known = storeSink?.chatUriOf(this.sessionId);
		if (known) return Promise.resolve(known);
		if (!storeSink) return Promise.reject(new Error('manox: store not connected'));
		return storeSink.whenChatReady(this.sessionId);
	}

	/** Submit a user message: a write-ahead `chat/turnStarted` dispatch. The
	 * caller's `originRpc` doubles as the client-minted turn id, so the
	 * optimistic echo retires exactly when the folded turn lands. */
	async submit(
		text: string,
		images?: ImageAttachment[],
		originRpc?: string,
	): Promise<Record<string, unknown> | null> {
		const turnId = originRpc ?? mintRpcId();
		dispatch(await this.chatChannel(), {
			type: 'chat/turnStarted',
			turnId,
			startedAt: new Date().toISOString(),
			message: {
				text,
				origin: { kind: 'user' },
				...(images?.length
					? {
							attachments: images.map((image) => ({
								type: 'embeddedResource',
								data: image.data,
								contentType: image.mimeType,
							})),
						}
					: {}),
			},
		});
		return { accepted: true, turnId };
	}

	/** Turn the queued message identified by `originRpc` into a steer of the
	 * running turn. */
	async steer(originRpc: string, text: string, images?: ImageAttachment[]): Promise<void> {
		const turnId = originRpc ?? mintRpcId();
		dispatch(await this.chatChannel(), {
			type: 'chat/pendingMessageSet',
			message: {
				text,
				origin: { kind: 'user' },
				...(images?.length
					? {
							attachments: images.map((image) => ({
								type: 'embeddedResource',
								data: image.data,
								contentType: image.mimeType,
							})),
						}
					: {}),
			},
			role: 'steering',
		});
		void turnId;
	}

	/** Drop a queued message (its echo bubble is removed locally too). */
	dropQueued(clientId: string): void {
		storeSink?.echoUser(this.sessionId, '', undefined, {});
		void clientId; // queued messages fold through pendingMessageRemoved
	}

	/** Confirm (approve/deny) a tool call awaiting confirmation. `callId` is
	 * the folded toolCall id (cards are fold-derived; there is no MsgId any
	 * more). */
	approve(callId: string, allow: boolean): void {
		void this.chatChannel().then((chatUri) =>
			dispatch(chatUri, {
			type: 'chat/toolCallConfirmed',
			toolCallId: callId,
				...(allow ? { approved: true, confirmed: 'user-action' } : { approved: false, reason: 'denied' }),
			}),
		).catch((e) => console.warn('manox webview: approve failed:', (e as Error).message));
	}

	/** Resolve an ask-question card: one id-routed tri-state row per parked
	 * question — selection(s), free text (`custom`), or skip (empty
	 * `selected`, no `custom`). */
	answerQuestion(callId: string, answers: Array<{ id: string; selected: string[]; custom?: string }>): void {
		const keyed: Record<string, unknown> = {};
		for (const row of answers) {
			keyed[row.id] =
				row.selected.length > 0 || row.custom
					? {
							state: 'submitted',
							value: row.selected.length > 1
								? { kind: 'selectedMany', value: row.selected }
								: row.custom
									? { kind: 'text', value: row.custom }
									: { kind: 'selected', value: row.selected[0] },
						}
					: { state: 'skipped' };
		}
		void this.chatChannel().then((chatUri) =>
			dispatch(chatUri, {
				type: 'chat/inputCompleted',
				requestId: callId,
				response: 'accept',
				answers: keyed,
			}),
		).catch((e) => console.warn('manox webview: answer failed:', (e as Error).message));
	}

	/** Withdraw an ask-question card: a declined completion cancels the
	 * request (the host converges through its decline path). */
	cancelAsk(callId: string): void {
		void this.chatChannel().then((chatUri) =>
			dispatch(chatUri, {
				type: 'chat/inputCompleted',
				requestId: callId,
				response: 'cancel',
			}),
		).catch((e) => console.warn('manox webview: cancelAsk failed:', (e as Error).message));
	}

	cancel(): void {
		void this.chatChannel().then((chatUri) =>
			dispatch(chatUri, { type: 'chat/turnCancelled' }),
		).catch((e) => console.warn('manox webview: cancel failed:', (e as Error).message));
	}

	/** §D.3 / L8: the picker sends the canonical `{provider}/{model}` ref.
	 * Session config rides the SESSION channel — no chat dependency. */
	setModel(ref: string): void {
		dispatch(sessionUriOf(this.sessionId), {
			type: 'session/configChanged',
			config: { model: ref },
		});
	}

	setReasoningEffort(effort: string): void {
		dispatch(sessionUriOf(this.sessionId), {
			type: 'session/configChanged',
			config: { reasoningEffort: effort },
		});
	}

	setApprovalMode(mode: string): void {
		dispatch(sessionUriOf(this.sessionId), {
			type: 'session/configChanged',
			config: { approvalMode: mode },
		});
	}

	setPlanMode(enabled: boolean): void {
		const chatUri = storeSink?.chatUriOf(this.sessionId);
		if (!chatUri) return;
		dispatch(`x-manox-plan:/${chatUri.slice('ahp-chat:/'.length)}`, {
			type: 'x-manox-plan/planModeChanged',
			enabled,
		});
	}

	/** Resolve a plan-review card through the elicitation path: the host
	 * settles a `plan-review:` request by scanning the answer rows for
	 * "approve" (approve seeds plan execution; any other answer is the
	 * refine path). */
	planVerdict(callId: string, choice: 'execute_keep' | 'execute_compact' | 'refine'): void {
		const approved = choice !== 'refine';
		void this.chatChannel().then((chatUri) =>
			dispatch(chatUri, {
				type: 'chat/inputCompleted',
				requestId: callId,
				response: approved ? 'accept' : 'decline',
				answers: approved
					? {
							verdict: { state: 'submitted', value: { kind: 'selected', value: choice === 'execute_keep' ? 'approve' : 'approve-compact' } },
						}
					: { verdict: { state: 'skipped' } },
			}),
		).catch((e) => console.warn('manox webview: verdict failed:', (e as Error).message));
	}

	/** Execute-fresh: archive this session and seed a new one with the plan
	 * (the planExecute command rides the archive edge host-side). */
	planExecuteFresh(planFile: string, cwd: string): void {
		void api
			.newSession({
				cwd: cwd || undefined,
				planFile,
			})
			.catch(() => undefined);
	}

	goal(action: string, objective?: string, budget?: number): void {
		void request('x-manox/goal', {
			channel: sessionUriOf(this.sessionId),
			action,
			...(objective !== undefined ? { objective } : {}),
			...(budget !== undefined ? { budget } : {}),
		}).catch(() => undefined);
	}

	stopBackgroundTask(taskId: string): void {
		// The x-manox v5 surface has no client stop dispatch (the stop signal
		// reaches clients through `backgroundTasksChanged` status). Logged
		// fail-closed — see README limitations.
		bridge().post({
			t: 'log',
			level: 'warn',
			message: `stopBackgroundTask(${taskId}): no client stop dispatch on the AHP surface`,
		});
	}

}

/** Global command surface (registry refreshes, session lifecycle). */
export const api = {
	/** Ask the host to re-push the folded state (the models-settle planner's
	 * refresh; post-restart resync). */
	refresh(): void {
		bridge().post({ t: 'refresh' });
	},
	requestModels(): void {
		// The model catalogue streams as root state (agents[]); the planner's
		// re-issue maps to a refresh ask.
		this.refresh();
	},
	/** Create a session (client-chosen AHP URI) and open its chat. The
	 * `originRpc`-tagged echo was already parked by the composer's
	 * `draftThread`; the first message rides `ThreadApi.submit` with the SAME
	 * id, so the echo retires when the folded turn lands. */
	async newSession(opts: {
		/** Client-minted draft id (the caller drafted the thread locally). */
		localId?: string;
		text?: string;
		images?: ImageAttachment[];
		/** Canonical `{provider}/{modelId}` (L8). */
		modelRef?: string | null;
		cwd?: string | null;
		originRpc?: string;
		planFile?: string;
		}): Promise<string | null> {
		const facts = getBootFacts();
		const localId = opts.localId ?? globalThis.crypto.randomUUID();
		const sessionUri = sessionUriOf(localId);
		const config: Record<string, unknown> = {};
		if (opts.modelRef) config.model = opts.modelRef;
		if (facts.approvalMode) config.approvalMode = facts.approvalMode;
		try {
			await request('createSession', {
				channel: sessionUri,
				...(opts.cwd || facts.cwd ? { workingDirectories: [`file://${opts.cwd ?? facts.cwd}`] } : {}),
			});
		} catch {
			// The store drops the draft when the summary never lands; surface
			// nothing beyond the composer's own error path.
			return null;
		}
		// The host IGNORES `createSession.params.config` (probe-verified:
		// router takes only the channel; the SessionIntent carries no model/
		// approval) — the sanctioned config write is the `session/configChanged`
		// dispatch, applied by the runtime's acceptance arm. It must land
		// BEFORE the first turn for the model choice to bind — and after the
		// provider registry has settled, or the write is refused with
		// `unknown model` (a cold registry, not a bad ref).
		if (Object.keys(config).length > 0) {
			void (async () => {
				const deadline = Date.now() + 30_000;
				while (storeSink && !storeSink.modelsReady() && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				if (opts.modelRef) storeSink?.setClientModelRef(sessionUri, opts.modelRef);
				dispatch(sessionUri, { type: 'session/configChanged', config });
			})();
		}
		storeSink?.confirmDraft(localId, sessionUri);
		storeSink?.openRemote(sessionUri);
		if (opts.text || opts.images?.length) {
			await new ThreadApi(sessionUri).submit(opts.text ?? '', opts.images ?? [], opts.originRpc);
		}
		if (opts.planFile) {
			void request('x-manox/planExecute', {
				channel: sessionUri,
				planFile: opts.planFile,
			}).catch(() => undefined);
		}
		return sessionUri;
	},
	listThreads(): void {
		this.refresh();
	},
	listCommands(): void {
		this.refresh();
	},
	archiveThread(sessionId: string, archived: boolean): void {
		dispatch(sessionUriOf(sessionId), { type: 'session/isArchivedChanged', archived });
	},
	pinThread(sessionId: string, pinned: boolean): void {
		const chatUri = storeSink?.chatUriOf(sessionId);
		// Pin lives on the thread bag; the channel keys by session.
		void chatUri;
		dispatch(`x-manox-thread:/${sessionUriOf(sessionId).slice('ahp-session:/'.length)}`, {
			type: 'x-manox/pinnedChanged',
			pinned,
		});
	},
	openThread(sessionId: string): void {
		// Switch the view optimistically; the relayed snapshots confirm it.
		storeSink?.openRemote(sessionUriOf(sessionId));
	},
	/** Reopen a stored chain in the editor-area panel (§7): a code-chain
	 * card / header-chip click. The chain DATA lives host-side
	 * (workspaceState), so this is an out-of-band `openCodeChain` ask. */
	openCodeChain(chainId: string): void {
		bridge().post({ t: 'openCodeChain', chainId });
	},
};
