# manox VS Code extension

manox agent workbench inside VS Code: a sidebar chat webview plus the `@manox`
chat participant, backed by the manox agent runtime embedded **in-process**
through the [`manox-napi`](https://github.com/dspo/manox) native binding and
speaking **protocol v2** (journal streams + projections + host events).

This is the standalone home of the VS Code frontend. It originally lived at
`apps/vscode` in the manox monorepo and was removed there when the v2
event-journal architecture landed (archived at tag `archive/frontends-final`);
this repo revives it leaner — v2-native, self-contained, zero runtime npm
dependencies.

## Architecture

```
┌─ VS Code extension host ────────────────────────────────────────────┐
│ extension.ts            activation (lazy), commands, config push    │
│ agentHost.ts            shared host: transport + AgentConnection    │
│ participant.ts          @manox chat participant (own sessions)      │
│ sidebar/sidebarProvider webview relay: frames verbatim, viewing reg │
│ transport/napiTransport loads manox_napi.node, pins MANOX_HOME      │
└───────────────┬─────────────────────────────────────────────────────┘
                │ FromClient/FromServer JSON  (in-process, unbounded)
        ┌───────▼────────┐
        │ manox-napi     │  AgentServer on its own tokio runtime
        │ (dspo/manox)   │  capabilities: approve · askUserQuestion · planVerdict
        └────────────────┘

┌─ Webview (dist/webview/bundle.js, browser IIFE) ────────────────────┐
│ webview/store.ts        ChatApp: its OWN AgentConnection over the   │
│                         host relay (id namespace `web-`)            │
│ webview/render.ts       thread list · transcript · approval cards   │
│ client/journalStream.ts §F.1 engine (ported twin, shared vectors)   │
│ client/sessionStore.ts  window + projections + running mirror       │
│ client/transcript.ts    journal records → bubbles / tool cards      │
└─────────────────────────────────────────────────────────────────────┘
```

Key invariants (from the manox architecture doc, `docs/dsh-v2-architecture.md`):

- **One physical connection, two consumers.** The host connection
  (participant, `deny`-on-unrouted-ServerCall policy) and the webview
  connection (`observe` policy) share the napi wire with disjoint id
  namespaces (`host-*` / `web-*`); each ignores the other's correlation ids.
- **The webview speaks the protocol directly.** The sidebar relay forwards
  every guard-parsed `FromServer` frame verbatim and relays `FromClient`
  frames back — the webview answers `request` (adjudication) frames itself.
  The host registers a no-op ServerCall handler for the session the webview
  is *viewing* so its own fail-closed default cannot race the card.
- **Client state is journal-folded** (L6): transcript items come from journal
  records via `TranscriptFold`, UI values from projections
  (higher-`asOfSeq`-wins), never from a second domain mirror.
- **Resync is the only recovery** (L5): entry-queue overflow or engine
  violation ends the stream and the client re-follows from a fresh snapshot.
- **State-root isolation**: manox holds an exclusive flock on
  `<MANOX_HOME>/runtime.lock` and *exits the process on contention*, so the
  extension pins `MANOX_HOME` to a dedicated root (default `~/.manox-vscode`)
  before loading the addon and starts the agent lazily (first use), never at
  activation.

## Prerequisites: the native binding

The `.node` addon is **not bundled**. Build it from the manox repository:

```sh
git clone https://github.com/dspo/manox   # or your local checkout
cd manox
script/build-napi            # lean addon (no MCP/LSP/terminal/WS-gateway), release
# script/build-napi --full  for the complete runtime
# script/build-napi --debug for a debug build
```

Then point this extension at the staged directory — resolution order:

1. the `manox.sdkRoot` setting,
2. the `VSCODE_AGENT_HOST_MANOX_SDK_ROOT` environment variable,
3. `<extension>/native/manox_napi.node` (copy it there to make the install
   self-contained).

Providers/models resolve from `<MANOX_HOME>/cx.providers.config.yaml`; the
first start of a fresh state root copies nothing — drop a provider config
there (or symlink the desktop app's) to get models.

## Develop

```sh
npm install
npm run compile    # tsc --noEmit + esbuild (out/extension.js, dist/webview/bundle.*)
npm test           # vitest: protocol guards, journal engine vectors, fold, connection
code .             # then F5 ("Run manox extension")
```

Package:

```sh
npm run package    # vsce package --no-dependencies → manox-vscode-<version>.vsix
code --install-extension manox-vscode-*.vsix --force
```

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `manox.sdkRoot` | *(unset)* | Directory containing `manox_napi.node`. |
| `manox.stateRoot` | `~/.manox-vscode` | `MANOX_HOME` for the embedded runtime. Must not be the desktop app's `~/.manox` (exclusive runtime lock; contention terminates the extension host). |
| `manox.approvalMode` | `workspace-write` | Tool-authorization policy seeded into new sessions (`read-only` / `workspace-write` / `danger-full-access`). |

Commands: `manox: Focus Chat`, `manox: New Session`. The sidebar header also
carries model / reasoning-effort / approval-mode selectors; thread rows
pin/archive; approval, plan-verdict and question cards render inline.

## Protocol maintenance discipline

The typed wire vocabulary (`src/protocol/types.ts`) is hand-maintained in
lock-step with the Rust `manox-protocol` crate (protocol epoch 6):

- `src/client/journalStream.ts` is the TS twin of
  `crates/manox-protocol/src/journal_stream.rs`; both run the same shared
  conformance vectors (`src/client/journal-cases.json`, ported from the manox
  repo). When manox bumps the vectors, copy them over and keep this engine
  green — that is the cross-engine equivalence gate.
- `src/protocol/guards.test.ts` pins the exact JSON key shapes the Rust serde
  tests assert (envelope `kind` tags, camelCase payload fields, externally
  tagged `Ok`/`Err` outcomes, flattened snapshot records). A drift here means
  this host can no longer talk to the current epoch.
- Unknown vocabulary drops + logs on both sides (L12); the closed Rust enum
  rejects unknown `kind`/`method` tags in `sendCommand` — never fatal in TS.

## Scope and known limitations (v1)

- **One window at a time**: two VS Code windows driving manox would contend
  for the same `MANOX_HOME` lock — the second window's extension host is
  terminated by the runtime when it first starts the agent (upstream fix:
  make manox-napi's `start()` return `Err` on lock contention instead of
  exiting). Keep one manox-enabled window per state root.
- **Non-viewed sessions auto-deny adjudications** (fail-closed §D.4): an
  approval for a session the sidebar is not currently following is denied on
  arrival. Follow the session to answer interactively.
- The staged addon is the **lean** napi build (manox PR #790): no MCP client,
  no LSP integration, no terminal stack, no WS gateway — terminal call arms
  answer the `feature/unavailable` stable code, and the agent falls back to
  its documented no-MCP/no-LSP paths. Build with `script/build-napi --full`
  and restage to get those back; any napi consumer can also mix per
  subsystem (`--features mcp,lsp,…`).
- Not wired yet (protocol supports; UI does not): `ForkSession`, background
  tasks, sub-agent panels, backwards history paging (`PageHistory`),
  plan-mode composer affordances, `GetConversationInfo` usage card.
- `session/already-owned` (#794): another process holds the session's
  per-session write lease — e.g. the desktop app is driving the same thread.
  The holder's exit releases it; a retry then succeeds.
- `askUserQuestion` speaks the canonical B2-PR-1 vocabulary (#796): the card
  renders per-question `detail`/`intent`/`multiSelect`, and answers are
  id-routed tri-state rows (selection, free text, or skip) — no card-level
  response override.
- The old extension's `languageModelChatProviders` integration (exposing
  manox providers as VS Code language models via `modelChat`) was cut with
  the revival — it depended on proposed chat-provider APIs; revisit once
  stable.
