// AgentConnection — the v2 client orchestrator over one wire (§F.2/F.1). Owns
// RPC correlation, follow streams (JournalStream + SessionStore per stream),
// the host-event registry fold, and ServerCall routing.
//
// Two consumers share one physical connection with separate instances of this
// class (the napi transport on the host; the sidebar relay into the webview,
// which runs its own instance over postMessage). Cross-consumer safety rules:
//   * response/streamItem frames whose id/streamId this instance did not mint
//     are ignored (the other consumer's traffic);
//   * ServerCall handling is owned by exactly one party per delivery — see
//     `UnroutedCallPolicy`.
//
// The dual-protocol window (GW1): registry pushes arrive as BOTH the legacy
// `ServerNote::{threadsUpdated,models}` and the `Host` frames; both fold into
// the same state idempotently.

import { notification, replyErr, request, streamCancel, streamOpen } from '../protocol/builders';
import { asHostEvent, asServerNote, parseFromServer } from '../protocol/guards';
import type {
	ClientCall,
	ClientNote,
	FromClient,
	FromServer,
	ModelInfo,
	MsgId,
	RpcError,
	ServerCall,
	ThreadListItem,
} from '../protocol/types';
import { SessionStore } from './sessionStore';

/** Byte pipe for protocol frames. Implemented by the napi transport (host)
 * and the webview postMessage bridge (webview). */
export interface Wire {
	send(frame: FromClient): void;
	onFrame(handler: (frame: FromServer) => void): () => void;
}

/** What this connection does with a ServerCall no handler is registered for:
 * the process-owning side denies fail-closed; a relayed consumer (the webview)
 * only observes — the host answers. */
export type UnroutedCallPolicy = 'deny' | 'observe';

export type ServerCallHandler = (call: ServerCall, id: MsgId) => void;

export interface AgentConnectionOptions {
	readonly idPrefix: string;
	/** Unrouted ServerCall policy (default `deny`). */
	readonly unroutedCalls?: UnroutedCallPolicy;
	/** Wire-frame log/drop sink for version-skew diagnostics (guards). */
	readonly onDroppedFrame?: (raw: unknown) => void;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: RpcError) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** A live follow stream + its store. */
export interface SessionHandle {
	readonly sessionId: string;
	readonly store: SessionStore;
	/** Stop following (StreamCancel) and drop routing. */
	close(): void;
	/** Subscribe to store changes (transcript/projections/state). */
	onChange(listener: () => void): () => void;
}

interface FollowRuntime {
	handle: SessionHandle;
	currentStreamId: string;
	closed: boolean;
	maxMessages?: number;
	listeners: Set<() => void>;
}

const CALL_TIMEOUT_MS = 30_000;

export class AgentConnection {
	private readonly wire: Wire;
	private readonly options: AgentConnectionOptions;
	private seq = 0;
	private readonly pending = new Map<MsgId, PendingCall>();
	private readonly follows = new Map<string, FollowRuntime>();
	private readonly callHandlers = new Map<string, ServerCallHandler>();
	private readonly frameSubs = new Set<(frame: FromServer) => void>();
	private readonly hostSubs = new Set<(frame: FromServer & { kind: 'host' }) => void>();
	private readyResolve: (() => void) | null = null;
	private readonly readyPromise: Promise<void>;
	/** §D.5 registry mirror (folded from both envelopes). */
	threads: ThreadListItem[] = [];
	models: ModelInfo[] = [];

	constructor(wire: Wire, options: AgentConnectionOptions) {
		this.wire = wire;
		this.options = options;
		this.readyPromise = new Promise<void>((resolve) => {
			this.readyResolve = resolve;
		});
		wire.onFrame((frame) => this.dispatch(frame));
	}

	/** Resolves when the server's Ready (either envelope) has arrived. */
	get ready(): Promise<void> {
		return this.readyPromise;
	}

