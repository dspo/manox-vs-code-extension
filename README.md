# manox VS Code extension

manox agent workbench inside VS Code: a sidebar chat webview plus the `@manox`
chat participant, backed by the manox agent runtime embedded **in-process**
through the [`manox-napi`](https://github.com/dspo/manox) native binding
(v0.3.0) and speaking **AHP 1.0.0** — the Agent Host Protocol (JSON-RPC 2.0,
channel model, `x-manox` extension surface v5).

This is the standalone home of the VS Code frontend. It originally lived at
`apps/vscode` in the manox monorepo and was removed there when the v2
event-journal architecture landed (archived at tag `archive/frontends-final`).
The sidebar UI is the original React webview, restored from the manox
repository history (orphan lineage `apps/web/webui` @ `9c165b25`, the last
state before the frontend split into `dspo/manox-app`) and adapted to the
extension's protocol layer — vendored under `webview-ui/`. The 0.8.0 release
migrated it from protocol v2 to AHP (manox v0.3.0).

## Architecture

```
┌─ VS Code extension host ────────────────────────────────────────────┐
│ extension.ts            activation (lazy), commands, config push    │
│ agentHost.ts            shared host: transport + the ONE AHP client │
│ client/agentClient.ts   ManoxClient: initialize, folds, operations  │
│ participant.ts          @manox chat participant (own sessions)      │
│ sidebar/sidebarProvider webview relay: snapshots + events out,      │
│                         req/dispatch/view in (workspace-scoped)     │
│ transport/napiTransport loads manox_napi.node, pins MANOX_HOME      │
│ transport/ahpTransport  the binding as an SDK AhpTransport          │
└───────────────┬─────────────────────────────────────────────────────┘
                │ AHP JSON-RPC text frames  (in-process, unbounded)
        ┌───────▼────────┐
        │ manox-napi     │  the manox v0.3.0 runtime on its own tokio
        │ (dspo/manox)   │  runtime; raw AHP transport bridge (lean
        │                │  build: no MCP/LSP/terminal/WS-gateway)
        └────────────────┘

┌─ Webview (webview-ui/, React 19 + Tailwind; → dist/webview/bundle.*)┐
│ state/store.ts          the relay fold: snapshots + action          │
│                         envelopes through the SAME SDK reducers     │
│ state/chatFold.ts       AHP ChatState → TranscriptItem[] projection │
│ api/client.ts           relay req/dispatch (protocol faces)         │
│ api/vscode-bridge.ts    postMessage transport + channel watchdog    │
│ components/…            threads view · transcript · cards · pickers │
└─────────────────────────────────────────────────────────────────────┘
```

Key invariants:

- **One AHP connection, one client.** AHP initializes once per connection,
  so the extension host owns the only `AhpClient` (`ManoxClient`); the
  webview speaks the protocol THROUGH it: it builds the dispatch actions and
  command params, the relay is its transport (`req`/`dispatch`/`view` out;
  `snapshot`/`event`/`res` in).
- **Both sides fold the same envelopes with the same code.** The host folds
  through the SDK's `AhpStateMirror` + `chatReducer`; the webview folds the
  relayed envelopes through the same SDK reducers plus the `x-manox` TS twin
  (`src/protocol/xmanox.ts`, imported from `webview-ui`). No second domain
  mirror: the transcript is a projection of the folded `ChatState`
  (`state/chatFold.ts`), never an independent fold.
- **Workspace scoping is the ONE relay mutation.** `~/.manox` is shared with
  the desktop app, so session-catalogue events for other repositories are
  dropped on the host side (`workspaceFilter.ts`: git common-dir identity,
  worktree-aware). Everything else relays verbatim.
- **Write-ahead writes, echo reconciliation.** Every client write is a
  `dispatchAction`; the folded echo (carrying `origin` + a `rejectionReason`
  when refused) is the confirmation face. Optimistic user bubbles are keyed
  by the client-minted turn id and retire when the folded turn lands.
- **The webview self-heals a stale host→webview channel.**
  `retainContextWhenHidden` lets a graceful extension-host restart (e.g. an
  install) leave the retained iframe deaf: the new relay posts messages the
  window never delivers, freezing the store on pre-restart state. A
  heartbeat watchdog (`webview-ui/…/state/watchdog.ts`) pings
  `{t:'ping', seq}` every 5 s and treats ANY host message — pong echoes
  included — as liveness; after ~3 unanswered pings of silence it declares
  the channel stale and reloads the iframe (visible only; a hidden view
  defers the verdict to `visibilitychange`). The heartbeat is sidebar
  out-of-band envelope vocabulary, never protocol.
- **Shared state root**: the extension defaults `MANOX_HOME` to the desktop
  app's `~/.manox`, so threads, models and provider config are one surface.
  The agent still starts lazily (first use), never at activation.

## The native binding

Released vsix packages are **self-contained**: the `manox_napi.node` addon
is bundled under `native/` and loaded from there — no manox checkout
required at runtime. The addon is platform-specific (the bundled build is
macOS arm64); shipping other platforms means packaging per-target vsix
builds the same way other native extensions do.

For development, rebuild the addon from the manox repository (v0.3.0) and
restage:

```sh
git clone https://github.com/dspo/manox   # or your local checkout
cd manox && git checkout v0.3.0
script/build-napi            # lean addon (no MCP/LSP/terminal/WS-gateway), release
# script/build-napi --full  for the complete runtime
# script/build-napi --debug for a debug build
cp target/napi/manox_napi.node <this-repo>/native/   # repackage to bundle it
```

Resolution order (first hit wins) — the setting/env exist as dev overrides
so a fresh rebuild can be tested without repackaging:

1. the `manox.sdkRoot` setting,
2. the `VSCODE_AGENT_HOST_MANOX_SDK_ROOT` environment variable,
3. `<extension>/native/manox_napi.node` (the bundled addon).

Providers/models resolve from `<MANOX_HOME>/cx.providers.config.yaml`; the
first start of a fresh state root copies nothing — drop a provider config
there (or symlink the desktop app's) to get models.

## Develop

```sh
npm install && npm install --prefix webview-ui
npm run compile    # tsc (host + webview-ui) + esbuild host + React/Tailwind bundle
npm test           # vitest: host suites + webview-ui suites (fold, relay, cards)
code .             # then F5 ("Run manox extension")
```

`compile` + `test` for both projects run in CI on every PR and on `main`
pushes (`.github/workflows/ci.yml`, alongside the no-coauthor gate). The
live-runtime smoke test stays env-gated (`MANOX_SMOKE=1` + a staged
`manox_napi.node`) and does not run in CI:

```sh
MANOX_SMOKE=1 VSCODE_AGENT_HOST_MANOX_SDK_ROOT=<staged-dir> npx vitest run src/smoke.test.ts
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
| `manox.stateRoot` | `~/.manox` | `MANOX_HOME` for the embedded runtime — shared with the desktop app by default so threads/models/provider config are one surface; set a separate directory to isolate. An externally preset `MANOX_HOME` env var wins over this setting — the `/tutor` command provisions into the env root to match. |
| `manox.approvalMode` | `workspace-write` | Tool-authorization policy seeded into new sessions (`read-only` / `workspace-write` / `danger-full-access`), sent as the session `config` on `createSession`. |

Commands: `manox: Focus Chat`, `manox: New Session`, `manox: Open Code
Tutor` (tour steps are `alt+left`/`alt+right` scoped to
`activeWebviewPanelId == manox.codeChain`, so they never steal the
workbench back/forward nav).
The sidebar header also
carries model / reasoning-effort / approval-mode selectors; thread rows
pin/archive; approval, plan-review and question cards render inline.

## Protocol maintenance discipline

The wire vocabulary is the **published AHP SDK**
(`@microsoft/agent-host-protocol`, the TypeScript source of truth the six
language bindings generate from) plus the **`x-manox` extension surface v5**:

- Standard protocol types (`ChatState`, `SessionSummary`, action envelopes,
  the reducers) come from the npm SDK — never hand-copied.
- The `x-manox` vocabulary (channels, actions, commands, host→client
  requests) is hand-maintained in `src/protocol/xmanox.ts` in lock-step with
  `manox_ahp::ext::declaration()` (`crates/manox-ahp/src/ext/mod.rs`,
  `VERSION = 5`). The bag fold there is the TS twin of
  `ext::reducer::apply`; `xmanox.test.ts` mirrors the Rust reducer's own
  test cases field for field — that is the cross-engine equivalence gate.
- `initialize` declares the host→client requests this extension answers in
  `_meta["x-manox"].serverRequests` (clipboardRead / openExternal /
  invokeTool; browserOp stays undeclared — no embedded browser). The host
  routes capability calls fail-closed by that declaration.
- Unknown vocabulary drops + logs on both sides (L12); unrecognized actions
  are no-ops in the reducers, unrecognized relay messages drop at the
  bridge — never fatal.

## Scope and known limitations (0.8.0)

- **The staged addon is the lean napi build** (manox PR #790 lineage): no
  MCP client, no LSP integration, no terminal stack, no WS gateway —
  terminal faces answer the protocol's unavailable arm, and the agent falls
  back to its documented no-MCP/no-LSP paths. Build with
  `script/build-napi --full` and restage to get those back.
- **New-session chat materialization**: a brand-new session's `defaultChat`
  is a pointer the host answers `subscribe` with NotFound until the chat
  exists, and only an accepted chat action creates it (and the creation is
  async host-side). `ManoxClient` materializes with a zero-draft dispatch
  and retries NotFound briefly — probe-verified against v0.3.0; revisit if
  upstream makes the seed materialize eagerly.
- **Background-task stop has no client dispatch** on the x-manox v5 surface
  (the stop signal reaches clients through `backgroundTasksChanged`
  status). The card's stop affordance logs fail-closed.
- **The browser webview surface was retired** with the v2 WS gateway (the
  v2-era browser host is gone upstream). `web-bridge.ts` was removed; a
  future browser client would plug in over the SDK's `WebSocketTransport`.
- Not wired yet (the AHP surface supports; UI does not): fork/side-chat
  (`createChat` with a source), changeset review cards, terminal channels,
  automations. The protocol types are in the SDK when the UI catches up.
- Code Tutor (`src/codechain/`): the LLM generates an LSP-verified
  code-reading tour rendered in an editor-area webview panel. The seven
  Tutor tools are contributed through the AHP-native
  `session/activeClientSet` action and invoked through the
  `x-manox/invokeTool` host→client request (the `{content, isError}` reply
  contract is unchanged from v2). `/tutor` is a harness slash command
  provisioned into `<MANOX_HOME>/commands/tutor.md` at activation. The
  contribution is a write-ahead dispatch: on a session whose runtime has no
  intent yet (no provider configured) the host rejects it and the registrar
  retries on the next lifecycle edge.
- Host capabilities: the extension declares `clipboardRead`
  (text-only, via `vscode.env.clipboard`), `openExternal` (via
  `vscode.env.openExternal`; the agent's Open tool is approval-gated
  upstream) and `invokeTool` in the handshake; the host routes capability
  calls fail-closed by that declaration, so they never surface as webview
  cards.
