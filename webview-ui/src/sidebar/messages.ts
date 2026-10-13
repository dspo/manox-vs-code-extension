// Out-of-band host protocol. The webview speaks typed `FromClient` /
// `FromServer` (re-exported from `../protocol`) with the host; session
// lifecycle rides the wire (the VS Code relay is transparent), so the old
// host-only lifecycle verbs are retired. What remains are the two host UI
// notes that originate from the extension (command palette / title bar /
// keybindings) and never cross the agent wire, plus the code-chain
// journal-card push (§7).

import type { FromClient, FromServer } from '../protocol';

/** Outbound webview → host: a typed `FromClient`, the code-chain card
 * click asking the host to reopen a stored chain (no wire equivalent —
 * chains live in the host's workspaceState, §7), or the watchdog's
 * channel heartbeat `ping` (answered with a `pong` on the host side;
 * pure out-of-band, never a wire frame). */
export type ToHost =
	| FromClient
	| { t: 'openCodeChain'; chainId: string }
	| { t: 'ping'; seq: number };

/** Host → webview out-of-band UI note (not from the agent):
 * `open_turn_navigator` is the macOS cmd+m path (the OS minimize
 * accelerator swallows the key before the DOM); `new_session` is the host
 * command / title-bar button; `code_chain` announces a freshly generated
 * chain for its journal card. */
export type HostNote =
	| { kind: 'open_turn_navigator' }
	| { kind: 'new_session' }
	| { kind: 'code_chain'; sessionId: string; chainId: string; title: string; nodeCount: number };

/** Inbound host → webview: a typed `FromServer`, or a host UI note. */
export type ToWebview = FromServer | HostNote;
