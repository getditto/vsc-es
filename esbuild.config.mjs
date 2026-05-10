import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// Render help markdown → HTML before bundling.
execFileSync('node', [path.join(__dirname, 'scripts', 'render-help.mjs')], { stdio: 'inherit' });

const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode', '@dittolive/ditto'],
  sourcemap: true,
  logLevel: 'info'
});

const webviewCtx = await esbuild.context({
  entryPoints: {
    editor: 'webview-ui/editor/main.ts',
    subscription: 'webview-ui/subscription/main.ts',
    peers: 'webview-ui/peers/main.ts',
    query: 'webview-ui/query/main.ts',
    inspector: 'webview-ui/inspector/main.ts',
    addIndex: 'webview-ui/addIndex/main.ts',
    importSubscriptions: 'webview-ui/import-subscriptions/main.ts',
    queryMetrics: 'webview-ui/queryMetrics/main.ts',
    databaseMetrics: 'webview-ui/databaseMetrics/main.ts',
  },
  bundle: true,
  outdir: 'dist/webview-ui',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info'
});

// Mark dist/ as CJS so Node's ESM loader doesn't reject the bundle
// (root package.json is "type": "module", but the extension bundle is CJS).
const distDir = path.join(__dirname, 'dist');
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'package.json'), '{"type":"commonjs"}\n');

// Copy @vscode/codicons assets to dist/webview-ui/ for webview consumption.
const codiconSrc = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
const webviewUiDir = path.join(distDir, 'webview-ui');
fs.mkdirSync(webviewUiDir, { recursive: true });
fs.copyFileSync(path.join(codiconSrc, 'codicon.css'), path.join(webviewUiDir, 'codicon.css'));
fs.copyFileSync(path.join(codiconSrc, 'codicon.ttf'), path.join(webviewUiDir, 'codicon.ttf'));

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log('[esbuild] watching…');
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  console.log('[esbuild] build finished.');
}
