// Typed protocol hub for the webview. Under AHP the wire vocabulary comes
// from the `@microsoft/agent-host-protocol` SDK (the same types the host and
// the Rust side generate from); this module re-exports the slices the webview
// reads and carries:
//
//   * the UI view models the components render (threads rows, model rows,
//     transcript-adjacent wire shapes) — UI concerns the webview OWNS, mapped
//     from AHP state in the store fold, never a second wire contract;
//   * the relay message vocabulary (the host sidebar proxies this webview's
//     protocol traffic over one AHP connection).

import type {
	ChatState as AhpChatState,
	ChatSummary as AhpChatSummary,
	SessionState as AhpSessionState,
	SessionSummary as AhpSessionSummary,
} from '@microsoft/agent-host-protocol';

export type { AhpChatState, AhpChatSummary, AhpSessionState, AhpSessionSummary };

// ── view models (webview-owned; the store maps AHP state onto these) ───────

/** One model row in the picker. Mapped from the root state's
 * `agents[].models` (`SessionModelInfo`); the canonical display ref is
 * `{provider}/{id}`. */
export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	provider_name?: string;
	api: string;
	context_window: number;
	max_tokens?: number;
	config_id?: string;
	agents?: string[];
}

/** One threads-list row. Mapped from `SessionSummary` plus the session's
 * `x-manox-thread:/` bag (pin/label/leaf live there — AHP has no slot). The
 * flag columns are the §D.5 mirror vocabulary the list has always rendered;
 * `unread` is client-owned (GW5). */
export interface ThreadListItem {
	id: string;
	title: string;
	updated_at: number;
	running: boolean;
	/** Deprecated (GW5): always false; unread is client-owned state. */
	unread: boolean;
	errored: boolean;
	pending_auth: boolean;
	pending_plan: boolean;
	background_work: boolean;
	model_id: string;
	pinned: boolean;
	archived: boolean;
	parent_id: string | null;
	depth: number;
	project?: string;
	tag?: string;
	approval_mode?: number;
}

export type ApprovalMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ReasoningEffort = 'high' | 'max';

export type PlanVerdictChoice = 'execute_keep' | 'execute_compact' | 'refine';

/** Base64 image attachment on a submitted message. */
export interface ImageAttachment {
	data: string;
	mimeType: string;
}

/** One id-routed tri-state answer row of an ask-question card. */
export interface AskAnswerRow {
	id: string;
	selected: string[];
	custom?: string;
}

/** One question step of an AHP chat input request (elicitation): every
 * question carries a stable `id` (answers route by it), an optional `detail`
 * markdown support text, and an optional `intent` (`{kind, approve}` names
 * the approving option label). Answers are tri-state: option selection(s),
 * free text (`custom`), or skip. */
export interface AskQuestionWire {
	id?: string;
	question: string;
	header?: string;
	detail?: string;
	intent?: { kind: string; approve?: string };
	multiSelect?: boolean;
	options: { label: string; description?: string; recommended?: boolean }[];
}

/** User-side Goal lifecycle action (mirrors the gpui host's `/goal` verbs). */
export type GoalAction = 'create' | 'edit' | 'replace' | 'clear' | 'pause' | 'resume';

/** Wire vocabulary emitted by the host for tool calls (kebab-case). The
 * webview store folds terminal values into UI semantics (success →
 * completed, error → failed); the rest pass through. */
export type ToolCallStatus =
	| 'pending-approval'
	| 'running'
	| 'success'
	| 'continued'
	| 'error'
	| 'denied'
	| 'cancelled'
	| (string & {});

/** One slash-completion entry: a built-in/prompt-macro command or a skill. */
export interface CommandEntry {
	name: string;
	/** Null for built-ins; the webview translates them via `i18n_key`. */
	description: string | null;
	kind: 'command' | 'skill';
	argument_hint: string | null;
	/** Fluent key (agent locales) for built-in commands; the webview's own
	 * i18n dict carries the copy. Null for markdown commands and skills. */
	i18n_key?: string | null;
}

