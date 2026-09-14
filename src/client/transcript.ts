// Journal-entry → transcript fold (§F.2): the single place that turns
// `JournalWireEntry` records (§C.2 vocabulary) into `TranscriptItem`s, for
// both the snapshot window (`replace`) and the live tail (`append`). Adapted
// from the manox monorepo's webui fold
// (archive/frontends-final:.../state/entries.ts), trimmed to the surfaces this
// host renders. This is a *generic UI fold* over the window — not domain
// state: every value is read off the record itself (L6). No other module
// interprets journal payloads.
//
// Streaming reconciliation: `agentTextDelta` / `agentThinkingDelta` entries
// grow the trailing draft bubble; the durable `message{role:assistant}` row
// that lands at turn settle *finalizes* it (the draft is replaced with the
// authoritative text) instead of stacking a duplicate. Tool lifecycle keys on
// `callId` (`toolCall` / `toolOutputChunk` / `toolResult` entries plus the
// `approval` decision rows).

import { asArray, asBool, asNumber, asRecord, asString, isRecord } from '../protocol/guards';
import type { JournalWireEntry } from '../protocol/types';

/** A flattened §C.1 envelope row the fold consumes (guards already validated
 * `type` against the declared vocabulary; field extraction below is tolerant
 * so wire drift degrades to "ignored", never an exception). */
export type WireRecord = JournalWireEntry;

/** View-model states of a tool card. */
export type ToolCallStatus =
	| 'pending'
	| 'running'
	| 'completed'
	| 'continued'
	| 'failed'
	| 'denied'
	| 'cancelled';

export interface ToolCallState {
	id: string;
	name: string;
	title: string;
	status: ToolCallStatus;
	output: string;
	isError: boolean;
	autoApproved?: boolean;
}

export interface UserImage {
	mimeType: string;
	/** data: URL ready for an <img>, or null when the payload was empty. */
	data: string | null;
}

export type TranscriptItem =
	| { kind: 'user'; id: string; text: string; timestamp?: number; images?: UserImage[] }
	| { kind: 'assistant'; id: string; text: string; modelId?: string }
	| { kind: 'thinking'; id: string; text: string }
	| { kind: 'tool'; id: string; tool: ToolCallState }
	| { kind: 'compaction'; id: string; summary: string };

/** Per-turn transcript facts the fold derives (not projections). */
export interface FoldSideEffects {
	turnStarted: boolean;
	turnFinished: { failed: boolean; cancelled: boolean; strandedSteerIds: string[] } | null;
	stop: boolean;
	threadError: string | null;
}

const TERMINAL = new Set<ToolCallStatus>(['completed', 'failed', 'denied', 'cancelled', 'continued']);
const isTerminal = (status: ToolCallStatus): boolean => TERMINAL.has(status);

/** Normalize the actor's kebab tool statuses to the view vocabulary. */
function foldToolStatus(raw: string): ToolCallStatus {
	switch (raw) {
		case 'pending-approval':
			return 'pending';
		case 'success':
			return 'completed';
		case 'error':
			return 'failed';
		case 'running':
		case 'continued':
		case 'denied':
		case 'cancelled':
			return raw;
		default:
			return 'running';
	}
}

const capOutputTail = (text: string): string => {
	const CAP = 64_000;
	if (text.length <= CAP) return text;
	let start = text.length - CAP;
	const code = text.charCodeAt(start);
	if (code >= 0xdc00 && code <= 0xdfff) start += 1;
	return text.slice(start);
};

/** Content blocks of a `message` row, kernel storage shape (L12-tolerant:
 * unknown block shapes are skipped, never thrown). */
type Block =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string; redacted?: boolean }
	| { type: 'image'; data: string; mimeType: string }
	| { type: 'toolCall'; id: string; name: string; arguments: unknown };

function parseBlock(raw: unknown): Block | null {
	const b = asRecord(raw);
	if (!b) return null;
	switch (asString(b.type)) {
		case 'text':
			return { type: 'text', text: asString(b.text) ?? '' };
		case 'thinking':
			return {
				type: 'thinking',
				text: asString(b.thinking) ?? '',
				redacted: typeof b.redacted === 'boolean' ? b.redacted : undefined,
			};
		case 'image':
			return {
				type: 'image',
				data: asString(b.data) ?? '',
				mimeType: asString(b.mimeType) ?? 'application/octet-stream',
			};
		case 'toolCall':
			return {
				type: 'toolCall',
				id: asString(b.id) ?? '',
				name: asString(b.name) ?? '',
				arguments: b.arguments,
			};
		default:
			return null;
	}
}

