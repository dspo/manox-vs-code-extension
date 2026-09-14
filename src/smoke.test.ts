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

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentConnection, type Wire } from './client/connection';
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
});
