// The transcript mapping: folded AHP chat state → `TranscriptItem[]`. This
// is a projection, not a second fold — the protocol truth is the `ChatState`
// the `chatReducer` produces (the same reducer the host runs); the items here
// are the render vocabulary the components already speak. Unknown response
// parts drop with a log (L12), never fail the render.

import type { AhpChatState } from '../../../protocol';
import type { ExtBag } from '../../../../../src/protocol/xmanox';
import { EXT_ACTIONS } from '../../../../../src/protocol/xmanox';
import type {
	AskQuestionWire,
	BackgroundTaskSnapshotWire,
} from '../../../protocol';
import type { ToolCallState as UiToolCall, ToolUiStatus, TranscriptItem } from './transcript';

/** Fold-side context the mapping reads beyond the chat state. */
export interface ChatFoldContext {
	threadBag?: ExtBag;
	workBag?: ExtBag;
	/** Out-of-band Code Tutor chain cards (host-pushed, §7). */
	codeChains?: Array<{ chainId: string; title: string; nodeCount: number }>;
}

/** Map the folded chat state to render items, in protocol order: turns in
 * order (the live active turn last), then the client-side artifacts the
 * chat state does not carry (background-task registry rows from the work
 * bag, out-of-band chain cards). */
export function chatStateToItems(chat: AhpChatState, ctx: ChatFoldContext = {}): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	for (const turn of chat.turns) mapTurn(items, turn.id, turn.message, turn.responseParts ?? []);
	if (chat.activeTurn) {
		mapTurn(items, chat.activeTurn.id, chat.activeTurn.message, chat.activeTurn.responseParts ?? []);
	}
	// Background-task registry rows (the work bag's keyed view).
	const tasks = (ctx.workBag?.backgroundTasks ?? {}) as Record<string, BackgroundTaskSnapshotWire>;
	for (const task of Object.values(tasks)) {
		if (isRecord(task) && typeof task.task_id === 'string') {
			items.push({ kind: 'background_task', id: `bg-${task.task_id}`, task });
		}
	}
	// Out-of-band Code Tutor cards.
	for (const card of ctx.codeChains ?? []) {
		items.push({
			kind: 'code_chain',
			id: `code-chain-${card.chainId}`,
			chainId: card.chainId,
			title: card.title,
			nodeCount: card.nodeCount,
		});
	}
	return items;
}

function mapTurn(
	items: TranscriptItem[],
	turnId: string,
	message: { text?: unknown; model?: unknown } | undefined,
	responseParts: unknown[],
): void {
	const text = typeof message?.text === 'string' ? message.text : '';
	const model = isRecord(message?.model) ? message.model : undefined;
	const modelRef =
		model && typeof model.provider === 'string' && typeof model.id === 'string'
			? `${model.provider}/${model.id}`
			: null;
	items.push({ kind: 'user', id: `u-${turnId}`, text, turnId, modelId: modelRef });
	for (const part of responseParts) {
		mapPart(items, turnId, part);
	}
}

function mapPart(items: TranscriptItem[], turnId: string, part: unknown): void {
	if (!isRecord(part) || typeof part.kind !== 'string') return;
	switch (part.kind) {
		case 'markdown': {
			const id = typeof part.id === 'string' ? part.id : `m-${items.length}`;
			const text = typeof part.text === 'string' ? part.text : '';
			if (text !== '') items.push({ kind: 'assistant', id, text });
			return;
		}
		case 'reasoning': {
			const id = typeof part.id === 'string' ? part.id : `r-${items.length}`;
			const text = typeof part.content === 'string' ? part.content : '';
			if (text.trim() !== '') items.push({ kind: 'thinking', id, text });
			return;
		}
		case 'toolCall': {
			const call = part.toolCall;
			if (!isRecord(call) || typeof call.id !== 'string') return;
			mapToolCall(items, turnId, call);
			return;
		}
		case 'inputRequest': {
			const request = part.request;
			if (!isRecord(request) || typeof request.id !== 'string') return;
			mapInputRequest(items, turnId, request, part.response);
			return;
		}
		case 'error': {
			// Error banners ride the thread `error` field (the store maps
			// them); the part itself renders nothing extra here.
			return;
		}
		default:
			console.debug('[webui] unknown response part dropped', part.kind);
			return;
	}
}

