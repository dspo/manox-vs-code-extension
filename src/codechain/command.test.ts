// Command provisioning + panel HTML, both pure/vscode-free. `provisionCodeChainCommand`
// runs on the runtime boot path (review #12) — its written/unchanged branches
// are pinned against a temp dir; `renderPanelHtml` is the CSP/asset contract
// of the repo's first `createWebviewPanel` (§19).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCodeChainCommand, CODECHAIN_COMMAND_FILE, resolveProvisionRoot } from './command';
import { renderPanelHtml } from './panelHtml';

describe('provisionCodeChainCommand (review #12)', () => {
	let root = '';
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'cc-cmd-'));
	});
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it('creates commands/codechain.md and reports `written`', () => {
		expect(ensureCodeChainCommand(root)).toBe('written');
		const file = join(root, 'commands', CODECHAIN_COMMAND_FILE);
		expect(existsSync(file)).toBe(true);
		// The body carries the $ARGUMENTS placeholder and the prefixed tool
		// names the model actually calls.
		const md = readFileSync(file, 'utf8');
		expect(md).toContain('$ARGUMENTS');
		expect(md).toContain('client_GenCodeChain');
		expect(md).toContain('argument-hint');
		// Progressive-building workflow keywords: the narrative seed, the
		// Extend block tool, the Expand/Annotate follow-up roles, the business
		// loop-first reading step, the truncation/re-shard clause, and the
		// size caps the workflow names explicitly.
		expect(md).toContain('client_ExtendCodeChainNode');
		expect(md).toContain('client_ExpandCodeChainNode');
		expect(md).toContain('client_AnnotateCodeChainNode');
		expect(md).toContain('narrative');
		expect(md).toContain('业务闭环');
		expect(md).toContain('原样重发');
		expect(md).toContain('payload too large');
		expect(md).toContain('≤120');
		expect(md).toContain('≤8');
	});

	it('a second run with unchanged content reports `unchanged` (mtime-stable)', () => {
		expect(ensureCodeChainCommand(root)).toBe('written');
		const before = readFileSync(join(root, 'commands', CODECHAIN_COMMAND_FILE), 'utf8');
		expect(ensureCodeChainCommand(root)).toBe('unchanged');
		expect(readFileSync(join(root, 'commands', CODECHAIN_COMMAND_FILE), 'utf8')).toBe(before);
	});

	it('a drift (e.g. a version bump to the constant) is rewritten', () => {
		ensureCodeChainCommand(root);
		writeFileSync(join(root, 'commands', CODECHAIN_COMMAND_FILE), 'stale', 'utf8');
		expect(ensureCodeChainCommand(root)).toBe('written');
	});
});

describe('resolveProvisionRoot (MANOX_HOME precedence, review #12)', () => {
	it('env unset → uses the configured root, no warning', () => {
		const warns: string[] = [];
		expect(resolveProvisionRoot('/configured', '', (m) => warns.push(m))).toBe('/configured');
		expect(resolveProvisionRoot('/configured', undefined, () => undefined)).toBe('/configured');
		expect(warns).toHaveLength(0);
	});
	it('env set + different → provisions the env root and warns', () => {
		const warns: string[] = [];
		expect(resolveProvisionRoot('/configured', '/env-home', (m) => warns.push(m))).toBe('/env-home');
		expect(warns.some((w) => w.includes('MANOX_HOME'))).toBe(true);
	});
	it('env set + equal → configured root, no warning', () => {
		const warns: string[] = [];
		expect(resolveProvisionRoot('/same', '/same', (m) => warns.push(m))).toBe('/same');
		expect(warns).toHaveLength(0);
	});
});

describe('renderPanelHtml', () => {
	const html = renderPanelHtml({
		nonce: 'abc123',
		cspSource: 'vscode-webview://xyz',
		language: 'zh-cn',
		scriptUri: 'vscode-resource:/codechain-bundle.js',
		styleUri: 'vscode-resource:/bundle.css',
	});

	it('nonce-scoped CSP on script + style, default-src none', () => {
		expect(html).toContain("default-src 'none'");
		expect(html).toContain("script-src vscode-webview://xyz 'nonce-abc123'");
		expect(html).toContain("style-src vscode-webview://xyz 'nonce-abc123' 'unsafe-inline'");
	});
	it('mounts the codechain bundle with the nonce and the language meta', () => {
		expect(html).toContain('<script nonce="abc123" src="vscode-resource:/codechain-bundle.js">');
		expect(html).toContain('<meta name="vscode-language" content="zh-cn">');
		expect(html).toContain('<div id="root">');
	});
});
