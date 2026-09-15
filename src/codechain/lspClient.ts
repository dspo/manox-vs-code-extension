// VS Code adapter for the resolver seam (§5): every provider rides the
// `vscode.execute*Provider` commands — the only sanctioned way to reach
// language features from a non-editor extension — and results are flattened
// to the plain-data shapes in `resolve.ts`. The pure core never imports this
// module; vitest injects a fake `LspClient` instead.
//
// Two boundaries this adapter owns that the core must NOT reimplement:
//   * platform path/uri semantics — `vscode.Uri.file` (Windows drive letters,
//     percent-encoding, `#`/`%` in names); a hand-built `file://${abs}` would
//     be pathological on Windows and for special filenames (review #9);
//   * liveness — every provider call races `PROVIDER_TIMEOUT_MS` so a wedged
//     language server degrades to "no symbols here", never a hang that
//     outlasts the server's 300s tool CALL_TIMEOUT (review #10).

import * as vscode from 'vscode';
import type { ChainRange } from './types';
import type { LspClient, LspItem, LspLocation, LspSymbol, WorkspaceView } from './resolve';
import { PROVIDER_TIMEOUT_MS } from './resolve';

const chainRange = (r: vscode.Range): ChainRange => ({
	startLine: r.start.line,
	startCharacter: r.start.character,
	endLine: r.end.line,
	endCharacter: r.end.character,
});

const callItem = (item: vscode.CallHierarchyItem | vscode.TypeHierarchyItem): LspItem => ({
	name: item.name,
	uri: item.uri.toString(),
	range: chainRange(item.range),
	selectionRange: chainRange(item.selectionRange),
});

/** DocumentSymbol[] (hierarchical). `SymbolInformation[]` (flat, legacy
 * providers) carries no range at all — treat it as no symbols and let the
 * workspace-symbol / text fallbacks locate the name. */
function toSymbols(symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[]): LspSymbol[] {
	if (symbols.length > 0 && 'range' in (symbols[0] as vscode.DocumentSymbol)) {
		return (symbols as vscode.DocumentSymbol[]).map((s) => ({
			name: s.name,
			detail: s.detail,
			range: chainRange(s.range),
			selectionRange: chainRange(s.selectionRange),
			children: toSymbols(s.children ?? []),
		}));
	}
	return [];
}

/** Race a provider command against the per-call budget, swallowing both
 * provider absence (rejected command) and a timeout into `onStall`. */
async function provider<T>(command: string, onStall: T, ...args: unknown[]): Promise<T> {
	// executeCommand returns a Thenable that rejects for an unknown command;
	// coerce it, then race the settled promise against the timeout. A
	// resolved-but-undefined body (provider answered "nothing") is `onStall`.
	const call = Promise.resolve(vscode.commands.executeCommand(command, ...args) as T | undefined).catch(
		() => onStall,
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stall = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(onStall), PROVIDER_TIMEOUT_MS);
	});
	try {
		return (await Promise.race([call, stall])) ?? onStall;
	} finally {
		clearTimeout(timer);
	}
}

const position = (line: number, character: number): vscode.Position =>
	new vscode.Position(line, character);

const NONE: never[] = [];

export class VscodeLspClient implements LspClient {
	async documentSymbols(uri: string): Promise<LspSymbol[]> {
		const doc = await this.open(uri);
		if (!doc) return [];
		return toSymbols(
			await provider<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', NONE, doc.uri),
		);
	}

	async readText(uri: string): Promise<string> {
		const doc = await this.open(uri);
		return doc?.getText() ?? '';
	}

	async workspaceSymbols(query: string): Promise<LspLocation[]> {
		// §5 zero-hit fallback. `executeWorkspaceSymbolProvider` wants
		// (query[, token]) and returns SymbolInformation[]; the range on
		// those rows is the declaration range.
		const infos = await provider<vscode.SymbolInformation[]>(
			'vscode.executeWorkspaceSymbolProvider',
			NONE,
			query,
		);
		return infos
			.filter((s) => s.location)
			.map((s) => ({
				uri: s.location.uri.toString(),
				range: chainRange(s.location.range),
				name: s.name,
			}));
	}

	async prepareCallHierarchy(
		uri: string,
		pos: { line: number; character: number },
	): Promise<LspItem[]> {
		const doc = await this.open(uri);
		if (!doc) return [];
		const items = await provider<vscode.CallHierarchyItem[]>(
			'vscode.prepareCallHierarchy',
			NONE,
			doc.uri,
			position(pos.line, pos.character),
		);
		return items.map(callItem);
	}