const secondsOf = (iso: string): number | undefined => {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? undefined : Math.round(ms / 1000);
};

let foldCounter = 0;
const nextFoldId = (prefix: string): string => `${prefix}-${++foldCounter}`;

/**
 * Mutable incremental fold over the journal window (see module header).
 * `modelRef` is the canonical ref in force during the fold (seeded from the
 * snapshot's `model` projection by the store, advanced by `modelChange`
 * rows); `autoApproved` accumulates approval-decision ids whose tool card had
 * not landed yet (§C.2 approval dual-state fold).
 */
export class TranscriptFold {
	items: TranscriptItem[] = [];
	private readonly toolIndex = new Map<string, number>();
	readonly autoApproved = new Set<string>();
	private pendingAutoApprovals: string[] = [];
	/** Canonical `{provider}/{modelId}` in force; display only (L6). */
	modelRef: string | null = null;
	private lastAssistantSeq = -1;
	private lastThinkingSeq = -1;

	side: FoldSideEffects = emptySide();

	/** Re-fold the whole window (Replace / Prepend). */
	replace(records: readonly WireRecord[]): void {
		this.reset();
		for (const record of records) this.append(record);
	}

	/** Apply one live `Entry` frame (fresh seq only; the engine guarantees
	 * monotonicity, and re-applied rows are dropped upstream). */
	append(record: WireRecord): void {
		this.side = emptySide();
		this.applyRecord(record);
	}

	private reset(): void {
		this.items = [];
		this.toolIndex.clear();
		this.autoApproved.clear();
		this.pendingAutoApprovals = [];
		this.lastAssistantSeq = -1;
		this.lastThinkingSeq = -1;
		this.side = emptySide();
	}

	private applyRecord(r: WireRecord): void {
		switch (r.type) {
			case 'message':
				this.onMessage(r);
				return;
			case 'uiNote':
				this.onUiNote(r);
				return;
			case 'custom':
				// Legacy durable UI annotation (pre-`uiNote` files wrote
				// `custom{customType: "manox_ui_note"}`): payload is the uiNote
				// row verbatim — fold it the same way.
				if (asString(r.customType) === 'manox_ui_note') {
					const payload = asRecord(r.data);
					this.onUiNote({
						...r,
						type: 'uiNote',
						kind: payload ? (asString(payload.kind) ?? 'notice') : 'notice',
						data: payload ? payload.data : undefined,
					} as WireRecord);
				}
				return;
			case 'turnStart':
				this.side.turnStarted = true;
				return;
			case 'turnFinish':
				this.side.turnFinished = {
					failed: asBool(r.failed),
					cancelled: asBool(r.cancelled),
					strandedSteerIds: asArray(r.strandedSteerIds).filter(
						(v): v is string => typeof v === 'string',
					),
				};
				return;
			case 'stop':
				this.side.stop = true;
				return;
			case 'error':
				this.side.threadError = asString(r.message);
				return;
			case 'agentTextDelta': {
				const s = asString(r.s);
				if (s === null) return;
				const last = this.items[this.items.length - 1];
				if (last && last.kind === 'assistant' && this.lastAssistantSeq === r.seq - 1) {
					this.items[this.items.length - 1] = { ...last, text: last.text + s };
				} else {
					this.items.push({ kind: 'assistant', id: nextFoldId('assistant'), text: s, modelId: this.modelRef ?? undefined });
				}
				this.lastAssistantSeq = r.seq;
				return;
			}
			case 'agentThinkingDelta': {
				const s = asString(r.s);
				if (s === null) return;
				const last = this.items[this.items.length - 1];
				if (last && last.kind === 'thinking' && this.lastThinkingSeq === r.seq - 1) {
					this.items[this.items.length - 1] = { ...last, text: last.text + s };
				} else {
					this.items.push({ kind: 'thinking', id: nextFoldId('thinking'), text: s });
				}
				this.lastThinkingSeq = r.seq;
				return;
			}
			case 'toolCall': {
				const callId = asString(r.callId);
				if (!callId) return;
				const name = asString(r.name) ?? '';
				this.upsertTool(callId, (prev) => {
					const status = foldToolStatus(asString(r.status) ?? 'running');
					return {
						id: callId,
						name,
						title: asString(r.title) || prev?.title || name || callId,
						status,
						output: prev?.output ?? '',
						isError: status === 'failed' ? true : (prev?.isError ?? false),
						autoApproved: prev?.autoApproved || this.drainAutoApproval(callId) || undefined,
					};
				});
				return;
			}
			case 'toolResult': {
				const callId = asString(r.callId);
				if (!callId) return;
				const isError = asBool(r.isError);
				this.upsertTool(callId, (prev) => ({
					id: callId,
					name: prev?.name ?? '',
					title: prev?.title ?? callId,
					status: isError ? 'failed' : prev && isTerminal(prev.status) ? prev.status : 'completed',
					output: capOutputTail(asString(r.output) ?? ''),
					isError,
					autoApproved: prev?.autoApproved || this.drainAutoApproval(callId) || undefined,
				}));
				return;
			}
			case 'toolOutputChunk': {
				const callId = asString(r.callId);
				const chunk = asString(r.chunk);
				if (!callId || chunk === null) return;
				this.upsertTool(callId, (prev) => ({
					id: callId,
					name: prev?.name ?? '',
					title: prev?.title ?? callId,
					status: prev?.status ?? 'running',
					output: capOutputTail((prev?.output ?? '') + chunk),
					isError: prev?.isError ?? false,
					autoApproved: prev?.autoApproved,
				}));
				return;
			}
			case 'modelChange': {
				const to = asString(r.to);
				if (to) this.modelRef = to;
				return;
			}
			case 'approval': {
				const kind = asString(r.kind);
				const authId = asString(r.authId);
				if (!authId) return;
				// Requests ride the waterfall ServerCall (the adjudication card
				// source); only the decision's `allow` verdict folds (the
				// auto-approve badge). The pending set itself is the
				// `pending_auth` projection (P face).
				if (kind === 'decision' && asString(r.verdict) === 'allow') {
					const callId = asString(r.toolCallId);
					if (callId) this.markAutoApproved(callId);
				}
				return;
			}
			case 'compactionStarted':
				this.items.push({ kind: 'compaction', id: nextFoldId('compaction-started'), summary: '' });
				return;
			case 'compaction':
				this.onCompaction(r);
				return;
			default:
				// Transcript-irrelevant vocabulary (lifecycle edges, tree
				// bookkeeping, metrics, subagent rails) folds in the store's
				// projection / side-effect arms, not here.
				return;
		}
	}

