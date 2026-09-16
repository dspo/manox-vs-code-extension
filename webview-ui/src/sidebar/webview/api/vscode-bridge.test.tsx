// @vitest-environment jsdom
// VS Code bridge + watchdog wiring (transport-liveness self-heal): the
// heartbeat posts `{t:'ping', seq}` on mount and on schedule, host traffic
// resets it, and a stale verdict — only while the iframe is visible —
// reloads the window after posting the warn breadcrumb. `window.location
// .reload` is replaced with a spy; timers are fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Posted = Record<string, unknown>;

function dispatchHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function reloadSpy(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    value: { reload, href: 'http://localhost/' },
    writable: true,
    configurable: true,
  });
  return reload;
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    writable: true,
    configurable: true,
  });
}

describe('vscode bridge channel watchdog', () => {
  let posted: Posted[];
  let createVscodeBridge: (typeof import('./vscode-bridge'))['createVscodeBridge'];
  let WATCHDOG_PING_INTERVAL_MS: number;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    posted = [];
    vi.stubGlobal(
      'acquireVsCodeApi',
      vi.fn(() => ({ postMessage: (msg: Posted) => posted.push(msg) })),
    );
    reload = reloadSpy();
    setVisibility('visible');
    ({ createVscodeBridge, WATCHDOG_PING_INTERVAL_MS } = await import('./vscode-bridge'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('pings immediately on mount', () => {
    createVscodeBridge();
    const first = posted[0];
    expect(first.t).toBe('ping');
    expect(typeof first.seq).toBe('number');
  });

  it('pings on schedule while silent', () => {
    createVscodeBridge();
    posted.length = 0;
    vi.advanceTimersByTime(WATCHDOG_PING_INTERVAL_MS);
    expect(posted.map((p) => p.t)).toEqual(['ping']);
  });

  it('stale after missLimit unanswered pings: warn posted, window reloaded once', () => {
    createVscodeBridge();
    reload.mockClear();
    // missLimit = 3 default: stale flips on the 3rd tick (pings at mount,
    // then ticks at 1×, 2×, 3× — the third declares stale and reloads).
    vi.advanceTimersByTime(WATCHDOG_PING_INTERVAL_MS * 4);
    expect(reload).toHaveBeenCalledTimes(1);
    const warn = posted.filter((p) => p.t === 'log').at(-1);
    expect(warn).toMatchObject({ level: 'warn', message: 'channel stale — reloading webview' });
  });

  it('pong is consumed by the watchdog, never surfaced to listeners', () => {
    const bridge = createVscodeBridge();
    const listener = vi.fn();
    bridge.onMessage(listener);
    const ping = [...posted].reverse().find((p) => p.t === 'ping')!;
    dispatchHost({ t: 'pong', seq: ping.seq });
    dispatchHost({ t: 'frame', frame: { kind: 'notification', note: { method: 'error' } } });
    // Only the frame reached the listener (the fatal/notification path is
    // irrelevant here — we just count that pong produced no listener call).
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ kind: 'notification' });
  });

  it('healthy pong stream keeps the channel alive indefinitely', () => {
    createVscodeBridge();
    reload.mockClear();
    const seqOfLastPing = () =>
      [...posted].reverse().find((p) => p.t === 'ping')!.seq as number;
    for (let round = 0; round < 8; round++) {
      vi.advanceTimersByTime(WATCHDOG_PING_INTERVAL_MS);
      dispatchHost({ t: 'pong', seq: seqOfLastPing() });
    }
    expect(reload).not.toHaveBeenCalled();
  });

  it('any other host message counts as liveness evidence', () => {
    createVscodeBridge();
    reload.mockClear();
    for (let round = 0; round < 8; round++) {
      vi.advanceTimersByTime(WATCHDOG_PING_INTERVAL_MS);
      dispatchHost({ t: 'config', approvalMode: 'workspace-write' });
    }
    expect(reload).not.toHaveBeenCalled();
  });

  it('stale verdict is withheld while hidden and reloads on show', () => {
    setVisibility('hidden');
    createVscodeBridge();
    reload.mockClear();
    vi.advanceTimersByTime(WATCHDOG_PING_INTERVAL_MS * 5);
    expect(reload).not.toHaveBeenCalled(); // hidden: never reload
    expect(posted.filter((p) => p.t === 'log')).toHaveLength(0); // nor warn
    setVisibility('visible');
    posted.length = 0;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reload).toHaveBeenCalledTimes(1); // shows → immediate self-heal
    expect(posted.map((p) => p.t)).toEqual([]); // stale is terminal: no wake re-ping
  });
});
