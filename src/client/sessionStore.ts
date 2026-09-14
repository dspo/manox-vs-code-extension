// Per-session client state (§F.2): journal window + projections + transcript
// fold. One fold path maps journal records to transcript items; projections
// arrive as pushed deltas (P face, higher-`asOfSeq`-wins). The store is a
// passive fold — it never sends frames; `AgentConnection` (or the webview
// bridge) owns the wire.
//
// Gap repair: the engine's synchronous `readPage` source stays empty here —
// `PageHistory` resolves asynchronously over the wire, so a gap reports as an
// engine violation and the caller re-follows (fresh snapshot; L5 discipline,
// same simplification the archived webui shipped). Backwards paging calls
// `prependHistory` with a resolved `PageHistory` page.

import { asString, isKnownJournalTag, isRecord, normalizeWireRecords } from '../protocol/guards';
import type { JournalWireEntry, SessionSnapshot } from '../protocol/types';
import { JournalStream, type JournalChange } from './journalStream';
import { TranscriptFold, type FoldSideEffects, type TranscriptItem } from './transcript';

/** One cached window row: the record plus its seq key. */
interface WindowRow {
	seq: number;
	record: JournalWireEntry;
}

export interface SessionStoreEvents {
	/** Coarse change notification (transcript / projections / state). */
	readonly changed: () => void;
	/** Engine violation — terminal; the caller must re-follow (L5). */
	readonly violated: (message: string) => void;
}

/** The `model` projection value is `{provider, modelId}`; the canonical
 * display ref is `{provider}/{modelId}` (L8: split for display only). */
export function modelRefOf(value: unknown): string | null {
	if (!isRecord(value)) return null;
	const provider = asString(value.provider);
	const modelId = asString(value.modelId) ?? asString(value.id);
	if (!provider || !modelId) return null;
	return `${provider}/${modelId}`;
}

export class SessionStore {
	readonly sessionId: string;
	private readonly events: SessionStoreEvents;
	private readonly fold = new TranscriptFold();
	private rows: WindowRow[] = [];
	/** Projection map: key → {value, asOfSeq}; higher-seq-wins (§E.1). */
	readonly projections = new Map<string, { value: unknown; asOfSeq: number }>();
	private engine: JournalStream;
	/** Older records exist before the window (snapshot truncation). */
	hasMore = false;
	/** Client-mirror running flag; authoritative chain per §E.1 (`running`
	 * projection > SessionStatus delta > facade). */
	running = false;
	errored = false;
	/** Whether a snapshot has ever landed (generation-restart guard). */
	private openedOnce = false;
	/** Client-owned optimistic user bubbles keyed by Submit's originRpc. */
	readonly echoes = new Map<string, { text: string; retired: boolean }>();

	constructor(sessionId: string, events: SessionStoreEvents) {
		this.sessionId = sessionId;
		this.events = events;
		this.engine = new JournalStream(
			// PageHistory resolves asynchronously over the wire; gaps become
			// violations → re-follow (see module header).
			{ readPage: () => [] },
			{
				publish: (change) => this.onPublish(change),
				failed: (message) => events.violated(message),
			},
		);
	}

	/** The transcript items (a fresh array per call — render-friendly). */
	get transcript(): TranscriptItem[] {
		return [...this.fold.items];
	}

	/** Side-effects of the most recently applied entry. */
	get side(): FoldSideEffects {
		return this.fold.side;
	}

	projectionValue(key: string): unknown {
		return this.projections.get(key)?.value;
	}

	get title(): string {
		const t = this.projectionValue('title');
		return typeof t === 'string' && t.trim() ? t : 'New session';
	}

	get modelRef(): string | null {
		return modelRefOf(this.projectionValue('model'));
	}

	/** Optimistic echo for a Submit whose receipt is in flight; retired when
	 * the durable user row lands (originRpc correlation, L7). */
	addEcho(originRpc: string, text: string): void {
		this.echoes.set(originRpc, { text, retired: false });
	}

	// ── feed points (follow-stream frames) ─────────────────────────────────

	/** Apply a follow-stream opening snapshot (frame #1, §F.1 rule 1). */
	applySnapshot(snapshot: SessionSnapshot): void {
		this.openedOnce = true;
		this.rows = normalizeWireRecords(snapshot.records).map((record) => ({ seq: record.seq, record }));
		const page = this.rows.map((row) => ({ first: row.seq, last: row.seq }));
		this.engine.opened(snapshot.cursor, page);
		this.hasMore = snapshot.hasMore;
		this.applyProjections(snapshot.projections, snapshot.projectionsAsOfSeq);
		this.events.changed();
	}