	private onMessage(r: WireRecord): void {
		const role = asString(r.role);
		if (r.display === false) return; // hidden rows (embedder seeds etc.)
		const blocks = asArray(r.content).map(parseBlock).filter((b): b is Block => b !== null);
		if (role === 'user') {
			let text = '';
			const images: UserImage[] = [];
			for (const b of blocks) {
				if (b.type === 'text') text += b.text;
				if (b.type === 'image') {
					images.push({
						mimeType: b.mimeType,
						data: b.data ? `data:${b.mimeType};base64,${b.data}` : null,
					});
				}
			}
			if (!text && images.length === 0) return;
			this.items.push({
				kind: 'user',
				id: r.id || nextFoldId('user'),
				text,
				timestamp: secondsOf(r.timestamp),
				images: images.length ? images : undefined,
			});
			return;
		}
		if (role === 'assistant') {
			this.onAssistantMessage(blocks, r);
			return;
		}
		if (role === 'tool') {
			this.onToolMessage(r);
		}
	}

	private onAssistantMessage(blocks: Block[], r: WireRecord): void {
		// Durable assistant row: finalize the streamed draft(s) and stamp the
		// model in force. Thinking-first, then text — mirror the block order.
		let sawText = false;
		let sawThinking = false;
		for (const b of blocks) {
			if (b.type === 'thinking' && b.text.trim() && !b.redacted) {
				const last = this.items[this.items.length - 1];
				if (last && last.kind === 'thinking' && this.lastThinkingSeq !== -1) {
					this.items[this.items.length - 1] = { ...last, text: b.text };
				} else {
					this.items.push({ kind: 'thinking', id: nextFoldId('thinking'), text: b.text });
				}
				this.lastThinkingSeq = r.seq;
				sawThinking = true;
			}
			if (b.type === 'text' && b.text.trim()) {
				const last = this.items[this.items.length - 1];
				if (last && last.kind === 'assistant' && this.lastAssistantSeq !== -1) {
					// Replace the streamed draft with the authoritative text.
					this.items[this.items.length - 1] = { ...last, text: b.text };
				} else {
					this.items.push({
						kind: 'assistant',
						id: nextFoldId('assistant'),
						text: b.text,
						modelId: this.modelRef ?? undefined,
					});
				}
				this.lastAssistantSeq = r.seq;
				sawText = true;
			}
			if (b.type === 'toolCall' && b.id) {
				this.upsertTool(b.id, (prev) => ({
					id: b.id,
					name: prev?.name ?? b.name,
					title: prev?.title || `${b.name}(${JSON.stringify(b.arguments ?? {})})`,
					status: prev?.status ?? 'completed',
					output: prev?.output ?? '',
					isError: prev?.isError ?? false,
					autoApproved: prev?.autoApproved || this.drainAutoApproval(b.id) || undefined,
				}));
			}
		}
		// A streaming turn always ends with an authoritative row; reset the
		// draft continuations so a later delta opens a new bubble.
		if (sawText || sawThinking) {
			this.lastAssistantSeq = sawText ? r.seq : -1;
			this.lastThinkingSeq = sawThinking ? r.seq : -1;
		}
	}

