// ManoxClient — the extension's single AHP client over the napi bridge
// (manox v0.3.0). Replaces the v2 AgentConnection/JournalStream/SessionStore
// stack: AHP is one connection with one `initialize`, so there is exactly one
// client here and it owns all correlation. Consumers (participant, sidebar,
// Code Tutor) read the folded state and dispatch actions through this class;
// the sidebar relays raw events to the webview, which folds the SAME
// envelopes through the SAME SDK reducers (one fold path, no second mirror).
//
// State layout:
//   * root/session/terminal/changeset  — SDK `AhpStateMirror` (generated
//     reducers; the host and this client run the same code).
//   * `ahp-chat:/` channels            — `chatReducer` (the mirror has no
//     chat slot; the fold here is the same reducer the host runs).
//   * `x-manox-*` channels             — `ExtBag` twin (`src/protocol/xmanox.ts`)
//     plus the workspaces/commands catalogues; baselines arrive as
//     `x-manox/baseline` action envelopes, deltas as ordinary envelopes.
//
// Unknown vocabulary drops with a log line (L12): an unrecognized action is
// left to the reducers' own Unknown arms (no-ops) and never disconnects.

import { randomUUID } from 'node:crypto';
import type {
	ActionEnvelope,
	ChatState,
	InitializeResult,
	SessionSummary,
	ToolDefinition,
	URI,
} from '@microsoft/agent-host-protocol';
import { chatReducer } from '@microsoft/agent-host-protocol';
import {
	AhpClient,
	AhpStateMirror,
	type AhpTransport,
	type SubscriptionEvent,
} from '@microsoft/agent-host-protocol/client';
import { NapiAhpTransport } from '../transport/ahpTransport';
import type { NapiTransport } from '../transport/napiTransport';
import {
	EXT_ACTIONS,
	EXT_CHANNELS,
	EXT_COMMANDS,
	EXT_META_KEY,
	applyExtAction,
	applyExtBaseline,
	applyWorkspaceAction,
	emptyExtBag,
	emptyWorkspaceCatalogue,
	extInitializeMeta,
	type ExtBag,
	type WorkspaceCatalogue,
} from '../protocol/xmanox';

/** AHP protocol version this client offers; the host negotiates. */
const PROTOCOL_VERSIONS = ['1.0.0', '0.9.0'] as const;

/** Channels subscribed during the handshake: the registry root plus the two
 * connection-level extension catalogues. Per-session/chat channels subscribe
 * on demand (`view`). */
const INITIAL_SUBSCRIPTIONS: URI[] = ['ahp-root://', EXT_CHANNELS.workspaces, EXT_CHANNELS.commands];

/** A sidebar-list row: the root summary plus this thread's extension bag
 * (pin/label/leaf live there, not in AHP state). */
export interface SessionRow {
	readonly uri: URI;
	summary: SessionSummary;
	bag: ExtBag;
}

/** Everything fanned out to the sidebar relay (and tests): the raw
 * protocol events the webview folds itself. */
export type RelayEvent =
	| { readonly type: 'action'; readonly envelope: ActionEnvelope }
	| { readonly type: 'sessionAdded'; readonly summary: SessionSummary }
	| { readonly type: 'sessionRemoved'; readonly session: URI }
	| { readonly type: 'sessionSummaryChanged'; readonly session: URI; readonly changes: Partial<SessionSummary> };

/** A chat's folded view: protocol chat state plus the per-channel extension
 * bags the UI reads (plan review, metrics…). */
export interface ChatView {
	readonly chatUri: URI;
	readonly sessionUri: URI;
	chat: ChatState | undefined;
	plan: ExtBag;
	metrics: ExtBag;
}

/** What a fresh session needs (v2 createSession intent, mapped onto AHP). */
export interface CreateSessionIntent {
	cwd?: string;
	approvalMode?: string;
	model?: string;
	reasoningEffort?: string;
}

