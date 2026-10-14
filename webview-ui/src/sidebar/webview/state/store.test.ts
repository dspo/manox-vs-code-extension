// The AHP relay fold, over hand-built relay traffic (no bridge): snapshot
// seeding, action folding through the same SDK reducers the host runs, echo
// retirement by turn id, catalogue events, card derivation, and the L12
// tolerance rules (unknown channels/actions/messages drop, never throw).

import { describe, expect, it, vi } from 'vitest';

import type { RelayToWebview } from '../../../protocol';
import { EXT_ACTIONS } from '../../../../../src/protocol/xmanox';
import { Store, type StoreEffects } from './store';

const SESSION = 'ahp-session:/s-1';
const CHAT = 'ahp-chat:/c-1';

/** Drive the store through the relay, collecting derived state. */
function harness(effects: Partial<StoreEffects> = {}) {
	const store = new Store();
	const seen: Array<ReturnType<Store['get']>> = [];
	store.subscribe(() => seen.push(JSON.parse(JSON.stringify(store.get())) as ReturnType<Store['get']>));
	const merged: StoreEffects = {
		view: vi.fn(),
		viewChat: vi.fn(),
		fetchTurns: async () => false,
		...effects,
	};
	store.attachEffects(merged);
	const relay = (msg: RelayToWebview) => store.relay(msg);
	return { store, seen, relay, view: merged.view as unknown as ReturnType<typeof vi.fn> };
}

const summaryOf = (uri: string, overrides: Record<string, unknown> = {}) => ({
	resource: uri,
	provider: 'manox',
	title: 'Fix the login flow',
	status: 1,
	modifiedAt: '2026-10-13T08:00:00.000Z',
	workingDirectories: ['file:///repo'],
	...overrides,
});

const chatSnapshot = (channel: string, extra: Record<string, unknown> = {}) => ({
	t: 'snapshot' as const,
	channel,
	state: {
		resource: channel,
		title: '',
		status: 1,
		modifiedAt: '2026-10-13T08:00:00.000Z',
		turns: [],
		...extra,
	},
});

/** Seed the session→chat edge the per-thread derivation reads. */
const seedSession = (relay: (msg: RelayToWebview) => void): void => {
	relay({ t: 'snapshot', channel: SESSION, state: { ...summaryOf(SESSION), defaultChat: CHAT } });
};

