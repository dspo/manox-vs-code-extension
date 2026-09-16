// The Code Tutor view document, extracted from `panel.ts` so it is a
// vscode-free pure function (the vscode `Webview` only supplies the string
// inputs) and therefore unit-testable (§19). CSP/nonce/asset wiring mirrors
// `sidebarProvider.renderHtml` exactly — the same document shape feeds the
// webview VIEW's `webview.html` now that the panel is a `WebviewViewProvider`;
// deliberately NOT a new HTML discipline.

export interface PanelHtmlInput {
	/** Per-document random nonce (the CSP `script-src`/`style-src` allowlist). */
	nonce: string;
	/** `webview.cspSource` — the local-resource authority. */
	cspSource: string;
	/** `vscode.env.language`, injected for the panel's own i18n detection. */
	language: string;
	/** `webview.asWebviewUri(<extension>/dist/webview/codechain-bundle.js)`. */
	scriptUri: string;
	/** The shared Tailwind sheet (already `@source`s the panel tree). */
	styleUri: string;
}

export function renderPanelHtml(input: PanelHtmlInput): string {
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="vscode-language" content="${input.language}">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src ${input.cspSource} 'nonce-${input.nonce}'; img-src ${input.cspSource} data: blob:; style-src ${input.cspSource} 'nonce-${input.nonce}' 'unsafe-inline'; font-src ${input.cspSource};">
  <link rel="stylesheet" href="${input.styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${input.nonce}" src="${input.scriptUri}"></script>
</body>
</html>`;
}