	/** Subscribe to every parsed frame (raw relay — the sidebar bridge). */
	onFrame(handler: (frame: FromServer) => void): () => void {
		this.frameSubs.add(handler);
		return () => this.frameSubs.delete(handler);
	}

	/** Subscribe to host-event frames only (registry pushes, status deltas). */
	onHostEvent(handler: (frame: FromServer & { kind: 'host' }) => void): () => void {
		this.hostSubs.add(handler);
		return () => this.hostSubs.delete(handler);
	}

	/** Register/replace the ServerCall handler for a session (null clears). */
	setCallHandler(sessionId: string, handler: ServerCallHandler | null): void {
		if (handler === null) this.callHandlers.delete(sessionId);
		else this.callHandlers.set(sessionId, handler);
	}

	/** Deliver one frame built elsewhere (webview relay path). */
	sendRaw(frame: FromClient): void {
		this.wire.send(frame);
	}

	send(note: ClientNote): void {
		this.wire.send(notification(note));
	}

	/** One ClientCall → its Response payload (rejects with the RpcError). */
	call(call: ClientCall, timeoutMs: number = CALL_TIMEOUT_MS): Promise<unknown> {
		const id = `${this.options.idPrefix}-rpc-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject({ code: -1, message: `manox: request timed out (${call.method})`, data: null });
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.wire.send(request(id, call));
		});
	}

	// ── typed convenience calls ─────────────────────────────────────────────

	async listThreads(): Promise<ThreadListItem[]> {
		const value = await this.call({ method: 'listThreads' });
		return Array.isArray(value) ? (value as ThreadListItem[]) : [];
	}

	async listModels(): Promise<ModelInfo[]> {
		const value = await this.call({ method: 'listModels' });
		return Array.isArray(value) ? (value as ModelInfo[]) : [];
	}

	/** CreateSession (v2 §D.2): resolves with the session id receipt. */
	async createSession(intent: {
		cwd?: string;
		project?: string;
		initialModel?: string;
		approvalMode?: string;
		reasoningEffort?: string;
		workingDirectories?: string[];
	}): Promise<string> {
		const value = await this.call({ method: 'createSession', ...intent });
		const sessionId =
			typeof value === 'object' && value !== null
				? (value as { session_id?: unknown }).session_id
				: undefined;
		if (typeof sessionId !== 'string') {
			throw new Error('manox: createSession receipt carried no session_id');
		}
		return sessionId;
	}

	/** OpenSession (idempotent re-own): resolves when the receipt lands. */
	async openSession(sessionId: string): Promise<void> {
		await this.call({ method: 'openSession', sessionId });
	}

	/** Submit (v2 §D.2): receipt `{accepted, message_id}`. */
	async submit(sessionId: string, text: string, originRpc?: string): Promise<void> {
		await this.call({ method: 'submit', sessionId, text, images: [], originRpc });
	}

	// ── follow streams ──────────────────────────────────────────────────────

	/** Open a follow stream for a session and return its store. Re-follows
	 * (fresh snapshot) on resync/violation per L5. */
	follow(sessionId: string, maxMessages?: number): SessionHandle {
		const runtime: FollowRuntime = {
			handle: null as unknown as FollowRuntime['handle'],
			currentStreamId: '',
			closed: false,
			maxMessages,
			listeners: new Set(),
		};

		const store = new SessionStore(sessionId, {
			changed: () => {
				for (const listener of runtime.listeners) listener();
			},
			violated: () => this.refollow(runtime),
		});

		runtime.handle = {
			sessionId,
			store,
			close: () => {
				if (runtime.closed) return;
				runtime.closed = true;
				const id = runtime.currentStreamId;
				this.follows.delete(id);
				this.wire.send(streamCancel(id));
			},
			onChange: (listener) => {
				runtime.listeners.add(listener);
				return () => runtime.listeners.delete(listener);
			},
		};

		this.openFollow(runtime);
		return runtime.handle;
	}

	// ── frame dispatch ──────────────────────────────────────────────────────

	private dispatch(frame: FromServer): void {
		for (const sub of this.frameSubs) sub(frame);

		switch (frame.kind) {
			case 'response': {
				const pending = this.pending.get(frame.id);
				if (!pending) return; // the other consumer's correlation id
				clearTimeout(pending.timer);
				this.pending.delete(frame.id);
				if ('Ok' in frame.outcome) pending.resolve(frame.outcome.Ok);
				else pending.reject(frame.outcome.Err);
				return;
			}
			case 'request': {
				const call = frame.call;
				const sessionId = call.sessionId;
				const handler = this.callHandlers.get(sessionId);
				if (handler) {
					handler(call, frame.id);
					return;
				}
				if (this.options.unroutedCalls === 'observe') return;
				// Fail-closed defaults (§D.4): deny approvals; reject the rest
				// so the waterfall cancels instead of stalling.
				if (call.method === 'approve') {
					this.wire.send({
						kind: 'reply',
						id: frame.id,
						outcome: { Ok: { allow: false } },
					});
				} else {
					this.wire.send(replyErr(frame.id, `manox: no handler for ${call.method}`));
				}
				return;
			}
			case 'notification': {
				const note = asServerNote(frame);
				if (!note) return;
				if (note.method === 'ready') this.markReady();
				else if (note.method === 'threadsUpdated') this.threads = note.threads;
				else if (note.method === 'models') this.models = note.models;
				return;
			}
			case 'host': {
				const host = asHostEvent(frame);
				if (!host) return;
				for (const sub of this.hostSubs) sub(frame);
				if (host.type === 'ready') this.markReady();
				else if (host.type === 'threadsUpdated') this.threads = host.threads;
				else if (host.type === 'models') this.models = host.models;
				return;
			}
			case 'streamItem': {
				const runtime = this.follows.get(frame.streamId);
				if (!runtime || runtime.closed) return; // the other consumer's stream
				const f = frame.frame;
				if (f.type === 'snapshot') runtime.handle.store.applySnapshot(f);
				else if (f.type === 'entry') runtime.handle.store.applyEntry(f);
				else if (f.type === 'projections') runtime.handle.store.applyProjections(f.values, f.asOfSeq);
				return;
			}
			case 'streamEnd': {
				const runtime = this.follows.get(frame.streamId);
				if (!runtime) return;
				this.follows.delete(frame.streamId);
				if (frame.reason.type === 'resync' || frame.reason.type === 'failure') {
					// L5: re-follow from a fresh snapshot.
					this.refollow(runtime);
				} else {
					// Closed (session disposed / ownership lost) or cancelled:
					// stop routing this id.
					runtime.closed = true;
				}
				return;
			}
		}
	}

	/** L5 re-follow: drop the dead stream's routing entry, announce the
	 * generation boundary, and mint a fresh open. */
	private refollow(runtime: FollowRuntime): void {
		if (runtime.closed) return;
		this.follows.delete(runtime.currentStreamId);
		runtime.handle.store.restart();
		this.openFollow(runtime);
	}

	private openFollow(runtime: FollowRuntime): void {
		runtime.currentStreamId = `${this.options.idPrefix}-stream-${++this.seq}`;
		this.follows.set(runtime.currentStreamId, runtime);
		this.wire.send(
			streamOpen(runtime.currentStreamId, {
				type: 'followSession',
				sessionId: runtime.handle.sessionId,
				maxMessages: runtime.maxMessages,
			}),
		);
	}

	/** Parse-and-dispatch one raw (unparsed) wire value — the transport's
	 * JSON callback entry. Unknown vocabulary drops (L12). */
	acceptRaw(raw: unknown): void {
		const frame = parseFromServer(raw);
		if (frame === null) {
			this.options.onDroppedFrame?.(raw);
			return;
		}
		this.dispatch(frame);
	}

	private markReady(): void {
		this.readyResolve?.();
		this.readyResolve = null;
	}
}
