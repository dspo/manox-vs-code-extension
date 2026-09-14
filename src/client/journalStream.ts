// `JournalStream` — the §F.1 journal-window engine (architecture v2). Ported
// from the TS twin that lived in the manox monorepo's webui
// (archive/frontends-final:apps/web/webui/src/sidebar/webview/state/journal.ts),
// rule-for-rule identical to the Rust engine in
// crates/manox-protocol/src/journal_stream.rs; both engines stay in lock-step
// by running the same shared conformance vectors
// (test/journal-cases.json, ported from the manox repo).
//
// Pure algebra: no DOM, no network, no async, no session domain types. A page
// is an ordered `Entry[]`; entries carry an inclusive `[first, last]` seq
// range. Gap repair reads pages through an injected `JournalSource` (in
// production wired to `PageHistory`); output flows through the `publish` /
// `failed` callbacks.
//
// Because the cursor is fixed to dense u64 seq, the pluggable compare/follows
// algebra specialises to number ordering and `right === left + 1`. The spec's
// u64 wire cursor means an empty opening page keeps tail `undefined` while
// still being accepted (the page carries no entry, so no seq can encode
// "empty"); consumers read the window from the published `replace`.

/** One journal entry covering the inclusive `[first, last]` seq range. */
export interface JournalEntry {
	readonly first: number;
	readonly last: number;
}

/** A journal page: an ordered run of entries. */
export type JournalPage = readonly JournalEntry[];

/** Reads one journal page whose tail equals `through` (gap repair). */
export interface JournalSource {
	/** Read the page ending at `through` (inclusive). */
	readPage(through: number): JournalPage;
	/** Diagnostic stream name embedded in protocol-failure messages. */
	readonly name?: string;
}

/** One committed change to the published journal window. */
export type JournalChange =
	| { readonly type: 'replace'; readonly entries: JournalPage; readonly hasMore: boolean }
	| { readonly type: 'prepend'; readonly entries: JournalPage; readonly hasMore: boolean }
	| { readonly type: 'append'; readonly entry: JournalEntry };

/** Cursor bookkeeping recorded on every successful apply (§F.1.4). */
export interface JournalCursors {
	/** Head (oldest) cursor currently in the published window. */
	readonly first: number | undefined;
	/** Tail (newest) cursor currently in the published window. */
	readonly last: number | undefined;
	/** Cursor a follow stream must resume from at the next opening. */
	readonly resume: number | undefined;
}

/** Construction options for one `JournalStream`. */
export interface JournalStreamOptions {
	/** Apply one complete journal-window change. */
	readonly publish: (change: JournalChange) => void;
	/** Publish a protocol failure (terminal for the stream in production). */
	readonly failed: (message: string) => void;
}

/** Internal result type: `Err(message)` is a protocol violation. */
type Outcome = undefined | string;

/** The input union for the single `apply` entry point (mirrors Rust). */
export type JournalInput =
	| { readonly kind: 'opened'; readonly cursor: number; readonly page: JournalPage }
	| { readonly kind: 'entry'; readonly entry: JournalEntry }
	| { readonly kind: 'prepend'; readonly page: JournalPage; readonly hasMore: boolean }
	| { readonly kind: 'generation' };

/**
 * The snapshot-first, gap-free journal window engine over a stream of inputs.
 * Synchronous and framework-neutral — drive it with `opened`/`entry`/
 * `prependPage`/`restart` (or a single `apply`).
 *
 * Rules (§F.1): a non-empty opening page must end at its cursor and be
 * internally adjacent; entries at-or-below the tail drop idempotently; a hole
 * triggers a repair page read (merged with queued entries, retried once); a
 * generation restart validates the next opening as a resume; a prepend must
 * adjoin the window head.
 */
export class JournalStream {
	private readonly source: JournalSource;
	private readonly publish: (change: JournalChange) => void;
	private readonly failed: (message: string) => void;

	private openedState = false;
	private resumedPending = false;
	private firstCursor: number | undefined;
	private lastCursor: number | undefined;
	private resumeCursor: number | undefined;

	constructor(source: JournalSource, options: JournalStreamOptions) {
		this.source = source;
		this.publish = options.publish;
		this.failed = options.failed;
	}

	/** The cursors recorded after the most recent successful apply. */
	cursors(): JournalCursors {
		return { first: this.firstCursor, last: this.lastCursor, resume: this.resumeCursor };
	}

	/** The journal cursor to resume a re-opened follow from, if any. */
	resumeCursorValue(): number | undefined {
		return this.resumeCursor;
	}

	/** Announce a connection generation boundary (re-follow); the next
	 * `opened` is validated as a resume. Returns the violation message (also
	 * reported through `failed`) or `undefined` on success. */
	restart(): Outcome {
		return this.apply({ kind: 'generation' });
	}

