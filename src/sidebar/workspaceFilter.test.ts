// Workspace scoping for the session catalogue (§ the sidebar's one rewritten
// part of the relay). The rule is ported from the manox monorepo's embedded
// extension (`crates/manox-actor/src/actor.rs`, commit b1b099f2), so these
// tests pin the same three behaviors that commit's message called out:
//   * a session started in a LINKED WORKTREE is visible from the main
//     checkout, and vice versa (the bug the original fixed);
//   * a directory outside the workspace's repository is hidden;
//   * a workspace outside git keeps exact-path matching.
// The resolver is injected, so none of this shells out to a real `git`.

import { describe, expect, it, vi } from 'vitest';

import type { ScopeRow } from './workspaceFilter';
import { WorkspaceThreadFilter, fileUriToPath, gitCommonDir, projectOfSummary, threadsOwnedBy } from './workspaceFilter';

const row = (resource: string, project?: string): ScopeRow => ({
	resource,
	...(project !== undefined ? { project } : {}),
});

/** The AHP summary shape (`workingDirectories` are `file://` URIs). */
const summary = (resource: string, dirs?: string[]): { resource: string; workingDirectories?: string[] } => ({
	resource,
	...(dirs ? { workingDirectories: dirs } : {}),
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
			[row('ahp-session:/a', '/w'), row('ahp-session:/b', '/other')],
			'/w',
		);
		expect(kept.map((r) => r.resource)).toEqual(['ahp-session:/a']);
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
		expect(kept.map((r) => r.resource)).toEqual(['main', 'wt']);
	});

	it('matches in the other direction too (worktree workspace, main-checkout thread)', async () => {
		const { filter } = gitOf({ '/w-feature': '/repos/w/.git', '/w': '/repos/w/.git' });
		const kept = await filter.ownedBy([row('main', '/w')], '/w-feature');
		expect(kept.map((r) => r.resource)).toEqual(['main']);
	});

	it('falls back to exact-path matching when the workspace is outside git', async () => {
		const { filter } = gitOf({ '/plain/nested': undefined as unknown as string });
		const kept = await filter.ownedBy(
			[row('exact', '/plain'), row('nested', '/plain/nested'), row('other', '/somewhere')],
			'/plain',
		);
		expect(kept.map((r) => r.resource)).toEqual(['exact']);
	});

	it('admits a row with no `project` rather than hiding the user\'s own thread', async () => {
		const { filter } = gitOf({ '/w': '/repos/w/.git' });
		const kept = await filter.ownedBy([row('ungrouped'), row('here', '/w')], '/w');
		expect(kept.map((r) => r.resource)).toEqual(['ungrouped', 'here']);
	});

	it('preserves the server\'s row order', async () => {
		const { filter } = gitOf({ '/w': '/repos/w/.git', '/wt': '/repos/w/.git' });
		const kept = await filter.ownedBy(
			[row('c', '/wt'), row('a', '/w'), row('b', '/wt')],
			'/w',
		);
		expect(kept.map((r) => r.resource)).toEqual(['c', 'a', 'b']);
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
		expect(kept.map((r) => r.resource)).toEqual(['y']);
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
		expect(kept.map((r) => r.resource)).toEqual(['ok']);
		expect(logs.some((m) => m.includes('/broken'))).toBe(true);
	});

	it('returns every row unchanged when no workspace cwd is known', async () => {
		const { resolve, filter } = gitOf({});
		const rows = [row('a', '/w'), row('b', '/other')];
		expect(await filter.ownedBy(rows, '')).toEqual(rows);
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe('summary scoping', () => {
	it('derives the project from the first file:// working directory', () => {
		expect(projectOfSummary({ workingDirectories: ['file:///w', 'file:///elsewhere'] })).toBe('/w');
		expect(projectOfSummary({})).toBeUndefined();
	});

	it('decodes file:// URIs to paths', () => {
		expect(fileUriToPath('file:///a/b/c')).toBe('/a/b/c');
		expect(fileUriToPath('/plain/path')).toBeUndefined();
	});

	it('threadsOwnedBy scopes AHP summaries to the workspace repository', async () => {
		const repos: Record<string, string | undefined> = { '/w': '/repos/w/.git', '/other': '/repos/other/.git' };
		const resolve = vi.fn(async (dir: string) => repos[dir] ?? null);
		const filter = new WorkspaceThreadFilter(resolve);
		const kept = await threadsOwnedBy(
			[summary('ahp-session:/a', ['file:///w']), summary('ahp-session:/b', ['file:///other'])],
			'/w',
			filter,
		);
		expect(kept.map((r) => r.resource)).toEqual(['ahp-session:/a']);
	});
});

describe('gitCommonDir', () => {
	it('answers null for a directory that is not a repository', async () => {
		// A path that cannot be a repo (and whose git invocation fails).
		expect(await gitCommonDir('/nonexistent/definitely-not-a-repo-xyz')).toBeNull();
	});
});
