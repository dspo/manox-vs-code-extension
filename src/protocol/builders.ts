// FromClient frame constructors. Builders only shape objects; the napi side
// parses them against the closed Rust enum and surfaces unknown `kind`/
// `method` tags as errors (logged + dropped by callers, never fatal).

import type {
	ClientCall,
	ClientNote,
	FromClient,
	HookKind,
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

export const askUserQuestionReply = (
	id: string,
	answers: [string, string][],
	response: string | null,
): FromClient => replyOk(id, { answers, response });

// Frequently-shaped Initialize (host-side diagnostics only — the napi binding
// sends the real handshake itself).

export const initializeCall = (
	clientId: string,
	capabilities: HookKind[],
	sessions: string[],
	protocolEpoch: number,
): ClientCall => ({ method: 'initialize', clientId, capabilities, sessions, protocolEpoch });
