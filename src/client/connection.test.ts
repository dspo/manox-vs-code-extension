// End-to-end client tests over a scripted fake wire: RPC correlation,
// follow-stream lifecycle (snapshot → entries → projections → resync),
// ServerCall routing (fail-closed defaults + registered handlers), and the
// GW1 dual-envelope registry fold.

import { describe, expect, it } from 'vitest';
import { AgentConnection, type Wire } from './connection';
import type { FromClient, FromServer, JournalWireEntry } from '../protocol/types';

/** Records sent frames; feeds frames in on demand. */
class FakeWire implements Wire {
	readonly sent: FromClient[] = [];
	private handler: ((frame: FromServer) => void) | null = null;

	send(frame: FromClient): void {
		this.sent.push(frame);
	}

	onFrame(handler: (frame: FromServer) => void): () => void {
		this.handler = handler;
		return () => {
			this.handler = null;
		};
	}

	/** Deliver one server frame into the connection. */
	feed(frame: FromServer): void {
		this.handler?.(frame);
	}
}

const header = { id: 's1', cwd: '/p', parentSession: null, metadata: null, createdAt: 't' };

function snapshotFrame(streamId: string, records: JournalWireEntry[], cursor: number): FromServer {
	return {
		kind: 'streamItem',
		streamId,
		frame: {
			type: 'snapshot',
			sessionId: 's1',
			header,
			cursor,
			records,
			hasMore: false,
			projections: { title: 'Hello' },
			projectionsAsOfSeq: cursor,
		},
	};
}

