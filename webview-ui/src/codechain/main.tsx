// Code-chain panel entry — separate from the sidebar bundle (second esbuild
// entry, `dist/webview/codechain-bundle.js`). Same mount shape as the
// sidebar main.tsx: an ErrorBoundary-wrapped root reading `#root`.

import { createRoot } from 'react-dom/client';

import { ErrorBoundary } from '../sidebar/webview/components/error-boundary';
import { CodeChainApp } from './app';
import { createVscodePanelBridge } from './bridge';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <CodeChainApp bridge={createVscodePanelBridge()} />
  </ErrorBoundary>,
);
