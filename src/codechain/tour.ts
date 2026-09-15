// Tour flattening (§6.3): the panel's 上一步/下一步 walk the tree in DFS
// preorder, skipping nodes the editor cannot jump to. Pure functions over
// the model — the cursor itself lives with the panel host (tour.ts is the
// O(n) source tested against fixtures).

import type { CodeChain, ResolvedNode } from './types';

/** True when a click on this node can land the editor somewhere: resolved
 * with a range, or ambiguous with at least one candidate to pick from.
 * `stale` still counts — navigation attempts a live re-resolve (§10). */
export const isNavigable = (node: ResolvedNode): boolean =>
	(node.location.range !== undefined || (node.location.candidates?.length ?? 0) > 0) &&
	node.location.resolveStatus !== 'unresolved';

/** DFS preorder of the whole tree (panel order + counts). */
export function flattenPreorder(root: ResolvedNode): ResolvedNode[] {
	const out: ResolvedNode[] = [];
	const walk = (node: ResolvedNode): void => {
		out.push(node);
		for (const child of node.children) walk(child);
	};
	walk(root);
	return out;
}

/** DFS preorder restricted to navigable nodes — the tour array (§6.3:
 * `unresolved` nodes are skipped; the panel walks this with a cursor). */
export function tourOrder(chain: CodeChain): ResolvedNode[] {
	return flattenPreorder(chain.root).filter(isNavigable);
}

/** Advance a tour cursor. `dir` is the requested step; `index` is the
 * current position (-1 = before the first stop). Out-of-range and
 * already-at-the-end clamp; a tour with no stops returns null. */
export function stepTour(
	tour: ResolvedNode[],
	index: number,
	dir: 'prev' | 'next',
): { index: number; node: ResolvedNode } | null {
	if (tour.length === 0) return null;
	const target = dir === 'next' ? index + 1 : index - 1;
	if (target < 0 || target >= tour.length) {
		// Wrap-free: repeated presses pin at the ends so the cursor never
		// races ahead of the highlight.
		const clamped = dir === 'next' ? tour.length - 1 : 0;
		if (clamped === index) return null;
		return { index: clamped, node: tour[clamped] as ResolvedNode };
	}
	return { index: target, node: tour[target] as ResolvedNode };
}
