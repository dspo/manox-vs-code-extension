// Workspace scoping for the threads list. The sidebar shows the conversations
// that belong to THIS workspace — the workspace directory itself plus every
// worktree of the same git repository — not every thread in the shared
// `~/.manox` store (which the desktop app writes too).
//
// Ported from the manox monorepo's embedded VS Code extension
// (`crates/manox-actor/src/actor.rs`, `matches_workspace` /
// `repo_identity_cached` / `repo_identity`, commit b1b099f2 "Group worktrees
// of one repository in the thread list"). The rule and its two traps are
// deliberately identical to that original:
//
//   * REPOSITORY, NOT PATH. Comparing directories by string equality hides a
//     session started in a linked worktree from the main checkout and vice
//     versa. Every candidate path is resolved to the repository's git COMMON
//     directory (`git rev-parse --git-common-dir`), which every worktree of
//     one repository shares, so both directions match.
//   * A MISS IS NOT CACHED. A negative lookup may simply predate a `git init`
//     in the workspace, so only confirmed identities are memoized; a miss is
//     re-probed on the next call and takes effect without a restart.
//
// The server cannot do this for us: the wire `ThreadListItem` has no `cwd`
// column (see `src/protocol/types.ts`), so the filtering necessarily lives on
// the host side, where the workspace cwd and the thread rows meet.

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';

import type { FromServer, ThreadListItem } from '../protocol/types';

/** The git identity of a directory: the canonical common dir shared by every
 * worktree of its repository, or null outside git. */
export type RepoIdentity = string | null;

/** Resolve a directory's git identity. Injectable so tests (and the pure
 * matching rule) never shell out. */
export type RepoResolver = (dir: string) => Promise<RepoIdentity>;

/** Identity lookups in flight, keyed by directory: a burst of thread rows in
 * one repository costs ONE `git` spawn, not one per row. Only CONFIRMED
 * identities are cached (see the module header), so a transient failure or a
 * pre-`git init` miss never sticks. */
type Cache = Map<string, Promise<string | null>>;

/** The threaded filter: rows admitted for a workspace, in the server's order.
 * Memoized per directory for the burst, but never across a negative answer. */
export class WorkspaceThreadFilter {
	private readonly confirmed = new Map<string, string>();

	constructor(
		private readonly resolve: RepoResolver = gitCommonDir,
		private readonly log: (message: string) => void = () => undefined,
	) {}

	/** Keep only the rows belonging to `cwd`'s repository. Rows the filter
	 * cannot place (no `project`, or a directory outside git) fall back to
	 * exact-path matching, which is the pre-worktree behavior. */
	async ownedBy(rows: ThreadListItem[], cwd: string): Promise<ThreadListItem[]> {
		if (cwd === '') return rows;
		const wanted = await this.identity(cwd);
		if (wanted === null) {
			// A workspace outside git: exact directory equality is all the
			// evidence there is (the original's documented fallback).
			return rows.filter((row) => !row.project || row.project === cwd);
		}
		const cache: Cache = new Map();
		const kept: ThreadListItem[] = [];
		for (const row of rows) {
			const project = row.project;
			if (!project) {
				// The server omitted `project` (an ungrouped thread). It has no
				// directory to test, and dropping it would hide the user's own
				// thread — admit it rather than fail closed.
				kept.push(row);
				continue;
			}
			if (project === cwd) {
				kept.push(row);
				continue;
			}
			const identity = await this.identity(project, cache);
			if (identity !== null && identity === wanted) kept.push(row);
		}
		return kept;
	}

	private identity(dir: string, cache: Cache = new Map()): Promise<string | null> {
		const confirmed = this.confirmed.get(dir);
		if (confirmed !== undefined) return Promise.resolve(confirmed);
		let hit = cache.get(dir);
		if (!hit) {
			hit = this.resolve(dir)
				.then((identity) => {
					if (identity !== null) this.confirmed.set(dir, identity);
					return identity;
				})
				.catch((e: unknown) => {
					// A resolver that throws degrades to "not this repository",
					// never to a dropped list: the row simply fails the test.
					this.log(`workspace filter: identity lookup failed for ${dir}: ${e instanceof Error ? e.message : String(e)}`);
					return null;
				});
			cache.set(dir, hit);
		}
		return hit;
	}
}

/** `git rev-parse --git-common-dir` in `dir`, canonicalized. Every worktree of
 * one repository reports the same common dir; a non-repository (or a missing
 * `git`) answers null. */
export function gitCommonDir(dir: string): Promise<RepoIdentity> {
	return new Promise((resolve) => {
		execFile(
			'git',
			['-C', dir, 'rev-parse', '--git-common-dir'],
			{ timeout: 5_000, windowsHide: true },
			(error, stdout) => {
				if (error) {
					resolve(null);
					return;
				}
				const raw = stdout.trim();
				if (raw === '') {
					resolve(null);
					return;
				}
				// A relative answer resolves against the queried directory; an
				// absolute one (a linked worktree) replaces the base outright.
				const joined = raw.startsWith('/') ? raw : `${dir.replace(/\/+$/, '')}/${raw}`;
				try {
					resolve(realpathSync(joined));
				} catch {
					// The path need not exist for the identity to be usable —
					// canonicalization is a normalization, not a validation.
					resolve(joined);
				}
			},
		);
	});
}

// ── the relay's frame surgery ──────────────────────────────────────────────
//
// The registry arrives in TWO shapes during the dual-protocol window (the
// legacy `ServerNote` and the `Host` event) and both fold into the same store
// state, so both must be scoped identically. These helpers are pure frame
// surgery and live here (not in `sidebarProvider.ts`) so they are testable
// without a live vscode module.

/** The thread rows a frame carries, or null when it carries none. */
export function threadsOf(frame: FromServer): ThreadListItem[] | null {
	if (frame.kind === 'host') {
		const host = frame.host;
		if (host?.type === 'threadsUpdated' && Array.isArray(host.threads)) return host.threads;
		return null;
	}
	if (frame.kind !== 'notification') return null;
	const note = frame.note;
	if (note?.method === 'threadsUpdated' && Array.isArray(note.threads)) return note.threads;
	return null;
}

/** `frame` with its thread rows replaced, in the SAME shape it arrived in.
 * Only ever called for a frame `threadsOf` accepted, so the fallthrough is
 * unreachable — it returns the frame untouched rather than throwing. */
export function withThreads(frame: FromServer, threads: ThreadListItem[]): FromServer {
	if (frame.kind === 'host') {
		return { ...frame, host: { ...frame.host, threads } } as FromServer;
	}
	if (frame.kind === 'notification') {
		return { ...frame, note: { ...frame.note, threads } } as FromServer;
	}
	return frame;
}
