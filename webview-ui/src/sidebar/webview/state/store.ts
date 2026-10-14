// Multi-thread chat store, AHP edition. One fold path maps the sidebar
// relay's protocol traffic into immutable state:
//
//   snapshots  → per-channel fold seeds (session summaries, chat states,
//                x-manox bags, the root registry, the catalogues)
//   events     → action envelopes folded through the SAME SDK reducers the
//                host runs (`chatReducer` for `ahp-chat:/`, the SDK mirror
//                reducers for session state, the `x-manox` TS twin for the
//                extension channels) + catalogue deltas
//   client-owned → view selection, drafts, echoes, focus/unread
//
// The transcript is a MAPPING, not a second fold: `chatStateToItems` derives
// `TranscriptItem[]` from the folded AHP chat state (turns + response parts +
// input requests), so the webview and the host read one protocol truth with
// no journal-engine twin. Optimistic echoes ride alongside (client-owned,
// keyed by the client-minted turn id) and retire when the folded state
// carries the turn.
//
// Unknown vocabulary drops with a log line (L12): unrecognized actions are
// ignored by the reducers' Unknown arms; unrecognized relay messages are
// dropped at the bridge.

import { chatReducer } from '@microsoft/agent-host-protocol';
import type { AhpChatState, AhpSessionSummary, ApprovalMode, BackgroundTaskSnapshotWire, CommandEntry, ConversationInfo, GoalSnapshotWire, ModelInfo, PlanSnapshotWire, ReasoningEffort, RelayEvent, RelayToWebview, SubagentChildWire, ThreadListItem } from '../../../protocol';
import {
	EXT_ACTIONS,
	EXT_CHANNELS,
	applyExtAction,
	applyExtBaseline,
	applyWorkspaceAction,
	emptyExtBag,
	type ExtBag,
} from '../../../../../src/protocol/xmanox';
import type { TranscriptItem, UserImage, ToolUiStatus } from './transcript';
import { chatStateToItems } from './chatFold';

export type { ToolCallState, ToolUiStatus, TranscriptItem, UserImage } from './transcript';

export interface ThreadState {
	sessionId: string;
	/** The chat fold has landed (session_ready derives from the snapshot —
	 * never from a control note). */
	ready: boolean;
	cwd: string;
	title: string;
	turnActive: boolean;
	planMode: boolean;
	items: TranscriptItem[];
	modelRef: string | null;
	approvalMode: ApprovalMode;
	reasoningEffort: ReasoningEffort;
	branch: string | null;
	plan: PlanSnapshotWire | null;
	goal: GoalSnapshotWire | null;
	pendingAuthIds: string[];
	backgroundTasks: Record<string, BackgroundTaskSnapshotWire>;
	subagents: Array<{
		id: string;
		agent_type: string;
		description: string;
		tool_uses: number;
		latest_activity: string | null;
		status: string;
	}>;
	subagentChildren: Record<string, SubagentChildWire[]>;
	conversationInfo: ConversationInfo | null;
	committed: number;
	loading: boolean;
	error: string | null;
	lastTurnDurationSec: number | null;
}

export interface ChatState {
	view: 'threads' | 'conversation';
	threads: ThreadListItem[];
	activeThreadId: string | null;
	perThread: Record<string, ThreadState>;
	models: ModelInfo[];
	commands: CommandEntry[];
	error: string | null;
	/** Transport generation (`boot` arrivals): drives the reconnect
	 * affordance. */
	connected: number;
}

const initialState: ChatState = {
	view: 'threads',
	threads: [],
	activeThreadId: null,
	perThread: {},
	models: [],
	commands: [],
	error: null,
	connected: 0,
};