	private onToolMessage(r: WireRecord): void {
		// `tool`-role rows carry the whole kernel message JSON (§C.2):
		// `toolResult` / `bashExecution` shapes.
		const msg = isRecord(asArray(r.content)[0]) ? (asArray(r.content)[0] as Record<string, unknown>) : null;
		if (!msg) return;
		const kind = asString(msg.role);
		if (kind === 'toolResult') {
			const callId = asString(msg.toolCallId);
			if (!callId) return;
			const isError = asBool(msg.isError);
			const text = asArray(msg.content)
				.map(parseBlock)
				.filter((b): b is Extract<Block, { type: 'text' }> => !!b && b.type === 'text')
				.map((b) => b.text)
				.join('');
			this.upsertTool(callId, (prev) => ({
				id: callId,
				name: prev?.name || asString(msg.toolName) || 'tool',
				title: prev?.title || asString(msg.toolName) || callId,
				status: isError ? 'failed' : prev && isTerminal(prev.status) ? prev.status : 'completed',
				output: capOutputTail(text),
				isError,
				autoApproved: prev?.autoApproved || this.drainAutoApproval(callId) || undefined,
			}));
		}
	}

	private onUiNote(r: WireRecord): void {
		// §C.2 durable UI annotation: only the `error` kind has a client
		// surface today (the thread error banner); other kinds are display
		// notes without a renderer — ignore, never throw (L12).
		if ((asString(r.kind) ?? 'notice') !== 'error') return;
		const data = asRecord(r.data);
		this.side.threadError = data ? (asString(data.text) ?? '') : '';
	}

	private onCompaction(r: WireRecord): void {
		const summary = asString(r.summary) ?? '';
		for (let i = this.items.length - 1; i >= 0; i -= 1) {
			const item = this.items[i];
			if (item && item.kind === 'compaction' && item.summary === '') {
				this.items[i] = { ...item, summary };
				return;
			}
		}
		this.items.push({ kind: 'compaction', id: nextFoldId('compaction'), summary });
	}

	private upsertTool(id: string, f: (prev: ToolCallState | undefined) => ToolCallState): void {
		const index = this.toolIndex.get(id);
		if (index === undefined) {
			this.toolIndex.set(id, this.items.length);
			this.items.push({ kind: 'tool', id, tool: f(undefined) });
			return;
		}
		const item = this.items[index];
		if (item && item.kind === 'tool') {
			this.items[index] = { kind: 'tool', id, tool: f(item.tool) };
		}
	}

	private markAutoApproved(callId: string): void {
		this.autoApproved.add(callId);
		const index = this.toolIndex.get(callId);
		if (index !== undefined) {
			const item = this.items[index];
			if (item && item.kind === 'tool' && !item.tool.autoApproved) {
				this.items[index] = { ...item, tool: { ...item.tool, autoApproved: true } };
			}
		} else if (!this.pendingAutoApprovals.includes(callId)) {
			this.pendingAutoApprovals.push(callId);
		}
	}

	/** True once when the id's parked auto-approval is consumed by a fresh
	 * tool card (the documented decision-before-call ordering race, §C.2). */
	private drainAutoApproval(callId: string): boolean {
		if (!this.pendingAutoApprovals.includes(callId)) return false;
		this.pendingAutoApprovals = this.pendingAutoApprovals.filter((x) => x !== callId);
		return true;
	}
}

const emptySide = (): FoldSideEffects => ({
	turnStarted: false,
	turnFinished: null,
	stop: false,
	threadError: null,
});
