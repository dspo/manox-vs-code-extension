// Tour flattening over the shared fixture (§11): the preorder array the
// panel's 上一步/下一步 walks, and the cursor algebra (clamp-at-ends, skip
// `unresolved`, keep `ambiguous` — a candidate is still a jump target).

import { describe, expect, it } from 'vitest';

import fixtures from '../../test-fixtures/codechain-cases.json';
import type { CodeChain, ResolvedNode } from './types';
import { flattenPreorder, isNavigable, stepTour, tourOrder } from './tour';

const chain = fixtures.chain as unknown as CodeChain;

describe('tour flatten + cursor (fixture-backed)', () => {
	it('flattenPreorder walks the whole tree in DFS preorder', () => {
		expect(flattenPreorder(chain.root).map((n) => n.id)).toEqual([
			'handler.create',
			'service.create',
			'stock.validate',
			'stock.deduct',
			'note.txn',
			'event.emitted',
			'broken.hallucinated',
		]);
	});

	it('the tour skips unresolved nodes and keeps ambiguous ones (§6.3)', () => {
		const ids = tourOrder(chain).map((n) => n.id);
		expect(ids).toEqual((fixtures.tour.order as string[]).concat([]));
		for (const skipped of fixtures.tour.skipped as string[]) {
			expect(ids).not.toContain(skipped);
		}
		// `stock.deduct` is ambiguous but has candidates — still a stop.
		expect(ids).toContain('stock.deduct');
	});

	it('isNavigable requires a jump target and a not-dead status', () => {
		const byId = new Map(flattenPreorder(chain.root).map((n) => [n.id, n]));
		expect(isNavigable(byId.get('handler.create') as ResolvedNode)).toBe(true);
		expect(isNavigable(byId.get('stock.deduct') as ResolvedNode)).toBe(true);
		expect(isNavigable(byId.get('broken.hallucinated') as ResolvedNode)).toBe(false);
		// A `note` with no file/location never gets a range → not navigable.
		expect(isNavigable(byId.get('note.txn') as ResolvedNode)).toBe(false);
	});

	it('stepTour advances, clamps at the ends, and nulls on an empty tour', () => {
		const tour = tourOrder(chain);
		expect(tour.length).toBe(5);
		// From before the start, `next` lands on the first stop.
		const first = stepTour(tour, -1, 'next');
		expect(first).toMatchObject({ index: 0 });
		expect(first?.node.id).toBe(tour[0]?.id);
		// Walking to the end clamps: repeated presses stay on the last stop.
		let at = 0;
		for (let i = 0; i < 10; i += 1) {
			const stepped = stepTour(tour, at, 'next');
			if (!stepped) break;
			at = stepped.index;
		}
		expect(at).toBe(tour.length - 1);
		// Prev from the first stop is already pinned: null.
		expect(stepTour(tour, 0, 'prev')).toBeNull();
		// Prev/next through the middle are plain steps.
		expect(stepTour(tour, 2, 'next')?.index).toBe(3);
		expect(stepTour(tour, 2, 'prev')?.index).toBe(1);
		expect(stepTour([], 0, 'next')).toBeNull();
	});
});