	/** Apply one generation's opening snapshot: the tail page and the journal
	 * cursor at opening time. */
	opened(cursor: number, page: JournalPage): Outcome {
		return this.apply({ kind: 'opened', cursor, page });
	}

	/** Apply one live `Entry` frame. */
	entry(entry: JournalEntry): Outcome {
		return this.apply({ kind: 'entry', entry });
	}

	/** Apply one backwards history page; `hasMore` mirrors the page's
	 * "older entries exist" flag. */
	prependPage(page: JournalPage, hasMore: boolean): Outcome {
		return this.apply({ kind: 'prepend', page, hasMore });
	}

	/**
	 * Feed one arrival into the engine. Returns the violation message on a
	 * protocol violation — the same message is reported through the `failed`
	 * callback before being returned. A violation is terminal for the stream
	 * in production; `apply` itself is reentrant so the shared test vectors
	 * can keep driving after a recorded violation.
	 */
	apply(input: JournalInput): Outcome {
		let result: Outcome;
		switch (input.kind) {
			case 'generation':
				result = this.onGeneration();
				break;
			case 'opened':
				result = this.onOpened(input.cursor, input.page);
				break;
			case 'entry':
				result = this.onEntry(input.entry);
				break;
			case 'prepend':
				result = this.onPrepend(input.page, input.hasMore);
				break;
		}
		if (result !== undefined) {
			this.failed(result);
		}
		return result;
	}

	private name(): string {
		return this.source.name ?? 'journal';
	}

	private violation(core: string): string {
		return `${this.name()} ${core}`;
	}

	private onGeneration(): Outcome {
		if (!this.openedState) {
			return this.violation('generation restart before opening');
		}
		this.resumedPending = true;
		return undefined;
	}

	private onOpened(cursor: number, page: JournalPage): Outcome {
		const resumed = this.resumedPending;
		this.resumedPending = false;
		if (resumed && this.lastCursor !== undefined && cursor < this.lastCursor) {
			return this.violation('resumed at a cursor behind the last applied entry');
		}
		const failure = this.replaceFromOpening(cursor, page);
		if (failure !== undefined) {
			return failure;
		}
		this.openedState = true;
		return undefined;
	}

	/** Assert the page ends at its opening cursor (non-empty pages) and is
	 * internally adjacent, record `first`/`last`/`resume`, and publish
	 * `replace`. An empty opening page keeps tail `undefined` (no entry means
	 * no seq can encode "empty"). */
	private replaceFromOpening(cursor: number, page: JournalPage): Outcome {
		if (page.length > 0) {
			const through = this.assertPageThrough(page, cursor);
			if (through !== undefined) {
				return through;
			}
		}
		const adjacent = this.assertPage(page);
		if (adjacent !== undefined) {
			return adjacent;
		}
		const hasMore = (page[0]?.first ?? 0) > 0;
		this.firstCursor = page[0]?.first;
		this.lastCursor = page.length > 0 ? cursor : undefined;
		this.resumeCursor = cursor;
		this.publish({ type: 'replace', entries: page, hasMore });
		return undefined;
	}

	private onEntry(entry: JournalEntry): Outcome {
		if (!this.openedState) {
			return this.violation('emitted an entry before its opening cursor');
		}
		const range = this.entryRange(entry);
		if (typeof range === 'string') {
			return range;
		}
		const [first, entryLast] = range;
		const tail = this.lastCursor;
		if (tail === undefined) {
			if (first !== 0) {
				return this.replaceThrough(entryLast, [entry], false);
			}
			this.firstCursor = first;
			this.lastCursor = entryLast;
			this.resumeCursor = entryLast;
			this.publish({ type: 'append', entry });
			return undefined;
		}
		if (entryLast <= tail) {
			return undefined;
		}
		if (first <= tail) {
			return this.violation('emitted a partially overlapping entry');
		}
		if (tail + 1 !== first) {
			return this.replaceThrough(entryLast, [entry], false);
		}
		if (this.firstCursor === undefined) {
			this.firstCursor = first;
		}
		this.lastCursor = entryLast;
		this.resumeCursor = entryLast;
		this.publish({ type: 'append', entry });
		return undefined;
	}