export interface ManoxClientOptions {
	readonly clientId: string;
	readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Host → client capability request handlers. `clipboardRead` answers the
 * clipboard TEXT (or null) — the kernel fails closed on non-text; v2's
 * `{data, mimeType}` envelope is gone with the v2 gateway. `invokeTool`
 * answers the `{content, isError}` contract (structured results ride as
 * JSON in `content`). */
export interface HostRequestHandlers {
	clipboardRead(): Promise<string | null>;
	openExternal(url: string): Promise<void>;
	invokeTool(params: {
		clientId: string;
		toolCallId: string;
		name: string;
		input: unknown;
	}): Promise<{ content: string; isError?: boolean }>;
}

export class ManoxClient {
	readonly transport: AhpTransport;
	readonly client: AhpClient;
	private readonly mirror = new AhpStateMirror();
	private readonly chats = new Map<URI, ChatState>();
	/** Chat URI → owning session URI, recorded at view time (chat URIs do not
	 * embed their session; the invokeTool path needs the reverse mapping). */
	private readonly chatSessions = new Map<URI, URI>();
	private readonly bags = new Map<URI, ExtBag>();
	private readonly sessions = new Map<URI, SessionRow>();
	private readonly workspaces: WorkspaceCatalogue = emptyWorkspaceCatalogue();
	private commands: unknown[] = [];
	private initResult: InitializeResult | null = null;

	private readonly eventSubs = new Set<(event: RelayEvent) => void>();
	private readonly changeSubs = new Set<() => void>();
	private readonly subscriptions = new Set<URI>();

	private constructor(
		transport: NapiAhpTransport,
		private readonly options: ManoxClientOptions,
	) {
		this.transport = transport;
		this.client = new AhpClient(transport);
	}

	/**
	 * Bridge the napi transport, run the AHP handshake (declaring the host
	 * requests this extension answers), fold the initial snapshots, and pump
	 * events. Resolves once the control plane is live.
	 */
	static async start(
		napi: NapiTransport,
		handlers: HostRequestHandlers,
		options: ManoxClientOptions,
	): Promise<ManoxClient> {
		const manox = new ManoxClient(NapiAhpTransport.over(napi), options);
		const { client } = manox;
		client.connect();
		client.setServerRequestHandler(((method: string, params: unknown) =>
			manox.answerHostRequest(handlers, method, params)) as never);
		// The SDK's typed `initialize` cannot carry `_meta`; the generic
		// request path passes it through (serde keeps unknown fields, and the
		// host reads `x-manox.serverRequests` from exactly here — router.rs
		// `declared_client_requests`).
		const init = (await manox.request('initialize', {
			channel: 'ahp-root://',
			clientId: options.clientId,
			protocolVersions: [...PROTOCOL_VERSIONS],
			initialSubscriptions: [...INITIAL_SUBSCRIPTIONS],
			_meta: extInitializeMeta(),
		})) as InitializeResult;
		manox.initResult = init;
		for (const uri of INITIAL_SUBSCRIPTIONS) manox.attach(uri);
		for (const snapshot of init.snapshots ?? []) manox.applySnapshot(snapshot);
		manox.hydrateSessionCatalogue();
		options.log?.('info', `AHP initialized: protocol ${init.protocolVersion}, serverSeq ${init.serverSeq}`);
		return manox;
	}

	/**
	 * Pull the pre-existing session catalogue (`listSessions`, paginated).
	 * The root snapshot does NOT carry it, and `root/sessionAdded` only
	 * covers sessions created while connected — without this sweep the
	 * sidebar shows no history at all. Two extra delayed passes cover the
	 * host's async thread-store refresh (an immediate first sweep can
	 * legitimately answer an empty page — probe-verified); every row
	 * upserts AND fans out as a `sessionAdded` relay event, so late-landing
	 * rows still reach the webview no matter when they land.
	 */
	private hydrateSessionCatalogue(): void {
		const sweep = (): Promise<void> => this.sweepCatalogue();
		void sweep().catch((e) => this.options.log?.('warn', `session catalogue sweep failed: ${(e as Error).message}`));
		const retries = [2_000, 6_000];
		for (const delay of retries) {
			setTimeout(() => void sweep().catch((e) => this.options.log?.('warn', `catalogue re-sweep failed: ${(e as Error).message}`)), delay);
		}
	}

