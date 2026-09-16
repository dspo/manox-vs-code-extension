# manox VS Code extension

manox agent workbench inside VS Code: a sidebar chat webview plus the `@manox`
chat participant, backed by the manox agent runtime embedded **in-process**
through the [`manox-napi`](https://github.com/dspo/manox) native binding and
speaking **protocol v2** (journal streams + projections + host events).

This is the standalone home of the VS Code frontend. It originally lived at
`apps/vscode` in the manox monorepo and was removed there when the v2
event-journal architecture landed (archived at tag `archive/frontends-final`).
The sidebar UI is the original React webview, restored from the manox
repository history (orphan lineage `apps/web/webui` @ `9c165b25`, the last
state before the frontend split into `dspo/manox-app`) and adapted to the
standalone extension's protocol layer — vendored under `webview-ui/`.

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
        │ (dspo/manox)   │  capabilities: approve · askUserQuestion · planVerdict · clientTool
        └────────────────┘

┌─ Webview (webview-ui/, React 19 + Tailwind; → dist/webview/bundle.*)┐
│ state/store.ts          per-thread fold over the journal stream     │
│ state/journal.ts        §F.1 engine twin (shared manox vectors)     │
│ api/client.ts           receipts, follow streams, adjudication      │
│                         replies (frame-MsgId keyed, #796 canonical) │
│ api/vscode-bridge.ts    {t:*} envelope ↔ FromClient/FromServer      │
│ components/…            threads view · transcript · cards · pickers │
└─────────────────────────────────────────────────────────────────────┘
```

Key invariants (from the manox architecture doc, `docs/dsh-v2-architecture.md`):

- **One physical connection, two consumers.** The host connection
  (participant, `deny`-on-unrouted-ServerCall policy) and the webview
  connection (`observe` policy) share the napi wire with disjoint id
  namespaces (`host-*` / `web-*`); each ignores the other's correlation ids.
- **The webview speaks the protocol directly.** The sidebar relay forwards
  every guard-parsed `FromServer` frame verbatim (wrapped in `{t:'frame'}`
  envelopes) and relays `FromClient` frames back — the webview answers
  adjudication `request` frames itself. The host registers a no-op ServerCall
  shield for every session the webview claims by opening a follow stream, so
  its own fail-closed default cannot race a card; unclaimed sessions deny on
  arrival. Host-owned capabilities (clipboardRead / openExternal) are
  answered by the host interceptor before any shield.
- **Client state is journal-folded** (L6): transcript items come from journal
  records via `TranscriptFold`, UI values from projections
  (higher-`asOfSeq`-wins), never from a second domain mirror.
- **Resync is the only recovery** (L5): entry-queue overflow or engine
  violation ends the stream and the client re-follows from a fresh snapshot.
- **Shared state root**: the extension defaults `MANOX_HOME` to the desktop
  app's `~/.manox`, so threads, models and provider config are one surface.
  Concurrent instances are safe (the old exclusive `runtime.lock` is gone;
  the only remaining flock is the WS gateway lease, and contention there is
  a loud no-op, never an exit). The agent still starts lazily (first use),
  never at activation.
- **The webview self-heals a stale host→webview channel.**
  `retainContextWhenHidden` lets a graceful extension-host restart (e.g. an
  install) leave the retained iframe deaf: the new relay posts frames the
  window never delivers, freezing the store on pre-restart state. A
  heartbeat watchdog (`webview-ui/…/state/watchdog.ts`) pings
  `{t:'ping', seq}` every 5 s and treats ANY host message — pong echoes
  included — as liveness; after ~3 unanswered pings of silence it declares
  the channel stale and reloads the iframe (visible only; a hidden view
  defers the verdict to `visibilitychange`). The heartbeat is sidebar
  out-of-band envelope vocabulary, never protocol — the host answers pings
  without touching the agent relay, and a healthy boot re-push also
  refetches the registries without a reload at all.
- **The webview keeps refetching models until registration settles.** The
  server registers model providers on a background thread (per-provider
  keychain resolution, up to ~30 s) and marks itself ready *before* that
  finishes, so it broadcasts an empty `models: []` on ready and only the
  populated list once registration completes. A mount that lands in that
  window caches the empty list and can miss the second broadcast, freezing
  the model picker on "No models configured" — a hole the watchdog's boot
  re-push cannot cover. A planner (`webview-ui/…/state/models-refetch.ts`)
  re-issues `requestModels()` every 10 s until the store's model list is
  non-empty, then stops for good (settle is sticky).

## The native binding

Released vsix packages are **self-contained**: the `manox_napi.node` addon
is bundled under `native/` and loaded from there — no manox checkout
required at runtime. The addon is platform-specific (the bundled build is
macOS arm64); shipping other platforms means packaging per-target vsix
builds the same way other native extensions do.

For development, rebuild the addon from the manox repository and restage:

```sh
git clone https://github.com/dspo/manox   # or your local checkout
cd manox
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
npm test           # vitest: host suites + webview-ui suites (journal vectors, store, guards)
code .             # then F5 ("Run manox extension")
```

`compile` + `test` for both projects run in CI on every PR and on `main`
pushes (`.github/workflows/ci.yml`, alongside the no-coauthor gate). The
live-runtime smoke test stays env-gated (`MANOX_SMOKE=1` + a staged
`manox_napi.node`) and does not run in CI.

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
| `manox.approvalMode` | `workspace-write` | Tool-authorization policy seeded into new sessions (`read-only` / `workspace-write` / `danger-full-access`). |

Commands: `manox: Focus Chat`, `manox: New Session`, `manox: Open Code
Tutor` (tour steps are `alt+left`/`alt+right` scoped to
`activeWebviewPanelId == manox.codeChain`, so they never steal the
workbench back/forward nav).
The sidebar header also
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
  this host can no longer talk to the current epoch. One deliberate exception
  to camelCase: `ClientToolSpec` mirrors a Rust struct with no `rename_all`,
  so its keys are snake_case (`input_schema`/`read_only`) — `builders.ts`'s
  `clientToolSpec` is the single conversion face and the guards test locks it.
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
- Host capabilities (#792): the staged addon declares `clipboardRead`,
  `openExternal`, and `clientTool`; the extension host answers clipboard
  reads (text-only, via `vscode.env.clipboard`) and external opens (via
  `vscode.env.openExternal`; the agent's Open tool is approval-gated
  upstream) before any per-session routing, so they never surface as
  webview cards. `clientTool` is now live: the host registers the
  Code Tutor tool set (`registerSessionTools`) and answers
  `invokeClientTool` from the interceptor (see below).
- Code Tutor (`src/codechain/`): the LLM generates an LSP-verified
  code-reading tour rendered in an editor-area webview panel (model-
  facing tools carry the `client_` prefix the server adds; the bare
  names are `TutorEntry` / `TutorNarrate` /
  `TutorExtend` / `TutorAdd` /
  `TutorExpand` / `TutorAnnotate` /
  `TutorRefresh`, all `read_only`, seven in total and defined once in
  the `TOOL_NAMES` constants). The business flow is built progressively
  so no single tool reply
  overruns the model's output budget. The default path is node-by-node:
  `TutorAdd` appends exactly ONE node per call (a ~300-char tool
  JSON), which is the only shape a small-output-budget model — e.g.
  qwen3.8-flash through Bailian, ~2K output tokens shared across
  thinking/text/tool JSON, whose calls truncated mid-JSON even at a
  ≤8-node shard, the cut point tracking the budget down (5334 → 3251
  chars) — can reliably emit; `TutorEntry` (whole spine) and
  `TutorExtend` (a ≤8-node block) remain large-budget shortcuts.
  `TutorNarrate` commits the chain's business story as its own
  call (a narrative + tree in one payload blew a ~5KB budget and cut the
  stream mid-JSON on a real model). Symbol positions resolve through the `vscode.execute*Provider`
  commands, so a hallucinated location is rejected back to the model.
  `/tutor` is a harness slash command provisioned into
  `<MANOX_HOME>/commands/tutor.md` at activation (the legacy
  `codechain.md` from the pre-Tutor brand is removed on write, so an
  upgraded install never keeps a stale `/codechain`). The full invoke
  round-trip depends on the dspo/manox side (the napi ClientTool
  capability + read_only approval-gate fix); until that lands and the
  addon is restaged, registration succeeds but real tool calls fail
  closed — the offline suites cover the wire contract.
- The old extension's `languageModelChatProviders` integration (exposing
  manox providers as VS Code language models via `modelChat`) was cut with
  the revival — it depended on proposed chat-provider APIs; revisit once
  stable.