/** Serde wire form of agent plan snapshots. */
export interface PlanStepWire {
	step: string;
	status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanSnapshotWire {
	explanation: string | null;
	steps: PlanStepWire[];
}

/** Serde wire form of the thread's persistent Goal (agent::goal::ThreadGoal). */
export interface GoalSnapshotWire {
	thread_id: string;
	goal_id: string;
	objective: string;
	/** serde snake_case wire form of GoalStatus. */
	status: 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete';
	token_budget: number | null;
	tokens_used: number;
	time_used_seconds: number;
	status_reason: string | null;
	created_at: number;
	updated_at: number;
}

// ── §E.3 Q-face: the metrics-channel aggregate ──────────────────────────────

/** One per-model aggregate row of the §E.3 fold (`models[]`). */
export interface ConversationModelRow {
	provider: string;
	/** Canonical wire identity (L8): `{provider}/{model}`. */
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	calls: number;
	/** Last request's full context numerator. */
	lastTotal: number;
	contextWindow: number | null;
	hitRate: number | null;
	pct: number | null;
}

/** Working-tree stats inside the §E.3 fold (`git`). */
export interface ConversationGit {
	branch: string;
	ahead: number;
	behind: number;
	dirty: number;
}

/** The §E.3 metrics aggregate (the `x-manox-metrics:/<chat>` read model;
 * under AHP it streams as channel state — `sessionInfo` on the metrics bag —
 * instead of an on-demand reply). */
export interface ConversationInfo {
	threadId: string;
	cursor: number;
	title: string | null;
	cwd: string | null;
	project: string | null;
	/** Canonical `{provider}/{model}` display ref. */
	model: string | null;
	contextWindow: number | null;
	turns: number;
	messages: number;
	models: ConversationModelRow[];
	cumulativeCost: number;
	git: ConversationGit | null;
}

/** Wire form of a background-task snapshot (agent::background_task::TaskSnapshot). */
export interface BackgroundTaskSnapshotWire {
	task_id: string;
	kind: 'MonitorCommand' | 'MonitorWebSocket' | 'BackgroundBash';
	owner_thread_id: string;
	description: string;
	status: 'Running' | 'Stopping' | 'Completed' | 'Failed' | 'TimedOut' | 'Stopped' | 'SessionEnded';
	created_at_ms: number;
	ended_at_ms: number | null;
	event_count: number;
	total_bytes: number;
	exit_code: number | null;
	failure_summary: string | null;
	/** Bounded tail of accumulated output (newest bytes). Omitted by the
	 * sender when empty, so consumers must treat it as optional. */
	output_tail?: string;
}

/** One streamed child-session event from a running sub-agent. */
export type SubagentChildWire =
	| { kind: 'text'; text: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'tool_start'; id: string; name: string; hint?: { key: string; value: string } | null }
	| { kind: 'tool_end'; id: string; name: string; is_error: boolean };

// ── the relay vocabulary (mirrors src/sidebar/sidebarProvider.ts) ───────────

/** Host → webview. `snapshot` seeds the fold for one channel; `event` keeps
 * it current; `res` answers a `req`. */
export type RelayToWebview =
	| { t: 'snapshot'; channel: string; state: unknown }
	| { t: 'event'; event: RelayEvent }
	| { t: 'res'; id: string; ok: boolean; result?: unknown; error?: string }
	| { t: 'verb'; kind: 'new_session' | 'open_turn_navigator' }
	| { t: 'verb'; kind: 'code_chain'; sessionId: string; chainId: string; title: string; nodeCount: number }
	| { t: 'config'; approvalMode: string }
	| { t: 'boot'; cwd: string; approvalMode: string }
	| { t: 'pong'; seq: number }
	| { t: 'fatal'; message: string };

/** A catalog event relayed from the host (the subset of `ManoxClient`
 * RelayEvent the webview folds; action envelopes arrive verbatim). */
export type RelayEvent =
	| { readonly type: 'action'; readonly envelope: { channel: string; action: unknown; serverSeq?: number; origin?: unknown } }
	| { readonly type: 'sessionAdded'; readonly summary: AhpSessionSummary }
	| { readonly type: 'sessionRemoved'; readonly session: string }
	| { readonly type: 'sessionSummaryChanged'; readonly session: string; readonly changes: Partial<AhpSessionSummary> };