function mapToolCall(items: TranscriptItem[], _turnId: string, call: Record<string, unknown>): void {
	const id = String(call.id);
	const status = typeof call.status === 'string' ? call.status : '';
	const name = typeof call.name === 'string' ? call.name : 'tool';
	const title = typeof call.title === 'string' && call.title !== '' ? call.title : name;
	if (status === 'pending-confirmation' || status === 'pending-result-confirmation') {
		items.push({
			kind: 'approval',
			id: `approval-${id}`,
			callId: id,
			toolName: name,
			summary: typeof call.confirmationTitle === 'string' ? call.confirmationTitle : title,
			input: call.input,
		});
		return;
	}
	if (status === 'cancelled') {
		items.push({ kind: 'tool', id: `t-${id}`, tool: { id, name, title, status: 'cancelled', output: '', isError: false } });
		return;
	}
	const ui: ToolUiStatus = status === 'completed'
		? (isRecord(call.result) && call.result.isError === true ? 'failed' : 'completed')
		: status === 'auth-required'
			? 'running'
			: 'running';
	items.push({
		kind: 'tool',
		id: `t-${id}`,
		tool: {
			id,
			name,
			title,
			status: ui satisfies ToolUiStatus as UiToolCall['status'],
			output: resultText(call.result),
			isError: isRecord(call.result) && call.result.isError === true,
		},
	});
}

function mapInputRequest(
	items: TranscriptItem[],
	turnId: string,
	request: Record<string, unknown>,
	response: unknown,
): void {
	const requestId = String(request.id);
	const answered = response !== undefined && response !== null;
	// A plan review rides a `plan-review:`-prefixed request id (the host's
	// own convention, mirrored by the x-manox-plan bag's review edge).
	if (requestId.startsWith('plan-review:')) {
		items.push({
			kind: 'plan_review',
			id: `plan-${requestId}`,
			callId: requestId,
			planFile: typeof request.planFile === 'string' ? request.planFile : '',
			title: typeof request.message === 'string' ? request.message : 'Plan review',
			content: typeof request.content === 'string' ? request.content : '',
		});
		return;
	}
	// One card per question (the flat AskQuestionWire the card renders);
	// the answers route by the request id + the question's own id.
	const questions = Array.isArray(request.questions) ? request.questions : [];
	const shapes = questions.map((q) => askShape(q));
	for (const shape of shapes.length > 0 ? shapes : [askShape(undefined)]) {
		items.push({
			kind: 'ask_question',
			id: `ask-${requestId}-${shape.id ?? 'q'}`,
			callId: requestId,
			summary: typeof request.message === 'string' ? request.message : '',
			input: { ...shape, turnId } satisfies AskQuestionWire & { turnId: string } as unknown,
			answered,
		});
	}
}

function askShape(q: unknown): AskQuestionWire {
	if (!isRecord(q)) return { question: '', options: [] };
	return {
		id: typeof q.id === 'string' ? q.id : undefined,
		question: typeof q.message === 'string' ? q.message : '',
		header: typeof q.header === 'string' ? q.header : undefined,
		detail: typeof q.detail === 'string' ? q.detail : undefined,
		multiSelect: q.multiSelect === true,
		options: Array.isArray(q.options)
			? q.options.map((o) =>
					isRecord(o) && typeof o.label === 'string'
						? {
								label: o.label,
								description: typeof o.description === 'string' ? o.description : undefined,
							}
						: { label: '' },
				)
			: [],
	};
}

function resultText(result: unknown): string {
	if (!isRecord(result)) return '';
	const content = result.content;
	if (!Array.isArray(content)) return '';
	const texts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
			texts.push(block.text);
		}
	}
	return texts.join('\n');
}

/** The plan document a plan-review card renders, from the plan bag's
 * `verdictRequested` edge (the plan file + snapshot live there, durable). */
export function planReviewOf(planBag: ExtBag | undefined): { requestId: string; planFile: string; title: string; content: string } | null {
	const review = planBag?.planReview;
	if (!isRecord(review) || review.type !== EXT_ACTIONS.planVerdictRequested) return null;
	return {
		requestId: typeof review.requestId === 'string' ? review.requestId : '',
		planFile: typeof review.planFile === 'string' ? review.planFile : '',
		title: typeof review.title === 'string' ? review.title : 'Plan review',
		content: typeof review.content === 'string' ? review.content : '',
	};
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