const initThread = (sessionId: string): ThreadState => ({
	sessionId,
	ready: false,
	cwd: '',
	title: 'New conversation',
	turnActive: false,
	planMode: false,
	items: [],
	modelRef: null,
	reasoningEffort: 'high',
	approvalMode: 'workspace-write',
	branch: null,
	plan: null,
	goal: null,
	pendingAuthIds: [],
	backgroundTasks: {},
	subagents: [],
	subagentChildren: {},
	conversationInfo: null,
	committed: 0,
	loading: false,
	error: null,
	lastTurnDurationSec: null,
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** SessionStatus bitmask arms (AHP const enum; read tolerantly). */
const STATUS = { Error: 2, InProgress: 8, InputNeeded: 24, IsArchived: 64 } as const;
const hasStatus = (status: unknown, bit: number): boolean =>
	typeof status === 'number' && (status & bit) !== 0;

/** Client-owned optimistic bubble for a dispatch whose fold has not landed
 * yet. Retired when the folded chat state carries the turn id. */
interface Echo {
	key: string;
	turnId: string;
	text: string;
	images?: UserImage[];
	queued?: boolean;
	timestamp: number;
	modelRef: string | null;
}

/** The effects seam: the store never posts relay messages itself (pure
 * fold); the api client installs the real transport, tests install
 * recorders. */
export interface StoreEffects {
	/** View a session (subscribe its channels) — the relay seeds the fold. */
	view(sessionUri: string): void;
	/** View one chat explicitly. */
	viewChat(sessionUri: string, chatUri: string): void;
	/** Load one older page of turns into the chat fold (`fetchTurns`). */
	fetchTurns(chatUri: string, cursor?: string): Promise<boolean>;
}

/** The session↔chat edge the store tracks (the transcript maps a session's
 * default chat; a session MAY hold several chats — the view follows the
 * default). */
interface SessionEdge {
	sessionUri: string;
	chatUri: string | null;
}

export class Store {
	private state: ChatState = initialState;
	private readonly listeners = new Set<() => void>();

	// ── AHP folds (protocol truth) ────────────────────────────────────────
	private models: ModelInfo[] = [];
	private commands: CommandEntry[] = [];
	private readonly chats = new Map<string, AhpChatState>();
	private readonly bags = new Map<string, ExtBag>();
	private readonly summaries = new Map<string, AhpSessionSummary>();
	private readonly sessionStates = new Map<string, Record<string, unknown>>();
	private readonly edges = new Map<string, SessionEdge>();

	// ── client-owned (never folded from the wire) ──────────────────────────
	private readonly echoes = new Map<string, Echo[]>();
	private echoSeq = 0;
	private readonly creating = new Set<string>();
	private readonly workspaces = { workspaces: [] as unknown[], order: undefined as unknown };
	private effects: StoreEffects = {
		view: () => undefined,
		viewChat: () => undefined,
		fetchTurns: async () => false,
	};

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	get = (): ChatState => this.state;

	/** Install the transport effects (called once by the api client). */
	attachEffects(effects: StoreEffects): void {
		this.effects = effects;
	}

	/** The relay entry: every host → webview protocol message. */
	relay(msg: RelayToWebview): void {
		switch (msg.t) {
			case 'snapshot':
				this.applySnapshot(msg.channel, msg.state);
				return;
			case 'event':
				this.applyEvent(msg.event);
				return;
			case 'fatal':
				this.state = { ...this.state, error: msg.message };
				this.publish();
				return;
			default:
				// boot/config/verb/pong are host UI notes; the api layer (or
				// the bridge) consumed them before the store sees anything.
				return;
		}
	}

	// ── fold: snapshots ────────────────────────────────────────────────────

	private applySnapshot(channel: string, state: unknown): void {
		if (channel === 'ahp-root://') {
			const agents = isRecord(state) && Array.isArray(state.agents) ? state.agents : [];
			this.models = deriveModels(agents);
			this.publish();
			return;
		}
		if (channel.startsWith('ahp-session:/')) {
			if (isRecord(state)) {
				this.sessionStates.set(channel, state);
				this.upsertSummary(summaryLike(channel, state));
			}
			return;
		}
		if (channel.startsWith('ahp-chat:/')) {
			this.chats.set(channel, state as AhpChatState);
			this.publish();
			return;
		}
		if (channel === EXT_CHANNELS.workspaces) {
			applyWorkspaceAction(this.workspaces, {
				type: EXT_ACTIONS.workspacesBaseline,
				state,
			});
			this.publish();
			return;
		}
		if (channel === EXT_CHANNELS.commands) {
			const entries = isRecord(state)
				? (state.entries ?? state.commands)
				: undefined;
			this.commands = Array.isArray(entries) ? (entries as CommandEntry[]) : [];
			this.publish();
			return;
		}
		if (channel.startsWith('x-manox')) {
			const bag = this.bags.get(channel) ?? emptyExtBag();
			if (isRecord(state)) Object.assign(bag, state);
			this.bags.set(channel, bag);
			this.publish();
			return;
		}
		console.debug('[webui] snapshot for unknown channel dropped', channel);
	}

	// ── fold: events ───────────────────────────────────────────────────────

	private applyEvent(event: RelayEvent): void {
		switch (event.type) {
			case 'sessionAdded':
				this.upsertSummary(event.summary);
				return;
			case 'sessionRemoved':
				this.dropSession(event.session);
				return;
			case 'sessionSummaryChanged':
				this.applySummaryChange(event.session, event.changes);
				return;
			case 'action':
				this.applyEnvelope(event.envelope.channel, event.envelope.action);
				return;
		}
	}

	private applyEnvelope(channel: string, action: unknown): void {
		const type = isRecord(action) && typeof action.type === 'string' ? action.type : '';
		if (type === EXT_ACTIONS.baseline) {
			const bag = this.bags.get(channel) ?? emptyExtBag();
			applyExtBaseline(bag, action);
			this.bags.set(channel, bag);
			this.publish();
			return;
		}
		if (channel === EXT_CHANNELS.workspaces) {
			applyWorkspaceAction(this.workspaces, action);
			this.publish();
			return;
		}
		if (channel === EXT_CHANNELS.commands) {
			return; // catalogue is baseline-only
		}
		if (type.startsWith('x-manox')) {
			const bag = this.bags.get(channel) ?? emptyExtBag();
			applyExtAction(bag, action);
			this.bags.set(channel, bag);
			this.publish();
			return;
		}
		if (channel.startsWith('ahp-chat:/')) {
			const current = this.chats.get(channel);
			this.chats.set(channel, chatReducer(current ?? emptyChat(channel), action as never));
			this.retireEchoesFor(channel);
			this.publish();
			return;
		}
		if (channel.startsWith('ahp-session:/')) {
			// Session-state actions fold into the local session record (the
			// fields the UI reads: config values, defaultChat, inputNeeded).
			const state = this.sessionStates.get(channel);
			if (state && isRecord(action)) {
				foldSessionAction(channel, state, action);
			}
			this.publish();
			return;
		}
		if (channel === 'ahp-root://') {
			// The registry actions carry the FULL agents array (probe-verified
			// against the v0.3.0 host: provider registration completes async —
			// the initialize snapshot answers `agents: []`, and the populated
			// list arrives as this action seconds later). Fold it in place —
			// a "re-read" through the relay is a no-op: root is subscribed
			// during the handshake, and `ensureSubscribed` early-returns.
			if (type === 'root/agentsChanged' && Array.isArray((action as { agents?: unknown }).agents)) {
				this.models = deriveModels((action as { agents: unknown[] }).agents);
				this.publish();
			}
			return;
		}
		console.debug('[webui] action for unknown channel dropped', channel, type);
	}

	// ── session lifecycle (client → store) ────────────────────────────────

	/** Seed a fresh thread optimistically from the home composer: switch the
	 * view, echo the first message, and remember the id until the created
	 * session's summary lands. `sessionId` is the client-minted session URI
	 * (AHP createSession is client-chosen), so `confirmDraft` is a no-op in
	 * the happy path — kept for API compatibility. */
	draftThread(
		sessionId: string,
		text: string,
		images?: UserImage[],
		opts: { originRpc?: string } = {},
	): void {
		this.creating.add(sessionId);
		this.ensureEdge(sessionId);
		this.patch({
			...this.state,
			view: 'conversation',
			activeThreadId: sessionId,
			perThread: {
				...this.state.perThread,
				[sessionId]: initThread(sessionId),
			},
		});
		if (text || images?.length) this.echoUser(sessionId, text, images, opts);
	}

	/** Rekey a client-minted draft id to the canonical id (a no-op under AHP,
	 * where the createSession URI is client-chosen — kept for the tests). */
	confirmDraft(localId: string, serverId: string): void {
		if (localId === serverId) return;
		const edge = this.edges.get(localId);
		if (!edge) return;
		this.edges.delete(localId);
		this.edges.set(serverId, edge);
		this.creating.delete(localId);
		this.creating.add(serverId);
		const perThread = { ...this.state.perThread };
		const thread = perThread[localId];
		if (thread) {
			perThread[serverId] = { ...thread, sessionId: serverId };
			delete perThread[localId];
		}
		this.patch({
			...this.state,
			perThread,
			activeThreadId:
				this.state.activeThreadId === localId ? serverId : this.state.activeThreadId,
		});
	}

	/** Whether a drafted session is still waiting for the host's summary;
	 * sending must stay blocked until it lands. */
	isCreating(sessionId: string): boolean {
		return this.creating.has(sessionId);
	}

	/** Optimistic echo of a submission; retired when the folded chat carries
	 * the turn (the turnStarted action IS the durable user row under AHP). */
	echoUser(
		sessionId: string,
		text: string,
		images?: UserImage[],
		opts: { queued?: boolean; originRpc?: string; steerPendingId?: string } = {},
	): void {
		const echoes = this.echoes.get(sessionId) ?? [];
		echoes.push({
			key: `echo-${sessionId}-${++this.echoSeq}`,
			turnId: opts.originRpc ?? '',
			text,
			images: images?.length ? images : undefined,
			queued: opts.queued,
			timestamp: Math.round(Date.now() / 1000),
			modelRef: this.chatModelRef(this.chatUriOf(sessionId)),
		});
		this.echoes.set(sessionId, echoes);
		this.publish();
	}

	removeUser(sessionId: string, clientId: string): void {
		const echoes = this.echoes.get(sessionId);
		if (!echoes) return;
		this.echoes.set(
			sessionId,
			echoes.filter((e) => e.key !== clientId && e.turnId !== clientId),
		);
		this.publish();
	}

	markSteerPending(sessionId: string, clientId: string): void {
		this.publish();
		void clientId;
	}

	decideApproval(sessionId: string, id: string): void {
		// Cards derive from the fold now; answering is the dispatch's job.
		// The local echo of the decision arrives with the fold update.
		void sessionId;
		void id;
	}

	respondAsk(sessionId: string, id: string): void {
		void sessionId;
		void id;
	}

	clearPlanReview(sessionId: string): void {
		void sessionId;
	}

	/** Park the journal card for a freshly generated chain (§7). Keyed by
	 * chainId so a replayed host note replaces — never stacks — the card. */
	addCodeChain(
		sessionId: string,
		card: { chainId: string; title: string; nodeCount: number },
	): void {
		const edge = this.ensureEdge(sessionId);
		const chatUri = edge.chatUri;
		if (!chatUri) return;
		const codeChains = this.codeChainCards.get(chatUri) ?? [];
		this.codeChainCards.set(chatUri, [
			...codeChains.filter((c) => c.chainId !== card.chainId),
			card,
		]);
		this.publish();
	}

	private readonly codeChainCards = new Map<string, Array<{ chainId: string; title: string; nodeCount: number }>>();

	/** Switch to a thread: switch the view, mark loading, and view the
	 * session remotely (the relay seeds the fold with snapshots). */
	openRemote(sessionId: string): void {
		this.clearUnreadRow(sessionId);
		const edge = this.ensureEdge(sessionId);
		this.patch({
			...this.state,
			view: 'conversation',
			activeThreadId: sessionId,
			perThread: {
				...this.state.perThread,
				[sessionId]: {
					...(this.state.perThread[sessionId] ?? initThread(sessionId)),
					loading: true,
				},
			},
		});
		this.effects.view(sessionId);
		void sessionId;
		void edge;
	}

	openLocal(sessionId: string): void {
		this.clearUnreadRow(sessionId);
		this.patch({ ...this.state, view: 'conversation', activeThreadId: sessionId });
	}

	backToList(): void {
		// Leaving activeThreadId set would suppress the settle-unread of the
		// thread the user just left — this IS the blur (GW5).
		this.patch({ ...this.state, view: 'threads', activeThreadId: null });
	}

	/** Session ids with live local state (the api re-views these after a
	 * host restart). */
	liveSessionIds(): string[] {
		return [...this.edges.keys()];
	}

	/** Ask the host to re-push the folded state (the models-settle planner's
	 * refresh; also the post-restart resync). */
	refresh(): void {
		// Effect-free here: the api layer posts `{t:'refresh'}`.
	}

	/** The default-chat URI for a session, once known. */
	chatUriOf(sessionUri: string): string | null {
		return this.edges.get(sessionUri)?.chatUri ?? null;
	}

	/** Resolve the session's chat URI, waiting for the view round-trip when
	 * the edge is not known yet (a first message raced ahead of the session
	 * snapshot — the submit must queue on the fold, not throw). Rejects on
	 * the timeout so a dead relay surfaces as a failed send, not a hang. */
	whenChatReady(sessionUri: string, timeoutMs = 15_000): Promise<string> {
		const known = this.chatUriOf(sessionUri);
		if (known) return Promise.resolve(known);
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`manox: session ${sessionUri} has no default chat after ${timeoutMs}ms`));
			}, timeoutMs);
			const unsubscribe = this.subscribe(() => {
				const chatUri = this.chatUriOf(sessionUri);
				if (chatUri) {
					clearTimeout(timer);
					unsubscribe();
					resolve(chatUri);
				}
			});
			// The subscribe callback only fires on PUBLISH; check once more in
			// case the edge landed between the first read and the subscription.
			const immediate = this.chatUriOf(sessionUri);
			if (immediate) {
				clearTimeout(timer);
				unsubscribe();
				resolve(immediate);
			}
		});
	}

	/** Record the chat↔session edge (the api, after viewing). */
	setChatUri(sessionUri: string, chatUri: string | null): void {
		const edge = this.ensureEdge(sessionUri);
		edge.chatUri = chatUri;
		this.publish();
	}

	/** §E.3 read seam for the conversation-info plugin: the metrics
	 * aggregate folded from the `x-manox-metrics:/<chat>` bag. */
	conversationInfo(sessionUri: string): ConversationInfo | null {
		return this.state.perThread[sessionUri]?.conversationInfo ?? null;
	}

	/** §E.3 write seam for the conversation-info plugin: park the folded
	 * payload on the thread state so every subscriber sees it through the
	 * store (never a component-local mirror). */
	setConversationInfo(sessionId: string, info: ConversationInfo | null): void {
		const current = this.state.perThread[sessionId];
		if (!current || current.conversationInfo === info) return;
		this.patch(
			updateThread(this.state, sessionId, (t) => ({ ...t, conversationInfo: info })),
		);
	}

	// ── derivation ─────────────────────────────────────────────────────────

	private ensureEdge(sessionUri: string): SessionEdge {
		let edge = this.edges.get(sessionUri);
		if (!edge) {
			edge = { sessionUri, chatUri: null };
			this.edges.set(sessionUri, edge);
		}
		return edge;
	}

	private upsertSummary(summary: AhpSessionSummary): void {
		// Tolerance: a summary without an identity would poison the fold (a
		// poisoned `undefined` key makes EVERY later derive throw). Drop it.
		if (typeof summary.resource !== 'string' || summary.resource === '') return;
		this.summaries.set(summary.resource, summary);
		const sessionUri = summary.resource;
		const state = this.sessionStates.get(sessionUri);
		const defaultChat =
			(state && typeof state.defaultChat === 'string' && state.defaultChat) ||
			(typeof (summary as { defaultChat?: unknown }).defaultChat === 'string'
				? ((summary as { defaultChat: string }).defaultChat)
				: null);
		const edge = this.ensureEdge(sessionUri);
		if (defaultChat && edge.chatUri !== defaultChat) {
			edge.chatUri = defaultChat;
			this.effects.viewChat(sessionUri, defaultChat);
		}
		this.creating.delete(sessionUri);
		this.publish();
	}

	private applySummaryChange(sessionUri: string, changes: Partial<AhpSessionSummary>): void {
		const summary = this.summaries.get(sessionUri);
		if (summary) this.summaries.set(sessionUri, { ...summary, ...changes });
		const state = this.sessionStates.get(sessionUri);
		if (state) Object.assign(state, changes);
		this.publish();
	}

	private dropSession(sessionUri: string): void {
		this.summaries.delete(sessionUri);
		this.sessionStates.delete(sessionUri);
		const edge = this.edges.get(sessionUri);
		if (edge?.chatUri) {
			this.chats.delete(edge.chatUri);
			this.codeChainCards.delete(edge.chatUri);
		}
		this.echoes.delete(sessionUri);
		this.edges.delete(sessionUri);
		this.creating.delete(sessionUri);
		const perThread = { ...this.state.perThread };
		delete perThread[sessionUri];
		const wasActive = this.state.activeThreadId === sessionUri;
		this.patch({
			...this.state,
			perThread,
			activeThreadId: wasActive ? null : this.state.activeThreadId,
			view: wasActive ? 'threads' : this.state.view,
		});
		// The threads list derives from the summaries — re-derive after the
		// catalogue removal (patch alone keeps the stale rows).
		this.publish();
	}

	/** Retire echoes whose turn has landed in the fold (durable truth). */
	private retireEchoesFor(chatUri: string): void {
		const sessionUri = this.sessionOfChat(chatUri);
		if (!sessionUri) return;
		const echoes = this.echoes.get(sessionUri);
		if (!echoes || echoes.length === 0) return;
		const chat = this.chats.get(chatUri);
		if (!chat) return;
		const landed = (turnId: string): boolean =>
			turnId !== '' &&
			(chat.activeTurn?.id === turnId || chat.turns.some((t) => t.id === turnId));
		const kept = echoes.filter((e) => !landed(e.turnId));
		if (kept.length !== echoes.length) this.echoes.set(sessionUri, kept);
	}

	private sessionOfChat(chatUri: string): string | null {
		for (const [sessionUri, edge] of this.edges) {
			if (edge.chatUri === chatUri) return sessionUri;
		}
		return null;
	}

	private chatModelRef(chatUri: string | null): string | null {
		if (!chatUri) return null;
		const chat = this.chats.get(chatUri);
		const model = chat?.activeTurn?.message.model ?? chat?.draft?.model;
		return model && typeof (model as { id?: unknown }).id === 'string'
			? `${(model as { provider?: string }).provider ?? ''}/${(model as { id: string }).id}`
			: null;
	}

	/** Derive the observable state from the folds (one source). */
	private publish(): void {
		this.state = this.derive(this.state);
		for (const listener of this.listeners) listener();
	}

	private derive(prev: ChatState): ChatState {
		const threads: ThreadListItem[] = [...this.summaries.values()]
			.filter((summary) => typeof summary.resource === 'string')
			.map((summary) => this.toRow(summary))
			.sort((a, b) => b.updated_at - a.updated_at);
		const perThread: Record<string, ThreadState> = {};
		for (const [sessionUri, edge] of this.edges) {
			if (typeof sessionUri !== 'string') continue;
			const summary = this.summaries.get(sessionUri);
			const prevThread = prev.perThread[sessionUri] ?? initThread(sessionUri);
			perThread[sessionUri] = this.deriveThread(sessionUri, edge, summary, prevThread);
		}
		return {
			...prev,
			threads,
			perThread,
			models: this.models,
			commands: this.commands,
		};
	}

	private toRow(summary: AhpSessionSummary): ThreadListItem {
		const sessionUri = summary.resource;
		const bag = this.threadBag(sessionUri);
		const status = (summary as { status?: unknown }).status;
		const meta = (summary as { _meta?: Record<string, unknown> })._meta;
		const dir = Array.isArray(summary.workingDirectories)
			? summary.workingDirectories[0]
			: undefined;
		const planReview = bag.planReview as { type?: string } | null | undefined;
		const tasks = bag.backgroundTasks as Record<string, { status?: unknown }> | undefined;
		return {
			id: sessionUri,
			title: summary.title || 'New conversation',
			updated_at: Math.floor(new Date(summary.modifiedAt).getTime() / 1000) || 0,
			running: hasStatus(status, STATUS.InProgress) && !hasStatus(status, STATUS.InputNeeded),
			unread: false,
			errored: hasStatus(status, STATUS.Error),
			pending_auth: hasStatus(status, STATUS.InputNeeded),
			pending_plan: planReview?.type === EXT_ACTIONS.planVerdictRequested,
			background_work: Object.values(tasks ?? {}).some((t) => t.status === 'Running'),
			model_id: typeof meta?.model === 'string' ? meta.model : '',
			pinned: bag.pinned === true,
			archived: hasStatus(status, STATUS.IsArchived),
			parent_id: null,
			depth: 0,
			...(dir && typeof dir === 'string' ? { project: fileUriToPath(dir) } : {}),
		};
	}

	private deriveThread(
		sessionUri: string,
		edge: SessionEdge,
		summary: AhpSessionSummary | undefined,
		prev: ThreadState,
	): ThreadState {
		const chatUri = edge.chatUri;
		const chat = chatUri ? this.chats.get(chatUri) : undefined;
		const threadBag = this.threadBag(sessionUri);
		const planBag = chatUri ? this.bags.get(`${EXT_CHANNELS.plan}${chatUri.slice('ahp-chat:/'.length)}`) : undefined;
		const metricsBag = chatUri ? this.bags.get(`${EXT_CHANNELS.metrics}${chatUri.slice('ahp-chat:/'.length)}`) : undefined;
		const sessionState = this.sessionStates.get(sessionUri) ?? {};
		const config = isRecord(sessionState.config) ? sessionState.config : {};
		const configValues = isRecord(config.values) ? config.values : config;
		const workBag = this.bags.get(`${EXT_CHANNELS.work}${sessionUri.slice('ahp-session:/'.length)}`);
		const turnActive = chat?.activeTurn !== undefined;
		const items = chat
			? [
					...chatStateToItems(chat, {
						threadBag,
						workBag,
						codeChains: this.codeChainCards.get(chatUri ?? '') ?? [],
					}),
					...(this.echoes.get(sessionUri) ?? []).map(echoItem),
				]
			: (this.echoes.get(sessionUri) ?? []).map(echoItem);
		const plan = asPlan(planBag?.plan) ?? prev.plan;
		const goal = asGoal(workBag?.goal) ?? prev.goal;
		const pending = isRecord(sessionState.inputNeeded) || Array.isArray(sessionState.inputNeeded)
			? (sessionState.inputNeeded as Array<{ chat?: string; kind?: string }>)
			: [];
		const lastTurn = chat?.turns[chat.turns.length - 1];
		let duration: number | null = prev.lastTurnDurationSec;
		if (lastTurn) {
			const endedAt = lastTurnTurnEnd(lastTurn);
			const startedAt = lastTurn.startedAt ?? chat?.modifiedAt;
			if (startedAt) {
				const endedMs = endedAt === null ? Date.now() : new Date(endedAt).getTime();
				duration = Math.max(
					0,
					Math.round((endedMs - new Date(startedAt).getTime()) / 1000),
				);
			}
		}
		return {
			...prev,
			ready: chat !== undefined,
			loading: prev.loading && chat === undefined,
			title: summary?.title || chat?.title || prev.title,
			cwd: firstWorkingDir(sessionState) ?? prev.cwd,
			turnActive,
			planMode: planBag?.planMode === true,
			items,
			modelRef: this.currentModelRef(chat),
			approvalMode: kebabMode(configValues.approvalMode) ?? prev.approvalMode,
			reasoningEffort: (asString(configValues.reasoningEffort) as ReasoningEffort | null) ?? prev.reasoningEffort,
			branch: null,
			plan,
			goal,
			pendingAuthIds: pending.map((p) => String(p.chat ?? p.kind ?? '')),
			backgroundTasks: (workBag?.backgroundTasks ?? {}) as Record<string, BackgroundTaskSnapshotWire>,
			subagents: [],
			subagentChildren: {},
			conversationInfo: asConversationInfo(sessionUri, metricsBag),
			committed: chat?.turns.length ?? prev.committed,
			lastTurnDurationSec: turnActive ? prev.lastTurnDurationSec : (duration ?? prev.lastTurnDurationSec),
			error: chatError(chat) ?? prev.error,
		};
	}

	/** The session's currently selected model as the canonical display ref. */
	private currentModelRef(chat: AhpChatState | undefined): string | null {
		const model = chat?.activeTurn?.message.model ?? chat?.draft?.model;
		if (!model) return null;
		const provider = (model as { provider?: unknown }).provider;
		const id = (model as { id?: unknown }).id;
		return typeof provider === 'string' && typeof id === 'string' ? `${provider}/${id}` : null;
	}

	private threadBag(sessionUri: string): ExtBag {
		return this.bags.get(`${EXT_CHANNELS.thread}${sessionUri.slice('ahp-session:/'.length)}`) ?? emptyExtBag();
	}

	/** §E.2 read seam (hook compatibility): the thread state's per-key slot.
	 * The AHP store keeps values on the folded records; this projects the
	 * handful of keys the composer reads. */
	projection(sessionId: string, key: string): { value: unknown; seq: number } | undefined {
		const thread = this.state.perThread[sessionId];
		if (!thread) return undefined;
		const values: Record<string, unknown> = {
			title: thread.title,
			cwd: thread.cwd,
			running: thread.turnActive,
			plan_mode: thread.planMode,
			permission_mode: thread.approvalMode,
			reasoning_effort: thread.reasoningEffort,
			model: thread.modelRef,
		};
		if (key in values) return Object.freeze({ value: values[key], seq: 0 });
		return undefined;
	}

	/** History paging: one older page into the chat fold. */
	async requestOlder(sessionId: string): Promise<void> {
		const edge = this.edges.get(sessionId);
		if (!edge?.chatUri) return;
		const chat = this.chats.get(edge.chatUri);
		await this.effects.fetchTurns(edge.chatUri, chat?.turnsNextCursor);
	}

	hasMoreHistory(sessionId: string): boolean {
		const edge = this.edges.get(sessionId);
		if (!edge?.chatUri) return false;
		return this.chats.get(edge.chatUri)?.turnsNextCursor !== undefined;
	}

	/** §D.5: focus clears the row's unread flag (selection is client-owned). */
	private clearUnreadRow(sessionId: string): void {
		const idx = this.state.threads.findIndex((r) => r.id === sessionId);
		if (idx < 0 || !this.state.threads[idx]?.unread) return;
		const threads = this.state.threads.slice();
		threads[idx] = { ...threads[idx] as ThreadListItem, unread: false };
		this.patch({ ...this.state, threads });
	}

	private patch(next: ChatState): void {
		if (next === this.state) return;
		this.state = next;
		for (const listener of this.listeners) listener();
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Derive the picker rows from the root registry's `agents[].models`
 * (AHP `SessionModelInfo` → the webview-owned `ModelInfo`). Shared by the
 * root snapshot and the `root/agentsChanged` action — same payload shape. */
function deriveModels(agents: unknown[]): ModelInfo[] {
	return agents.flatMap((agent) => {
		const record = isRecord(agent) ? agent : {};
		const provider = typeof record.provider === 'string' ? record.provider : null;
		const models = Array.isArray(record.models) ? record.models : [];
		return models.flatMap((model) => {
			if (!isRecord(model) || typeof model.id !== 'string' || !provider) return [];
			return [{
				id: model.id,
				name: typeof model.name === 'string' ? model.name : model.id,
				provider,
				// The agent's display name ("BigModel") — the picker groups by
				// it, so the wire variants (BigModel-anthropic/-responses/…)
				// land in ONE submenu with per-row wire badges.
				provider_name: typeof record.displayName === 'string' ? record.displayName : undefined,
				api: '',
				context_window: typeof model.maxContextWindow === 'number' ? model.maxContextWindow : 0,
			}];
		});
	});
}

function emptyChat(resource: string): AhpChatState {
	return {
		resource,
		title: '',
		status: 1,
		modifiedAt: new Date().toISOString(),
		turns: [],
	} as unknown as AhpChatState;
}

function summaryLike(resource: string, state: Record<string, unknown>): AhpSessionSummary {
	// The session STATE snapshot carries no `resource` (it lives on the
	// snapshot envelope; the host wraps `{resource, state}`) — the channel
	// IS the identity. Without this, the summary poisons the fold under an
	// `undefined` key and every later derive throws on it.
	return { resource, ...state } as unknown as AhpSessionSummary;
}

/** Fold one session-channel action into the local session record (the
 * fields the UI reads; a full sessionReducer fold lives in the host's
 * AhpStateMirror — the webview keeps the light record). */
function foldSessionAction(_channel: string, state: Record<string, unknown>, action: Record<string, unknown>): void {
	const type = typeof action.type === 'string' ? action.type : '';
	switch (type) {
		case 'session/titleChanged':
			state.title = action.title;
			return;
		case 'session/configChanged':
			state.config = { ...(isRecord(state.config) ? state.config : {}), values: { ...(isRecord(state.config) && isRecord(state.config.values) ? state.config.values : {}), ...(isRecord(action.config) ? action.config : {}) } };
			return;
		case 'session/isArchivedChanged':
			state.status = Number(state.status ?? 0) ^ Number(action.archived === true ? STATUS.IsArchived : 0);
			return;
		default:
			// Tolerant: the light record does not fold every session action —
			// summaryChanged carries the display columns.
			return;
	}
}

function firstWorkingDir(state: Record<string, unknown>): string | null {
	const dirs = state.workingDirectories;
	if (Array.isArray(dirs) && typeof dirs[0] === 'string') return fileUriToPath(dirs[0]) ?? null;
	return null;
}

export function fileUriToPath(uri: string): string | undefined {
	if (!uri.startsWith('file://')) return typeof uri === 'string' && uri.startsWith('/') ? uri : undefined;
	let path = decodeURIComponent(uri.slice('file://'.length));
	path = path.replace(/^\/(?=[^/])/, '/');
	return path;
}

function kebabMode(mode: unknown): ApprovalMode | null {
	const kebab = (asString(mode) ?? '').replaceAll('_', '-');
	return kebab === 'read-only' || kebab === 'workspace-write' || kebab === 'danger-full-access'
		? kebab
		: null;
}

function asPlan(value: unknown): PlanSnapshotWire | null {
	if (!isRecord(value) || !Array.isArray(value.steps)) return null;
	return value as unknown as PlanSnapshotWire;
}

function asGoal(value: unknown): GoalSnapshotWire | null {
	if (!isRecord(value) || typeof value.objective !== 'string') return null;
	return value as unknown as GoalSnapshotWire;
}

function asConversationInfo(sessionUri: string, metricsBag: ExtBag | undefined): ConversationInfo | null {
	const aggregate = metricsBag?.sessionInfo;
	if (!isRecord(aggregate)) return null;
	return { ...(aggregate as unknown as ConversationInfo), threadId: sessionUri };
}

function chatError(chat: AhpChatState | undefined): string | null {
	if (!chat) return null;
	const parts = chat.activeTurn?.responseParts ?? [];
	for (const part of parts) {
		const record = part as { kind?: string; error?: { message?: unknown } };
		if (record.kind === 'error') {
			const message = isRecord(record.error) ? record.error.message : record.error;
			return asString(message) ?? 'the agent reported an error';
		}
	}
	return null;
}

function lastTurnTurnEnd(turn: unknown): string | null {
	const endedAt = (turn as { endedAt?: unknown } | null)?.endedAt;
	return typeof endedAt === 'string' ? endedAt : null;
}

function echoItem(echo: Echo): TranscriptItem {
	return {
		kind: 'user',
		id: echo.key,
		clientId: echo.key,
		turnId: echo.turnId,
		text: echo.text,
		timestamp: echo.timestamp,
		modelId: echo.modelRef,
		images: echo.images,
		queued: echo.queued,
	};
}

function updateThread(
	state: ChatState,
	sessionId: string,
	f: (t: ThreadState) => ThreadState,
): ChatState {
	const current = state.perThread[sessionId] ?? initThread(sessionId);
	const next = f(current);
	if (next === current && state.perThread[sessionId]) return state;
	return { ...state, perThread: { ...state.perThread, [sessionId]: next } };
}

/** Unused ToolUiStatus import guard (re-exported above). */
export type { ToolUiStatus as _ToolUiStatus };