describe('snapshot seeding', () => {
	it('a session summary snapshot seeds the threads list', () => {
		const { store, relay } = harness();
		relay({ t: 'snapshot', channel: SESSION, state: summaryOf(SESSION) });
		const state = store.get();
		expect(state.threads).toHaveLength(1);
		expect(state.threads[0]?.id).toBe(SESSION);
		expect(state.threads[0]?.title).toBe('Fix the login flow');
		expect(state.threads[0]?.project).toBe('/repo');
	});

	it('a chat snapshot seeds the fold and readies the thread', () => {
		const { store, relay } = harness();
		relay({ t: 'snapshot', channel: SESSION, state: { ...summaryOf(SESSION), defaultChat: CHAT } });
		relay({
			t: 'snapshot',
			channel: CHAT,
			state: {
				resource: CHAT,
				title: 'Fix the login flow',
				status: 1,
				modifiedAt: '2026-10-13T08:00:00.000Z',
				turns: [
					{
						id: 'turn-1',
						startedAt: '2026-10-13T08:00:01.000Z',
						message: { text: 'hello', origin: { kind: 'user' } },
						responseParts: [{ kind: 'markdown', id: 'm1', content: 'hi there' }],
					},
				],
			},
		});
		const thread = store.get().perThread[SESSION];
		expect(thread?.ready).toBe(true);
		expect(thread?.items.map((i) => i.kind)).toEqual(['user', 'assistant']);
		expect(thread?.items[1]?.kind === 'assistant' && thread.items[1].text).toBe('hi there');
	});

	it('the root snapshot derives the model catalogue', () => {
		const { store, relay } = harness();
		relay({
			t: 'snapshot',
			channel: 'ahp-root://',
			state: {
				agents: [
					{
						provider: 'manox',
						displayName: 'manox',
						models: [{ id: 'glm-5', name: 'GLM-5', maxContextWindow: 200_000 }],
					},
				],
			},
		});
		expect(store.get().models).toEqual([
			{ id: 'glm-5', name: 'GLM-5', provider: 'manox', provider_name: 'manox', api: '', context_window: 200_000 },
		]);
	});

	it('a root/agentsChanged action folds the agents payload in place', () => {
		const { store, relay } = harness();
		// The initialize snapshot answers `agents: []` (provider registration
		// completes async); the populated registry arrives as the action.
		relay({ t: 'snapshot', channel: 'ahp-root://', state: { agents: [] } });
		expect(store.get().models).toEqual([]);
		relay({
			t: 'event',
			event: {
				type: 'action',
				envelope: {
					channel: 'ahp-root://',
					action: {
						type: 'root/agentsChanged',
						agents: [
							{
								provider: 'BigModel-anthropic',
								displayName: 'BigModel',
								models: [
									{ id: 'glm-5', name: 'GLM-5', maxContextWindow: 200_000 },
									{ id: 'glm-4-flash', name: 'GLM-4 Flash' },
								],
							},
						],
					},
				},
			},
		});
		expect(store.get().models).toEqual([
			{ id: 'glm-5', name: 'GLM-5', provider: 'BigModel-anthropic', provider_name: 'BigModel', api: '', context_window: 200_000 },
			{ id: 'glm-4-flash', name: 'GLM-4 Flash', provider: 'BigModel-anthropic', provider_name: 'BigModel', api: '', context_window: 0 },
		]);
	});

	it('a root/agentsChanged without an agents array is dropped, not applied', () => {
		const { store, relay } = harness();
		relay({
			t: 'snapshot',
			channel: 'ahp-root://',
			state: { agents: [{ provider: 'p', models: [{ id: 'm', name: 'M' }] }] },
		});
		relay({
			t: 'event',
			event: { type: 'action', envelope: { channel: 'ahp-root://', action: { type: 'root/agentsChanged' } } },
		});
		// No payload → no fold; the previous registry stands.
		expect(store.get().models).toHaveLength(1);
	});

	it('the commands catalogue snapshot fills the slash registry', () => {
		const { store, relay } = harness();
		relay({
			t: 'snapshot',
			channel: 'x-manox-commands://',
			state: { entries: [{ name: 'tutor', description: null, kind: 'command', argument_hint: null }] },
		});
		expect(store.get().commands).toHaveLength(1);
	});
});

describe('action folding', () => {
	it('a chat/turnStarted action folds into the transcript and retires its echo', () => {
		const { store, relay } = harness();
		relay({ t: 'snapshot', channel: SESSION, state: { ...summaryOf(SESSION), defaultChat: CHAT } });
		store.openRemote(SESSION);
		store.setChatUri(SESSION, CHAT);
		relay(chatSnapshot(CHAT));

		// The optimistic echo (the composer parks it with the submission's id).
		store.echoUser(SESSION, 'fix it', undefined, { originRpc: 'turn-9' });
		expect(
			store.get().perThread[SESSION]?.items.some((i) => i.kind === 'user' && i.text === 'fix it'),
		).toBe(true);

		relay({
			t: 'event',
			event: {
				type: 'action',
				envelope: {
					channel: CHAT,
					action: {
						type: 'chat/turnStarted',
						turnId: 'turn-9',
						startedAt: '2026-10-13T08:00:05.000Z',
						message: { text: 'fix it', origin: { kind: 'user' } },
					},
				},
			},
		});
		const thread = store.get().perThread[SESSION];
		// The echo retired; the durable user row renders once.
		const userItems = thread?.items.filter((i) => i.kind === 'user' && i.text === 'fix it') ?? [];
		expect(userItems).toHaveLength(1);
		expect(userItems[0]?.kind === 'user' && userItems[0].turnId).toBe('turn-9');
		expect(thread?.turnActive).toBe(true);
	});

	it('an x-manox pinned action flips the threads row', () => {
		const { store, relay } = harness();
		relay({ t: 'snapshot', channel: SESSION, state: summaryOf(SESSION) });
		relay({
			t: 'event',
			event: {
				type: 'action',
				envelope: { channel: 'x-manox-thread:/s-1', action: { type: EXT_ACTIONS.pinnedChanged, pinned: true } },
			},
		});
		expect(store.get().threads[0]?.pinned).toBe(true);
	});

	it('a sessionRemoved event drops the thread and the per-thread state', () => {
		const { store, relay } = harness();
		relay({ t: 'snapshot', channel: SESSION, state: summaryOf(SESSION) });
		store.openRemote(SESSION);
		relay({ t: 'event', event: { type: 'sessionRemoved', session: SESSION } });
		const state = store.get();
		expect(state.threads).toHaveLength(0);
		expect(state.perThread[SESSION]).toBeUndefined();
		expect(state.view).toBe('threads');
	});

	it('a sessionSummaryChanged event updates the row in place', () => {
		const { store, relay } = harness();
		relay({ t: 'snapshot', channel: SESSION, state: summaryOf(SESSION) });
		relay({
			t: 'event',
			event: { type: 'sessionSummaryChanged', session: SESSION, changes: { title: 'Renamed' } },
		});
		expect(store.get().threads[0]?.title).toBe('Renamed');
	});
});

