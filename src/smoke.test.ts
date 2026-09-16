// Live integration smoke test against the real manox runtime — the analogue
// of the manox repo's `MANOX_RUN_LIVE` gating. Skipped unless
// `MANOX_SMOKE=1` and `VSCODE_AGENT_HOST_MANOX_SDK_ROOT` (or
// `manox.sdkRoot` via MANOX_SMOKE_SDK_ROOT) point at a staged
// `manox_napi.node` (built by `script/build-napi` in dspo/manox).
//
// Drives the full v2 path in-process: addon load → Initialize handshake →
// Ready → registry pulls → CreateSession → follow (snapshot + projections) →
// Submit receipt. No LLM turn is required; a state root without provider
// config still exercises the whole control plane.
//
// A second case exercises the Code Tutor `registerSessionTools` wire
// against the real server — the snake_case `input_schema`/`read_only` shape
// (guards.test pins it statically; this confirms the running serde reads it).
// The full invoke round-trip additionally needs (a) a model turn and (b) the
// ClientTool capability on the napi handshake (landed in dspo/manox #799); the
// invoke assertion is gated behind `MANOX_SMOKE_CLIENT_TOOL=1` and skipped by
// default, and it implies a provider configured under `MANOX_HOME`.
//
// The napi addon is a process-global singleton (`crates/manox-napi` holds the
// connection in a `static` slot): a second `start()` while the first actor is
// alive returns `actor already started`. Both cases below therefore drive one
// shared transport/connection established in `beforeAll` and disposed in
// `afterAll`, so a single `vitest run` exercises the whole path against one
// addon instance.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentConnection, type Wire } from './client/connection';
import { clientToolSpec, registerSessionTools } from './protocol/builders';
import { clientToolSpecs, TOOL_NAMES } from './codechain/tools';
import { parseFromServer } from './protocol/guards';
import { NapiTransport } from './transport/napiTransport';

const enabled = process.env.MANOX_SMOKE === '1';
const sdkRoot = process.env.VSCODE_AGENT_HOST_MANOX_SDK_ROOT ?? process.env.MANOX_SMOKE_SDK_ROOT;

const maybe = enabled && sdkRoot ? describe : describe.skip;

let transport: NapiTransport | null = null;
let connection: AgentConnection | null = null;

beforeAll(async () => {
	if (!enabled || !sdkRoot) return;
	// The agent runtime resolves its state/provider root from `MANOX_HOME`
	// (pinned to a fresh temp dir unless the operator overrides it). A fresh
	// root has no model configured, so a submit is rejected — still a valid
	// wire contract for the control-plane case.
	transport = NapiTransport.load({
		sdkRoot,
		stateRoot: mkdtempSync(join(tmpdir(), 'manox-smoke-home-')),
		clientId: 'vscode-smoke-test',
	});
	const wire: Wire = {
		send: (frame) => transport!.send(JSON.stringify(frame)),
		onFrame: (handler) =>
			transport!.onRaw((raw) => {
				const frame = parseFromServer(JSON.parse(raw));
				if (frame !== null) handler(frame);
			}),
	};
	connection = new AgentConnection(wire, { idPrefix: 'smoke' });
	await connection.ready;
}, 30_000);

afterAll(async () => {
	// Shutdown releases the addon's global connection slot; the in-process
	// agent server's tasks settle on the disconnected transport.
	await transport?.dispose();
	transport = null;
	connection = null;
});

maybe('live smoke against the real agent server', { timeout: 60_000 }, () => {
	it('handshakes, pulls registries, creates and follows a session', async () => {
		const conn = connection!;
		const threads = await conn.listThreads();
		expect(Array.isArray(threads)).toBe(true);
		const models = await conn.listModels();
		expect(Array.isArray(models)).toBe(true);

		const cwd = mkdtempSync(join(tmpdir(), 'manox-smoke-'));
		const sessionId = await conn.createSession({ cwd, approvalMode: 'read-only' });
		expect(typeof sessionId).toBe('string');
		expect(sessionId.length).toBeGreaterThan(0);

		const handle = conn.follow(sessionId);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('snapshot never arrived')), 15_000);
			handle.onChange(() => {
				if (handle.store.projections.size > 0) {
					clearTimeout(timer);
					resolve();
				}
			});
		});
		// The fresh session's snapshot carries the cwd projection baseline.
		expect(handle.store.projectionValue('cwd')).toBe(cwd);
		expect(handle.store.projectionValue('permission_mode')).toBe('read-only');

		// Submit on a model-less state root: either the receipt lands or the
		// typed model/unresolvable error does — both are valid wire
		// contracts; anything else is a protocol failure.
		const rejected = await conn
			.submit(sessionId, 'hello from the vscode smoke test')
			.then(() => null)
			.catch((e: unknown) => (typeof e === 'object' && e !== null ? e : { message: String(e) }));
		if (rejected !== null) {
			const message = (rejected as { message?: unknown }).message;
			expect(typeof message).toBe('string');
		}

		handle.close();
	});

	// The client-tool registration contract against the running server (§9.1:
	// the ClientToolSpec struct carries NO serde rename_all, so the wire keys
	// are snake_case — a camelCase frame would fail `missing field
	// input_schema`). Registration is not capability-gated, so this exercises
	// the real deserialization path even on the staged lean addon.
	it('registerSessionTools accepts the snake_case tool spec and reports the count', async () => {
		const conn = connection!;
		const sessionId = await conn.createSession({
			cwd: mkdtempSync(join(tmpdir(), 'manox-smoke-tools-')),
			approvalMode: 'read-only',
		});
		const receipt = await conn.call(
			registerSessionTools(sessionId, 'vscode-smoke-tools', clientToolSpecs().map(clientToolSpec)),
		);
		// §9.1: the server echoes `{ registered: <n> }`.
		expect(receipt).toMatchObject({ registered: clientToolSpecs().length });

		// The invoke round-trip needs a model turn (the ClientTool capability
		// landed in dspo/manox #799): opt-in, implies a provider configured
		// under `MANOX_HOME`.
		if (process.env.MANOX_SMOKE_CLIENT_TOOL === '1') {
			let invoked = false;
			const unsub = conn.onFrame((frame) => {
				if (
					frame.kind === 'request' &&
					frame.call.method === 'invokeClientTool' &&
					frame.call.name === TOOL_NAMES.entry
				) {
					invoked = true;
					conn.sendRaw({
						kind: 'reply',
						id: frame.id,
						outcome: { Ok: { content: JSON.stringify({ ok: true }), isError: false } },
					});
				}
			});
			await conn.submit(sessionId, '/tutor smoke');
			// Best-effort wait for a turn to reach a tool call; a
			// provider-less state root simply never invokes — the flag
			// implies a configured model.
			for (let i = 0; i < 60 && !invoked; i += 1) {
				await new Promise((r) => setTimeout(r, 1000));
			}
			unsub();
			expect(invoked).toBe(true);
		}
	});
});
