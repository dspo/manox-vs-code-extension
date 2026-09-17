// Workspace scoping for the threads list (§ the sidebar's one rewritten
// frame). The rule is ported from the manox monorepo's embedded extension
// (`crates/manox-actor/src/actor.rs`, commit b1b099f2), so these tests pin the
// same three behaviors that commit's message called out:
//   * a session started in a LINKED WORKTREE is visible from the main
//     checkout, and vice versa (the bug the original fixed);
//   * a directory outside the workspace's repository is hidden;
//   * a workspace outside git keeps exact-path matching.
// The resolver is injected, so none of this shells out to a real `git`.

import { describe, expect, it, vi } from 'vitest';

import type { FromServer, ThreadListItem } from '../protocol/types';
import { threadsOf, withThreads, WorkspaceThreadFilter, gitCommonDir } from './workspaceFilter';

const row = (id: string, project?: string): ThreadListItem => ({
	id,
	title: id,
	updated_at: 0,
	running: false,
	unread: false,
	errored: false,
	pending_auth: false,
	pending_plan: false,
	background_work: false,
	model_id: 'm',
	pinned: false,
	archived: false,
	parent_id: null,
	depth: 0,
	...(project !== undefined ? { project } : {}),
});

/** A fake git: every listed directory maps to a repository identity. */
const gitOf = (repos: Record<string, string>) => {
	const resolve = vi.fn(async (dir: string) => repos[dir] ?? null);
	return { resolve, filter: new WorkspaceThreadFilter(resolve) };
};

