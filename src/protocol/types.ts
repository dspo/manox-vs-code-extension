// Typed wire protocol — the authoritative source is the Rust `manox-protocol`
// crate in dspo/manox (protocol v2, PROTOCOL_EPOCH 6; §D of
// docs/dsh-v2-architecture.md). These types are hand-maintained here because
// the manox repo retired its generated TS bindings along with the old
// frontends; keep them in lock-step with the Rust enums:
//   FromClient / FromServer  — crates/manox-protocol/src/msg.rs
//   ClientCall / ClientNote  — crates/manox-protocol/src/client.rs
//   ServerCall / ServerNote  — crates/manox-protocol/src/server.rs
//   StreamKind / StreamFrame / HostEvent — src/stream.rs
//   JournalWireEvent / ThreadHeader / UsagePayload — src/journal.rs
//   ModelInfo / ThreadListItem — src/wire.rs (snake_case on purpose)
// Everything is `unknown`-tolerant on read: guards.ts is the parse face.

/** JSON value (alias kept for readability in wire payloads). */
export type Json = unknown;

/** Correlation id of a request/response or call/reply pair (a bare string on
 * the wire — `MsgId(pub String)`). */
export type MsgId = string;

/** Client-minted handle of one server→client stream (a bare string). */
export type StreamId = string;

/** Canonical model reference, `{provider_registration}/{model_id}` (a bare
 * string — never parsed for identity beyond display splitting, L8). */
export type ModelRef = string;

/** The `Err` arm of a Response/Reply outcome: `{code, message, data}`. The
 * §D.7 stable string code rides `data.code` when present. */
export interface RpcError {
	code: number;
	message: string;
	data: Json;
}

/** serde shape of `Result<Value, RpcError>`: externally tagged. */
export type RpcOutcome = { Ok: Json } | { Err: RpcError };

/** Base64-encoded image attachment (submit / steer payloads). */
export interface ImageAttachment {
	data: string;
	mimeType: string;
}

// ── ClientCall (tag `method`) ───────────────────────────────────────────────

export type ClientCall =
	| { method: 'initialize'; clientId: string; capabilities: AnswerKind[]; sessions: string[]; protocolEpoch: number }
	| { method: 'openSession'; sessionId: string }
	| { method: 'listThreads' }
	| { method: 'listModels' }
	| { method: 'listCommands' }
	| { method: 'terminalAttach'; session: string; cols: number; rows: number; terminalId?: string }
	| { method: 'terminalSnapshot'; terminal: string }
	| { method: 'modelChat'; requestId: string; model: string; messages: Json; tools: Json }
	| { method: 'registerSessionTools'; sessionId: string; clientId: string; tools: ClientToolSpec[] }
	| {
			method: 'createSession';
			cwd?: string;
			project?: string;
			initialModel?: ModelRef;
			approvalMode?: string;
			reasoningEffort?: string;
			seed?: Json[];
			workingDirectories?: string[];
	  }
	| { method: 'submit'; sessionId: string; text: string; images: ImageAttachment[]; originRpc?: string }
	| { method: 'steer'; sessionId: string; messageId: string; text: string; images: ImageAttachment[]; originRpc?: string }
	| { method: 'pageHistory'; sessionId: string; throughSeq: number; beforeSeq?: number; maxMessages?: number }
	| { method: 'getConversationInfo'; sessionId: string }
	| { method: 'cancelDelivery'; deliveryId: string }
	| {
			method: 'forkSession';
			sourceSessionId: string;
			throughEntryId: string;
			cwd?: string;
			project?: string;
			initialModel?: ModelRef;
			approvalMode?: string;
			reasoningEffort?: string;
	  };

/** One embedder-registered tool (`RegisterSessionTools`). The Rust struct
 * carries no `rename_all` (crates/manox-protocol/src/client.rs), so the wire
 * keys are snake_case — `inputSchema`/`readOnly` would fail deserialization
 * (`missing field input_schema`) or be silently dropped. builders.ts's
 * `clientToolSpec` is the shaping face; guards.test pins the JSON keys. */
