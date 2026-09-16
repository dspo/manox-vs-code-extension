// Channel watchdog — pure state machine, no DOM, no timers, no store
// (webview discipline: this file is testable in isolation and touches
// nothing else).
//
// Why it exists: the sidebar view is registered with
// `retainContextWhenHidden: true`. When the extension host restarts
// gracefully (e.g. an extension install) while the renderer window keeps
// living, the retained webview iframe's host→webview postMessage channel
// can go stale: frames keep arriving at the host relay and are posted,
// but the iframe never receives them, so the store freezes on pre-restart
// state (e.g. an empty model list forever). A full-window reload fixes
// it; a webview-only reload does too, because the self-heal is "rebuild
// the iframe, rebuild the channel".
//
// Protocol (out-of-band, never relayed as agent frames): the webview
// posts `{t:'ping', seq}` every `pingIntervalMs`; the host echoes
// `{t:'pong', seq}`. ANY message arriving from the host over the channel
// counts as liveness evidence — pongs are only needed while the channel
// is otherwise silent, so an active stream never looks stale. If
// `missLimit` consecutive pings go unanswered with no other host traffic
// in between, the channel is `stale` and the caller reloads (only while
// visible — a hidden retainContextWhenHidden iframe defers the verdict to
// the next show; reloading a hidden view would loop while the tab is away).

export const DEFAULT_PING_INTERVAL_MS = 5_000;
export const DEFAULT_MISS_LIMIT = 3;

export interface ChannelWatchdogOptions {
	/** Milliseconds between heartbeat pings. */
	pingIntervalMs?: number;
	/** Consecutive unanswered pings tolerated before `isStale()` flips. */
	missLimit?: number;
	/** Injectable clock (tests drive time deterministically). */
	now: () => number;
}

export interface ChannelWatchdog {
	/** Arm the watchdog at mount; a ping is due immediately so a
	 * dead-on-arrival channel is caught without waiting one interval. */
	onMount(): 'ping' | null;
	/** Drive one scheduler tick (call from a setInterval): returns 'ping'
	 * when a ping comes due, otherwise null. Post
	 * `{t:'ping', seq: lastPingSeq()}`. */
	tick(): 'ping' | null;
	/** The host echoed `seq` for the outstanding ping. */
	onPong(seq: number): void;
	/** Liveness evidence: any host→webview message whatsoever. */
	onAnyHostMessage(): void;
	/** Sticky once the channel is declared dead (the caller reloads). */
	isStale(): boolean;
	/** The seq stamped on the most recent ping (from `onMount`/`tick`). */
	lastPingSeq(): number;
}

export function createChannelWatchdog(opts: ChannelWatchdogOptions): ChannelWatchdog {
	const interval = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
	const missLimit = opts.missLimit ?? DEFAULT_MISS_LIMIT;

	// The internal seq is seeded from the wall clock (ms): a pong echoing a
	// pre-reload page's ping can never match a freshly mounted watchdog's
	// first seq, which keeps the exact-match `onPong` guard honest across
	// iframe rebuilds (`now()` only needs millisecond monotonicity within a
	// page lifetime).
	let seq = Math.floor(opts.now());
	let outstanding = false; // the last ping awaits its pong
	let misses = 0; // consecutive unanswered pings
	let lastPingAt = opts.now();
	let stale = false;

	const sendPing = (): 'ping' => {
		seq += 1;
		outstanding = true;
		lastPingAt = opts.now();
		return 'ping';
	};

	const clear = (): void => {
		outstanding = false;
		misses = 0;
	};

	return {
		onMount() {
			return sendPing();
		},
		tick() {
			if (stale) return null; // terminal: reload is in progress
			if (outstanding) misses += 1; // previous ping never answered
			if (misses >= missLimit) {
				stale = true;
				return null;
			}
			if (opts.now() - lastPingAt < interval) return null;
			return sendPing();
		},
		onPong(pongSeq) {
			if (!outstanding || pongSeq !== seq) return; // echo for an older ping
			clear();
		},
		onAnyHostMessage() {
			clear();
		},
		isStale() {
			return stale;
		},
		lastPingSeq() {
			return seq;
		},
	};
}
