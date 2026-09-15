// Webview-side chat application state: thread registry, the active session's
// follow handle, pending ServerCall cards, and composer/settings state.
// Owns its `AgentConnection` over the host relay wire (the `observe` policy:
// this side renders cards and answers through the relay; the host's deny
// default is masked by the `viewing` registration).

import { AgentConnection, type SessionHandle, type Wire } from '../client/connection';
import { parseFromServer } from '../protocol/guards';
import { errorText } from '../util';
import type {
	ApprovalMode,
	AskAnswerRow,
	AskQuestionWire,
	FromClient,
	ModelInfo,
	ServerCall,
	ThreadListItem,
} from '../protocol/types';

/** Webview → host messages (mirror of the host's ToHost). */
export type WebviewToHost =
	| { t: 'frame'; frame: FromClient }
	| { t: 'viewing'; sessionId: string | null }
	| { t: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Host → webview messages (mirror of the host's ToWebview). */
export type HostToWebview =
	| { t: 'frame'; frame: unknown }
	| { t: 'verb'; kind: 'new_session' }
	| { t: 'config'; approvalMode: string }
	| { t: 'boot'; cwd: string; approvalMode: string }
	| { t: 'fatal'; message: string };

/** One pending adjudication card. */
export interface PendingCard {
	id: string;
	call: ServerCall;
}

export type ChatView = 'list' | 'chat';

export interface ChatAppEvents {
	readonly render: () => void;
}

export class ChatApp {
	readonly connection: AgentConnection;
	view: ChatView = 'list';
	threads: ThreadListItem[] = [];
	models: ModelInfo[] = [];
	/** Client-owned unread dots (GW5: raised by SessionStatus, cleared here). */
	readonly unread = new Set<string>();
	cards: PendingCard[] = [];
	fatal: string | null = null;
	/** Workspace cwd pushed by the host at boot (CreateSession intent). */
	cwd = '';
	approvalMode: ApprovalMode = 'workspace-write';
	active: SessionHandle | null = null;

	private readonly events: ChatAppEvents;
	private readonly api: { postMessage(message: WebviewToHost): void };
	private readonly offHostEvent: () => void;
	private readonly offFrame: () => void;
	private offChange: () => void;

	constructor(api: { postMessage(message: WebviewToHost): void }, events: ChatAppEvents) {
		this.api = api;
		this.events = events;

		const wire: Wire = {
			send: (frame) => api.postMessage({ t: 'frame', frame }),
			onFrame: (handler) => {
				const listener = (event: MessageEvent): void => {
					const msg = event.data as HostToWebview | undefined;
					if (!msg || msg.t !== 'frame') return;
					const frame = parseFromServer(msg.frame);
					if (frame !== null) handler(frame);
				};
				window.addEventListener('message', listener);
				return () => window.removeEventListener('message', listener);
			},
		};
		this.connection = new AgentConnection(wire, { idPrefix: 'web', unroutedCalls: 'observe' });

		this.offFrame = this.connection.onFrame((frame) => {
			if (frame.kind === 'request') this.addCard(frame.id, frame.call);
		});
		this.offHostEvent = this.connection.onHostEvent((frame) => {
			const host = frame.host;
			if (host.type === 'threadsUpdated') {
				this.threads = host.threads;
				this.events.render();
			} else if (host.type === 'sessionStatus') {
				this.applyStatus(host);
				this.events.render();
			}
		});
		this.offChange = () => {};
	}

	/** Boot: host pushes cwd/config; pull the registries. */
	boot(msg: HostToWebview & { t: 'boot' }): void {
		this.cwd = msg.cwd;
		this.approvalMode = approvalOf(msg.approvalMode);
		void this.refreshThreads();
		void this.refreshModels();
	}

	async refreshThreads(): Promise<void> {
		try {
			this.threads = await this.connection.listThreads();
			this.events.render();
		} catch (e) {
			this.log('warn', `listThreads failed: ${errorText(e)}`);
		}
	}

	async refreshModels(): Promise<void> {
		try {
			this.models = await this.connection.listModels();
			this.events.render();
		} catch (e) {
			this.log('warn', `listModels failed: ${errorText(e)}`);
		}
	}

	/** Open (or re-own) a thread and follow it. */
	async openThread(sessionId: string): Promise<void> {
		this.closeActive();
		try {
			await this.connection.openSession(sessionId);
		} catch (e) {
			this.log('warn', `openSession failed: ${errorText(e)}`);
			return;
		}
		this.attach(sessionId, this.connection.follow(sessionId));
	}

	/** Create a fresh thread and follow it. */
	async newSession(): Promise<void> {
		this.closeActive();
		let sessionId: string;
		try {
			sessionId = await this.connection.createSession({
				cwd: this.cwd || undefined,
				approvalMode: this.approvalMode,
			});
		} catch (e) {
			this.fatal = errorText(e);
			this.events.render();
			return;
		}
		this.attach(sessionId, this.connection.follow(sessionId));
	}

	private attach(sessionId: string, handle: SessionHandle): void {
		this.active = handle;
		this.view = 'chat';
		this.cards = [];
		this.unread.delete(sessionId);
		this.offChange();
		this.offChange = handle.onChange(() => this.events.render());
		this.api.postMessage({ t: 'viewing', sessionId });
		this.events.render();
	}

	/** Stop following the active session and return to the list view. */
	closeActive(): void {
		if (!this.active) return;
		this.api.postMessage({ t: 'viewing', sessionId: null });
		this.offChange();
		this.active.close();
		this.active = null;
		this.cards = [];
		this.view = 'list';
		this.events.render();
	}

	/** Submit the composer text; optimistic echo rides the originRpc. */
	async submit(text: string): Promise<void> {
		if (!this.active || text.trim() === '') return;
		try {
			await this.connection.submit(this.active.sessionId, text);
		} catch (e) {
			this.log('error', `submit failed: ${errorText(e)}`);
			this.events.render();
		}
	}

	cancelTurn(): void {
		if (this.active) this.connection.send({ method: 'cancelTurn', sessionId: this.active.sessionId });
	}

	setModel(modelRef: string): void {
		if (this.active) this.connection.send({ method: 'setModel', sessionId: this.active.sessionId, id: modelRef });
	}

	setApprovalMode(mode: ApprovalMode): void {
		this.approvalMode = mode;
		if (this.active) this.connection.send({ method: 'setApprovalMode', sessionId: this.active.sessionId, mode });
	}

	setReasoningEffort(effort: string): void {
		if (this.active) this.connection.send({ method: 'setReasoningEffort', sessionId: this.active.sessionId, effort });
	}

	pinThread(sessionId: string, pinned: boolean): void {
		this.connection.send({ method: 'pinThread', sessionId, pinned });
	}

	archiveThread(sessionId: string, archived: boolean): void {
		this.connection.send({ method: 'archiveThread', sessionId, archived });
	}

	// ── adjudication cards ──────────────────────────────────────────────────

	approve(allow: boolean): void {
		const card = this.cards[0];
		if (!card || card.call.method !== 'approve') return;
		this.connection.sendRaw({ kind: 'reply', id: card.id, outcome: { Ok: { allow } } });
		this.dropCard(card.id);
	}

	planVerdict(choice: 'execute_keep' | 'execute_compact' | 'refine'): void {
		const card = this.cards[0];
		if (!card || card.call.method !== 'planVerdict') return;
		this.connection.sendRaw({ kind: 'reply', id: card.id, outcome: { Ok: { choice } } });
		this.dropCard(card.id);
	}

	/** Canonical B2-PR-1 answer: one row per parked question, routed by id;
	 * an untouched question answers as skip (empty selected, no custom). */
	answerQuestion(rows: AskAnswerRow[]): void {
		const card = this.cards[0];
		if (!card || card.call.method !== 'askUserQuestion') return;
		const answered = new Set(rows.map((row) => row.id));
		const full = [
			...rows,
			...this.questionsOf(card)
				.filter((q) => q.id && !answered.has(q.id))
				.map((q) => ({ id: q.id as string, selected: [] as string[] })),
		];
		this.connection.sendRaw({ kind: 'reply', id: card.id, outcome: { Ok: { answers: full } } });
		this.dropCard(card.id);
	}

	/** Parse an askUserQuestion payload (L1 vocabulary; tolerant): every
	 * wire question should carry a minted `id` — one without is unusable for
	 * canonical routing and renders as informational only. */
	questionsOf(card: PendingCard): AskQuestionWire[] {
		if (card.call.method !== 'askUserQuestion') return [];
		const input = card.call.input;
		if (typeof input !== 'object' || input === null) return [];
		const questions = (input as { questions?: unknown }).questions;
		if (!Array.isArray(questions)) return [];
		return questions.filter(
			(q): q is AskQuestionWire =>
				typeof q === 'object' && q !== null && typeof (q as { question?: unknown }).question === 'string',
		);
	}

	private addCard(id: string, call: ServerCall): void {
		if (this.cards.some((c) => c.id === id)) return;
		if (this.active && call.sessionId === this.active.sessionId) {
			this.cards.push({ id, call });
			this.events.render();
		}
	}

	private dropCard(id: string): void {
		this.cards = this.cards.filter((c) => c.id !== id);
		this.events.render();
	}

	/** Fold a SessionStatus delta: unread is client-owned (GW5). */
	private applyStatus(host: {
		sessionId: string;
		running?: boolean;
		errored?: boolean;
		unread?: boolean;
	}): void {
		if (host.unread === true && host.sessionId !== this.active?.sessionId) {
			this.unread.add(host.sessionId);
		}
		if (host.running === true || host.errored === true) this.unread.delete(host.sessionId);
	}

	handleConfig(approvalMode: string): void {
		this.approvalMode = approvalOf(approvalMode);
		this.events.render();
	}

	handleVerb(kind: 'new_session'): void {
		void this.newSession();
	}

	handleFatal(message: string): void {
		this.fatal = message;
		this.events.render();
	}

	log(level: 'info' | 'warn' | 'error', message: string): void {
		this.api.postMessage({ t: 'log', level, message });
	}

	dispose(): void {
		this.offFrame();
		this.offHostEvent();
		this.offChange();
		this.active?.close();
	}
}

const approvalOf = (value: string): ApprovalMode =>
	value === 'read-only' || value === 'danger-full-access' ? value : 'workspace-write';