export interface ClientToolSpec {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	read_only?: boolean;
}

/** Capability a client can answer when the server issues a ServerCall
 * (Rust `AnswerKind`, answer_kind.rs — renamed from HookKind at #795; the
 * wire tags are unchanged camelCase literals). */
export type AnswerKind =
	| 'approve'
	| 'planVerdict'
	| 'askUserQuestion'
	| 'browserOp'
	| 'clipboardRead'
	| 'openExternal'
	| 'clientTool';

// ── ClientNote (tag `method`) ───────────────────────────────────────────────

export type ClientNote =
	| { method: 'createSession'; sessionId: string; cwd?: string } // compat arm
	| { method: 'disposeSession'; sessionId: string }
	| { method: 'detachSession'; sessionId: string }
	| { method: 'submit'; sessionId: string; text: string; images: ImageAttachment[]; clientId?: string } // compat
	| { method: 'steer'; sessionId: string; clientId: string; text: string; images: ImageAttachment[] } // compat
	| { method: 'dropQueued'; sessionId: string; clientId: string }
	| { method: 'cancelTurn'; sessionId: string }
	| { method: 'setModel'; sessionId: string; id: ModelRef }
	| { method: 'setReasoningEffort'; sessionId: string; effort: string }
	| { method: 'setApprovalMode'; sessionId: string; mode: string }
	| { method: 'setCwd'; sessionId: string; cwd: string }
	| { method: 'setPlanMode'; sessionId: string; enabled: boolean }
	| { method: 'setBrowserSuite'; sessionId: string; suite: string; enable: boolean }
	| { method: 'planSeedExecution'; sessionId: string; planFile: string }
	| { method: 'compact'; sessionId: string; instructions?: string }
	| { method: 'goal'; sessionId: string; action: string; objective?: string; budget?: number; maxRounds?: number }
	| { method: 'stopBackgroundTask'; sessionId: string; taskId: string }
	| { method: 'archiveThread'; sessionId: string; archived: boolean }
	| { method: 'pinThread'; sessionId: string; pinned: boolean }
	| { method: 'insertThreadBefore'; threadId: string; beforeThreadId?: string }
	| { method: 'insertGroupBefore'; path: string; beforePath?: string }
	| { method: 'terminalInput'; terminal: string; bytes: string }
	| { method: 'terminalResize'; terminal: string; cols: number; rows: number }
	| { method: 'cancelModelChat'; requestId: string }
	| { method: 'shutdown' }
	| { method: 'appendUserMessage'; sessionId: string; text: string; images: ImageAttachment[] }
	| { method: 'appendUiNote'; sessionId: string; kind: string; data: Json };

// ── ServerCall (tag `method`) ───────────────────────────────────────────────

export type ServerCall =
	| { method: 'approve'; deliveryId: string; sessionId: string; authId: string; toolName: string; summary: string; input: Json }
	| { method: 'planVerdict'; deliveryId: string; sessionId: string; planFile: string; title: string; content?: string }
	| { method: 'askUserQuestion'; deliveryId: string; sessionId: string; authId: string; input: Json }
	| { method: 'browserOp'; sessionId: string; op: Json }
	| { method: 'clipboardRead'; sessionId: string }
	| { method: 'openExternal'; sessionId: string; url: string }
	| { method: 'invokeClientTool'; deliveryId: string; sessionId: string; clientId: string; toolCallId: string; name: string; input: Json };

// ── ServerNote (tag `method`) — the retained §D.6 surface ──────────────────

export type ServerNote =
	| { method: 'ready' }
	| { method: 'sessionCreated'; sessionId: string }
	| { method: 'sessionDisposed'; sessionId: string }
	| { method: 'threadsUpdated'; threads: ThreadListItem[] }
	| { method: 'models'; models: ModelInfo[] }
	| { method: 'commands'; commands: Json }
	| { method: 'error'; sessionId: string | null; message: string }
	| { method: 'modelText'; requestId: string; text: string }
	| { method: 'modelThinking'; requestId: string; text: string }
	| { method: 'modelToolCall'; requestId: string; id: string; name: string; input: Json }
	| { method: 'modelChatDone'; requestId: string; stop?: string; error?: string };

