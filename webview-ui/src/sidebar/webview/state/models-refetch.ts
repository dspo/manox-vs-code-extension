// Models-refetch planner — pure state machine, no DOM, no timers, no store
// (webview discipline: this file is testable in isolation and touches
// nothing else; the setInterval + store-bridge wiring lives in `app.tsx` and
// is exercised by the render smoke test).
//
// Why it exists: the manox server registers model providers on a background
// thread (per-provider keychain resolution, measured up to ~30 s). It marks
// itself ready BEFORE that finishes and broadcasts an empty `models: []`
// immediately, then a second `models: [ …37 ]` only once registration
// settles. The sidebar webview mounts during that window, so the one-shot
// `api.requestModels()` on mount folds the empty list into the store and
// caches "No models configured"; if the populated broadcast is missed
// (published before the listener attached, or on a channel the
// retainContextWhenHidden iframe never delivers) the model picker is stuck
// empty forever. The PR #3 watchdog only closes the *post-mount* liveness
// hole — a `boot`/`config` re-push refetches the registries, but a boot that
// lands before mount or before registration finishes still leaves the
// picker empty. This is the *settle* hole the watchdog cannot see.
//
// Fix: after mount, re-request the model registry on a fixed interval
// (`intervalMs`) until the store reports a non-empty list — i.e. until
// `isSettled(modelCount)` flips. That predicate is the seam: the default is
// "any model has arrived" (the picker only needs one entry to be usable),
// but it stays injectable so a future heuristic (a provider-count floor, an
// age cutoff) can swap in without touching the scheduler. Once settled the
// verdict is sticky: `tick()` returns null forever and the caller stops
// both the requests and the interval — no polling for the life of the view.

export const DEFAULT_MODELS_REFETCH_INTERVAL_MS = 10_000;

export interface ModelsRefetchPlannerOptions {
	/** Milliseconds between model-registry refetches while unsettled. */
	intervalMs?: number;
	/** Settled once the current model count satisfies this. Defaults to
	 * "non-empty" — the picker's real readiness condition. */
	isSettled?: (modelCount: number) => boolean;
	/** Injectable clock (tests drive the interval deterministically). */
	now: () => number;
}

export interface ModelsRefetchPlanner {
	/** Arm the planner at mount; a refetch is due immediately so the empty
	 * registry a ready-but-still-registering server broadcast is re-probed
	 * without waiting one interval. Returns null when already settled. */
	onMount(): 'refetch' | null;
	/** Drive one scheduler tick (call from a setInterval): returns 'refetch'
	 * when a re-request comes due, otherwise null. Once settled, always
	 * null — the caller tears down the interval on the first null verdict. */
	tick(): 'refetch' | null;
	/** Feed the current model-registry size (read from the store on every
	 * publish). Flips `isSettled()` once the settlement predicate holds. */
	onModels(count: number): void;
	/** Sticky once the registry is settled (refetching stops for good). */
	isSettled(): boolean;
}

export function createModelsRefetchPlanner(
	opts: ModelsRefetchPlannerOptions,
): ModelsRefetchPlanner {
	const interval = opts.intervalMs ?? DEFAULT_MODELS_REFETCH_INTERVAL_MS;
	const settled = opts.isSettled ?? ((count) => count > 0);

	let isSettled = false; // sticky once the registry is populated
	let lastFetchAt = opts.now();

	const fetchDue = (at: number): boolean => at - lastFetchAt >= interval;

	const markFetched = (): void => {
		lastFetchAt = opts.now();
	};

	return {
		onMount() {
			if (isSettled) return null;
			markFetched();
			return 'refetch';
		},
		tick() {
			if (isSettled) return null; // terminal: the interval is gone
			if (!fetchDue(opts.now())) return null; // scheduler fired early
			markFetched();
			return 'refetch';
		},
		onModels(count) {
			// Settlement only ever flips one way: once the registry has
			// content, a later transient empty broadcast must not re-arm the
			// polling (the picker is already usable).
			if (!isSettled && settled(count)) isSettled = true;
		},
		isSettled() {
			return isSettled;
		},
	};
}