	/** One paginated `listSessions` pass: upsert every summary, fan out the
	 * rows that are new to the catalogue. */
	private async sweepCatalogue(): Promise<void> {
		const fresh = await sweepSessionCatalogue(
			this.request.bind(this),
			(summary, isNew) => {
				this.upsertRow(summary);
				if (isNew) this.fanout({ type: 'sessionAdded', summary });
			},
			(uri) => this.sessions.has(uri),
		);
		if (fresh > 0) {
			this.options.log?.('info', `session catalogue: ${fresh} new row(s)`);
			this.changed();
		}
	}

	/** The negotiated protocol version (diagnostics). */
	get protocolVersion(): string | undefined {
		return this.initResult?.protocolVersion;
	}

	/** The host's x-manox declaration version, from the handshake `_meta`. */
	get extVersion(): number | undefined {
		const meta = this.initResult?._meta as Record<string, unknown> | undefined;
		const ext = meta?.[EXT_META_KEY] as { version?: unknown } | undefined;
		return typeof ext?.version === 'number' ? ext.version : undefined;
	}

	// ── folded state reads ──────────────────────────────────────────────────

	/** Root state: agents and their models (`agents[].models`). */
	get root(): { agents: { provider: string; displayName?: string; models: unknown[] }[] } {
		return this.mirror.root as { agents: { provider: string; displayName?: string; models: unknown[] }[] };
	}

	/** Every known session (root catalogue + per-thread extension bags). */
	rows(): SessionRow[] {
		return [...this.sessions.values()];
	}

	/** One session's row, when known. */
	row(sessionUri: URI): SessionRow | undefined {
		return this.sessions.get(sessionUri);
	}

	/** The command catalogue (`x-manox-commands://` baseline). */
	get commandCatalogue(): unknown[] {
		return this.commands;
	}

	/** The workspace catalogue (`x-manox-workspaces://`). */
	get workspaceCatalogue(): WorkspaceCatalogue {
		return this.workspaces;
	}

	/** A chat's folded state. */
	chat(chatUri: URI): ChatState | undefined {
		return this.chats.get(chatUri);
	}

	/** An extension channel's bag (thread/plan/work/metrics…). */
	bag(channelUri: URI): ExtBag {
		return this.bags.get(channelUri) ?? emptyExtBag();
	}

	/** A subscribed session's full folded state. */
	sessionState(sessionUri: URI): ReturnType<AhpStateMirror['getSession']> {
		return this.mirror.getSession(sessionUri);
	}

	/** Run a protocol command on this client's connection (the relay's `req`
	 * face — the webview names the command, the host supplies the wire). */
	requestProtocol(method: string, params: unknown): Promise<unknown> {
		return this.request(method, params);
	}

	/** Dispatch a protocol action from the webview (the relay's `dispatch`
	 * face). Write-ahead: refusals surface as the echoed envelope's
	 * `rejectionReason`, which the fold fans out. */
	dispatchProtocol(channel: URI, action: unknown): void {
		this.client.dispatch(channel, action as never);
	}

	/** Whether this client has subscribed to `uri`. */
	subscribed(uri: URI): boolean {
		return this.subscriptions.has(uri);
	}

	// ── registry operations ─────────────────────────────────────────────────

	/** The model catalogue flattened from the root agents (v2 listModels). */
	models(): { provider: string; id: string; name: string }[] {
		const out: { provider: string; id: string; name: string }[] = [];
		for (const agent of this.root.agents) {
			for (const model of agent.models as { id?: unknown; name?: unknown }[]) {
				if (typeof model.id === 'string') {
					out.push({ provider: agent.provider, id: model.id, name: typeof model.name === 'string' ? model.name : model.id });
				}
			}
		}
		return out;
	}

