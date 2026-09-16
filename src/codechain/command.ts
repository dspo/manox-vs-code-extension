// The `/tutor` slash command — the Code Tutor entry point, delivered as a
// server-native harness command: manox loads `<MANOX_HOME>/commands/*.md` at
// startup (dspo/manox crates/manox-agent/src/command.rs — frontmatter
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
// Rebrand cleanup: the Tutor feature shipped as `/codechain` before, so
// `ensureCodeChainCommand` also REMOVES the legacy `codechain.md` next to
// writing `tutor.md` — an upgraded install must never keep a stale
// `/codechain` command pointing at renamed tools.
//
// This module is the single source of the prompt text: the file written to
// disk and anything that later echoes it both come from `CODECHAIN_COMMAND_MD`.
// Tool names in the body carry the server's model-facing `client_` prefix
// (§8 Phase 0 revision) and are built from the `TOOL_NAMES` constants
// (tools.ts — the single source for tool names), never string literals.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_NAMES } from './tools';
import { MAX_BEAT_CHARS, MAX_EXTEND_NODES, MAX_SUMMARY_CHARS } from './types';

export const CODECHAIN_COMMAND_NAME = 'tutor';
export const CODECHAIN_COMMAND_FILE = `${CODECHAIN_COMMAND_NAME}.md`;
/** Pre-rebrand provisioning file (`/codechain`); `ensureCodeChainCommand`
 * deletes it on write so old users upgrade to `/tutor` with no leftover. */
export const LEGACY_CODECHAIN_COMMAND_FILE = 'codechain.md';

/** Frontmatter + workflow body (§8(b)). `description` / `argument-hint` feed
 * the composer typeahead; the body is the turn prompt. */
export const CODECHAIN_COMMAND_MD = `---
description: Build an LSP-verified Code Tutor reading tour of a business flow
argument-hint: <what to understand, e.g. 订单创建接口的业务逻辑>
---
用户想通过「代码导游（Code Tutor）」功能阅读理解代码。用户的问题：$ARGUMENTS

工作流程（业务优先，逐节点成链；叙事与树分开提交，各自留足输出预算。默认路径每次调用只加一个节点——小输出预算模型（如百炼上的 qwen3.8-flash，单次响应仅 ~2K tokens，thinking/text/tool JSON 共享）即使按分片协议仍会把多节点的 tool_use 写到截断，逐节点是唯一对所有模型都可行的建链方式）：
1. 先用可用的检索/阅读工具定位业务入口（路由/handler/公开 API），先读通业务闭环——状态在哪里被改变、事件发到哪里、账在哪里记——再沿真实调用关系回填调用路径。只通读改变或承载业务状态的步骤；middleware、参数格式校验、幂等、审计日志、错误包装、DTO 转换等惯例代码不要作为节点深入（有业务例外含义的一句话写进父节点 summary 或 edgeNote）。
2. 建立链骨架（默认，任意模型可行）：调用一次 client_${TOOL_NAMES.entry} 只放链的 title、question 与单个 root 入口节点（kind='entry'）、不要带 narrative；或直接不带 chainId 与 parentId 调用一次 client_${TOOL_NAMES.add} 添加第一个入口节点来创建链（回复回带新的 chainId，后续调用复用它）。
3. 按故事发生的顺序逐个 client_${TOOL_NAMES.add} 添加节点：每次调用只加一个节点，parentId 用上一次回复返回的 nodeId（即本步在业务叙事里跟随的那个节点；紧跟 root 的一步可省略 parentId 挂到根）；每个节点写它的业务一拍 beat（≤${MAX_BEAT_CHARS} 字）与 summary（≤${MAX_SUMMARY_CHARS} 字，用户语言讲业务上发生了什么），file/symbol 必须是你真正读过的符号、禁报行号，概念性且无单一代码位置的步骤用 kind='note'。一次调用绝不塞 children——一步一个节点、多次调用。
4. 值得补充时：真实调用边用 client_${TOOL_NAMES.expand}（宿主经 LSP 解析）、语义补注用 client_${TOOL_NAMES.annotate}。（大输出预算模型也可用 client_${TOOL_NAMES.entry} 一次播种整棵 ≤${MAX_EXTEND_NODES} 节点主干、或用 client_${TOOL_NAMES.extend} 一次补 ≤${MAX_EXTEND_NODES} 个节点的整块作为捷径；小输出预算模型不要走整树/整块，坚持逐节点。）
5. 链成型后单独调用 client_${TOOL_NAMES.narrate} 提交成篇叙事：一次只写 narrative 文本（300-600 字 markdown 连贯业务故事：触发→关键决策→状态流转→对外后果），带上 chainId，切勿塞回其它调用。
6. 工具返回后，用 2-3 句话向用户概述这条链的主干（回扣 narrative 的故事线），并提示：点击树节点或按“上一步/下一步”可跟随代码导游的导览阅读。
若 client_${TOOL_NAMES.entry} / client_${TOOL_NAMES.add} / client_${TOOL_NAMES.extend} 报告符号解析失败，根据报错只修正失败的那个节点 file/symbol 后重试（最多 3 次），仍失败则将失败节点降级为 kind='note' 并在 summary 说明。若工具报告 payload too large 或节点/摘要被截断，改用更小的粒度（回到逐节点、每次一个）重试，禁止原样重发。
`;

/** Resolve the state root to provision, mirroring the transport's own
 * precedence: `MANOX_HOME` env wins over the configured setting (the addon
 * only pins `MANOX_HOME` when it is unset — `napiTransport.loadBinding`).
 * Without this, an externally preset `MANOX_HOME` would make provisioning
 * write one directory while the server scans another, so `/tutor`
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

/** Write (or refresh) `<stateRoot>/commands/tutor.md` and remove the legacy
 * `codechain.md` (pre-Tutor branding — an upgraded install must not keep a
 * stale `/codechain`). Idempotent: an identical file is left untouched so
 * every activation never churns mtime. Synchronous — it runs on the one-time
 * runtime boot path ahead of the server's startup command scan. Throws
 * surface to the caller; the boot caller must not let a state-root hiccup
 * abort activation. */
export function ensureCodeChainCommand(stateRoot: string): 'written' | 'unchanged' {
	const dir = join(stateRoot, 'commands');
	const file = join(dir, CODECHAIN_COMMAND_FILE);
	mkdirSync(dir, { recursive: true });
	rmSync(join(dir, LEGACY_CODECHAIN_COMMAND_FILE), { force: true });
	if (existsSync(file) && readFileSync(file, 'utf8') === CODECHAIN_COMMAND_MD) return 'unchanged';
	writeFileSync(file, CODECHAIN_COMMAND_MD, 'utf8');
	return 'written';
}
