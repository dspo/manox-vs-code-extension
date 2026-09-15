// Wire-shape tests: pin the exact JSON keys the Rust side's own serde tests
// assert (crates/manox-protocol/src/{msg,client,server,stream,journal}.rs and
// the napi pump tests). A drift here means this host can no longer talk to
// the current protocol epoch.

import { describe, expect, it } from 'vitest';
import type { FromClient } from './types';
import {
	approveReply,
	askUserQuestionReply,
	clientToolReply,
	clientToolSpec,
	notification,
	planVerdictReply,
	registerSessionTools,
	replyErr,
	replyOk,
	request,
	streamCancel,
	streamOpen,
} from './builders';
import { JOURNAL_EVENT_TYPES, parseFromServer } from './guards';

describe('builders produce the exact serde shapes', () => {
	it('streamOpen carries camelCase streamId/streamKind', () => {
		const frame = streamOpen('web-1', { type: 'followSession', sessionId: 's1' });
		const json = JSON.parse(JSON.stringify(frame));
		expect(json).toEqual({
			kind: 'streamOpen',
			streamId: 'web-1',
			streamKind: { type: 'followSession', sessionId: 's1', maxMessages: undefined },
		});
		expect(json.streamKind.type).toBe('followSession');
	});

	it('reply outcome is externally tagged Ok/Err', () => {
		expect(JSON.parse(JSON.stringify(replyOk('r', { allow: true })))).toEqual({
			kind: 'reply',
			id: 'r',
			outcome: { Ok: { allow: true } },
		});
		const err = JSON.parse(JSON.stringify(replyErr('r', 'no')));
		expect(err.outcome.Err.code).toBe(-1);
		expect(err.outcome.Err.data).toBeNull();
	});

	it('adjudication replies match the §D.4 payload contracts', () => {
		const outcomeOf = (frame: FromClient) => (frame as { outcome: unknown }).outcome;
		expect(outcomeOf(approveReply('a', true))).toEqual({ Ok: { allow: true } });
		expect(outcomeOf(planVerdictReply('p', 'refine'))).toEqual({ Ok: { choice: 'refine' } });
		// B2-PR-1 canonical (#796): id-routed tri-state rows, no card-level
		// response override; `custom` is omitted when unset.
		expect(outcomeOf(askUserQuestionReply('q', [{ id: 'q1', selected: ['opt'] }, { id: 'q2', selected: [] }]))).toEqual({
			Ok: { answers: [{ id: 'q1', selected: ['opt'] }, { id: 'q2', selected: [] }] },
		});
	});

	it('notifications carry the method tag one level down', () => {
		expect(JSON.parse(JSON.stringify(notification({ method: 'cancelTurn', sessionId: 's1' })))).toEqual({
			kind: 'notification',
			note: { method: 'cancelTurn', sessionId: 's1' },
		});
	});

	// RegisterSessionTools (client.rs): the ClientCall envelope is
	// `rename_all_fields = "camelCase"` — `sessionId`/`clientId` on the call —
	// but the `ClientToolSpec` struct carries NO rename_all, so its wire keys
	// are snake_case. Sending `inputSchema` fails deserialization with
	// `missing field input_schema`; `readOnly` would be silently dropped to
	// false. These two tests are that boundary's lock.
	it('registerSessionTools pins the mixed camelCase/snake_case wire', () => {
		const call = registerSessionTools('s1', 'vscode-1', [
			clientToolSpec({
				name: 'GenCodeChain',
				description: 'd',
				inputSchema: { type: 'object' },
				readOnly: true,
			}),
		]);
		const json = JSON.parse(JSON.stringify(request('rpc-1', call)));
		expect(json).toEqual({
			kind: 'request',
			id: 'rpc-1',
			call: {
				method: 'registerSessionTools',
				sessionId: 's1',
				clientId: 'vscode-1',
				tools: [
					{ name: 'GenCodeChain', description: 'd', input_schema: { type: 'object' }, read_only: true },
				],
			},
		});
	});

	it('clientToolSpec omits read_only when unset (Rust defaults false)', () => {
		expect(JSON.parse(JSON.stringify(clientToolSpec({ name: 't', description: 'd', inputSchema: {} })))).toEqual({
			name: 't',
			description: 'd',
			input_schema: {},
		});
	});

	it('InvokeClientTool replies carry the exact {content, isError} Ok payload', () => {
		expect(JSON.parse(JSON.stringify(clientToolReply('r', 'text', false)))).toEqual({
			kind: 'reply',
			id: 'r',
			outcome: { Ok: { content: 'text', isError: false } },
		});
		expect(JSON.parse(JSON.stringify(clientToolReply('r', 'boom', true)))).toEqual({
			kind: 'reply',
			id: 'r',
			outcome: { Ok: { content: 'boom', isError: true } },
		});
	});
});

