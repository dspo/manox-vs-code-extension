// Boot facts the extension host pushes at panel resolve (`{t:'boot'}` /
// `{t:'config'}` envelopes) that the sandboxed webview cannot read itself:
// the workspace cwd and the configured approval mode. Consumed by the api
// layer's CreateSession intent — the same facts the host would have used
// when lifecycle was host-orchestrated.

export interface BootFacts {
	cwd: string | null;
	approvalMode: string | null;
}

const facts: BootFacts = { cwd: null, approvalMode: null };

export function setBootFacts(patch: Partial<BootFacts>): void {
	if (patch.cwd !== undefined) facts.cwd = patch.cwd;
	if (patch.approvalMode !== undefined) facts.approvalMode = patch.approvalMode;
}

export function getBootFacts(): Readonly<BootFacts> {
	return facts;
}
