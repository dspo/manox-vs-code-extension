// The x-manox extension surface — the TS twin of `manox_ahp::ext` (v0.3.0,
// `crates/manox-ahp/src/ext/{mod,reducer}.rs`). AHP deliberately stays
// agent-agnostic; everything manox-specific travels as extension channels
// (`x-manox-*`), extension actions/commands/requests (`x-manox/*`), and
// `_meta["x-manox"]` on `initialize`. The declaration below must stay in
// lock-step with the Rust `declaration()` — it is what the host advertises
// and what this host consumes.
//
// Extension channels are NOT state-bearing: `subscribe` answers with an
// `x-manox/baseline` action envelope (`{type, state}` — the channel's whole
// bag, or the catalogue payload for the connection-level channels), then
// deltas ride ordinary action envelopes. The bag fold here mirrors
// `ext::reducer::apply` field for field, unknown-tolerant by design (an
// action this build does not know leaves the state untouched — L12).

/** `_meta` key carrying the extension declaration on `initialize` params
 * and result. */
export const EXT_META_KEY = 'x-manox';

/** Extension surface version this extension speaks (upstream `ext::VERSION`). */
export const EXT_VERSION = 5;

/** State-bearing extension channel prefixes (upstream `ext::channels`). */
export const EXT_CHANNELS = {
	/** Plan mode, plan document, plan review lifecycle (per chat). */
	plan: 'x-manox-plan:/',
	/** Goal, background tasks, browser suites, sub-agent tree (per session). */
	work: 'x-manox-work:/',
	/** Aggregated conversation metrics — the v2 Q face (per chat). */
	metrics: 'x-manox-metrics:/',
	/** Thread rows: pin, label, session info, leaf cursor (per session). */
	thread: 'x-manox-thread:/',
	/** Durable workspace rows: directory identity plus ordered session account. */
	workspaces: 'x-manox-workspaces://',
	/** Command / skill catalogue (stateless snapshot channel). */
	commands: 'x-manox-commands://',
} as const;

/** Extension actions (upstream `ext::actions`). */
export const EXT_ACTIONS = {
	baseline: 'x-manox/baseline',
	planModeChanged: 'x-manox-plan/planModeChanged',
	planChanged: 'x-manox-plan/planChanged',
	planVerdictRequested: 'x-manox-plan/verdictRequested',
	planReviewSettled: 'x-manox-plan/reviewSettled',
	workGoalChanged: 'x-manox-work/goalChanged',
	workBackgroundTasks: 'x-manox-work/backgroundTasksChanged',
	workBrowserSuites: 'x-manox-work/browserSuitesChanged',
	workActiveTools: 'x-manox-work/activeToolsChanged',
	metricsChanged: 'x-manox-metrics/changed',
	workspacesBaseline: 'x-manox-workspaces/baseline',
	workspacesChanged: 'x-manox-workspaces/changed',
	workspacesRemoved: 'x-manox-workspaces/removed',
	orderChanged: 'x-manox/orderChanged',
	pinnedChanged: 'x-manox/pinnedChanged',
	labelChanged: 'x-manox/labelChanged',
	sessionInfoChanged: 'x-manox/sessionInfoChanged',
	leafChanged: 'x-manox/leafChanged',
} as const;

/** Extension commands (upstream `ext::commands`). */
export const EXT_COMMANDS = {
	compact: 'x-manox/compact',
	planExecute: 'x-manox/planExecute',
	goal: 'x-manox/goal',
	openTurn: 'x-manox/openTurn',
} as const;

/** Host → client requests (upstream `ext::requests`). The extension answers
 * clipboardRead / openExternal / invokeTool; browserOp stays undeclared
 * (no embedded browser in VS Code). */
export const EXT_REQUESTS = {
	browserOp: 'x-manox/browserOp',
	clipboardRead: 'x-manox/clipboardRead',
	openExternal: 'x-manox/openExternal',
	invokeTool: 'x-manox/invokeTool',
} as const;

