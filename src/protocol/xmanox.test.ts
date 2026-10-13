// The x-manox bag fold — the TS twin of `manox_ahp::ext::reducer`. Both sides
// must fold the same extension actions to the same state (the host runs the
// Rust fold, this extension the TS one), so these tests mirror the upstream
// reducer's own test cases field for field.

import { describe, expect, it } from 'vitest';

import {
	EXT_ACTIONS,
	applyExtAction,
	applyExtBaseline,
	applyWorkspaceAction,
	emptyExtBag,
	emptyWorkspaceCatalogue,
	extensionChannelId,
	isExtensionChannel,
	isSessionScopedChannel,
} from './xmanox';

describe('applyExtAction', () => {
	it('folds the declared actions', () => {
		const bag = emptyExtBag();
		expect(applyExtAction(bag, { type: EXT_ACTIONS.planModeChanged, enabled: true })).toBe(true);
		expect(bag.planMode).toBe(true);
		expect(applyExtAction(bag, { type: EXT_ACTIONS.pinnedChanged, pinned: true })).toBe(true);
		expect(bag.pinned).toBe(true);
		expect(applyExtAction(bag, { type: EXT_ACTIONS.workBrowserSuites, suites: ['chrome'] })).toBe(true);
		expect(bag.browserSuites).toEqual(['chrome']);
	});

	it('keeps both plan-review lifecycle edges in one field', () => {
		const bag = emptyExtBag();
		const requested = { type: EXT_ACTIONS.planVerdictRequested, requestId: 'r1' };
		applyExtAction(bag, requested);
		expect(bag.planReview).toEqual(requested);
		const settled = { type: EXT_ACTIONS.planReviewSettled };
		applyExtAction(bag, settled);
		expect(bag.planReview).toEqual(settled);
	});

	it('upserts background-task registry rows by snake_case task_id', () => {
		const bag = emptyExtBag();
		const action = (snapshot: object) => ({ type: EXT_ACTIONS.workBackgroundTasks, snapshot });
		expect(applyExtAction(bag, action({ task_id: 'bg_3', status: 'Running' }))).toBe(true);
		expect(applyExtAction(bag, action({ task_id: 'mon_4', status: 'Running' }))).toBe(true);
		expect(applyExtAction(bag, action({ task_id: 'bg_3', status: 'Completed' }))).toBe(true);
		expect(Object.keys(bag.backgroundTasks ?? {}).length).toBe(2);
		expect((bag.backgroundTasks as Record<string, { status?: string }>)['bg_3']?.status).toBe('Completed');
		// A row without a keyable id cannot enter the view and does not
		// disturb it (the fold has no clear edge).
		expect(applyExtAction(bag, { type: EXT_ACTIONS.workBackgroundTasks })).toBe(false);
		expect(applyExtAction(bag, action({ status: 'Running' }))).toBe(false);
		expect(Object.keys(bag.backgroundTasks ?? {}).length).toBe(2);
	});

	it('unknown actions leave the state untouched (L12)', () => {
		const bag = emptyExtBag();
		expect(applyExtAction(bag, { type: 'x-manox-something/ofTheFuture', x: 1 })).toBe(false);
		expect(applyExtAction(bag, { no: 'type' })).toBe(false);
		expect(bag).toEqual(emptyExtBag());
	});
});

describe('applyExtBaseline', () => {
	it('replaces the bag with the carried state', () => {
		const bag = emptyExtBag();
		applyExtBaseline(bag, {
			type: EXT_ACTIONS.baseline,
			state: { pinned: true, label: 'main', leaf: 'turn-9' },
		});
		expect(bag.pinned).toBe(true);
		expect(bag.label).toBe('main');
		expect(bag.leaf).toBe('turn-9');
	});
});

describe('workspace catalogue fold', () => {
	it('baseline replaces, changed upserts by id, removed drops', () => {
		const catalogue = emptyWorkspaceCatalogue();
		applyWorkspaceAction(catalogue, {
			type: EXT_ACTIONS.workspacesBaseline,
			state: { workspaces: [{ id: 'w1' }], order: { 'w1': 1 } },
		});
		expect(catalogue.workspaces).toEqual([{ id: 'w1' }]);
		applyWorkspaceAction(catalogue, { type: EXT_ACTIONS.workspacesChanged, workspace: { id: 'w1', moved: true } });
		applyWorkspaceAction(catalogue, { type: EXT_ACTIONS.workspacesChanged, workspace: { id: 'w2' } });
		expect(catalogue.workspaces).toHaveLength(2);
		applyWorkspaceAction(catalogue, { type: EXT_ACTIONS.workspacesRemoved, id: 'w1' });
		expect(catalogue.workspaces.map((r) => (r as { id: string }).id)).toEqual(['w2']);
	});
});

describe('channel helpers', () => {
	it('classifies the declared channels', () => {
		expect(isExtensionChannel('x-manox-thread:/s1')).toBe(true);
		expect(isExtensionChannel('x-manox-workspaces://')).toBe(true);
		expect(isExtensionChannel('ahp-session:/s1')).toBe(false);
		expect(isSessionScopedChannel('x-manox-plan:/c1')).toBe(true);
		expect(isSessionScopedChannel('x-manox-commands://')).toBe(false);
		expect(extensionChannelId('x-manox-thread:/s1')).toBe('s1');
		expect(extensionChannelId('x-manox-commands://')).toBeUndefined();
	});
});
