// Host bundler:
//   host    src/extension.ts  → out/extension.js   (CommonJS, node, vscode external)
// The webview bundle (dist/webview/bundle.{js,css}) is built by the
// webview-ui/ package (React + Tailwind); `npm run compile` chains both.
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
];

if (watch) {
	for (const cfg of targets) await (await context(cfg)).watch();
} else {
	for (const cfg of targets) await build(cfg);
}
