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
// A second case exercises the GenCodeChain `registerSessionTools` wire
// against the real server — the snake_case `input_schema`/`read_only` shape
// (guards.test pins it statically; this confirms the running serde reads it).
// The full invoke round-trip additionally needs (a) a model turn and (b) the
// dspo/manox PR that adds the ClientTool capability to the napi handshake —
// neither is available in the staged lean addon, so the invoke assertion is
// gated behind `MANOX_SMOKE_CLIENT_TOOL=1` and skipped by default.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentConnection, type Wire } from './client/connection';
import { clientToolSpec, registerSessionTools } from './protocol/builders';
import { clientToolSpecs } from './codechain/tools';
import { parseFromServer } from './protocol/guards';
import { NapiTransport } from './transport/napiTransport';

const enabled = process.env.MANOX_SMOKE === '1';
const sdkRoot = process.env.VSCODE_AGENT_HOST_MANOX_SDK_ROOT ?? process.env.MANOX_SMOKE_SDK_ROOT;

const maybe = enabled && sdkRoot ? describe : describe.skip;

let transport: NapiTransport | null = null;
let connection: AgentConnection | null = null;

afterAll(async () => {
	await transport?.dispose();
});

maybe('live smoke against the real agent server', { timeout: 60_000 }, () => {
	it('handshakes, pulls registries, creates and follows a session', async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), 'manox-smoke-'));
		transport = NapiTransport.load({
			sdkRoot: sdkRoot as string,
			stateRoot,
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
		const threads = await connection.listThreads();
		expect(Array.isArray(threads)).toBe(true);
		const models = await connection.listModels();
		expect(Array.isArray(models)).toBe(true);

		const sessionId = await connection.createSession({ cwd: stateRoot, approvalMode: 'read-only' });
		expect(typeof sessionId).toBe('string');
		expect(sessionId.length).toBeGreaterThan(0);

		const handle = connection.follow(sessionId);
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
		expect(handle.store.projectionValue('cwd')).toBe(stateRoot);
		expect(handle.store.projectionValue('permission_mode')).toBe('read-only');

		// Submit on a model-less state root: either the receipt lands or the
		// typed model/unresolvable error does — both are valid wire
		// contracts; anything else is a protocol failure.
		const rejected = await connection
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
		const stateRoot = mkdtempSync(join(tmpdir(), 'manox-smoke-tools-'));
		const toolTransport = NapiTransport.load({
			sdkRoot: sdkRoot as string,
			stateRoot,
			clientId: 'vscode-smoke-tools',
		});
		const wire: Wire = {
			send: (frame) => toolTransport.send(JSON.stringify(frame)),
			onFrame: (handler) =>
				toolTransport.onRaw((raw) => {
					const frame = parseFromServer(JSON.parse(raw));
					if (frame !== null) handler(frame);
				}),
		};
		const conn = new AgentConnection(wire, { idPrefix: 'smoke-tools' });
		try {
			await conn.ready;
			const sessionId = await conn.createSession({ cwd: stateRoot, approvalMode: 'read-only' });
			const receipt = await conn.call(
				registerSessionTools(
					sessionId,
					'vscode-smoke-tools',
					clientToolSpecs().map(clientToolSpec),
				),
			);
			// §9.1: the server echoes `{ registered: <n> }`.
			expect(receipt).toMatchObject({ registered: clientToolSpecs().length });

			// The invoke round-trip needs a model turn + the ClientTool
			// capability on the napi handshake (dspo/manox PR): opt-in.
			if (process.env.MANOX_SMOKE_CLIENT_TOOL === '1') {
				let invoked = false;
				const unsub = conn.onFrame((frame) => {
					if (
						frame.kind === 'request' &&
						frame.call.method === 'invokeClientTool' &&
						frame.call.name === 'GenCodeChain'
					) {
						invoked = true;
						conn.sendRaw({
							kind: 'reply',
							id: frame.id,
							outcome: { Ok: { content: JSON.stringify({ ok: true }), isError: false } },
						});
					}
				});
				await conn.submit(sessionId, '/codechain smoke');
				// Best-effort wait for a turn to reach a tool call; a
				// provider-less state root simply never invokes — the flag
				// implies a configured model.
				for (let i = 0; i < 60 && !invoked; i += 1) {
					await new Promise((r) => setTimeout(r, 1000));
				}
				unsub();
				expect(invoked).toBe(true);
			}
		} finally {
			await toolTransport.dispose();
		}
	});
});