describe('card derivation', () => {
	const chatWithParts = (parts: unknown[]) =>
		chatSnapshot(CHAT, {
			activeTurn: {
				id: 'turn-1',
				startedAt: '2026-10-13T08:00:01.000Z',
				message: { text: 'go', origin: { kind: 'user' } },
				responseParts: parts,
			},
		});

	it('a pending-confirmation tool call derives an approval card', () => {
		const { store, relay } = harness();
		seedSession(relay);
		relay(chatWithParts([
			{
				kind: 'toolCall',
				toolCall: {
					id: 'call-1', name: 'shell', title: 'Shell',
					status: 'pending-confirmation', input: { cmd: 'rm' },
				},
			},
		]));
		const items = store.get().perThread[SESSION]?.items ?? [];
		const approval = items.find((i) => i.kind === 'approval');
		expect(approval?.kind === 'approval' && approval.callId).toBe('call-1');
	});

	it('a question elicitation derives one ask card per question', () => {
		const { store, relay } = harness();
		seedSession(relay);
		relay(chatWithParts([
			{
				kind: 'inputRequest',
				request: {
					id: 'req-1',
					message: 'Pick one',
					questions: [
						{ id: 'q1', message: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
					],
				},
			},
		]));
		const items = store.get().perThread[SESSION]?.items ?? [];
		const ask = items.find((i) => i.kind === 'ask_question');
		expect(ask?.kind === 'ask_question' && (ask.input as { id?: string }).id).toBe('q1');
	});

	it('a plan-review elicitation derives the plan-review card', () => {
		const { store, relay } = harness();
		seedSession(relay);
		relay(chatWithParts([
			{ kind: 'inputRequest', request: { id: 'plan-review:e-1', message: 'Approve the plan?' } },
		]));
		const items = store.get().perThread[SESSION]?.items ?? [];
		expect(items.some((i) => i.kind === 'plan_review' && i.callId === 'plan-review:e-1')).toBe(true);
	});
});

describe('tolerance (L12)', () => {
	it('snapshots and actions for unknown channels drop without throwing', () => {
		const { store, relay } = harness();
		relay({ t: 'snapshot', channel: 'ahp-canvas:/x', state: { weird: true } });
		relay({
			t: 'event',
			event: { type: 'action', envelope: { channel: 'ahp-canvas:/x', action: { type: 'canvas/ink', x: 1 } } },
		});
		expect(store.get().threads).toHaveLength(0);
	});

	it('unknown relay message types are ignored', () => {
		const { store, relay } = harness();
		relay({ t: 'pong', seq: 1 } as unknown as RelayToWebview);
		expect(store.get()).toBeDefined();
	});
});

describe('view lifecycle', () => {
	it('openRemote asks the effects to view the session', () => {
		const { store, view } = harness();
		store.openRemote(SESSION);
		expect(view).toHaveBeenCalledWith(SESSION);
	});

	it('openRemote marks the thread loading until the chat fold lands', () => {
		const { store, relay } = harness();
		relay({ t: 'snapshot', channel: SESSION, state: { ...summaryOf(SESSION), defaultChat: CHAT } });
		store.openRemote(SESSION);
		expect(store.get().perThread[SESSION]?.loading).toBe(true);
		relay(chatSnapshot(CHAT));
		expect(store.get().perThread[SESSION]?.loading).toBe(false);
		expect(store.get().perThread[SESSION]?.ready).toBe(true);
	});
});