// ── HostEvent (tag `type`) ──────────────────────────────────────────────────

export type HostEvent =
	| { type: 'ready'; epoch: number }
	| { type: 'models'; models: ModelInfo[] }
	| { type: 'commands'; commands: Json }
	| { type: 'threadsUpdated'; threads: ThreadListItem[] }
	| {
			type: 'sessionStatus';
			sessionId: string;
			running?: boolean;
			errored?: boolean;
			unread?: boolean;
			pendingAuth?: boolean;
			pendingPlan?: boolean;
			backgroundWork?: boolean;
	  }
	| { type: 'sessionCreated'; sessionId: string; header: ThreadHeader }
	| { type: 'sessionDisposed'; sessionId: string }
	| { type: 'error'; message: string; sessionId: string | null }
	| { type: 'projects'; known: string[] }
	| { type: 'terminalsUpdated'; terminals: TerminalSummary[] };

export interface TerminalSummary {
	id: string;
	title: string | null;
	lifecycle: string;
	exitCode: number | null;
}

// ── Stream payloads (tag `type`) ────────────────────────────────────────────

export type StreamKind =
	| { type: 'followSession'; sessionId: string; maxMessages?: number }
	| { type: 'followTerminal'; terminalId: string };

export type StreamFrame =
	| { type: 'snapshot' } & SessionSnapshot
	| { type: 'entry'; seq: number; id: string; parentId: string | null; timestamp: string; event: JournalWireEvent }
	| { type: 'projections' } & ProjectionsFrame
	| { type: 'terminalOutput'; data: string };

export interface SessionSnapshot {
	sessionId: string;
	header: ThreadHeader;
	/** Inclusive seq of the last active-chain entry; 0 for an empty journal. */
	cursor: number;
	records: JournalWireEntry[];
	hasMore: boolean;
	projections: Record<string, Json>;
	projectionsAsOfSeq: number;
}

export interface ProjectionsFrame {
	sessionId: string;
	asOfSeq: number;
	values: Record<string, Json>;
}

export type StreamEndReason =
	| { type: 'closed' }
	| { type: 'cancelled' }
	| { type: 'resync' }
	| { type: 'failure'; code: string; message: string };

// ── Envelopes (tag `kind`) ──────────────────────────────────────────────────

export type FromClient =
	| { kind: 'request'; id: MsgId; call: ClientCall }
	| { kind: 'notification'; note: ClientNote }
	| { kind: 'reply'; id: MsgId; outcome: RpcOutcome }
	| { kind: 'streamOpen'; streamId: StreamId; streamKind: StreamKind }
	| { kind: 'streamCancel'; streamId: StreamId };

export type FromServer =
	| { kind: 'response'; id: MsgId; outcome: RpcOutcome }
	| { kind: 'request'; id: MsgId; call: ServerCall }
	| { kind: 'notification'; note: ServerNote }
	| { kind: 'host'; host: HostEvent }
	| { kind: 'streamItem'; streamId: StreamId; frame: StreamFrame }
	| { kind: 'streamEnd'; streamId: StreamId; reason: StreamEndReason };

// ── Journal vocabulary (tag `type`, camelCase payload fields) ──────────────

