// The client-tool registration lifecycle controller — extracted from
// `registration.ts` so it is vscode-free and unit-testable against a fake
// host (§9.2, review #4/#19). The caller (`ensureCodeChain`) wires it to the
// real `ManoxClient`.
//
// Under AHP the contribution is the `session/activeClientSet` action: the
// dispatched client bag lands in `SessionState.activeClients[]` and every
// subscriber folds the same state. Registration is in-memory + session-scoped
// + a FULL REPLACE per (session, clientId), so replaying the complete set is
// the idempotent recovery for every lifecycle edge. Dispatch is write-ahead
// (no wire receipt): a refused write surfaces as the echoed envelope's
// `rejectionReason` and is logged from the fold, not here. The `inFlight`
// guard exists ONLY to collapse a concurrent burst (e.g. `sessionAdded`
// racing a sidebar claim), NOT as a permanent "seen this session" set: a
// disposed-then-cold-reopened session under the SAME id must re-register, so
// `onSessionDisposed` frees the slot and a settled session is freely
// re-registered on the next edge.
//
// The no-workspace-folder case (§10) skips with a log: the tools would fail
// every file resolution anyway, and an unregistered set keeps the LLM on its
// documented no-client-tool paths.

import type { ToolDefinition } from '@microsoft/agent-host-protocol';
import type { ToolSpec } from './tools';

/** Internal ToolSpec → AHP `ToolDefinition` (the `session/activeClientSet`
 * contribution shape). The AHP face reads `inputSchema` (camelCase) and
 * takes the read-only hint from `annotations.readOnlyHint`; the kernel then
 * derives its own snake_case spec (upstream `client_tool_spec`). Lives here
 * (vscode-free) so the smoke test can pin the conversion. */
export function toToolDefinition(spec: ToolSpec): ToolDefinition {
	return {
		name: spec.name,
		description: spec.description,
		inputSchema: {
			type: 'object',
			...(typeof spec.inputSchema.properties === 'object' && spec.inputSchema.properties !== undefined
				? { properties: spec.inputSchema.properties as Record<string, object> }
				: {}),
			...(Array.isArray(spec.inputSchema.required) ? { required: spec.inputSchema.required as string[] } : {}),
		},
		annotations: { readOnlyHint: spec.readOnly },
	};
}

export interface RegistrarHost {
	/** Dispatch the `session/activeClientSet` contribution for `sessionUri`.
	 * Write-ahead: resolves once the dispatch notification is handed to the
	 * transport (the fold is the confirmation face). */
	send(sessionUri: string, tools: ToolDefinition[]): Promise<unknown>;
	hasWorkspace(): boolean;
	log(message: string): void;
	/** The tool set to replay — supplied by the caller so the test can pin
	 * the exact definitions sent. */
	tools(): ToolDefinition[];
}

export class SessionToolRegistrar {
	/** Sessions with a register call in flight (dedup only the concurrent
	 * burst, not the process lifetime — review #4). */
	private readonly inFlight = new Set<string>();
	private readonly specs: ToolDefinition[];

	constructor(private readonly host: RegistrarHost) {
		this.specs = host.tools();
	}

	registerSession(sessionUri: string): void {
		if (!sessionUri || this.inFlight.has(sessionUri)) return;
		if (!this.host.hasWorkspace()) {
			this.host.log('no workspace folder — client tools not registered');
			return;
		}
		this.inFlight.add(sessionUri);
		void this.host
			.send(sessionUri, this.specs)
			.then(
				() => this.host.log(`client tools contributed to ${sessionUri} (session/activeClientSet)`),
				(e) => this.host.log(`activeClientSet(${sessionUri}) failed: ${String(e)}`),
			)
			// Always release the in-flight slot: a later lifecycle edge
			// (re-open, next claim) retries the replace.
			.finally(() => this.inFlight.delete(sessionUri));
	}

	/** The host reported a session gone: drop any bookkeeping so a cold
	 * re-open under the same id re-registers (the in-memory registration
	 * died with it, §9.2). */
	onSessionDisposed(sessionUri: string): void {
		this.inFlight.delete(sessionUri);
	}
}
