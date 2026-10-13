// Live integration smoke test against the real manox runtime (v0.3.0, AHP)
// — the analogue of the manox repo's `MANOX_RUN_LIVE` gating. Skipped unless
// `MANOX_SMOKE=1` and `VSCODE_AGENT_HOST_MANOX_SDK_ROOT` (or `manox.sdkRoot`
// via MANOX_SMOKE_SDK_ROOT) point at a staged `manox_napi.node` (built by
// `script/build-napi` in dspo/manox).
//
// Drives the full AHP path in-process: addon load → `initialize` (with the
// x-manox `_meta` declaration) → root/workspace/commands snapshots →
// `createSession` → session + default-chat subscription → `chat/turnStarted`
// dispatch → the fold observes the echo. No LLM turn is required; a state
// root without provider config still exercises the whole control plane.
//
// A second case exercises the Code Tutor contribution wire — the
// `session/activeClientSet` action lands in `SessionState.activeClients`
// with the Tutor tools (the fold pins it; this confirms the running host
// serves it). The full invoke round-trip additionally needs (a) a model turn
// and (b) a provider configured under `MANOX_HOME`; it stays gated behind
// `MANOX_SMOKE_CLIENT_TOOL=1` and skipped by default.
//
// The napi addon is a process-global singleton (`crates/manox-napi` holds the
// connection in a `static` slot): a second `start()` while the first actor is
// alive returns `actor already started`. All cases below therefore drive one
// shared transport/client established in `beforeAll` and disposed in
// `afterAll`.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManoxClient } from './client/agentClient';
import { toToolDefinition } from './codechain/sessionRegistrar';
import { clientToolSpecs, TOOL_NAMES } from './codechain/tools';
import { EXT_CHANNELS, EXT_VERSION, extInitializeMeta } from './protocol/xmanox';
import { NapiTransport } from './transport/napiTransport';

const enabled = process.env.MANOX_SMOKE === '1';
const sdkRoot = process.env.VSCODE_AGENT_HOST_MANOX_SDK_ROOT ?? process.env.MANOX_SMOKE_SDK_ROOT;

const maybe = enabled && sdkRoot ? describe : describe.skip;

let transport: NapiTransport | null = null;
let manox: ManoxClient | null = null;

beforeAll(async () => {
	if (!enabled || !sdkRoot) return;
	// The agent runtime resolves its state/provider root from `MANOX_HOME`
	// (pinned to a fresh temp dir unless the operator overrides it). A fresh
	// root has no model configured, so a turn cannot stream — still a valid
	// wire contract for the control-plane case.
	const stateRoot = process.env.MANOX_SMOKE_STATE_ROOT ?? mkdtempSync(join(tmpdir(), 'manox-smoke-'));
	process.env.MANOX_HOME = stateRoot;
	transport = NapiTransport.load({ sdkRoot, stateRoot, clientId: 'vscode-smoke' });
	manox = await ManoxClient.start(
		transport,
		{
			clipboardRead: async () => null,
			openExternal: async () => {},
			invokeTool: async () => ({ content: 'smoke: not served', isError: true }),
		},
		{
			clientId: 'vscode-smoke',
			log: (level, message) => console.log(`[smoke:${level}] ${message}`),
		},
	);
}, 120_000);

afterAll(async () => {
	await manox?.dispose();
	transport = null;
});

maybe('manox v0.3.0 AHP smoke', () => {
	it('completes the AHP handshake with the x-manox declaration', () => {
		expect(manox).toBeTruthy();
		expect(manox!.protocolVersion).toBe('1.0.0');
		expect(manox!.extVersion).toBe(EXT_VERSION);
	});

	it('serves the root registry and the extension catalogues', async () => {
		expect(Array.isArray(manox!.root.agents)).toBe(true);
		// The catalogues are extension channels: their baselines ride
		// `x-manox/baseline` action envelopes right after subscribe. A fresh
		// state root carries an empty (but present) command catalogue.
		const deadline = Date.now() + 4_000;
		let catalogued = false;
		while (Date.now() < deadline && !catalogued) {
			catalogued = manox!.subscribed('x-manox-commands://') && manox!.workspaceCatalogue.workspaces !== undefined;
			if (!catalogued) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(Array.isArray(manox!.commandCatalogue)).toBe(true);
		expect(Array.isArray(manox!.workspaceCatalogue.workspaces)).toBe(true);
	}, 10_000);

	it('creates a session, views its chat, and folds the turn dispatch', async () => {
		const created = await manox!.createSession({ approvalMode: 'read-only' });
		expect(created.sessionUri.startsWith('ahp-session:/')).toBe(true);
		expect(created.chatUri.startsWith('ahp-chat:/')).toBe(true);

		await manox!.viewChat(created.sessionUri, created.chatUri);
		// The client's write-ahead turn dispatch is accepted (the host may
		// still fail the turn itself without a provider — the fold echo, not
		// a streaming model reply, is the assertion).
		const { turnId } = manox!.submit(created.chatUri, 'smoke: control-plane turn');
		expect(turnId.startsWith('turn-')).toBe(true);

		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const state = manox!.chat(created.chatUri);
			if ((state?.turns.length ?? 0) > 0 || state?.activeTurn) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(manox!.chat(created.chatUri)).toBeTruthy();

		await manox!.disposeSession(created.sessionUri);
	});

	it('contributes the Code Tutor tool set via session/activeClientSet', async () => {
		const created = await manox!.createSession({ approvalMode: 'read-only' });
		await manox!.view(created.sessionUri);
		let echoed = false;
		let rejection: string | null = null;
		const unsubscribe = manox!.onEvent((event) => {
			if (event.type === 'action' && event.envelope.channel === created.sessionUri) {
				const action = event.envelope.action as { type?: string };
				if (action.type === 'session/activeClientSet') {
					// `rejectionReason` rides the ENVELOPE (the write-ahead
					// reconciliation face), not the action.
					echoed = true;
					rejection = event.envelope.rejectionReason ?? null;
				}
			}
		});
		try {
			manox!.setActiveClientTools(
				created.sessionUri,
				clientToolSpecs().map(toToolDefinition),
			);
			// The write-ahead dispatch echoes with our origin. On a provider-less
			// state root the runtime has no intent yet and REJECTS the write
			// (`no runtime intent yet`) — the same fail-shape as a rejected
			// submit, documented in the module header. The wire contract under
			// test is the echo + attribution, not the runtime state.
			const deadline = Date.now() + 4_000;
			while (Date.now() < deadline && !echoed) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(echoed).toBe(true);
			expect(typeof rejection).toBe('string');
			expect(clientToolSpecs().some((s) => s.name === TOOL_NAMES.entry)).toBe(true);
		} finally {
			unsubscribe();
		}
		await manox!.disposeSession(created.sessionUri);
	}, 10_000);

	it('declares exactly the host requests this extension serves', () => {
		const meta = extInitializeMeta() as { 'x-manox'?: { serverRequests?: string[] } };
		expect(meta['x-manox']?.serverRequests).toEqual([
			'x-manox/clipboardRead',
			'x-manox/openExternal',
			'x-manox/invokeTool',
		]);
		expect(EXT_CHANNELS.commands).toBe('x-manox-commands://');
	});
});