	/** Create a session (client-minted URI, AHP `createSession`) and return
	 * its chat handle once the host seeds the default chat. */
	async createSession(intent: CreateSessionIntent): Promise<{ sessionUri: URI; chatUri: URI }> {
		const sessionUri = `ahp-session:/${randomUUID()}` as URI;
		const workingDirectories = intent.cwd ? [`file://${intent.cwd}`] : undefined;
		const config: Record<string, unknown> = {};
		if (intent.model) config.model = intent.model;
		if (intent.reasoningEffort) config.reasoningEffort = intent.reasoningEffort;
		if (intent.approvalMode) config.approvalMode = intent.approvalMode;
		await this.request('createSession', {
			channel: sessionUri,
			...(workingDirectories ? { workingDirectories } : {}),
			...(Object.keys(config).length > 0 ? { config } : {}),
		});
		await this.view(sessionUri);
		const state = this.mirror.getSession(sessionUri);
		const chatUri = state?.defaultChat;
		if (!chatUri) throw new Error(`manox: session ${sessionUri} seeded no default chat`);
		return { sessionUri, chatUri };
	}

	/** Dispose a session (AHP `disposeSession`). */
	async disposeSession(sessionUri: URI): Promise<void> {
		await this.request('disposeSession', { channel: sessionUri });
		this.unview(sessionUri);
	}

	// ── viewing (subscriptions) ─────────────────────────────────────────────

	/** Subscribe a session, its default chat, and its extension channels.
	 * Idempotent per channel. Resolves after the snapshot legs land. */
	async view(sessionUri: URI): Promise<void> {
		await this.ensureSubscribed(sessionUri);
		const state = this.mirror.getSession(sessionUri);
		const chatUri = state?.defaultChat;
		if (chatUri) await this.viewChat(sessionUri, chatUri);
		for (const prefix of [EXT_CHANNELS.thread, EXT_CHANNELS.work] as const) {
			const id = sessionUri.slice('ahp-session:/'.length);
			await this.ensureSubscribed(`${prefix}${id}` as URI);
		}
	}

	/** Subscribe one chat explicitly (plus its plan/metrics extension channels)
	 * and record the chat→session edge.
	 *
	 * Materialization: a brand-new session's `defaultChat` is a pointer the
	 * host answers `subscribe` with NotFound until the chat exists, and only
	 * an accepted chat action creates it (probe-verified against the v0.3.0
	 * host; `createChat` refuses with `already exists` while the pointer
	 * stands). A zero draft dispatch is the harmless materializer. */
	async viewChat(sessionUri: URI, chatUri: URI): Promise<void> {
		if (!this.subscriptions.has(chatUri)) {
			this.dispatch(chatUri, { type: 'chat/draftChanged', draft: { text: '', origin: { kind: 'user' } } });
		}
		await this.ensureSubscribed(chatUri);
		this.chatSessions.set(chatUri, sessionUri);
		const id = chatUri.slice('ahp-chat:/'.length);
		for (const prefix of [EXT_CHANNELS.plan, EXT_CHANNELS.metrics] as const) {
			await this.ensureSubscribed(`${prefix}${id}` as URI);
		}
	}

	/** The session a chat belongs to (recorded at view time). */
	sessionOfChat(chatUri: URI): URI | undefined {
		return this.chatSessions.get(chatUri);
	}

	/** Locate the session currently running a client-tool call: scans the
	 * folded chats for the toolCall id. `x-manox/invokeTool` does not carry a
	 * session — the Code Tutor's chain store keys by session, so the request
	 * must be attributed. */
	sessionForToolCall(toolCallId: string): URI | undefined {
		for (const [chatUri, state] of this.chats) {
			const parts = state.activeTurn?.responseParts ?? [];
			for (const part of parts) {
				const record = part as { kind?: unknown; toolCall?: { id?: unknown } };
				if (record?.kind === 'toolCall' && record.toolCall?.id === toolCallId) {
					return this.chatSessions.get(chatUri);
				}
			}
		}
		return undefined;
	}

	/** The folded view of one chat (chat state + plan/metrics bags). */
	chatView(sessionUri: URI, chatUri: URI): ChatView {
		return {
			chatUri,
			sessionUri,
			chat: this.chats.get(chatUri),
			plan: this.bag(`${EXT_CHANNELS.plan}${chatUri.slice('ahp-chat:/'.length)}` as URI),
			metrics: this.bag(`${EXT_CHANNELS.metrics}${chatUri.slice('ahp-chat:/'.length)}` as URI),
		};
	}

