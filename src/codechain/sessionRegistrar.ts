// The `registerSessionTools` lifecycle controller — extracted from
// `registration.ts` so it is vscode-free and unit-testable against a fake
// host (§9.2, review #4/#19). The caller (`ensureCodeChain`) wires it to the
// real `AgentConnection`.
//
// Registration is in-memory + session-scoped + a FULL REPLACE per
// (session, clientId) on the server, so replaying the complete set is the
// idempotent recovery for every lifecycle edge. The `inFlight` guard exists
// ONLY to collapse a concurrent burst (e.g. `sessionCreated` racing a
// follow-stream claim), NOT as a permanent "seen this session" set: a
// disposed-then-cold-reopened session under the SAME id must re-register
// (review #4), so `onSessionDisposed` frees the slot and a settled session is
// freely re-registered on the next edge.
//
// The no-workspace-folder case (§10) skips with a log: the tools would fail
// every file resolution anyway, and an unregistered set keeps the LLM on its
// documented no-client-tool paths.

import type { ClientToolSpec } from '../protocol/types';

export interface RegistrarHost {
	/** Fire a RegisterSessionTools call; resolves with the `{registered:n}`
	 * receipt or rejects. */
	send(sessionId: string, tools: ClientToolSpec[]): Promise<unknown>;
	hasWorkspace(): boolean;
	log(message: string): void;
	/** The tool set to replay — supplied by the caller so the test can pin
	 * the exact specs sent. */
	tools(): ClientToolSpec[];
}

export class SessionToolRegistrar {
	/** Sessions with a register call in flight (dedup only the concurrent
	 * burst, not the process lifetime — review #4). */
	private readonly inFlight = new Set<string>();
	private readonly specs: ClientToolSpec[];

	constructor(private readonly host: RegistrarHost) {
		this.specs = host.tools();
	}

	registerSession(sessionId: string): void {
		if (!sessionId || this.inFlight.has(sessionId)) return;
		if (!this.host.hasWorkspace()) {
			this.host.log('no workspace folder — client tools not registered');
			return;
		}
		this.inFlight.add(sessionId);
		void this.host
			.send(sessionId, this.specs)
			.then(
				(receipt) => this.host.log(`client tools registered for ${sessionId}: ${JSON.stringify(receipt)}`),
				(e) => this.host.log(`registerSessionTools(${sessionId}) failed: ${String(e)}`),
			)
			// Always release the in-flight slot: a later lifecycle edge
			// (re-open, next follow) retries the replace.
			.finally(() => this.inFlight.delete(sessionId));
	}

	/** Server reported a session gone: drop any bookkeeping so a cold
	 * re-open under the same id re-registers (the in-memory registration
	 * died with it, §9.2). */
	onSessionDisposed(sessionId: string): void {
		this.inFlight.delete(sessionId);
	}
}