export type JournalWireEvent =
	// transcript
	| { type: 'message'; role: string; content: Json[]; usage?: UsagePayload; originRpc?: string; display?: boolean }
	| { type: 'uiNote'; kind: string; data: Json }
	| { type: 'custom'; customType: string; data: Json }
	| { type: 'customMessage'; customType: string; content: Json[]; display: boolean }
	// lifecycle
	| { type: 'turnStart' }
	| { type: 'turnFinish'; cancelled: boolean; failed: boolean; strandedSteerIds: string[] }
	| { type: 'stop'; reason: string | null }
	| { type: 'retry'; attempt: number; maxAttempts: number; delaySecs: number; reason: string }
	| { type: 'error'; message: string }
	// streaming delta
	| { type: 'agentTextDelta'; s: string }
	| { type: 'agentThinkingDelta'; s: string }
	| { type: 'toolCall'; callId: string; name: string; title: string; status: string; input: Json }
	| { type: 'toolResult'; callId: string; output: string; isError: boolean }
	| { type: 'toolOutputChunk'; callId: string; chunk: string }
	| { type: 'subagentChild'; agentId: string; event: Json }
	| { type: 'subagentProgress'; agentId: string; agentType: string; toolUses: number; latestActivity?: string; status: string }
	// state change
	| { type: 'modelChange'; from?: ModelRef; to: ModelRef }
	| { type: 'cwdChange'; path: string }
	| { type: 'projectChange'; path: string | null }
	| { type: 'permissionModeChange'; mode: string }
	| { type: 'reasoningEffortChange'; effort: string }
	| { type: 'planModeChange'; enabled: boolean }
	| { type: 'planUpdate'; snapshot: Json }
	| { type: 'planReview'; state: string; planFile: string | null }
	| { type: 'goal'; goal: Json }
	| { type: 'title'; title: string }
	| { type: 'browserSuites'; suites: string[] }
	| { type: 'backgroundTask'; snapshot: Json }
	| { type: 'approval'; kind: string; authId: string; toolName?: string; toolCallId?: string; verdict?: string; reason?: string }
	| { type: 'pinnedArchived'; pinned: boolean; archived: boolean }
	| { type: 'activeToolsChange'; tools: string[] }
	| { type: 'compaction'; summary: string; messagesCompacted: number; tokensBefore: number; retainedTail: Json[]; firstKeptEntryId?: string }
	| { type: 'compactionStarted'; tokensBefore: number }
	// compression / tree
	| { type: 'branchSummary'; text: string }
	| { type: 'label'; label: string }
	| { type: 'sessionInfo'; data: Json }
	| { type: 'leaf'; targetId: string }
	// metrics
	| { type: 'metrics'; kind: string; data: Json };

/** One snapshot record: the §C.1 envelope with the event flattened inline. */
export interface JournalWireEntry {
	seq: number;
	id: string;
	parentId: string | null;
	timestamp: string;
	/** The event's fields (including its `type` tag) flattened into the row. */
	[type: string]: Json;
}

export interface UsagePayload {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

export interface ThreadHeader {
	id: string;
	cwd: string;
	parentSession: string | null;
	metadata: Json;
	createdAt: string;
}

// ── List-channel rows (snake_case on the wire, matching the Rust structs) ──

export interface ThreadListItem {
	id: string;
	title: string;
	updated_at: number;
	running: boolean;
	/** Deprecated (GW5): always false; derive unread from SessionStatus deltas. */
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

// ── UI-side projections of opaque payloads (client concerns, not contract) ──

/** How the user resolves a submitted plan review. */
export type PlanVerdictChoice = 'execute_keep' | 'execute_compact' | 'refine';

/** Tool-authorization policy (the actor's kebab wire values). */
export type ApprovalMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Reasoning-effort wire vocabulary accepted by createSession / setReasoningEffort. */
export type ReasoningEffort = 'high' | 'max';

/**
 * One question step of an `askUserQuestion` ServerCall input payload
 * (B2-PR-1 / L1 vocabulary, #796): every question carries a stable `id`
 * (server-minted when the model omits it — answers route by it), an
 * optional `detail` markdown support text, and an optional `intent`
 * (`{kind, approve}` names the approving option label; only alongside a
 * `detail`). Answers are tri-state: option selection(s), free text
 * (`custom`), or skip (empty selected, no custom).
 */
export interface AskQuestionWire {
	id?: string;
	question: string;
	header?: string;
	detail?: string;
	intent?: { kind: string; approve?: string };
	multiSelect?: boolean;
	options: { label: string; description?: string; recommended?: boolean }[];
}

/** One canonical answer row (B2-PR-1): routed by `id`; skip = empty
 * `selected` with no `custom`; NO card-level response override. */
export interface AskAnswerRow {
	id: string;
	selected: string[];
	custom?: string;
}
