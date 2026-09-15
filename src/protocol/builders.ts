// FromClient frame constructors. Builders only shape objects; the napi side
// parses them against the closed Rust enum and surfaces unknown `kind`/
// `method` tags as errors (logged + dropped by callers, never fatal).

import type {
	AskAnswerRow,
	ClientCall,
	ClientNote,
	ClientToolSpec,
	FromClient,
	AnswerKind,
	RpcOutcome,
	StreamId,
	StreamKind,
} from './types';

export const request = (id: string, call: ClientCall): FromClient => ({
	kind: 'request',
	id,
	call,
});

export const notification = (note: ClientNote): FromClient => ({
	kind: 'notification',
	note,
});

export const reply = (id: string, outcome: RpcOutcome): FromClient => ({
	kind: 'reply',
	id,
	outcome,
});

export const replyOk = (id: string, payload: Record<string, unknown>): FromClient =>
	reply(id, { Ok: payload });

export const replyErr = (id: string, message: string): FromClient =>
	reply(id, { Err: { code: -1, message, data: null } });

export const streamOpen = (streamId: StreamId, streamKind: StreamKind): FromClient => ({
	kind: 'streamOpen',
	streamId,
	streamKind,
});

export const streamCancel = (streamId: StreamId): FromClient => ({
	kind: 'streamCancel',
	streamId,
});

// Frequently-shaped ServerCall replies (§D.4 payload contracts).

export const approveReply = (id: string, allow: boolean): FromClient =>
	replyOk(id, { allow });

export const planVerdictReply = (id: string, choice: 'execute_keep' | 'execute_compact' | 'refine'): FromClient =>
	replyOk(id, { choice });

/** Canonical B2-PR-1 reply (#796): `{answers: [{id, selected, custom?}]}` —
 * id-routed tri-state; the legacy positional shape (`[[q, a]]` + card-level
 * `response`) is server-read-only for one transitional release; clients
 * write the canonical shape exclusively. */
export const askUserQuestionReply = (id: string, rows: AskAnswerRow[]): FromClient =>
	replyOk(id, {
		answers: rows.map((row) => ({
			id: row.id,
			selected: row.selected,
			...(row.custom !== undefined ? { custom: row.custom } : {}),
		})),
	});

// ── client tools (RegisterSessionTools / InvokeClientTool) ─────────────────

/** Shape one `ClientToolSpec` at the snake_case wire keys the Rust struct
 * deserializes (no serde rename_all — see types.ts). The host-side input is
 * camelCase; this is the single conversion face. */
export const clientToolSpec = (tool: {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly?: boolean;
}): ClientToolSpec => ({
	name: tool.name,
	description: tool.description,
	input_schema: tool.inputSchema,
	...(tool.readOnly !== undefined ? { read_only: tool.readOnly } : {}),
});

/** RegisterSessionTools replaces the client's whole tool set for the session
 * (server-side is a full per-(session, clientId) swap; re-sending the
 * complete list is the idempotent replay path). */
export const registerSessionTools = (
	sessionId: string,
	clientId: string,
	tools: ClientToolSpec[],
): ClientCall => ({ method: 'registerSessionTools', sessionId, clientId, tools });

/** The InvokeClientTool reply contract: the server reads exactly
 * `{content, isError}` out of the Ok payload — `content` becomes the
 * toolResult journal output, `isError: true` turns it into
 * "execution failed: <content>" the model can self-correct against.
 * Structured results ride as JSON in `content`. */
export const clientToolReply = (id: string, content: string, isError: boolean): FromClient =>
	replyOk(id, { content, isError });

/** Frequently-shaped Initialize (host-side diagnostics only — the napi binding
 * sends the real handshake itself). */

export const initializeCall = (
	clientId: string,
	capabilities: AnswerKind[],
	sessions: string[],
	protocolEpoch: number,
): ClientCall => ({ method: 'initialize', clientId, capabilities, sessions, protocolEpoch });
