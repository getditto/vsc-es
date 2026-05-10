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

// NOTE: don't emit a <link rel="stylesheet"> here — the help HTML is
// fetched and injected via .innerHTML inside HelpContentElement's
// shadow DOM, where a relative href resolves against the wrong base
// URL and silently fails to load. Help styling lives in the element's
// `static styles` block instead, scoped via the .help-root class.

for (const f of fs.readdirSync(srcDir)) {
  if (!f.endsWith('.md')) continue;
  const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
  const html = md.render(src);
  const wrapped = `<div class="help-root">${html}</div>`;
  fs.writeFileSync(path.join(outDir, f.replace(/\.md$/, '.html')), wrapped, 'utf8');
}

console.log('[render-help] rendered', fs.readdirSync(srcDir).filter(f => f.endsWith('.md')).join(', '));
