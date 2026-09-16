// The `registerSessionTools` lifecycle controller over a fake host (§9.2
// replay rules, review #4/#19): full-replace-per-register makes it idempotent,
// a `sessionDisposed` frees the slot so a cold re-open under the SAME id
// re-sends the tool set, and the no-workspace case skips with a log. This is
// the vscode-free face `ensureCodeChain` wires to the real connection.

import { describe, expect, it } from 'vitest';

import type { ClientToolSpec } from '../protocol/types';
import { SessionToolRegistrar, type RegistrarHost } from './sessionRegistrar';

// Drain the register promise chain to its `.finally` (microtasks after a
// resolved send need a macrotask boundary before the in-flight slot frees).
const flush = async (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeHost(opts: { hasWorkspace?: boolean; fail?: boolean } = {}) {
	const sent: { sessionId: string; tools: ClientToolSpec[] }[] = [];
	const logs: string[] = [];
	const host: RegistrarHost = {
		send: (sessionId, tools) => {
			sent.push({ sessionId, tools });
			if (opts.fail) return Promise.reject(new Error('boom'));
			return Promise.resolve({ registered: tools.length });
		},
		hasWorkspace: () => opts.hasWorkspace ?? true,
		log: (m) => logs.push(m),
		tools: () => [
			{ name: 'GenCodeChain', description: 'd', input_schema: {} },
			{ name: 'ExpandCodeChainNode', description: 'd', input_schema: {} },
		],
	};
	return { host, sent, logs };
}

describe('SessionToolRegistrar', () => {
	it('sends the full snake_case tool set on the first edge', () => {
		const { host, sent } = fakeHost();
		new SessionToolRegistrar(host).registerSession('s1');
		expect(sent).toHaveLength(1);
		expect(sent[0]?.sessionId).toBe('s1');
		expect(sent[0]?.tools).toEqual([
			{ name: 'GenCodeChain', description: 'd', input_schema: {} },
			{ name: 'ExpandCodeChainNode', description: 'd', input_schema: {} },
		]);
	});

	it('dedups only the in-flight burst, not the process lifetime', async () => {
		const { host, sent } = fakeHost();
		let release!: () => void;
		host.send = (sessionId, tools) =>
			new Promise<void>((resolve) => {
				sent.push({ sessionId, tools });
				release = () => resolve();
			});
		const reg = new SessionToolRegistrar(host);
		reg.registerSession('s1');
		reg.registerSession('s1'); // still in flight → suppressed
		expect(sent).toHaveLength(1);
		release();
		await flush();
		reg.registerSession('s1'); // after settle → the replace re-sends (idempotent)
		expect(sent).toHaveLength(2);
	});

	it('a failed register releases the slot so a later edge retries (no throw)', async () => {
		const { host, sent, logs } = fakeHost({ fail: true });
		const reg = new SessionToolRegistrar(host);
		reg.registerSession('s1');
		await flush(); // drain the rejection + the finally cleanup
		// The rejection was logged, never thrown up into the frame bus, and
		// the in-flight guard cleared → the same id re-registers.
		reg.registerSession('s1');
		await flush();
		expect(sent.filter((s) => s.sessionId === 's1')).toHaveLength(2);
		expect(logs.some((l) => l.includes('failed'))).toBe(true);
	});

	it('sessionDisposed frees the id so a same-id re-open re-registers (review #4)', async () => {
		const { host, sent } = fakeHost();
		const reg = new SessionToolRegistrar(host);
		reg.registerSession('s1');
		await flush();
		reg.registerSession('s1'); // settled → replace re-sends anyway
		await flush();
		reg.onSessionDisposed('s1');
		reg.registerSession('s1'); // the disposed path must never leave a tombstone
		await flush();
		expect(sent.filter((s) => s.sessionId === 's1').length).toBe(3);
	});

	it('no workspace folder → skip with a log, no send', () => {
		const { host, sent, logs } = fakeHost({ hasWorkspace: false });
		new SessionToolRegistrar(host).registerSession('s1');
		expect(sent).toHaveLength(0);
		expect(logs.some((l) => l.includes('workspace'))).toBe(true);
	});

	it('empty session id is ignored', () => {
		const { host, sent } = fakeHost();
		new SessionToolRegistrar(host).registerSession('');
		expect(sent).toHaveLength(0);
	});
});
