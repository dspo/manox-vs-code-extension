// Imperative DOM rendering for the chat webview. State lives in `ChatApp`;
// this module only projects it onto the DOM. The transcript has a fast path
// for streaming updates (same item ids, last item mutated → update that node
// only); everything else rebuilds.

import type { TranscriptItem } from '../client/transcript';
import { renderMarkdown } from './markdown';
import type { ChatApp } from './store';

export interface Renderer {
	render(): void;
}

/** Cheap change fingerprint per item: id + mutable-length/status fields. */
function itemSignature(item: TranscriptItem): string {
	switch (item.kind) {
		case 'assistant':
		case 'thinking':
			return `${item.id}:${item.text.length}`;
		case 'tool':
			return `${item.id}:${item.tool.status}:${item.tool.output.length}:${item.tool.autoApproved ?? ''}`;
		default:
			return item.id;
	}
}

export function createRenderer(app: ChatApp): Renderer {
	const root = document.getElementById('root');
	if (!root) throw new Error('manox webview: #root missing');

	// ── static scaffold ────────────────────────────────────────────────────
	root.innerHTML = `
		<header class="header">
			<button id="btn-list" class="icon-btn" title="Threads">☰</button>
			<span id="title" class="title"></span>
			<span id="status-dot" class="dot" hidden></span>
			<span class="spacer"></span>
			<select id="sel-model" class="select" title="Model"></select>
			<select id="sel-effort" class="select" title="Reasoning effort">
				<option value="">effort</option>
				<option value="high">high</option>
				<option value="max">max</option>
			</select>
			<button id="btn-new" class="icon-btn" title="New session">✚</button>
		</header>
		<div id="fatal" class="fatal" hidden></div>
		<main id="main" class="main"></main>
	`;

	const el = {
		root,
		btnList: byId<HTMLButtonElement>('btn-list'),
		btnNew: byId<HTMLButtonElement>('btn-new'),
		title: byId<HTMLElement>('title'),
		statusDot: byId<HTMLElement>('status-dot'),
		selModel: byId<HTMLSelectElement>('sel-model'),
		selEffort: byId<HTMLSelectElement>('sel-effort'),
		fatal: byId<HTMLElement>('fatal'),
		main: byId<HTMLElement>('main'),
	};

	el.btnList.onclick = () => app.closeActive();
	el.btnNew.onclick = () => void app.newSession();
	el.selModel.onchange = () => {
		if (el.selModel.value) app.setModel(el.selModel.value);
	};
	el.selEffort.onchange = () => {
		if (el.selEffort.value) app.setReasoningEffort(el.selEffort.value);
		el.selEffort.value = '';
	};

	let renderedSignatures: string[] = [];

	const render = (): void => {
		renderHeader();
		el.fatal.hidden = app.fatal === null;
		el.fatal.textContent = app.fatal ?? '';
		if (app.view === 'list' || !app.active) renderThreadList();
		else renderConversation();
	};

	const renderHeader = (): void => {
		const store = app.active?.store;
		el.title.textContent = app.view === 'chat' && store ? store.title : 'manox';
		const running = store?.running ?? false;
		const errored = store?.errored ?? false;
		el.statusDot.hidden = !(running || errored);
		el.statusDot.className = `dot ${errored ? 'dot-error' : running ? 'dot-running' : ''}`;
		renderModelSelect();
	};

	const renderModelSelect = (): void => {
		const current = app.active?.store?.modelRef ?? '';
		const options = ['', ...app.models.map((m) => `${m.provider}/${m.id}`)]
			.map((ref) => {
				const label = ref === '' ? 'model' : ref;
				const selected = ref === current ? ' selected' : '';
				return `<option value="${escapeAttr(ref)}"${selected}>${escapeHtml(label)}</option>`;
			})
			.join('');
		if (el.selModel.innerHTML !== options) el.selModel.innerHTML = options;
		el.selModel.value = current;
	};

	const renderThreadList = (): void => {
		renderedSignatures = [];
		const rows = app.threads
			.filter((t) => !t.archived || t.pinned)
			.map((thread) => {
				const badges = [
					thread.running ? '<span class="badge badge-run">running</span>' : '',
					thread.pending_auth ? '<span class="badge badge-auth">approval</span>' : '',
					thread.pending_plan ? '<span class="badge badge-plan">plan</span>' : '',
					thread.errored ? '<span class="badge badge-err">error</span>' : '',
					app.unread.has(thread.id) ? '<span class="badge badge-unread">●</span>' : '',
				]
					.filter(Boolean)
					.join('');
				return `
					<div class="thread-row" data-id="${escapeAttr(thread.id)}">
						<span class="thread-pin" title="${thread.pinned ? 'Unpin' : 'Pin'}">${thread.pinned ? '★' : '☆'}</span>
						<span class="thread-title">${escapeHtml(thread.title || 'Untitled')}</span>
						<span class="thread-badges">${badges}</span>
						<span class="thread-actions">
							<button class="icon-btn" data-act="archive" title="${thread.archived ? 'Unarchive' : 'Archive'}">${thread.archived ? '⬆' : '🗄'}</button>
						</span>
					</div>`;
			})
			.join('');
		el.main.innerHTML = `
			<div class="thread-list">${rows || '<div class="empty">No threads yet — start one with ✚</div>'}</div>
		`;
		for (const row of el.main.querySelectorAll<HTMLElement>('.thread-row')) {
			const id = row.dataset.id ?? '';
			row.onclick = (event) => {
				const act = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
				if (act === 'archive') {
					const thread = app.threads.find((t) => t.id === id);
					app.archiveThread(id, !(thread?.archived ?? false));
					return;
				}
				if ((event.target as HTMLElement).classList.contains('thread-pin')) {
					const thread = app.threads.find((t) => t.id === id);
					app.pinThread(id, !(thread?.pinned ?? false));
					return;
				}
				void app.openThread(id);
			};
		}
	};

	const renderConversation = (): void => {
		const store = app.active!.store;
		const items = store.transcript;

		if (!el.main.querySelector('.conversation')) {
			el.main.innerHTML = `
				<div class="conversation">
					<div class="transcript" id="transcript"></div>
					<div class="cards" id="cards"></div>
					<div class="composer">
						<textarea id="composer-input" rows="2" placeholder="Ask manox… (Enter to send, Shift+Enter for newline)"></textarea>
						<div class="composer-actions">
							<select id="sel-approval" class="select" title="Approval mode">
								<option value="read-only">read-only</option>
								<option value="workspace-write">workspace-write</option>
								<option value="danger-full-access">full access</option>
							</select>
							<button id="btn-send" class="btn primary">Send</button>
							<button id="btn-stop" class="btn" hidden>Stop</button>
						</div>
					</div>
				</div>`;
			wireComposer();
		}

		const transcript = byId<HTMLElement>('transcript');
		const signatures = items.map(itemSignature);
		const differsAt = firstDifference(renderedSignatures, signatures);
		if (differsAt === -1) {
			// No transcript change — only cards/composer state may have moved.
		} else if (differsAt === signatures.length - 1 && renderedSignatures.length === signatures.length) {
			// Streaming fast path: only the last item mutated.
			const last = transcript.children[transcript.children.length - 1];
			if (last instanceof HTMLElement) renderTranscriptItemInto(last, items[items.length - 1]!);
			renderedSignatures = signatures;
			transcript.scrollTop = transcript.scrollHeight;
		} else {
			transcript.innerHTML = '';
			for (const item of items) {
				const node = document.createElement('div');
				renderTranscriptItemInto(node, item);
				transcript.appendChild(node);
			}
			renderedSignatures = signatures;
			transcript.scrollTop = transcript.scrollHeight;
		}

		renderCards();
		syncComposer();
	};

	const wireComposer = (): void => {
		const input = byId<HTMLTextAreaElement>('composer-input');
		const send = byId<HTMLButtonElement>('btn-send');
		const stop = byId<HTMLButtonElement>('btn-stop');
		const approval = byId<HTMLSelectElement>('sel-approval');
		approval.value = app.approvalMode;
		send.onclick = () => {
			const text = input.value;
			input.value = '';
			void app.submit(text);
		};
		stop.onclick = () => app.cancelTurn();
		approval.onchange = () => {
			app.setApprovalMode(approval.value as typeof app.approvalMode);
		};
		input.onkeydown = (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				const text = input.value;
				input.value = '';
				void app.submit(text);
			}
		};
	};

	const syncComposer = (): void => {
		const store = app.active!.store;
		const stop = byId<HTMLButtonElement>('btn-stop');
		const send = byId<HTMLButtonElement>('btn-send');
		if (stop && send) {
			stop.hidden = !store.running;
			send.hidden = store.running;
		}
		const approval = byId<HTMLSelectElement>('sel-approval');
		if (approval && approval.value !== app.approvalMode) approval.value = app.approvalMode;
	};

	const renderCards = (): void => {
		const cards = byId<HTMLElement>('cards');
		if (!cards) return;
		const card = app.cards[0];
		if (!card) {
			cards.innerHTML = '';
			return;
		}
		const call = card.call;
		if (call.method === 'approve') {
			cards.innerHTML = `
				<div class="card">
					<div class="card-title">Approve <code>${escapeHtml(call.toolName)}</code></div>
					<div class="card-body"><pre>${escapeHtml(call.summary)}</pre></div>
					<div class="card-actions">
						<button class="btn primary" data-act="allow">Allow</button>
						<button class="btn" data-act="deny">Deny</button>
					</div>
				</div>`;
		} else if (call.method === 'planVerdict') {
			cards.innerHTML = `
				<div class="card">
					<div class="card-title">Plan review: ${escapeHtml(call.title)}</div>
					<div class="card-body plan">${renderMarkdown(call.content ?? '')}</div>
					<div class="card-actions">
						<button class="btn primary" data-act="execute_keep">Execute</button>
						<button class="btn" data-act="execute_compact">Execute (compact)</button>
						<button class="btn" data-act="refine">Refine</button>
					</div>
				</div>`;
		} else if (call.method === 'askUserQuestion') {
			const questions = app.questionsOf(card);
			cards.innerHTML = `
				<div class="card">
					<div class="card-title">Question</div>
					<div class="card-body">${
						questions
							.map(
								(q) => `
						<div class="question">
							<div class="question-text">${escapeHtml(q.question)}</div>
							<div class="question-options">
								${q.options
									.map(
										(opt) =>
											`<button class="btn" data-q="${escapeAttr(q.question)}" data-a="${escapeAttr(opt.label)}">${escapeHtml(opt.label)}${opt.recommended ? ' ✓' : ''}</button>`,
									)
									.join('')}
							</div>
						</div>`,
							)
							.join('') || '<div class="question-text">(unsupported payload)</div>'
					}</div>
				</div>`;
			for (const button of cards.querySelectorAll<HTMLButtonElement>('[data-q]')) {
				button.onclick = () => {
					app.answerQuestion([[button.dataset.q ?? '', button.dataset.a ?? '']], null);
				};
			}
			return;
		} else {
			cards.innerHTML = `<div class="card"><div class="card-title">${escapeHtml(call.method)}</div></div>`;
			return;
		}
		for (const button of cards.querySelectorAll<HTMLButtonElement>('[data-act]')) {
			button.onclick = () => {
				const act = button.dataset.act;
				if (act === 'allow') app.approve(true);
				else if (act === 'deny') app.approve(false);
				else if (act === 'execute_keep' || act === 'execute_compact' || act === 'refine') {
					app.planVerdict(act);
				}
			};
		}
	};

	const renderTranscriptItemInto = (node: HTMLElement, item: TranscriptItem): void => {
		switch (item.kind) {
			case 'user':
				node.className = 'item item-user';
				node.innerHTML = `<div class="bubble user">${escapeHtml(item.text)}${
					item.images
						? `<div class="images">${item.images
								.map((img) => (img.data ? `<img src="${escapeAttr(img.data)}" alt="">` : ''))
								.join('')}</div>`
						: ''
				}</div>`;
				return;
			case 'assistant':
				node.className = 'item item-assistant';
				node.innerHTML = `<div class="bubble assistant md">${renderMarkdown(item.text)}${
					item.modelId ? `<div class="meta">${escapeHtml(item.modelId)}</div>` : ''
				}</div>`;
				return;
			case 'thinking':
				node.className = 'item item-thinking';
				node.innerHTML = `<details class="thinking"><summary>thinking</summary><div>${escapeHtml(item.text)}</div></details>`;
				return;
			case 'tool': {
				node.className = 'item item-tool';
				const tool = item.tool;
				const statusClass =
					tool.status === 'running' || tool.status === 'pending'
						? 'tool-run'
						: tool.status === 'failed'
							? 'tool-err'
							: '';
				const output = tool.output
					? `<pre class="tool-output">${escapeHtml(tool.output.slice(-4000))}</pre>`
					: '';
				node.innerHTML = `
					<details class="tool ${statusClass}">
						<summary><span class="tool-name">${escapeHtml(tool.name)}</span> <span class="tool-title">${escapeHtml(tool.title)}</span> <span class="tool-status">${escapeHtml(tool.status)}</span>${tool.autoApproved ? '<span class="tool-auto">auto</span>' : ''}</summary>
						${output}
					</details>`;
				return;
			}
			case 'compaction':
				node.className = 'item item-compaction';
				node.innerHTML = `<div class="compaction">⏳ ${escapeHtml(item.summary || 'compacting history…')}</div>`;
				return;
		}
	};

	return { render };
}

function byId<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`manox webview: #${id} missing`);
	return el as T;
}

/** Index of the first differing element; -1 when equal. */
function firstDifference(a: string[], b: string[]): number {
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i += 1) {
		if (a[i] !== b[i]) return i;
	}
	return -1;
}

const escapeHtml = (text: string): string =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const escapeAttr = (text: string): string => escapeHtml(text).replace(/'/g, '&#39;');