describe('WorkspaceThreadFilter', () => {
	it('keeps the workspace itself and hides another repository', async () => {
		const { filter } = gitOf({
			'/w': '/repos/w/.git',
			'/other': '/repos/other/.git',
		});
		const kept = await filter.ownedBy(
			[row('a', '/w'), row('b', '/other')],
			'/w',
		);
		expect(kept.map((r) => r.id)).toEqual(['a']);
	});

	it('admits a LINKED WORKTREE of the same repository (the original bug)', async () => {
		// Both the main checkout and the worktree resolve to one common dir.
		const { filter } = gitOf({
			'/w': '/repos/w/.git',
			'/w-feature': '/repos/w/.git',
			'/elsewhere': '/repos/elsewhere/.git',
		});
		const kept = await filter.ownedBy(
			[row('main', '/w'), row('wt', '/w-feature'), row('out', '/elsewhere')],
			'/w',
		);
		expect(kept.map((r) => r.id)).toEqual(['main', 'wt']);
	});

	it('matches in the other direction too (worktree workspace, main-checkout thread)', async () => {
		const { filter } = gitOf({ '/w-feature': '/repos/w/.git', '/w': '/repos/w/.git' });
		const kept = await filter.ownedBy([row('main', '/w')], '/w-feature');
		expect(kept.map((r) => r.id)).toEqual(['main']);
	});

	it('falls back to exact-path matching when the workspace is outside git', async () => {
		const { filter } = gitOf({ '/plain/nested': undefined as unknown as string });
		const kept = await filter.ownedBy(
			[row('exact', '/plain'), row('nested', '/plain/nested'), row('other', '/somewhere')],
			'/plain',
		);
		expect(kept.map((r) => r.id)).toEqual(['exact']);
	});

	it('admits a row with no `project` rather than hiding the user\'s own thread', async () => {
		const { filter } = gitOf({ '/w': '/repos/w/.git' });
		const kept = await filter.ownedBy([row('ungrouped'), row('here', '/w')], '/w');
		expect(kept.map((r) => r.id)).toEqual(['ungrouped', 'here']);
	});

	it('preserves the server\'s row order', async () => {
		const { filter } = gitOf({ '/w': '/repos/w/.git', '/wt': '/repos/w/.git' });
		const kept = await filter.ownedBy(
			[row('c', '/wt'), row('a', '/w'), row('b', '/wt')],
			'/w',
		);
		expect(kept.map((r) => r.id)).toEqual(['c', 'a', 'b']);
	});

	it('memoizes a CONFIRMED identity but never caches a miss', async () => {
		// The original's rule: a negative lookup may just predate a `git init`,
		// so it is re-probed; a confirmed identity is stable.
		const repos: Record<string, string | undefined> = { '/w': '/repos/w/.git' };
		const resolve = vi.fn(async (dir: string) => repos[dir] ?? null);
		const filter = new WorkspaceThreadFilter(resolve);

		expect((await filter.ownedBy([row('x', '/w')], '/w')).length).toBe(1);
		const afterFirst = resolve.mock.calls.length;
		// A second pass reuses the confirmed identity (no new spawn).
		await filter.ownedBy([row('x', '/w')], '/w');
		expect(resolve.mock.calls.length).toBe(afterFirst);

		// A directory that was NOT a repository gets re-probed…
		await filter.ownedBy([row('y', '/fresh')], '/w');
		const before = resolve.mock.calls.filter((c) => c[0] === '/fresh').length;
		repos['/fresh'] = '/repos/w/.git'; // …so a later `git init` takes effect
		const kept = await filter.ownedBy([row('y', '/fresh')], '/w');
		expect(resolve.mock.calls.filter((c) => c[0] === '/fresh').length).toBeGreaterThan(before);
		expect(kept.map((r) => r.id)).toEqual(['y']);
	});

	it('shares one lookup for many rows in the same directory', async () => {
		const resolve = vi.fn(async (_dir: string) => '/repos/w/.git');
		const filter = new WorkspaceThreadFilter(resolve);
		await filter.ownedBy([row('a', '/wt'), row('b', '/wt'), row('c', '/wt')], '/w');
		// /w once + /wt once — not one spawn per row.
		expect(resolve.mock.calls.filter((c) => c[0] === '/wt')).toHaveLength(1);
	});

	it('treats a throwing resolver as "not this repository" instead of failing', async () => {
		const resolve = vi.fn(async (dir: string) => {
			if (dir === '/broken') throw new Error('git exploded');
			return '/repos/w/.git';
		});
		const logs: string[] = [];
		const filter = new WorkspaceThreadFilter(resolve, (m) => logs.push(m));
		const kept = await filter.ownedBy([row('bad', '/broken'), row('ok', '/w')], '/w');
		expect(kept.map((r) => r.id)).toEqual(['ok']);
		expect(logs.some((m) => m.includes('/broken'))).toBe(true);
	});

	it('returns every row unchanged when no workspace cwd is known', async () => {
		const { resolve, filter } = gitOf({});
		const rows = [row('a', '/w'), row('b', '/other')];
		expect(await filter.ownedBy(rows, '')).toEqual(rows);
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe('gitCommonDir', () => {
	it('answers null for a directory that is not a repository', async () => {
		// A path that cannot be a repo (and whose git invocation fails).
		expect(await gitCommonDir('/nonexistent/definitely-not-a-repo-xyz')).toBeNull();
	});
});

// ── the relay's frame surgery (both registry shapes) ──────────────────────
// The registry arrives in TWO shapes during the dual-protocol window and both
// fold into the same store state, so a filter that scoped only one of them
// would leave the other showing every thread on the machine.

describe('threads frame surgery', () => {
	const kept = [row('kept', '/w')];

	it('reads and rewrites the legacy `notification` shape', () => {
		const frame = {
			kind: 'notification',
			note: { method: 'threadsUpdated', threads: [row('a', '/w')] },
		} as unknown as FromServer;
		expect(threadsOf(frame)?.map((r) => r.id)).toEqual(['a']);
		const next = withThreads(frame, kept) as { note: { threads: unknown[] } };
		expect(next.note.threads).toEqual(kept);
	});

	it('reads and rewrites the `host` frame shape', () => {
		const frame = {
			kind: 'host',
			host: { type: 'threadsUpdated', threads: [row('a', '/w')] },
		} as unknown as FromServer;
		expect(threadsOf(frame)?.map((r) => r.id)).toEqual(['a']);
		const next = withThreads(frame, kept) as { host: { threads: unknown[] } };
		expect(next.host.threads).toEqual(kept);
	});

	it('ignores frames that carry no thread rows (they pass through untouched)', () => {
		const others: FromServer[] = [
			{ kind: 'host', host: { type: 'ready', epoch: 1 } },
			{ kind: 'notification', note: { method: 'sessionCreated', sessionId: 's' } },
			{ kind: 'response', id: '1', outcome: { Ok: {} } },
		] as unknown as FromServer[];
		for (const frame of others) expect(threadsOf(frame)).toBeNull();
	});
});