describe('AgentConnection over a scripted wire', () => {
	it('correlates responses by id and rejects Err outcomes as RpcError', async () => {
		const wire = new FakeWire();
		const conn = new AgentConnection(wire, { idPrefix: 'host' });
		const pending = conn.call({ method: 'listThreads' });
		const id = (wire.sent[0] as { id: string }).id;
		wire.feed({ kind: 'response', id, outcome: { Ok: [] } });
		await expect(pending).resolves.toEqual([]);
		await expect(pending).resolves.toBeTypeOf('object');

		const failing = conn.call({ method: 'openSession', sessionId: 'nope' });
		const id2 = (wire.sent[1] as { id: string }).id;
		wire.feed({
			kind: 'response',
			id: id2,
			outcome: { Err: { code: -1, message: 'thread not found', data: { code: 'session/not-found' } } },
		});
		await expect(failing).rejects.toMatchObject({ message: 'thread not found' });
	});

	it('ignores response ids it did not mint (webview relay traffic)', () => {
		const wire = new FakeWire();
		const conn = new AgentConnection(wire, { idPrefix: 'host' });
		expect(() =>
			wire.feed({ kind: 'response', id: 'web-rpc-1', outcome: { Ok: null } }),
		).not.toThrow();
	});

	it('marks ready from either envelope and folds the registry dual-push', async () => {
		const wire = new FakeWire();
		const conn = new AgentConnection(wire, { idPrefix: 'host' });
		const ready = conn.ready;
		wire.feed({ kind: 'notification', note: { method: 'ready' } });
		await ready;

		const threads = [{ id: 's1', title: 'T', updated_at: 1, running: false, unread: false, errored: false, pending_auth: false, pending_plan: false, background_work: false, model_id: 'm', pinned: false, archived: false, parent_id: null, depth: 0 }];
		wire.feed({ kind: 'host', host: { type: 'threadsUpdated', threads } });
		wire.feed({ kind: 'notification', note: { method: 'threadsUpdated', threads } });
		expect(conn.threads).toEqual(threads);
	});

	it('follows a session: snapshot, entries, projections, transcript fold', () => {
		const wire = new FakeWire();
		const conn = new AgentConnection(wire, { idPrefix: 'host' });
		const handle = conn.follow('s1');
		const streamId = (wire.sent[0] as { streamId: string }).streamId;

		wire.feed(snapshotFrame(streamId, [
			{ seq: 0, id: 'e0', parentId: null, timestamp: 't', type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
		], 0));
		expect(handle.store.title).toBe('Hello');
		expect(handle.store.transcript).toHaveLength(1);

		wire.feed({ kind: 'streamItem', streamId, frame: { type: 'entry', seq: 1, id: 'e1', parentId: 'e0', timestamp: 't', event: { type: 'agentTextDelta', s: 'he' } } });
		wire.feed({ kind: 'streamItem', streamId, frame: { type: 'entry', seq: 2, id: 'e2', parentId: 'e1', timestamp: 't', event: { type: 'agentTextDelta', s: 'llo' } } });
		const items = handle.store.transcript;
		expect(items.at(-1)).toMatchObject({ kind: 'assistant', text: 'hello' });

		wire.feed({ kind: 'streamItem', streamId, frame: { type: 'entry', seq: 3, id: 'e3', parentId: 'e2', timestamp: 't', event: { type: 'turnFinish', cancelled: false, failed: false, strandedSteerIds: [] } } });
		expect(handle.store.running).toBe(false);

		wire.feed({ kind: 'streamItem', streamId, frame: { type: 'projections', sessionId: 's1', asOfSeq: 3, values: { running: false, title: 'Renamed' } } });
		expect(handle.store.title).toBe('Renamed');

		handle.close();
		expect(wire.sent.at(-1)).toMatchObject({ kind: 'streamCancel', streamId });
	});

	it('re-follows with a fresh stream id on resync (L5)', () => {
		const wire = new FakeWire();
		const conn = new AgentConnection(wire, { idPrefix: 'host' });
		const handle = conn.follow('s1');
		const first = (wire.sent[0] as { streamId: string }).streamId;
		wire.feed({ kind: 'streamEnd', streamId: first, reason: { type: 'resync' } });
		const second = (wire.sent.at(-1) as { streamId?: string }).streamId;
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		// The new stream routes into the same store.
		wire.feed(snapshotFrame(second as string, [], 0));
		expect(handle.store.transcript).toEqual([]);
	});

	it('routes ServerCalls: registered handler first, then fail-closed defaults', () => {
		const wire = new FakeWire();
		const conn = new AgentConnection(wire, { idPrefix: 'host' });

		// Unrouted approve → deny (fail-closed §D.4).
		wire.feed({
			kind: 'request',
			id: 'adj-1',
			call: { method: 'approve', deliveryId: 'd1', sessionId: 's9', authId: 'a', toolName: 'bash', summary: 'rm', input: {} },
		});
		expect(wire.sent.at(-1)).toMatchObject({ kind: 'reply', id: 'adj-1', outcome: { Ok: { allow: false } } });

		// Unrouted ask → Err rejection so the waterfall cancels.
		wire.feed({
			kind: 'request',
			id: 'adj-2',
			call: { method: 'askUserQuestion', deliveryId: 'd2', sessionId: 's9', authId: 'a', input: {} },
		});
		expect(wire.sent.at(-1)).toMatchObject({ kind: 'reply', id: 'adj-2', outcome: { Err: expect.objectContaining({ message: expect.stringContaining('askUserQuestion') }) } });

		// Registered handler answers instead.
		const seen: string[] = [];
		conn.setCallHandler('s9', (call, id) => {
			seen.push(call.method);
			conn.sendRaw({ kind: 'reply', id, outcome: { Ok: { allow: true } } });
		});
		wire.feed({
			kind: 'request',
			id: 'adj-3',
			call: { method: 'approve', deliveryId: 'd3', sessionId: 's9', authId: 'a', toolName: 'bash', summary: 'ls', input: {} },
		});
		expect(seen).toEqual(['approve']);
		expect(wire.sent.at(-1)).toMatchObject({ kind: 'reply', id: 'adj-3', outcome: { Ok: { allow: true } } });
		conn.setCallHandler('s9', null);
	});

	it('hostCalls intercepts before per-session routing (capability calls)', () => {
		const wire = new FakeWire();
		const conn = new AgentConnection(wire, {
			idPrefix: 'host',
			hostCalls: (call, _id, reply) => {
				if (call.method === 'clipboardRead') {
					reply.ok({ data: Buffer.from('hi', 'utf8').toString('base64'), mimeType: 'text/plain' });
					return true;
				}
				if (call.method === 'openExternal') {
					reply.err('no handler');
					return true;
				}
				return false;
			},
		});
		// A viewed session's no-op shield must NOT swallow capability calls.
		const shielded: string[] = [];
		conn.setCallHandler('s1', (call) => shielded.push(call.method));

		wire.feed({ kind: 'request', id: 'cap-1', call: { method: 'clipboardRead', sessionId: 's1' } });
		expect(wire.sent.at(-1)).toMatchObject({
			kind: 'reply',
			id: 'cap-1',
			outcome: { Ok: { data: 'aGk=', mimeType: 'text/plain' } },
		});

		wire.feed({ kind: 'request', id: 'cap-2', call: { method: 'openExternal', sessionId: 's1', url: 'https://x' } });
		expect(wire.sent.at(-1)).toMatchObject({ kind: 'reply', id: 'cap-2', outcome: { Err: expect.objectContaining({ message: 'no handler' }) } });

		// Non-capability calls still route to the session shield untouched.
		wire.feed({
			kind: 'request',
			id: 'cap-3',
			call: { method: 'approve', deliveryId: 'd', sessionId: 's1', authId: 'a', toolName: 'bash', summary: '', input: {} },
		});
		expect(shielded).toEqual(['approve']);
	});

	// The code-chain host branch (agentHost.ts §4/§9.3): `invokeClientTool`
	// is answered by the interceptor BEFORE any per-session shield — a
	// viewed session's no-op handler would otherwise swallow it into the
	// server's 300s wait, and a per-session handler would override the
	// sidebar's approval-card answering. The reply is the `{content,
	// isError}` Ok contract.
	it('invokeClientTool is intercepted before the session shield and replies {content,isError}', () => {
		const wire = new FakeWire();
		const handled: string[] = [];
		const conn = new AgentConnection(wire, {
			idPrefix: 'host',
			hostCalls: (call, _id, reply) => {
				if (call.method === 'invokeClientTool') {
					handled.push(call.name);
					reply.ok({ content: JSON.stringify({ ok: true, chainId: 'cc-1' }), isError: false });
					return true;
				}
				return false;
			},
		});
		// A shielded (viewed) session must NOT capture the client-tool call.
		const shielded: string[] = [];
		conn.setCallHandler('s1', (call) => shielded.push(call.method));

		wire.feed({
			kind: 'request',
			id: 'inv-1',
			call: {
				method: 'invokeClientTool',
				deliveryId: 'd1',
				sessionId: 's1',
				clientId: 'vscode-1',
				toolCallId: 'tc1',
				name: 'TutorEntry',
				input: { title: 't' },
			},
		});
		expect(handled).toEqual(['TutorEntry']);
		expect(shielded).toEqual([]); // shield never saw it
		expect(wire.sent.at(-1)).toMatchObject({
			kind: 'reply',
			id: 'inv-1',
			outcome: { Ok: { content: JSON.stringify({ ok: true, chainId: 'cc-1' }), isError: false } },
		});

		// A failed tool round-trips as Ok { content, isError:true } (never an
		// RPC Err), so the model reads the self-correction text.
		conn.setCallHandler('s1', null);
	});

	it('observe policy never auto-answers (the webview consumer)', () => {
		const wire = new FakeWire();
		const conn = new AgentConnection(wire, { idPrefix: 'web', unroutedCalls: 'observe' });
		wire.feed({
			kind: 'request',
			id: 'adj-9',
			call: { method: 'approve', deliveryId: 'd9', sessionId: 's1', authId: 'a', toolName: 'bash', summary: '', input: {} },
		});
		expect(wire.sent).toEqual([]);
	});

	it('drops unknown vocabulary through the raw entry (L12)', () => {
		const wire = new FakeWire();
		const dropped: unknown[] = [];
		const conn = new AgentConnection(wire, { idPrefix: 'host', onDroppedFrame: (raw) => dropped.push(raw) });
		conn.acceptRaw({ kind: 'host', host: { type: 'warpSpeed' } });
		conn.acceptRaw('garbage');
		// Declared vocabulary still flows through the same entry.
		conn.acceptRaw({ kind: 'notification', note: { method: 'ready' } });
		expect(dropped).toHaveLength(2);
	});
});