	/** Apply one live `StreamFrame::Entry` (the full §C.1 envelope). */
	applyEntry(frame: { seq: number; id?: unknown; parentId?: unknown; timestamp?: unknown; event: unknown }): void {
		const seq = frame.seq;
		const event = isRecord(frame.event) ? frame.event : null;
		if (!Number.isFinite(seq) || !event) return;
		const type = asString(event.type) ?? 'unknown';
		const record: JournalWireEntry = {
			...event,
			seq,
			type,
			id: asString(frame.id) ?? `e-${seq}`,
			parentId: typeof frame.parentId === 'string' ? frame.parentId : null,
			timestamp: asString(frame.timestamp) ?? new Date().toISOString(),
		};
		// Feed the engine FIRST, before any tag filtering: every wire entry
		// occupies its seq (§F.1 density). Dropping an unknown-tag entry
		// before the engine would punch a hole and loop snapshot → resync.
		const violation = this.engine.entry({ first: seq, last: seq });
		if (violation) return; // violation → `failed` → caller re-follows
		const tail = this.engine.cursors().last;
		if (tail === undefined || tail < seq) return; // not applied (gap)
		insertRow(this.rows, { seq, record });
		if (!isKnownJournalTag(type)) {
			// L12 tolerance: the seq is claimed (density holds) but the row
			// renders nothing.
			return;
		}
		this.fold.append(record);
		this.retireEchoes();
		this.running = this.running || this.side.turnStarted;
		if (this.side.turnFinished) {
			this.running = false;
			this.errored = this.side.turnFinished.failed;
		}
		if (this.side.threadError) this.errored = true;
		this.events.changed();
	}

	/** Apply a projection delta or baseline (higher-`asOfSeq`-wins, §E.1). */
	applyProjections(values: Record<string, unknown>, asOfSeq: number): void {
		let changed = false;
		for (const [key, value] of Object.entries(values)) {
			const prior = this.projections.get(key);
			if (prior && prior.asOfSeq > asOfSeq) continue;
			this.projections.set(key, { value, asOfSeq });
			changed = true;
		}
		if (!changed) return;
		if ('running' in values) this.running = values.running === true;
		if ('errored' in values) this.errored = values.errored === true;
		// The `model` projection seeds the fold's display stamp (a rebuilt
		// window re-reads it in onPublish).
		this.fold.modelRef = this.modelRef ?? this.fold.modelRef;
	}

	/** Fold a resolved `PageHistory` page as a backwards prepend (§F.1.4). */
	prependHistory(records: readonly JournalWireEntry[], hasMore: boolean): void {
		const rows = normalizeWireRecords(records).map((record) => ({ seq: record.seq, record }));
		for (const row of rows) insertRow(this.rows, row);
		this.engine.prependPage(
			rows.map((row) => ({ first: row.seq, last: row.seq })),
			hasMore,
		);
	}

	/** Announce a re-follow generation; the next snapshot is validated as a
	 * resume (§F.1 rule 3). A generation restart before any snapshot opened
	 * is skipped — restarting an un-opened engine reports a violation, which
	 * would loop the re-follow path. */
	restart(): void {
		if (this.openedOnce) this.engine.restart();
	}

	/** True while an echo for `originRpc` is still unretired. */
	echoPending(originRpc: string): boolean {
		const echo = this.echoes.get(originRpc);
		return echo !== undefined && !echo.retired;
	}

	private onPublish(change: JournalChange): void {
		switch (change.type) {
			case 'append':
				// Entry frames are applied inline in `applyEntry`; the publish
				// is bookkeeping only.
				return;
			case 'replace':
			case 'prepend':
				// The engine's window just moved (opening, gap repair, or a
				// prepend page). Rebuild the transcript from the row cache.
				this.rebuildFold();
				return;
		}
	}

	private rebuildFold(): void {
		const cursors = this.engine.cursors();
		const first = cursors.first;
		const last = cursors.last;
		this.fold.modelRef = this.modelRef ?? this.fold.modelRef;
		const rows =
			first === undefined || last === undefined
				? []
				: this.rows.filter((row) => row.seq >= first && row.seq <= last);
		this.fold.replace(rows.map((row) => row.record));
	}

	/** Retire optimistic echoes whose durable user row landed (originRpc). */
	private retireEchoes(): void {
		for (const [originRpc, echo] of this.echoes) {
			if (echo.retired) continue;
			if (this.rows.some((row) => asString(row.record.originRpc) === originRpc)) {
				this.echoes.set(originRpc, { ...echo, retired: true });
			}
		}
	}
}

/** Ordered, idempotent row insert into the window cache. */
function insertRow(rows: WindowRow[], row: WindowRow): void {
	const last = rows[rows.length - 1];
	if (last === undefined || row.seq > last.seq) {
		rows.push(row);
		return;
	}
	if (row.seq === last.seq) return;
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		const cur = rows[i];
		if (cur === undefined) continue;
		if (cur.seq === row.seq) return;
		if (cur.seq < row.seq) {
			rows.splice(i + 1, 0, row);
			return;
		}
	}
	rows.unshift(row);
}
