// The session-catalogue hydration sweep — pagination, the fresh/known
// split, and the tolerance rules (non-array pages and bogus summaries drop
// without throwing; an empty first page is a legitimate answer, the host's
// thread-store refresh lands async).

import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@microsoft/agent-host-protocol';
import { sweepSessionCatalogue } from './agentClient';

const summaryOf = (uri: string): SessionSummary =>
	({
		resource: uri,
		provider: 'manox',
		title: uri,
		status: 1,
		modifiedAt: '2026-10-13T08:00:00.000Z',
	}) as unknown as SessionSummary;

describe('sweepSessionCatalogue', () => {
	it('walks pages via nextCursor and reports fresh rows', async () => {
		const pages: Record<string, unknown> = {
			'': { items: [summaryOf('ahp-session:/a')], nextCursor: 'c2' },
			c2: { items: [summaryOf('ahp-session:/b'), summaryOf('ahp-session:/c')], nextCursor: undefined },
		};
		const calls: Array<Record<string, unknown>> = [];
		const seen: string[] = [];
		const fresh = await sweepSessionCatalogue(
			(_method, params) => {
				calls.push(params as Record<string, unknown>);
				return Promise.resolve(pages[(params as { cursor?: string }).cursor ?? '']);
			},
			(summary, isNew) => {
				if (isNew) seen.push(summary.resource);
			},
			(uri) => uri === 'ahp-session:/a', // /a already known
		);
		expect(fresh).toBe(2);
		expect(seen).toEqual(['ahp-session:/b', 'ahp-session:/c']);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.cursor).toBe('c2');
	});

	it('an empty first page is a legitimate answer (the host refresh lands async)', async () => {
		const fresh = await sweepSessionCatalogue(
			() => Promise.resolve({ items: [], nextCursor: undefined }),
			() => undefined,
			() => false,
		);
		expect(fresh).toBe(0);
	});

	it('malformed pages drop without throwing', async () => {
		const fresh = await sweepSessionCatalogue(
			() => Promise.resolve({ items: 'not-an-array', nextCursor: undefined }),
			() => undefined,
			() => false,
		);
		expect(fresh).toBe(0);
		const fresh2 = await sweepSessionCatalogue(
			() => Promise.resolve(null),
			() => undefined,
			() => false,
		);
		expect(fresh2).toBe(0);
	});

	it('a summary without a resource is handed through (the consumer guards)', async () => {
		const seen: Array<SessionSummary | undefined> = [];
		await sweepSessionCatalogue(
			() => Promise.resolve({ items: [{ provider: 'p' } as unknown as SessionSummary], nextCursor: undefined }),
			(summary) => seen.push(summary),
			() => false,
		);
		expect(seen).toHaveLength(1);
	});
});