	/** Drop a session's subscriptions (dispose path). */
	unview(sessionUri: URI): void {
		const id = sessionUri.slice('ahp-session:/'.length);
		const state = this.mirror.getSession(sessionUri);
		for (const uri of [
			sessionUri,
			...(state?.defaultChat ? [state.defaultChat] : []),
			`${EXT_CHANNELS.thread}${id}`,
			`${EXT_CHANNELS.work}${id}`,
		]) {
			void this.client.unsubscribe(uri as URI);
			this.subscriptions.delete(uri as URI);
		}
	}

	// ── chat operations ─────────────────────────────────────────────────────

	/** Submit a user message: dispatch `chat/turnStarted` with a client-minted
	 * turn id (AHP's write-ahead model — the host echoes the action back as
	 * the folded state). */
	submit(chatUri: URI, text: string): { turnId: string } {
		const turnId = `turn-${randomUUID()}`;
		this.client.dispatch(chatUri, {
			type: 'chat/turnStarted',
			turnId,
			startedAt: new Date().toISOString(),
			message: { text, origin: { kind: 'user' } },
		} as never);
		return { turnId };
	}

	/** Steer the active turn (append to `steeringMessage`). */
	steer(chatUri: URI, text: string): void {
		this.dispatch(chatUri, {
			type: 'chat/pendingMessageSet',
			message: { text, origin: { kind: 'user' } },
			role: 'steering',
		});
	}

	/** Cancel the active turn. */
	cancelTurn(chatUri: URI): void {
		this.dispatch(chatUri, { type: 'chat/turnCancelled' });
	}

	/** Set the composer draft (host-side persistence of the input box). */
	setDraft(chatUri: URI, text: string): void {
		this.dispatch(chatUri, { type: 'chat/draftChanged', draft: { text, origin: { kind: 'user' } } });
	}

	/** Confirm (approve/deny) a tool call awaiting confirmation. */
	confirmToolCall(chatUri: URI, toolCallId: string, approved: boolean): void {
		this.dispatch(chatUri, { type: 'chat/toolCallConfirmed', toolCallId, approved });
	}

	/** Complete a client-executed tool call (the Code Tutor invoke path). */
	completeClientTool(chatUri: URI, toolCallId: string, content: string, isError: boolean): void {
		this.dispatch(chatUri, {
			type: 'chat/toolCallComplete',
			toolCallId,
			result: { content: [{ type: 'text', text: content }], isError },
		});
	}

	/** Decline an elicitation (chat input request) — the participant's
	 * fail-closed answer; the interactive path answers through the sidebar
	 * with `inputCompleted` + keyed answers. */
	declineInput(chatUri: URI, requestId: string): void {
		this.dispatch(chatUri, { type: 'chat/inputCompleted', requestId, response: 'decline' });
	}

	/** Contribute/refresh this client's session tools (AHP-native
	 * `session/activeClientSet`; replaces the v2 registerSessionTools). */
	setActiveClientTools(sessionUri: URI, tools: ToolDefinition[]): void {
		this.dispatch(sessionUri, {
			type: 'session/activeClientSet',
			client: { clientId: this.options.clientId, displayName: 'VS Code', tools },
		});
	}

	// ── session actions (sidebar) ───────────────────────────────────────────

	pinThread(sessionUri: URI, pinned: boolean): void {
		this.dispatch(sessionUri, { type: 'x-manox/pinnedChanged', pinned });
	}

	setTitle(sessionUri: URI, title: string): void {
		this.dispatch(sessionUri, { type: 'session/titleChanged', title });
	}

	setArchived(sessionUri: URI, archived: boolean): void {
		this.dispatch(sessionUri, { type: 'session/isArchivedChanged', archived });
	}

	/** Ask for the open turn's owning process (x-manox/openTurn). */
	async openTurnOwner(sessionUri: URI): Promise<unknown> {
		return this.request(EXT_COMMANDS.openTurn, { channel: sessionUri });
	}

	// ── events ──────────────────────────────────────────────────────────────