	async outgoingCalls(item: LspItem): Promise<LspItem[]> {
		const calls = await provider<vscode.CallHierarchyOutgoingCall[]>(
			'vscode.provideOutgoingCalls',
			NONE,
			this.anchor(item),
		);
		return calls.map((c) => callItem(c.to));
	}

	async incomingCalls(item: LspItem): Promise<LspItem[]> {
		const calls = await provider<vscode.CallHierarchyIncomingCall[]>(
			'vscode.provideIncomingCalls',
			NONE,
			this.anchor(item),
		);
		return calls.map((c) => callItem(c.from));
	}

	async prepareTypeHierarchy(
		uri: string,
		pos: { line: number; character: number },
	): Promise<LspItem[]> {
		const doc = await this.open(uri);
		if (!doc) return [];
		const items = await provider<vscode.TypeHierarchyItem[]>(
			'vscode.prepareTypeHierarchy',
			NONE,
			doc.uri,
			position(pos.line, pos.character),
		);
		return items.map(callItem);
	}

	async subtypes(item: LspItem): Promise<LspItem[]> {
		const subs = await provider<vscode.TypeHierarchyItem[]>('vscode.provideSubtypes', NONE, this.anchor(item));
		return subs.map(callItem);
	}

	async supertypes(item: LspItem): Promise<LspItem[]> {
		const supers = await provider<vscode.TypeHierarchyItem[]>('vscode.provideSupertypes', NONE, this.anchor(item));
		return supers.map(callItem);
	}

	async references(
		uri: string,
		pos: { line: number; character: number },
	): Promise<LspLocation[]> {
		const doc = await this.open(uri);
		if (!doc) return [];
		const locs = await provider<vscode.Location[]>('vscode.executeReferenceProvider', NONE, doc.uri, position(pos.line, pos.character));
		return locs.map((l) => ({ uri: l.uri.toString(), range: chainRange(l.range) }));
	}

	async implementations(
		uri: string,
		pos: { line: number; character: number },
	): Promise<LspLocation[]> {
		const doc = await this.open(uri);
		if (!doc) return [];
		const locs = await provider<vscode.Location[]>('vscode.executeImplementationProvider', NONE, doc.uri, position(pos.line, pos.character));
		return locs.map((l) => ({ uri: l.uri.toString(), range: chainRange(l.range) }));
	}

	/** Providers are item-identity keyed; hand back the original item shape
	 * they issued from (VS Code matches on uri+range internally). */
	private anchor(item: LspItem): unknown {
		return {
			uri: vscode.Uri.parse(item.uri),
			name: item.name,
			range: new vscode.Range(
				item.range.startLine,
				item.range.startCharacter,
				item.range.endLine,
				item.range.endCharacter,
			),
			selectionRange: new vscode.Range(
				item.selectionRange.startLine,
				item.selectionRange.startCharacter,
				item.selectionRange.endLine,
				item.selectionRange.endCharacter,
			),
		};
	}

	/** Open without focusing; the document must be material for most
	 * providers to have symbols at all. Bounded so a cold-file open cannot
	 * stall behind the same wedge as a provider. */
	private async open(uri: string): Promise<vscode.TextDocument | null> {
		try {
			return await withTimeout(
				Promise.resolve(vscode.workspace.openTextDocument(vscode.Uri.parse(uri))),
				PROVIDER_TIMEOUT_MS,
				null,
			);
		} catch {
			return null;
		}
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, onStall: T): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stall = new Promise<T | null>((resolve) => {
		timer = setTimeout(() => resolve(onStall), ms);
	});
	return Promise.race([promise, stall]).finally(() => clearTimeout(timer)) as Promise<T | null>;
}

/** WorkspaceView over the real workspace folders, fs.stat, and — the piece
 * the hand-built uri could not do safely — `vscode.Uri.file`/`fsPath` for
 * the platform path↔uri conversions (review #9). */
export function vscodeWorkspaceView(): WorkspaceView {
	return {
		folders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
		fileExists: async (absolutePath: string) => {
			try {
				const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
				return stat.type === vscode.FileType.File;
			} catch {
				return false;
			}
		},
		toUri: (absolutePath: string) => vscode.Uri.file(absolutePath).toString(),
		toPath: (uri: string) => {
			try {
				const parsed = vscode.Uri.parse(uri);
				return parsed.scheme === 'file' ? parsed.fsPath : null;
			} catch {
				return null;
			}
		},
	};
}
