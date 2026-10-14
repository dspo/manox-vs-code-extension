// The relay client, over a recorded bridge: the pending-request table (settle
// + orphan tolerance), the write-ahead dispatch shapes (submit / approve /
// verdict), and the session lifecycle (newSession rekeys nothing — the AHP
// createSession URI is client-chosen).

import { describe, expect, it, vi } from 'vitest';

import type { ToHost, ToWebview } from '../../messages';
import type { StoreEffects } from '../state/store';
import { Store } from '../state/store';
import { api, connectStore, setBridge, ThreadApi } from './client';
import type { Bridge } from './bridge';

const SESSION = 'ahp-session:/s-1';
const CHAT = 'ahp-chat:/c-1';

/** A recorded bridge: outbound posts are kept; tests fire inbound messages. */
function fakeBridge() {
	const posted: ToHost[] = [];
	const listeners = new Set<(message: ToWebview) => void>();
	const bridge: Bridge = {
		post: (message) => posted.push(message),
		onMessage: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const inbound = (message: ToWebview) => {
		for (const listener of listeners) listener(message);
	};
	return { bridge, posted, inbound };
}

function harness() {
	const fake = fakeBridge();
	setBridge(fake.bridge);
	const store = new Store();
	const effects = {
		view: vi.fn(),
		viewChat: vi.fn(),
		fetchTurns: async () => false,
	} satisfies StoreEffects;
	store.attachEffects(effects);
	return { ...fake, store, effects };
}

describe('dispatch shapes', () => {
	it('submit dispatches chat/turnStarted with the caller id as the turn id', async () => {
		const h = harness();
		connectStore({
			relay: h.store.relay.bind(h.store),
			openRemote: h.store.openRemote.bind(h.store),
			confirmDraft: h.store.confirmDraft.bind(h.store),
			attachEffects: h.store.attachEffects.bind(h.store),
			addCodeChain: h.store.addCodeChain.bind(h.store),
			setChatUri: h.store.setChatUri.bind(h.store),
			chatUriOf: () => CHAT,
			whenChatReady: () => Promise.resolve(CHAT),
			echoUser: h.store.echoUser.bind(h.store),
			conversationInfo: () => null,
		});
		void new ThreadApi(SESSION).submit('fix it', undefined, 'turn-9');
		await new Promise((resolve) => setTimeout(resolve, 0)); // the dispatch rides whenChatReady's microtask
		const dispatch = h.posted.find((m) => m.t === 'dispatch');
		expect(dispatch?.t).toBe('dispatch');
		const action = (dispatch as { action: Record<string, unknown> }).action;
		expect(action.type).toBe('chat/turnStarted');
		expect(action.turnId).toBe('turn-9');
		const message = action.message as { text?: string; origin?: { kind?: string } };
		expect(message.text).toBe('fix it');
		expect(message.origin?.kind).toBe('user');
	});

	it('approve dispatches the confirmed action with the fold id', async () => {
		const h = harness();
		connectStore({
			relay: h.store.relay.bind(h.store),
			openRemote: h.store.openRemote.bind(h.store),
			confirmDraft: h.store.confirmDraft.bind(h.store),
			attachEffects: h.store.attachEffects.bind(h.store),
			addCodeChain: h.store.addCodeChain.bind(h.store),
			setChatUri: h.store.setChatUri.bind(h.store),
			chatUriOf: () => CHAT,
			whenChatReady: () => Promise.resolve(CHAT),
			echoUser: h.store.echoUser.bind(h.store),
			conversationInfo: () => null,
		});
		new ThreadApi(SESSION).approve('call-1', false);
		await new Promise((resolve) => setTimeout(resolve, 0)); // the dispatch rides whenChatReady's microtask
		const dispatch = h.posted.find((m) => m.t === 'dispatch') as { action: Record<string, unknown> };
		expect(dispatch.action.type).toBe('chat/toolCallConfirmed');
		expect(dispatch.action.toolCallId).toBe('call-1');
		expect(dispatch.action.approved).toBe(false);
		expect(dispatch.action.reason).toBe('denied');
	});
});

describe('newSession', () => {
	it('creates with a client-chosen session URI and views it', async () => {
		const h = harness();
		connectStore({
			relay: h.store.relay.bind(h.store),
			openRemote: h.store.openRemote.bind(h.store),
			confirmDraft: h.store.confirmDraft.bind(h.store),
			attachEffects: h.store.attachEffects.bind(h.store),
			addCodeChain: h.store.addCodeChain.bind(h.store),
			setChatUri: h.store.setChatUri.bind(h.store),
			chatUriOf: () => CHAT,
			whenChatReady: () => Promise.resolve(CHAT),
			echoUser: h.store.echoUser.bind(h.store),
			conversationInfo: () => null,
		});
		const pending = api.newSession({ localId: 's-1', text: 'hello' });
		// The createSession req goes out; answer it, then the summary snapshot
		// (which seeds the default chat) and let the flow finish.
		const req = h.posted.find((m) => m.t === 'req') as { id: string; method: string; params: Record<string, unknown> };
		expect(req.method).toBe('createSession');
		expect(req.params.channel).toBe(SESSION);
		h.inbound({ t: 'res', id: req.id, ok: true, result: null });
		h.inbound({
			t: 'snapshot',
			channel: SESSION,
			state: { resource: SESSION, title: '', status: 1, modifiedAt: '', defaultChat: CHAT },
		});
		const created = await pending;
		expect(created).toBe(SESSION);
		// The draft rekey is a no-op (ids match); the view request went out
		// through the relay (connectStore installs the relay-posting effects).
		expect(h.posted.some((m) => m.t === 'view' && m.sessionUri === SESSION)).toBe(true);
		// The first message rode the chat dispatch.
		const dispatch = h.posted.find((m) => m.t === 'dispatch') as { channel: string; action: Record<string, unknown> };
		expect(dispatch.channel).toBe(CHAT);
		expect(dispatch.action.type).toBe('chat/turnStarted');
	});
});