	/** Subscribe to every protocol event (the sidebar relay's source). */
	onEvent(handler: (event: RelayEvent) => void): () => void {
		this.eventSubs.add(handler);
		return () => this.eventSubs.delete(handler);
	}

	/** Coarse change notification (any fold mutation). */
	onChange(listener: () => void): () => void {
		this.changeSubs.add(listener);
		return () => this.changeSubs.delete(listener);
	}

	async dispose(): Promise<void> {
		await this.client.shutdown();
		await this.transport.close();
	}

	// ── internals ───────────────────────────────────────────────────────────

	/** Write-ahead action dispatch (fire-and-forget; refusals surface as the
	 * echoed envelope's `rejectionReason`, which the fold fans out). */
	private dispatch(channel: URI, action: unknown): void {
		this.client.dispatch(channel, action as never);
	}

	private attach(uri: URI): void {
		this.subscriptions.add(uri);
		void (async () => {
			const subscription = this.client.attachSubscription(uri);
			for await (const event of subscription) {
				this.applySubscriptionEvent(uri, event);
			}
		})().catch((e) => this.options.log?.('warn', `subscription ${uri} ended: ${(e as Error).message}`));
	}

	/** Subscribe on demand and start pumping. The snapshot rides the
	 * subscribe RESULT — `{snapshot: {resource, state, fromSeq}}` (probe-
	 * verified against the v0.3.0 host) — and is applied here: the mirror
	 * has no other source for on-demand channels. Extension channels answer
	 * no snapshot; their baseline arrives as an action envelope through the
	 * queue. The local registration happens first, so neither is missed.
	 *
	 * NotFound (-32008) retries briefly: a just-materialized chat (the
	 * viewChat materializer) is created ASYNC host-side, so an immediate
	 * subscribe can legitimately race it. */
	private async ensureSubscribed(uri: URI, attempt = 0): Promise<void> {
		if (this.subscriptions.has(uri)) return;
		this.attach(uri);
		this.subscriptions.add(uri);
		try {
			const { result } = await this.client.subscribe(uri);
			const wrapped = result as { snapshot?: { resource?: unknown; state?: unknown } } | null;
			const unwrapped: { resource?: unknown; state?: unknown } | null =
				wrapped?.snapshot ?? (result as { resource?: unknown; state?: unknown } | null);
			if (unwrapped && typeof unwrapped.resource === 'string') {
				this.applySnapshot({ resource: unwrapped.resource, state: unwrapped.state });
			}
		} catch (e) {
			if (isNotFound(e) && attempt < 5) {
				this.subscriptions.delete(uri);
				await new Promise((resolve) => setTimeout(resolve, 120));
				return this.ensureSubscribed(uri, attempt + 1);
			}
			this.subscriptions.delete(uri);
			throw e;
		}
	}

	private applySubscriptionEvent(uri: URI, event: SubscriptionEvent): void {
		switch (event.type) {
			case 'action':
				this.applyEnvelope(event.params);
				return;
			case 'sessionAdded':
				this.upsertRow(event.params.summary);
				this.fanout({ type: 'sessionAdded', summary: event.params.summary });
				break;
			case 'sessionRemoved':
				this.sessions.delete(event.params.session);
				this.fanout({ type: 'sessionRemoved', session: event.params.session });
				break;
			case 'sessionSummaryChanged':
				this.applySummaryChange(event.params.session, event.params.changes);
				this.fanout({
					type: 'sessionSummaryChanged',
					session: event.params.session,
					changes: event.params.changes,
				});
				break;
			case 'authRequired':
				this.options.log?.('warn', `auth required on ${uri}`);
				return;
		}
		this.changed();
	}

