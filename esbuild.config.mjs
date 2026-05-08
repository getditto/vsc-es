import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

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

if (watch) {
  await extensionCtx.watch();
  console.log('[esbuild] watching…');
} else {
  await extensionCtx.rebuild();
  await extensionCtx.dispose();
  console.log('[esbuild] build finished.');
}
