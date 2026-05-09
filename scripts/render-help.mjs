// scripts/render-help.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'resources', 'help');
const outDir = path.join(root, 'dist', 'webview-ui', 'help');

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(srcDir, 'help.css'), path.join(outDir, 'help.css'));

for (const f of fs.readdirSync(srcDir)) {
  if (!f.endsWith('.md')) continue;
  const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
  const html = md.render(src);
  const wrapped = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="help.css"><div class="help-root">${html}</div>`;
  fs.writeFileSync(path.join(outDir, f.replace(/\.md$/, '.html')), wrapped, 'utf8');
}

console.log('[render-help] rendered', fs.readdirSync(srcDir).filter(f => f.endsWith('.md')).join(', '));
