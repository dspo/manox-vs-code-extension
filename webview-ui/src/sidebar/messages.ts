// Out-of-band host protocol. Under AHP the webview's protocol traffic rides
// the host's single connection through the sidebar relay (`snapshot` /
// `event` / `res` down; `req` / `dispatch` / `view` up — see
// `../../webview/api/client.ts`). What remains here is the envelope typing
// and the host UI notes that never cross the agent wire (host commands, the
// code-chain journal-card push, the watchdog heartbeat).

import type { RelayToWebview } from '../protocol';

/** Outbound webview → host: the protocol faces (`req` / `dispatch` / `view`
 * / `refresh`), the code-chain card click asking the host to reopen a stored
 * chain (no wire equivalent — chains live in the host's workspaceState, §7),
 * the viewed-session claim (drives the client-tool contribution), or the
 * watchdog's channel heartbeat `ping` (answered with a `pong` on the host
 * side; pure out-of-band, never a wire frame). */
export type ToHost =
	| { t: 'req'; id: string; method: string; params?: unknown }
	| { t: 'dispatch'; channel: string; action: unknown }
	| { t: 'view'; sessionUri: string; chatUri?: string }
	| { t: 'refresh' }
	| { t: 'viewing'; sessionUri: string | null }
	| { t: 'openCodeChain'; chainId: string }
	| { t: 'ping'; seq: number }
	| { t: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Host → webview out-of-band UI note (not from the agent):
 * `open_turn_navigator` is the macOS cmd+m path (the OS minimize
 * accelerator swallows the key before the DOM); `new_session` is the host
 * command / title-bar button; `code_chain` announces a freshly generated
 * chain for its journal card. */
export type HostNote = Extract<
	RelayToWebview,
	{ t: 'verb' | 'config' | 'boot' | 'pong' | 'fatal' }
>;

/** Inbound host → webview: the full relay envelope. */
export type ToWebview = RelayToWebview;
