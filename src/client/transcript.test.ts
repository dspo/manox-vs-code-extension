// Transcript-fold tests: streaming reconciliation (deltas → durable
// finalization), tool lifecycle keyed on callId, hidden display rows, and
// the uiNote error banner — the behaviors the chat rendering depends on.

import { describe, expect, it } from 'vitest';
import { TranscriptFold } from './transcript';
import type { TranscriptItem } from './transcript';
import type { JournalWireEntry } from '../protocol/types';

const e = (seq: number, fields: Record<string, unknown>): JournalWireEntry =>
	({ seq, id: `e-${seq}`, parentId: seq === 0 ? null : `e-${seq - 1}`, timestamp: 't', ...fields }) as JournalWireEntry;

describe('TranscriptFold', () => {
	it('grows the trailing draft on deltas and finalizes it with the durable assistant row', () => {
		const fold = new TranscriptFold();
		fold.append(e(0, { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }));
		fold.append(e(1, { type: 'agentTextDelta', s: 'he' }));
		fold.append(e(2, { type: 'agentTextDelta', s: 'llo' }));
		fold.append(e(3, { type: 'agentTextDelta', s: '!' }));

		let assistants = fold.items.filter((i) => i.kind === 'assistant');
		expect(assistants).toHaveLength(1);
		expect((assistants[0] as { text: string }).text).toBe('hello!');

		// The durable assistant row replaces the streamed draft, not stacks.
		fold.append(
			e(4, {
				type: 'message',
				role: 'assistant',
				content: [{ type: 'text', text: 'hello!' }],
			}),
		);
		assistants = fold.items.filter((i) => i.kind === 'assistant');
		expect(assistants).toHaveLength(1);
		expect((assistants[0] as { text: string }).text).toBe('hello!');

		// A delta after an intervening row (real turn boundary: tools /
		// user messages land between drafts) opens a NEW bubble.
		fold.append(e(5, { type: 'toolCall', callId: 'c1', name: 'bash', title: 'ls', status: 'running', input: {} }));
		fold.append(e(6, { type: 'agentTextDelta', s: 'next' }));
		expect(fold.items.filter((i) => i.kind === 'assistant')).toHaveLength(2);
	});

	it('folds tool lifecycle keyed on callId across toolCall/toolOutputChunk/toolResult', () => {
		const fold = new TranscriptFold();
		fold.append(e(0, { type: 'toolCall', callId: 'c1', name: 'bash', title: 'ls', status: 'running', input: {} }));
		fold.append(e(1, { type: 'toolOutputChunk', callId: 'c1', chunk: 'a' }));
		fold.append(e(2, { type: 'toolOutputChunk', callId: 'c1', chunk: 'b' }));
		fold.append(e(3, { type: 'toolResult', callId: 'c1', output: 'ab', isError: false }));

		const tools = fold.items.filter((i) => i.kind === 'tool');
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			kind: 'tool',
			tool: { id: 'c1', name: 'bash', status: 'completed', output: 'ab', isError: false },
		});
	});

	it('drops hidden display rows (embedder seeds)', () => {
		const fold = new TranscriptFold();
		fold.append(
			e(0, { type: 'message', role: 'custom', display: false, content: [{ type: 'text', text: 'seed' }] }),
		);
		expect(fold.items).toHaveLength(0);
	});

	it('surfaces uiNote errors through side effects', () => {
		const fold = new TranscriptFold();
		fold.append(e(0, { type: 'uiNote', kind: 'error', data: { text: 'boom' } }));
		expect(fold.side.threadError).toBe('boom');
		expect(fold.side.turnStarted).toBe(false);
	});

	it('tracks terminal turn edges', () => {
		const fold = new TranscriptFold();
		fold.append(e(0, { type: 'turnStart' }));
		expect(fold.side.turnStarted).toBe(true);
		fold.append(e(1, { type: 'turnFinish', cancelled: false, failed: true, strandedSteerIds: ['s1'] }));
		expect(fold.side.turnFinished).toEqual({ failed: true, cancelled: false, strandedSteerIds: ['s1'] });
	});

	it('rebuilds deterministically from a window (replace)', () => {
		const window: JournalWireEntry[] = [
			e(0, { type: 'message', role: 'user', content: [{ type: 'text', text: 'q' }] }),
			e(1, { type: 'agentTextDelta', s: 'a' }),
			e(2, { type: 'toolCall', callId: 'c1', name: 'bash', title: 'ls', status: 'running', input: {} }),
			e(3, { type: 'toolResult', callId: 'c1', output: '', isError: false }),
			e(4, { type: 'turnFinish', cancelled: false, failed: false, strandedSteerIds: [] }),
		];
		const fold = new TranscriptFold();
		fold.replace(window);
		const kinds = fold.items.map((item: TranscriptItem) => item.kind);
		expect(kinds).toEqual(['user', 'assistant', 'tool']);
	});
});