/** The `initialize` `_meta["x-manox"]` payload this host sends: the requests
 * it can answer. The host routes capability calls fail-closed by this
 * declaration — an undeclared name never reaches us. */
export const extInitializeMeta = (): Record<string, unknown> => ({
	[EXT_META_KEY]: {
		serverRequests: [EXT_REQUESTS.clipboardRead, EXT_REQUESTS.openExternal, EXT_REQUESTS.invokeTool],
	},
});

/** True when `uri` is one of the declared extension channels. */
export function isExtensionChannel(uri: string): boolean {
	return Object.values(EXT_CHANNELS).some((prefix) => uri.startsWith(prefix));
}

/** True when `uri` is a per-session extension channel (`…:/<session-id>`)
 * rather than a connection-level catalogue. */
export function isSessionScopedChannel(uri: string): boolean {
	return (['plan', 'work', 'metrics', 'thread'] as const).some((k) => uri.startsWith(EXT_CHANNELS[k]));
}

/** The session/chat id an extension channel URI carries (`…:/<id>`), or
 * undefined for the catalogue channels. */
export function extensionChannelId(uri: string): string | undefined {
	const at = uri.indexOf(':/');
	if (at < 0) return undefined;
	const rest = uri.slice(at + 2).split('/')[0];
	return rest === '' ? undefined : rest;
}

// ── the bag fold (TS twin of `ext::reducer`) ────────────────────────────────

/** Everything manox carries that AHP has no native slot for, per channel.
 * Field names are the wire's camelCase (`ext::reducer::XManoxState` renames
 * snake_case Rust fields); values stay `unknown`-tolerant — consumers
 * extract defensively. */
export interface ExtBag {
	planMode?: boolean;
	plan?: unknown;
	planReview?: unknown;
	goal?: unknown;
	browserSuites?: string[];
	/** Task id → the task's latest wire snapshot (journal rows upsert by
	 * `task_id`; snake_case because the row is the journal snapshot verbatim). */
	backgroundTasks?: Record<string, unknown>;
	pinned?: boolean;
	label?: string;
	/** On `x-manox-thread:/` the session-info row; on `x-manox-metrics:/` the
	 * metrics aggregate (that read model has no field of its own). */
	sessionInfo?: unknown;
	leaf?: string;
	activeTools?: string[];
	order?: unknown;
}

/** The wire row of a background-task registry entry. */
export interface BackgroundTaskRow {
	task_id?: unknown;
	status?: unknown;
	[key: string]: unknown;
}

export function emptyExtBag(): ExtBag {
	return {};
}

export function isExtAction(action: unknown): action is { type: string } {
	return typeof action === 'object' && action !== null && typeof (action as { type?: unknown }).type === 'string';
}

/** Fold one extension action into the bag. Mirrors `ext::reducer::apply`:
 * recognised-but-restating actions are harmless, unknown actions are
 * ignored (`Unrecognised`), never an error. Returns whether the bag may
 * have changed. */
