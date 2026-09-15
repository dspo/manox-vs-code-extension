// VS Code adapter for the resolver seam (§5): every provider rides the
// `vscode.execute*Provider` commands — the only sanctioned way to reach
// language features from a non-editor extension — and results are flattened
// to the plain-data shapes in `resolve.ts`. The pure core never imports this
// module; vitest injects a fake `LspClient` instead.
//
// Provider absence is a resolved empty list, never a rejected promise: an
// uninstalled language extension must degrade the same way the core's
// "no candidates" branch already does (§10 call-hierarchy-unavailable path).

import * as vscode from 'vscode';
import type { ChainRange } from './types';
import type { LspClient, LspItem, LspLocation, LspSymbol, WorkspaceView } from './resolve';

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
 * text-match fallback locate the name. */
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

/** Run an `executeCommand` provider call, swallowing provider absence. */
async function provider<T>(command: string, ...args: unknown[]): Promise<T> {
	try {
		return ((await vscode.commands.executeCommand(command, ...args)) as T | undefined) ?? ([] as T);
	} catch {
		return [] as T;
	}
}

const position = (line: number, character: number): vscode.Position =>
	new vscode.Position(line, character);

export class VscodeLspClient implements LspClient {
	async documentSymbols(uri: string): Promise<LspSymbol[]> {
		const doc = await this.open(uri);
		if (!doc) return [];
		return toSymbols(
			await provider<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri),
		);
	}

	async readText(uri: string): Promise<string> {
		const doc = await this.open(uri);
		return doc?.getText() ?? '';
	}

	async prepareCallHierarchy(
		uri: string,
		pos: { line: number; character: number },
	): Promise<LspItem[]> {
		const doc = await this.open(uri);
		if (!doc) return [];
		const items = await provider<vscode.CallHierarchyItem[]>(
			'vscode.prepareCallHierarchy',
			doc.uri,
			position(pos.line, pos.character),
		);
		return items.map(callItem);
	}

	async outgoingCalls(item: LspItem): Promise<LspItem[]> {
		const calls = await provider<vscode.CallHierarchyOutgoingCall[]>(
			'vscode.provideOutgoingCalls',
			this.anchor(item),
		);
		return calls.map((c) => callItem(c.to));
	}

	async incomingCalls(item: LspItem): Promise<LspItem[]> {
		const calls = await provider<vscode.CallHierarchyIncomingCall[]>(
			'vscode.provideIncomingCalls',
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
			doc.uri,
			position(pos.line, pos.character),
		);
		return items.map(callItem);
	}

	async subtypes(item: LspItem): Promise<LspItem[]> {
		const subs = await provider<vscode.TypeHierarchyItem[]>('vscode.provideSubtypes', this.anchor(item));
		return subs.map(callItem);
	}

	async supertypes(item: LspItem): Promise<LspItem[]> {
		// The VS Code API exposes supertypes only via the item's own
		// provider command pair; the engine currently seeds subtypes only.
		const supers = await provider<vscode.TypeHierarchyItem[]>(
			'vscode.provideSupertypes',
			this.anchor(item),
		);
		return supers.map(callItem);
	}

	async references(
		uri: string,
		pos: { line: number; character: number },
	): Promise<LspLocation[]> {
		const doc = await this.open(uri);
		if (!doc) return [];
		const locs = await provider<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, position(pos.line, pos.character));
		return locs.map((l) => ({ uri: l.uri.toString(), range: chainRange(l.range) }));
	}

	async implementations(
		uri: string,
		pos: { line: number; character: number },
	): Promise<LspLocation[]> {
		const doc = await this.open(uri);
		if (!doc) return [];
		const locs = await provider<vscode.Location[]>('vscode.executeImplementationProvider', doc.uri, position(pos.line, pos.character));
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
	 * providers to have symbols at all. */
	private async open(uri: string): Promise<vscode.TextDocument | null> {
		try {
			return await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
		} catch {
			return null;
		}
	}
}

/** WorkspaceView over the real workspace folders + fs.stat. */
export function vscodeWorkspaceView(): WorkspaceView {
	return {
		folders: () =>
			(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
		fileExists: async (absolutePath: string) => {
			try {
				const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
				return stat.type === vscode.FileType.File;
			} catch {
				return false;
			}
		},
	};
}
