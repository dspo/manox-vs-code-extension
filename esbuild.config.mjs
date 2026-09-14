// Bundler for both compile targets:
//   host    src/extension.ts  → out/extension.js   (CommonJS, node, vscode external)
//   webview src/webview/main.ts → dist/webview/bundle.{js,css} (browser IIFE)
// Test files are never entry points; tsc --noEmit covers typing.

import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = {
	bundle: true,
	sourcemap: false,
	logLevel: 'info',
};

const targets = [
	{
		...shared,
		entryPoints: ['src/extension.ts'],
		outfile: 'out/extension.js',
		platform: 'node',
		format: 'cjs',
		external: ['vscode'],
		target: 'node18',
	},
	{
		...shared,
		entryPoints: ['src/webview/main.ts'],
		outdir: 'dist/webview',
		entryNames: 'bundle',
		platform: 'browser',
		format: 'iife',
		target: 'es2022',
	},
];

if (watch) {
	for (const cfg of targets) await (await context(cfg)).watch();
} else {
	for (const cfg of targets) await build(cfg);
}
