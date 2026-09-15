// Out-of-band host protocol. The webview speaks typed `FromClient` /
// `FromServer` (re-exported from `../protocol`) with the host; session
// lifecycle rides the wire (the VS Code relay is transparent), so the old
// host-only lifecycle verbs are retired. What remains are the two host UI
// notes that originate from the extension (command palette / title bar /
// keybindings) and never cross the agent wire.

import type { FromClient, FromServer } from '../protocol';

/** Outbound webview → host: a typed `FromClient`. */
export type ToHost = FromClient;

/** Host → webview out-of-band UI note (not from the agent):
 * `open_turn_navigator` is the macOS cmd+m path (the OS minimize
 * accelerator swallows the key before the DOM); `new_session` is the
 * host command / title-bar button. */
export type HostNote = { kind: 'open_turn_navigator' } | { kind: 'new_session' };

/** Inbound host → webview: a typed `FromServer`, or a host UI note. */
export type ToWebview = FromServer | HostNote;