	/** Fold one action envelope into the local state and fan it out (the
	 * relay's source — the webview folds the same envelopes). */
	private applyEnvelope(envelope: ActionEnvelope): void {
		const { channel, action } = envelope;
		const record = action as { type?: unknown };
		const type = typeof record?.type === 'string' ? record.type : '';
		this.fanout({ type: 'action', envelope });

		if (channel === EXT_CHANNELS.workspaces) {
			// The catalogue folds from its baseline + deltas (a stateless
			// snapshot channel — no bag).
			if (type === EXT_ACTIONS.baseline) {
				applyWorkspaceAction(this.workspaces, { type: EXT_ACTIONS.workspacesBaseline, state: (action as { state?: unknown }).state });
			} else {
				applyWorkspaceAction(this.workspaces, action);
			}
			this.changed();
			return;
		}
		if (channel === EXT_CHANNELS.commands) {
			// The catalogue is baseline-only (stateless snapshot channel).
			if (type === EXT_ACTIONS.baseline) {
				const state = (action as { state?: unknown }).state;
				const entries = (state as { entries?: unknown; commands?: unknown })?.entries ?? (state as { commands?: unknown })?.commands;
				if (Array.isArray(entries)) this.commands = entries;
				this.changed();
			}
			return;
		}
		if (type === EXT_ACTIONS.baseline) {
			const bag = this.bags.get(channel) ?? emptyExtBag();
			applyExtBaseline(bag, action);
			this.bags.set(channel, bag);
			this.changed();
			return;
		}
		if (type.startsWith('x-manox')) {
			const bag = this.bags.get(channel) ?? emptyExtBag();
			applyExtAction(bag, action);
			this.bags.set(channel, bag);
			this.changed();
			return;
		}
		if (channel.startsWith('ahp-chat:/')) {
			const current = this.chats.get(channel);
			// Reducer-first: the fold IS the state (the host runs the same
			// code), so an action arriving for an unknown chat seeds an empty
			// state rather than being dropped — a snapshot may still be in
			// flight, and reducer arms are total.
			this.chats.set(channel, chatReducer(current ?? emptyChat(channel), action as never));
			this.changed();
			return;
		}
		// root/session/terminal/changeset — the SDK mirror's reducers.
		this.mirror.apply(envelope);
		this.syncRowFromSession(channel);
		this.changed();
	}

	/** Keep the session catalogue rows in step with subscribed session state. */
	private syncRowFromSession(sessionUri: URI): void {
		if (!sessionUri.startsWith('ahp-session:/')) return;
		const state = this.mirror.getSession(sessionUri);
		const row = this.sessions.get(sessionUri);
		if (!state) return;
		if (row) {
			row.summary = { ...row.summary, ...summaryOf(recordOf(state)) };
		} else {
			this.sessions.set(sessionUri, {
				uri: sessionUri,
				summary: summaryOf(recordOf(state)) as SessionSummary,
				bag: this.bags.get(threadBagUri(sessionUri)) ?? emptyExtBag(),
			});
		}
	}

	private upsertRow(summary: SessionSummary): void {
		const uri = summary.resource;
		const existing = this.sessions.get(uri);
		if (existing) {
			existing.summary = summary;
		} else {
			this.sessions.set(uri, { uri, summary, bag: this.bags.get(threadBagUri(uri)) ?? emptyExtBag() });
		}
	}

	private applySummaryChange(uri: URI, changes: Partial<SessionSummary>): void {
		const row = this.sessions.get(uri);
		if (row) row.summary = { ...row.summary, ...changes };
		const state = this.mirror.getSession(uri);
		if (state) Object.assign(state, changes);
	}

	/** Answer a host → client capability request (fail-closed to an error —
	 * the kernel treats every failure shape the same: never invent a reply). */
	private async answerHostRequest(handlers: HostRequestHandlers, method: string, params: unknown): Promise<unknown> {
		const p = (params ?? {}) as Record<string, unknown>;
		switch (method) {
			case 'x-manox/clipboardRead':
				return handlers.clipboardRead();
			case 'x-manox/openExternal': {
				const url = typeof p.url === 'string' ? p.url : '';
				if (!url) throw new Error('x-manox/openExternal needs a url');
				await handlers.openExternal(url);
				return null;
			}
			case 'x-manox/invokeTool': {
				const name = typeof p.name === 'string' ? p.name : '';
				const input = p.input;
				const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : '';
				const clientId = typeof p.clientId === 'string' ? p.clientId : '';
				if (!name || !toolCallId) throw new Error('x-manox/invokeTool needs name and toolCallId');
				return handlers.invokeTool({ clientId, toolCallId, name, input });
			}
			default:
				throw new Error(`no handler for ${method}`);
		}
	}

