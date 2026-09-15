// Typed wire protocol hub. The single source of truth is the extension's
// hand-maintained mirror of the Rust `manox-protocol` crate
// (`../../src/protocol/types.ts`, protocol epoch 6, lock-step with manox
// main). This module re-exports those types so the webview imports one hub,
// and carries the UI-side projections of opaque `JsonValue` payloads below —
// they are UI concerns, not wire contracts the server guarantees
// structurally.

export * from '../../src/protocol/types';

import type { AnswerKind } from '../../src/protocol/types';

/** Renamed `HookKind` → `AnswerKind` at manox #795 (wire tags unchanged);
 * the alias keeps pre-rename call sites compiling during the port. */
export type HookKind = AnswerKind;

/** User-side Goal lifecycle action (mirrors the gpui host's `/goal` verbs). */
export type GoalAction = 'create' | 'edit' | 'replace' | 'clear' | 'pause' | 'resume';

/** Wire vocabulary emitted by the actor (agent::ToolCallStatus, kebab-case).
 * The webview store folds terminal values into UI semantics
 * (success → completed, error → failed); the rest pass through. */
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

// ── §E.3 Q-face: the `GetConversationInfo` response payload ────────────────

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

/** The §E.3 `GetConversationInfo` response (on-demand fold, cached by
 * `(thread_id, cursor)` server-side; the client refreshes on committed-message
 * edges only). */
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
