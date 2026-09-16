// Tree → visible-row flattening for the DOM recursive renderer (§6.1: the
// collapsed case just drops rows, which keeps the list virtual-scroll-ready).
// Pure functions so the jsdom tests can assert visible order independently
// of React rendering.

import type { ResolvedNode } from '../../../src/codechain/types';

export interface VisibleRow {
	node: ResolvedNode;
	depth: number;
	hasChildren: boolean;
	collapsed: boolean;
}

/** DFS preorder, skipping the subtrees of collapsed ancestors. */
export function flattenVisible(root: ResolvedNode, collapsed: ReadonlySet<string>): VisibleRow[] {
	const rows: VisibleRow[] = [];
	const walk = (node: ResolvedNode, depth: number): void => {
		const hasChildren = node.children.length > 0;
		const isCollapsed = collapsed.has(node.id);
		rows.push({ node, depth, hasChildren, collapsed: isCollapsed });
		if (hasChildren && !isCollapsed) {
			for (const child of node.children) walk(child, depth + 1);
		}
	};
	walk(root, 0);
	return rows;
}

/** All node ids (collapse-all helper for the ⟳/⤢ affordances). */
export function allNodeIds(root: ResolvedNode): string[] {
	const out: string[] = [];
	const walk = (node: ResolvedNode): void => {
		out.push(node.id);
		for (const child of node.children) walk(child);
	};
	walk(root);
	return out;
}

/** `file:line` label for the detail header (0-based range → 1-based
 * display). Draft-relative path when the resolver carried one (§3); host-
 * expanded nodes fall back to the file name. */
export function locationLabel(node: ResolvedNode): string {
	const file =
		node.location.file ?? node.location.uri.split('/').pop() ?? node.location.uri;
	if (!file) return '';
	const range = node.location.range ?? node.location.candidates?.[0]?.range;
	return range ? `${file}:${range.startLine + 1}` : file;
}