	/** Read a repair page ending at `required`, merge the entries that queued
	 * during the read, retry once when the merged window still does not reach
	 * the target cursor, then publish `replace`. */
	private replaceThrough(required: number, queued: readonly JournalEntry[], repaired: boolean): Outcome {
		const page = this.source.readPage(required);
		if (page.length === 0) {
			return this.violation(
				repaired ? 'page did not reach its opening cursor' : 'ended while reading its replacement page',
			);
		}
		const through = this.assertPageThrough(page, required);
		if (through !== undefined) {
			return through;
		}
		const merged = this.mergeReplacement(page, queued);
		if (typeof merged === 'string') {
			return merged;
		}
		const target = this.maxCursor(required, queued);
		if (merged === null) {
			return this.replaceThrough(target, queued, true);
		}
		const tail = merged.length > 0 ? (merged[merged.length - 1] as JournalEntry).last : 0;
		if (tail < target) {
			return this.replaceThrough(target, queued, true);
		}
		const hasMore = (merged[0]?.first ?? 0) > 0;
		const finalTail = (merged[merged.length - 1] as JournalEntry).last;
		this.firstCursor = merged[0]?.first;
		this.lastCursor = finalTail;
		this.resumeCursor = finalTail;
		this.publish({ type: 'replace', entries: merged, hasMore });
		return undefined;
	}

	/** Validate the repair page, then absorb queued entries by ascending
	 * `first`. A queue entry that does not adjoin the merged tail leaves a
	 * hole (returns `null` → retry the read with a higher target). */
	private mergeReplacement(page: JournalPage, queued: readonly JournalEntry[]): (JournalEntry[] | null) | string {
		const entries: JournalEntry[] = [...page];
		const adjacent = this.assertPage(entries);
		if (adjacent !== undefined) {
			return adjacent;
		}
		const sorted = [...queued].sort((left, right) => left.first - right.first);
		const tail = entries.length > 0 ? (entries[entries.length - 1] as JournalEntry).last : undefined;
		if (tail === undefined) {
			return entries;
		}
		for (const entry of sorted) {
			const range = this.entryRange(entry);
			if (typeof range === 'string') {
				return range;
			}
			const [first, last] = range;
			if (last <= tail) {
				continue;
			}
			if (first <= tail) {
				return this.violation('replacement contains a partially overlapping entry');
			}
			if (tail + 1 !== first) {
				return null;
			}
			entries.push(entry);
		}
		return entries;
	}

	/** A backwards history page: entries at-or-after the window head drop; the
	 * remaining run must adjoin the head, otherwise the (spec-published) empty
	 * `prepend` is emitted before the violation. */
	private onPrepend(page: JournalPage, hasMore: boolean): Outcome {
		if (!this.openedState) {
			return this.violation('is not open');
		}
		const adjacent = this.assertPage(page);
		if (adjacent !== undefined) {
			return adjacent;
		}
		const before = this.firstCursor;
		const accepted = before === undefined ? [...page] : page.filter((entry) => entry.first < before);
		if (before !== undefined && accepted.length > 0) {
			const tailEntry = accepted[accepted.length - 1] as JournalEntry;
			const range = this.entryRange(tailEntry);
			if (typeof range === 'string') {
				return range;
			}
			if (range[1] + 1 !== before) {
				this.publish({ type: 'prepend', entries: [], hasMore: false });
				return this.violation('history page is discontinuous');
			}
		}
		if (accepted.length > 0) {
			this.firstCursor = (accepted[0] as JournalEntry).first;
		}
		// §二.8 invariant: `last` is undefined IFF the window is empty. A
		// prepend that FILLS an empty window makes the page the whole window —
		// its tail is the window tail and the resume cursor follows it.
		// Without this the next live entry takes the fresh-journal branch
		// (first !== 0 ⇒ gap-repair read) against a window that already has
		// history.
		if (this.lastCursor === undefined && accepted.length > 0) {
			const tail = (accepted[accepted.length - 1] as JournalEntry).last;
			this.lastCursor = tail;
			this.resumeCursor = tail;
		}
		this.publish({ type: 'prepend', entries: accepted, hasMore });
		return undefined;
	}

	/** Entries are internally adjacent (`last + 1 === next first`). */
	private assertPage(entries: JournalPage): Outcome {
		let previous: number | undefined;
		for (const entry of entries) {
			const range = this.entryRange(entry);
			if (typeof range === 'string') {
				return range;
			}
			if (previous !== undefined && previous + 1 !== range[0]) {
				return this.violation('page contains discontinuous entries');
			}
			previous = range[1];
		}
		return undefined;
	}

	/** Reject an inverted cursor range; return `[first, last]`. */
	private entryRange(entry: JournalEntry): [number, number] | string {
		if (entry.first > entry.last) {
			return this.violation('entry has an inverted cursor range');
		}
		return [entry.first, entry.last];
	}

	/** A non-empty page tail must equal its requested cursor. */
	private assertPageThrough(page: JournalPage, through: number): Outcome {
		const tail = page.length > 0 ? (page[page.length - 1] as JournalEntry).last : undefined;
		if (tail !== through) {
			return this.violation('page did not end at its requested cursor');
		}
		return undefined;
	}

	private maxCursor(cursor: number, entries: readonly JournalEntry[]): number {
		let result = cursor;
		for (const entry of entries) {
			if (entry.last > result) {
				result = entry.last;
			}
		}
		return result;
	}
}
