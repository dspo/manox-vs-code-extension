// Tolerant parse face for incoming wire data (the L12 client rule: unknown
// vocabulary drops + logs, never disconnects). `parseFromServer` validates the
// envelope `kind` and, one level deep, the payload's declared tag; everything
// below that stays `unknown` and consumers extract fields defensively.

import type { FromServer, HostEvent, JournalWireEntry, ServerCall, ServerNote, StreamFrame } from './types';

/** Envelope vocabulary of `FromServer` (§D.1). */
export const FROM_SERVER_KINDS: ReadonlySet<string> = new Set([
	'response',
	'request',
	'notification',
	'host',
	'streamItem',
	'streamEnd',
]);

/** Declared `HostEvent` surface (§D.5). */
export const HOST_EVENT_TYPES: ReadonlySet<string> = new Set([
	'ready',
	'models',
	'commands',
	'threadsUpdated',
	'sessionStatus',
	'sessionCreated',
	'sessionDisposed',
	'error',
	'projects',
	'terminalsUpdated',
	'workspaceUpdate',
]);

/** Retained `ServerNote` method surface (§D.6 as-built: owner control, list
 * channels, error, ModelChat side-stream). */
export const SERVER_NOTE_METHODS: ReadonlySet<string> = new Set([
	'ready',
	'sessionCreated',
	'sessionDisposed',
	'threadsUpdated',
	'models',
	'commands',
	'error',
	'modelText',
	'modelThinking',
	'modelToolCall',
	'modelChatDone',
]);

/** Declared `ServerCall` method surface (§D.4). */
export const SERVER_CALL_METHODS: ReadonlySet<string> = new Set([
	'approve',
	'planVerdict',
	'askUserQuestion',
	'browserOp',
	'clipboardRead',
	'openExternal',
	'invokeClientTool',
]);

/** Declared `StreamFrame` payload tags (§D.1). */
export const STREAM_FRAME_TYPES: ReadonlySet<string> = new Set([
	'snapshot',
	'entry',
	'projections',
	'terminalOutput',
]);

/** Declared `JournalWireEvent` tags (§C.2) — the isKnownJournalTag face. */
export const JOURNAL_EVENT_TYPES: ReadonlySet<string> = new Set([
	'message',
	'uiNote',
	'custom',
	'customMessage',
	'turnStart',
	'turnFinish',
	'stop',
	'retry',
	'error',
	'agentTextDelta',
	'agentThinkingDelta',
	'toolCall',
	'toolResult',
	'toolOutputChunk',
	'subagentChild',
	'subagentProgress',
	'modelChange',
	'cwdChange',
	'projectChange',
	'permissionModeChange',
	'reasoningEffortChange',
	'planModeChange',
	'planUpdate',
	'planReview',
	'goal',
	'title',
	'browserSuites',
	'backgroundTask',
	'approval',
	'pinnedArchived',
	'activeToolsChange',
	'compaction',
	'compactionStarted',
	'branchSummary',
	'label',
	'sessionInfo',
	'leaf',
	'metrics',
]);

export const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when the tag is in the declared §C.2 journal vocabulary. */
export const isKnownJournalTag = (tag: string): boolean => JOURNAL_EVENT_TYPES.has(tag);

export const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const asNumber = (v: unknown): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v : null;
export const asBool = (v: unknown): boolean => v === true;
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asRecord = (v: unknown): Record<string, unknown> | null =>
	typeof v === 'object' && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;

/**
 * Parse one raw JSON value as a `FromServer`. Returns null for anything whose
 * envelope or one-level tag is not in the declared vocabulary — callers log +
 * drop (version skew against a future server), never throw.
 */
export function parseFromServer(value: unknown): FromServer | null {
	if (!isRecord(value)) return null;
	switch (value.kind) {
		case 'response':
			return isRecord(value.outcome) ? (value as unknown as FromServer) : null;
		case 'request':
			return parseTagged(value.call, SERVER_CALL_METHODS) ? (value as unknown as FromServer) : null;
		case 'notification':
			return parseTagged(value.note, SERVER_NOTE_METHODS) ? (value as unknown as FromServer) : null;
		case 'host':
			return parseTagged(value.host, HOST_EVENT_TYPES) ? (value as unknown as FromServer) : null;
		case 'streamItem':
			return parseTagged(value.frame, STREAM_FRAME_TYPES) ? (value as unknown as FromServer) : null;
		case 'streamEnd':
			return isRecord(value.reason) ? (value as unknown as FromServer) : null;
		default:
			return null;
	}
}

/** True when the value is an internally-tagged object whose tag is declared. */
function parseTagged(payload: unknown, tags: ReadonlySet<string>): boolean {
	return isRecord(payload) && typeof payload.method === 'string'
		? tags.has(payload.method)
		: isRecord(payload) && typeof payload.type === 'string' && tags.has(payload.type);
}

/** Narrow a parsed `FromServer` into its ServerCall (null for other kinds). */
export function asServerCall(frame: FromServer): ServerCall | null {
	return frame.kind === 'request' ? (frame.call as ServerCall) : null;
}

/** Narrow a parsed `FromServer` into its ServerNote (null for other kinds). */
export function asServerNote(frame: FromServer): ServerNote | null {
	return frame.kind === 'notification' ? (frame.note as ServerNote) : null;
}

/** Narrow a parsed `FromServer` into its HostEvent (null for other kinds). */
export function asHostEvent(frame: FromServer): HostEvent | null {
	return frame.kind === 'host' ? (frame.host as HostEvent) : null;
}

/** Narrow a parsed `FromServer` into its StreamFrame (null for other kinds). */
export function asStreamFrame(frame: FromServer): StreamFrame | null {
	return frame.kind === 'streamItem' ? (frame.frame as StreamFrame) : null;
}

/**
 * Normalize raw `PageHistory` rows / snapshot `records` JSON into flattened
 * §C.1 envelope rows. Rows whose `type` is not in the declared vocabulary are
 * KEPT opaquely — they occupy their seq for the engine's adjacency algebra (a
 * dropped row would punch a hole and loop snapshot → resync); only rows
 * without a finite seq/type are dropped (malformed).
 */
export function normalizeWireRecords(raw: unknown): JournalWireEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: JournalWireEntry[] = [];
	for (const value of raw) {
		if (!isRecord(value)) continue;
		const seq = asNumber(value.seq);
		const type = asString(value.type);
		if (seq === null || type === null) continue;
		out.push({
			...value,
			seq,
			type,
			id: asString(value.id) ?? `e-${seq}`,
			parentId: typeof value.parentId === 'string' ? value.parentId : null,
			timestamp: asString(value.timestamp) ?? '',
		} as JournalWireEntry);
	}
	out.sort((a, b) => a.seq - b.seq);
	return out;
}
