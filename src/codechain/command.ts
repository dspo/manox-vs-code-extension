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

工作流程（业务优先，渐进成链；叙事与树分两次调用，各自留足输出预算）：
1. 先用可用的检索/阅读工具定位业务入口（路由/handler/公开 API），先读通业务闭环——状态在哪里被改变、事件发到哪里、账在哪里记——再沿真实调用关系回填调用路径。只通读改变或承载业务状态的步骤；middleware、参数格式校验、幂等、审计日志、错误包装、DTO 转换等惯例代码不要作为节点深入（有业务例外含义的一句话写进父节点 summary 或 edgeNote）。
2a. 调用 client_GenCodeChain 播种：只放故事主干（spine）树、不要带 narrative（树只放故事主干——业务语义不同的分支才展开，错误/回退路径最多用一个 kind='note' 节点概括；spine ≤8 个节点、整段 JSON 控制在 ~2.5KB 内；每个节点带 summary（≤120 字，用户语言讲业务上发生了什么）和 beat（≤60 字，该节点在故事里承担的一拍））。
2b. 播种成功后立刻单独调用 client_NarrateCodeChain 提交叙事：一次只写 narrative 文本（300-600 字 markdown 连贯业务故事：触发→关键决策→状态流转→对外后果），带上 2a 返回的 chainId，切勿把它塞回播种调用。
3. 值得深入的 spine 节点用 client_ExtendCodeChainNode 逐块补充：每块前先用读工具读该函数确认其业务含义，每块 ≤8 个新节点；本块改变故事时传更新后的完整 narrative，否则省略。
4. 之后：真实调用边用 client_ExpandCodeChainNode（宿主经 LSP 解析），语义补注用 client_AnnotateCodeChainNode。
5. 工具返回后，用 2-3 句话向用户概述这条链的主干（回扣 narrative 的故事线），并提示：点击树节点或按“上一步/下一步”可跟随代码阅读。
若 client_GenCodeChain 或 client_ExtendCodeChainNode 报告符号解析失败，根据报错修正 file/symbol 后重试（最多 3 次），仍失败则将失败节点降级为 kind='note' 并在 summary 说明。若工具报告 payload too large 或节点/摘要被截断，改用更小的分片重试，禁止原样重发。
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