describe('parseFromServer tolerates the declared vocabulary only', () => {
	it('accepts every envelope kind and rejects unknown ones', () => {
		const ok = [
			{ kind: 'response', id: 'r', outcome: { Ok: null } },
			{ kind: 'request', id: 'a', call: { method: 'approve', deliveryId: 'd', sessionId: 's', authId: 'x', toolName: 'bash', summary: '', input: {} } },
			{ kind: 'notification', note: { method: 'ready' } },
			{ kind: 'host', host: { type: 'ready', epoch: 6 } },
			{ kind: 'streamItem', streamId: 'st', frame: { type: 'entry', seq: 1, id: 'e-1', parentId: null, timestamp: '', event: { type: 'turnStart' } } },
			{ kind: 'streamEnd', streamId: 'st', reason: { type: 'resync' } },
		];
		for (const frame of ok) expect(parseFromServer(frame)).toEqual(frame);
		expect(parseFromServer({ kind: 'timeTravel', when: 'now' })).toBeNull();
		expect(parseFromServer({ kind: 'host', host: { type: 'warp' } })).toBeNull();
		expect(parseFromServer({ kind: 'notification', note: { method: 'agentText' } })).toBeNull();
		expect(parseFromServer('noise')).toBeNull();
		expect(parseFromServer(null)).toBeNull();
	});

	it('round-trips the pump-side v2 frame shapes (napi tests)', () => {
		// Mirrors manox-napi's v2_frame_wire_shapes_match_ts_bindings.
		const item = JSON.parse(
			JSON.stringify({
				kind: 'streamItem',
				streamId: 'st-1',
				frame: {
					type: 'entry',
					seq: 3,
					id: 'e-3',
					parentId: null,
					timestamp: '2026-09-05T00:00:00Z',
					event: { type: 'agentTextDelta', s: 'x' },
				},
			}),
		);
		const parsed = parseFromServer(item)!;
		expect(parsed.kind).toBe('streamItem');
		if (parsed.kind === 'streamItem' && parsed.frame.type === 'entry') {
			expect(parsed.frame.seq).toBe(3);
			expect(parsed.frame.event.type).toBe('agentTextDelta');
		}
	});

	it('snapshot records flatten the event tag inline (§C.1)', () => {
		const snap = {
			kind: 'streamItem',
			streamId: 'st',
			frame: {
				type: 'snapshot',
				sessionId: 's1',
				header: { id: 's1', cwd: '/p', parentSession: null, metadata: null, createdAt: 't' },
				cursor: 0,
				records: [{ seq: 0, id: 'e0', parentId: null, timestamp: 't', type: 'turnStart' }],
				hasMore: false,
				projections: {},
				projectionsAsOfSeq: 0,
			},
		};
		const parsed = parseFromServer(snap)!;
		expect(parsed.kind).toBe('streamItem');
	});

	it('journal vocabulary stays in lock-step with §C.2', () => {
		// The tags the Rust surface table declares; count guards accidental
		// additions/removals in either repo.
		expect(JOURNAL_EVENT_TYPES.size).toBe(38);
		for (const tag of ['message', 'turnStart', 'agentTextDelta', 'toolCall', 'approval', 'compaction', 'leaf', 'metrics']) {
			expect(JOURNAL_EVENT_TYPES.has(tag)).toBe(true);
		}
	});
});