export function applyExtAction(bag: ExtBag, action: unknown): boolean {
	if (!isExtAction(action)) return false;
	const type = action.type;
	switch (type) {
		case EXT_ACTIONS.planModeChanged:
			bag.planMode = boolOf(action, 'enabled');
			return true;
		case EXT_ACTIONS.planChanged:
			bag.plan = field(action, 'snapshot');
			return true;
		case EXT_ACTIONS.planVerdictRequested:
		case EXT_ACTIONS.planReviewSettled:
			// Both edges land in the same field: the review's lifecycle is one
			// fact; consumers render the difference from the action type.
			bag.planReview = action;
			return true;
		case EXT_ACTIONS.workGoalChanged:
			bag.goal = field(action, 'goal');
			return true;
		case EXT_ACTIONS.workBrowserSuites:
			bag.browserSuites = stringArrayOf(field(action, 'suites'));
			return true;
		case EXT_ACTIONS.workBackgroundTasks: {
			// Rows upsert by the journal snapshot's snake_case `task_id`; a row
			// without a keyable id cannot enter the view and does not disturb it.
			const snapshot = field(action, 'snapshot');
			const taskId = asString((snapshot as Record<string, unknown> | null)?.task_id);
			if (!snapshot || typeof snapshot !== 'object' || !taskId) return false;
			const registry = bag.backgroundTasks ?? {};
			registry[taskId] = snapshot;
			bag.backgroundTasks = registry;
			return true;
		}
		case EXT_ACTIONS.workActiveTools:
			bag.activeTools = stringArrayOf(field(action, 'tools'));
			return true;
		case EXT_ACTIONS.metricsChanged:
			// The read model has no field of its own; the payload is the
			// aggregate, kept verbatim.
			bag.sessionInfo = action;
			return true;
		case EXT_ACTIONS.pinnedChanged:
			bag.pinned = boolOf(action, 'pinned');
			return true;
		case EXT_ACTIONS.labelChanged:
			bag.label = asString(field(action, 'label'));
			return true;
		case EXT_ACTIONS.sessionInfoChanged:
			bag.sessionInfo = field(action, 'data');
			return true;
		case EXT_ACTIONS.leafChanged:
			bag.leaf = asString(field(action, 'targetId'));
			return true;
		case EXT_ACTIONS.orderChanged:
			bag.order = field(action, 'order');
			return true;
		default:
			return false;
	}
}

/** Apply an `x-manox/baseline` envelope: replace the bag with the carried
 * state (the fold of the channel's whole journal). */
export function applyExtBaseline(bag: ExtBag, action: unknown): void {
	const state = field(action, 'state');
	if (state !== null && typeof state === 'object') Object.assign(bag, state);
}

// ── the workspaces catalogue fold ───────────────────────────────────────────

/** The `x-manox-workspaces://` catalogue: folder rows plus each partition's
 * thread order (baseline `{workspaces, order}`; deltas `changed`/`removed`).
 * Kept `unknown`-tolerant — the UI extracts defensively. */
export interface WorkspaceCatalogue {
	workspaces: unknown[];
	order: unknown;
}

export function emptyWorkspaceCatalogue(): WorkspaceCatalogue {
	return { workspaces: [], order: undefined };
}

export function applyWorkspaceAction(catalogue: WorkspaceCatalogue, action: unknown): boolean {
	if (!isExtAction(action)) return false;
	switch (action.type) {
		case EXT_ACTIONS.workspacesBaseline: {
			const state = field(action, 'state');
			if (state !== null && typeof state === 'object') {
				const rows = (state as { workspaces?: unknown }).workspaces;
				catalogue.workspaces = Array.isArray(rows) ? rows : [];
				catalogue.order = (state as { order?: unknown }).order;
			}
			return true;
		}
		case EXT_ACTIONS.workspacesChanged: {
			const row = field(action, 'workspace');
			if (row === undefined) return false;
			const id = asString((row as { id?: unknown }).id);
			const rest = catalogue.workspaces.filter((r) => asString((r as { id?: unknown }).id) !== id);
			rest.push(row);
			catalogue.workspaces = rest;
			return true;
		}
		case EXT_ACTIONS.workspacesRemoved: {
			const id = asString(field(action, 'id'));
			if (!id) return false;
			catalogue.workspaces = catalogue.workspaces.filter((r) => asString((r as { id?: unknown }).id) !== id);
			return true;
		}
		default:
			return false;
	}
}

// ── tolerant field readers (the guards discipline, local) ───────────────────

export function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function field(action: unknown, key: string): unknown {
	return (action as Record<string, unknown>)[key];
}

function boolOf(action: unknown, key: string): boolean | undefined {
	const value = field(action, key);
	return typeof value === 'boolean' ? value : undefined;
}

function stringArrayOf(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}