	private applySnapshot(snapshot: { resource: URI; state: unknown }): void {
		const { resource, state } = snapshot;
		if (resource === 'ahp-root://') {
			this.mirror.applySnapshot({ resource, state } as never);
			return;
		}
		if (resource.startsWith('ahp-session:/') || resource.startsWith('ahp-terminal:/')) {
			this.mirror.applySnapshot({ resource, state } as never);
			this.syncRowFromSession(resource);
			return;
		}
		if (resource.startsWith('ahp-chat:/')) {
			this.chats.set(resource, state as ChatState);
			return;
		}
		if (resource === EXT_CHANNELS.workspaces) {
			const rows = (state as { workspaces?: unknown }).workspaces;
			this.workspaces.workspaces = Array.isArray(rows) ? rows : [];
			this.workspaces.order = (state as { order?: unknown }).order;
			return;
		}
		if (resource === EXT_CHANNELS.commands) {
			const entries = (state as { entries?: unknown; commands?: unknown }).entries ?? (state as { commands?: unknown }).commands;
			this.commands = Array.isArray(entries) ? entries : [];
			return;
		}
		if (resource.startsWith('x-manox')) {
			const bag = this.bags.get(resource) ?? emptyExtBag();
			Object.assign(bag, state);
			this.bags.set(resource, bag);
			return;
		}
		this.options.log?.('warn', `dropping snapshot for unknown channel ${resource}`);
	}

	private fanout(event: RelayEvent): void {
		for (const sub of this.eventSubs) sub(event);
	}

	private changed(): void {
		for (const sub of this.changeSubs) sub();
	}

	/** Generic request with tolerant params (the typed helpers cannot carry
	 * `_meta` or extension commands). */
	private request(method: string, params: unknown): Promise<unknown> {
		const raw = this.client.request as unknown as (m: string, p: unknown) => Promise<unknown>;
		return raw.call(this.client, method, params);
	}
}

/** AHP NotFound (-32008): the channel's backing resource does not exist
 * (yet). */
/** One paginated `listSessions` pass over a generic request face: upserts
 * every summary through `onSummary` (flagging rows the consumer has not
 * seen — `isNew`), returns the fresh count. Exported for the catalogue
 * hydration test. */
export async function sweepSessionCatalogue(
	request: (method: string, params: unknown) => Promise<unknown>,
	onSummary: (summary: SessionSummary, isNew: boolean) => void,
	hasRow: (uri: URI) => boolean,
): Promise<number> {
	let cursor: string | undefined;
	let fresh = 0;
	do {
		const result = (await request('listSessions', {
			channel: 'ahp-root://',
			...(cursor ? { cursor } : {}),
		})) as { items?: SessionSummary[]; nextCursor?: string } | null;
		const items = Array.isArray(result?.items) ? result.items : [];
		for (const summary of items) {
			const isNew = !hasRow(summary.resource);
			if (isNew) fresh += 1;
			onSummary(summary, isNew);
		}
		cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
	} while (cursor);
	return fresh;
}

function isNotFound(e: unknown): boolean {
	const code = (e as { code?: unknown }).code;
	return code === -32008;
}

function threadBagUri(sessionUri: URI): URI {
	return `${EXT_CHANNELS.thread}${sessionUri.slice('ahp-session:/'.length)}` as URI;
}

function emptyChat(resource: URI): ChatState {
	return {
		resource,
		title: '',
		status: 1 as never,
		modifiedAt: new Date().toISOString(),
		turns: [],
	} as ChatState;
}

/** Project a subscribed SessionState onto the catalogue summary fields. */
function summaryOf(state: Record<string, unknown>): Partial<SessionSummary> {
	const keys = ['provider', 'title', 'status', 'activity', 'project', 'workingDirectories', 'modifiedAt'] as const;
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		if (state[key] !== undefined) out[key] = state[key];
	}
	return out as Partial<SessionSummary>;
}

/** A SessionState read as an open record (the summary projection reads a
 * fixed key subset). */
function recordOf(state: object): Record<string, unknown> {
	return state as Record<string, unknown>;
}
