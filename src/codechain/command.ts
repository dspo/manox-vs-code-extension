// The `/codechain` slash command, delivered as a server-native harness
// command: manox loads `<MANOX_HOME>/commands/*.md` at startup
// (dspo/manox crates/manox-agent/src/command.rs — frontmatter
// `description` / `argument-hint`, body renders `$ARGUMENTS`), and submit
// expansion works identically for the sidebar composer and the chat
// participant. The extension therefore only has to PROVISION the markdown
// file into the runtime's state root before the agent server first starts —
// no client-side interception on either surface (verified against the manox
// tree, 2026-09-15).
//
// The provisioning MUST run before `command::init()`, which fires inside
// `napiBinding.start()` — i.e. during `AgentHost` construction, exactly once
// per process. So the write lives on that boot path (`ensureCodeChainCommand`
// is called synchronously in the `AgentHost` constructor), and it is SYNC on
// purpose: a fire-and-forget promise here would race the runtime's
// one-shot startup scan (review #12).
//
// This module is the single source of the prompt text: the file written to
// disk and anything that later echoes it both come from `CODECHAIN_COMMAND_MD`.
// Tool names in the body carry the server's model-facing `client_` prefix
// (§8 Phase 0 revision) — the model never sees the bare registration name.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CODECHAIN_COMMAND_NAME = 'codechain';
export const CODECHAIN_COMMAND_FILE = `${CODECHAIN_COMMAND_NAME}.md`;

/** Frontmatter + workflow body (§8(b)). `description` / `argument-hint` feed
 * the composer typeahead; the body is the turn prompt. */
export const CODECHAIN_COMMAND_MD = `---
description: Build an LSP-verified code-reading tour of a business flow
argument-hint: <what to understand, e.g. 订单创建接口的业务逻辑>
---
用户想通过「代码链」功能阅读理解代码。用户的问题：$ARGUMENTS

工作流程：
1. 先用可用的检索/阅读工具定位该业务的入口（路由/handler/公开 API），再沿真实调用关系读下去，直到覆盖完整业务闭环（入口→校验→核心逻辑→持久化/事件→出口）。
2. 调用 client_GenCodeChain 输出树。节点必须是你亲眼在代码里见过的符号；summary 用用户的语言写业务含义。
3. 工具返回后，用 2-3 句话向用户概述这条链的主干，并提示：点击树节点或按“上一步/下一步”可跟随代码阅读；想深挖某节点可让你 client_ExpandCodeChainNode 展开其真实调用边。
若 client_GenCodeChain 报告符号解析失败，根据报错修正 file/symbol 后重试（最多 3 次），仍失败则将失败节点降级为 kind='note' 并在 summary 说明。
`;

/** Resolve the state root to provision, mirroring the transport's own
 * precedence: `MANOX_HOME` env wins over the configured setting (the addon
 * only pins `MANOX_HOME` when it is unset — `napiTransport.loadBinding`).
 * Without this, an externally preset `MANOX_HOME` would make provisioning
 * write one directory while the server scans another, so `/codechain`
 * silently disappears (review #12). Returns the resolved root. */
export function resolveProvisionRoot(
	configuredStateRoot: string,
	envManoxHome: string | undefined,
	warn: (message: string) => void,
): string {
	const env = envManoxHome?.trim();
	if (env && env !== configuredStateRoot) {
		warn(
			`MANOX_HOME is externally set to ${env} but the manox.stateRoot setting says ${configuredStateRoot}; provisioning the command into the env root (what the server scans) — align the two to silence this`,
		);
		return env;
	}
	return configuredStateRoot;
}

/** Write (or refresh) `<stateRoot>/commands/codechain.md`. Idempotent: an
 * identical file is left untouched so every activation never churns mtime.
 * Synchronous — it runs on the one-time runtime boot path ahead of the
 * server's startup command scan. Throws surface to the caller; the boot
 * caller must not let a state-root hiccup abort activation. */
export function ensureCodeChainCommand(stateRoot: string): 'written' | 'unchanged' {
	const dir = join(stateRoot, 'commands');
	const file = join(dir, CODECHAIN_COMMAND_FILE);
	mkdirSync(dir, { recursive: true });
	if (existsSync(file) && readFileSync(file, 'utf8') === CODECHAIN_COMMAND_MD) return 'unchanged';
	writeFileSync(file, CODECHAIN_COMMAND_MD, 'utf8');
	return 'written';
}
