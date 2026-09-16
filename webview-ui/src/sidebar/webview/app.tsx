// Shell: switches between the thread list (home) and the active
// conversation. Thread states keep accumulating in the store regardless of
// which view is shown, so switching never interrupts or loses a running
// turn.

import { useEffect } from 'react';

import { api } from './api/client';
import { ConversationView } from './components/conversation-view';
import { ThreadsView } from './components/threads-view';
import { store, useChatState } from './state/bridge';
import {
  createModelsRefetchPlanner,
  DEFAULT_MODELS_REFETCH_INTERVAL_MS,
} from './state/models-refetch';
import { Slot } from './slots.outlet';

export const App = () => {
  const state = useChatState();
  const thread = state.activeThreadId ? (state.perThread[state.activeThreadId] ?? null) : null;

  // Global registries load once on mount; the host pushes updates
  // afterwards. Models are the exception to "once": the server can mark
  // itself ready and broadcast an empty `models: []` while it is still
  // registering providers on a background thread (keychain resolution, up to
  // ~30s), and the populated broadcast can slip past the one-shot request. A
  // small planner re-issues `requestModels()` every
  // `DEFAULT_MODELS_REFETCH_INTERVAL_MS` until the store's model list is
  // non-empty, then stops for good — see state/models-refetch.ts. (Threads
  // and slash entries do not need this: they are cheap full mirrors that the
  // host re-pushes on any `boot`/`config`, the PR #3 watchdog path.)
  useEffect(() => {
    const planner = createModelsRefetchPlanner({ now: () => Date.now() });
    // The mount fetch is the planner's `onMount()` (a probe is due
    // immediately), so a registry that never registers keeps re-probing on
    // the interval below until it lands.
    if (planner.onMount() === 'refetch') api.requestModels();
    api.listThreads();
    api.listCommands();

    let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      if (planner.tick() === 'refetch') api.requestModels();
    }, DEFAULT_MODELS_REFETCH_INTERVAL_MS);
    const stopTimer = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };

    // Feed the settle condition from the store, not from our own request
    // count: a populated registry that arrives via a host push settles the
    // planner too. Stop the interval the instant it settles (no window of
    // redundant polls before the next tick).
    const observe = (): void => {
      planner.onModels(store.get().models.length);
      if (planner.isSettled()) stopTimer();
    };
    const unsubscribe = store.subscribe(observe);
    observe();

    return () => {
      unsubscribe();
      stopTimer();
    };
  }, []);

  // Spend/context (§E.3) is no longer store-driven: the conversation-info
  // plugin (T8 §H) watches the `committed` edge and pulls `GetConversationInfo`
  // through its own seam. App keeps no request effects (the old turn-falling-
  // edge usage refresh was a §D.6 dead path and is gone).

  const body =
    state.view === 'conversation' && thread ? (
      <ConversationView
        commands={state.commands}
        error={thread.error ?? state.error}
        models={state.models}
        thread={thread}
        threads={state.threads}
      />
    ) : (
      <ThreadsView
        commands={state.commands}
        error={state.error}
        models={state.models}
        threads={state.threads}
      />
    );

  return (
    <>
      {body}
      {/* App-level modal overlays (§G): the settings sheet and any plugin
       * overlay render here through the `shell.overlay` outlet. */}
      <Slot name="shell.overlay" owner={{ sessionId: state.activeThreadId }} />
    </>
  );
};
