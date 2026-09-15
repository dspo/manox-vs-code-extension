// Streaming draft runs: thinking/text deltas merge into one transcript item
// per reasoning segment even when transcript-invisible rows (sub-agent
// chatter, metrics — manox main journals them inline between deltas) consume
// journal seqs inside the run. Regression for the chunk-splitting bug: the
// former seq-adjacency test opened a new block at every invisible row.

import { describe, expect, it } from 'vitest';

import { TranscriptFold, type WireRecord } from './entries';

const row = (seq: number, event: { type: string } & Record<string, unknown>): WireRecord =>
	({ seq, id: `e${seq}`, parentId: null, timestamp: 't', ...event }) as WireRecord;

describe('TranscriptFold streaming runs', () => {
	it('merges thinking deltas across invisible rows', () => {
		const fold = new TranscriptFold();
		fold.replace([
			row(1, { type: 'agentThinkingDelta', s: 'Let ' }),
			row(2, { type: 'subagentChild', agentId: 'a1', event: { kind: 'text', text: 'child' } }),
			row(3, { type: 'subagentProgress', agentId: 'a1', agentType: 'reviewer', toolUses: 1, status: 'running' }),
			row(4, { type: 'agentThinkingDelta', s: 'me check.' }),
			row(5, { type: 'metrics', kind: 'side_call', data: {} }),
			row(6, { type: 'agentThinkingDelta', s: ' Done.' }),
		]);
		const thinking = fold.items.filter((i) => i.kind === 'thinking');
		expect(thinking).toHaveLength(1);
		expect((thinking[0] as { text: string }).text).toBe('Let me check. Done.');
	});

	it('a rendered row closes the run; the next delta opens a new block', () => {
		const fold = new TranscriptFold();
		fold.replace([
			row(1, { type: 'agentThinkingDelta', s: 'first' }),
			row(2, {
				type: 'toolCall',
				callId: 'c1',
				name: 'bash',
				title: 'bash',
				status: 'running',
				input: {},
			}),
			row(3, { type: 'agentThinkingDelta', s: 'second' }),
		]);
		const thinking = fold.items.filter((i) => i.kind === 'thinking');
		expect(thinking).toHaveLength(2);
	});

	it('the durable assistant row replaces the streamed draft, not appends', () => {
		const fold = new TranscriptFold();
		fold.replace([
			row(1, { type: 'agentThinkingDelta', s: 'partial' }),
			row(2, { type: 'agentTextDelta', s: 'draft ' }),
			row(3, { type: 'agentTextDelta', s: 'text' }),
			row(4, {
				type: 'message',
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'complete thinking' },
					{ type: 'text', text: 'authoritative text' },
				],
			}),
			// A later turn's delta must not merge into the finalized bubble.
			row(5, { type: 'agentThinkingDelta', s: 'next turn' }),
		]);
		const kinds = fold.items.map((i) => i.kind);
		expect(kinds).toEqual(['thinking', 'assistant', 'thinking']);
		expect((fold.items[0] as { text: string }).text).toBe('complete thinking');
		expect((fold.items[1] as { text: string }).text).toBe('authoritative text');
		expect((fold.items[2] as { text: string }).text).toBe('next turn');
	});
});
