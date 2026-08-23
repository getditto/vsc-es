// webview-ui/inspector/attachment-viewer-element.ts
//
// Detects attachment-token-shaped objects in the selected JSON result and
// renders fetch/save controls for each. Listens for host-side responses
// to update the loaded/progress/error state per token.
//
// `detectAttachments` is inlined here (mirrors `src/inspector/inspector-state.ts`)
// because webview bundles cannot reach into `src/`.

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { postToHost } from '../shared/messaging.js';
import { codiconStyles } from './codicon-styles.js';

interface AttachmentMetadata {
  id: string;
  length: number;
  contentType?: string;
  filename?: string;
}

/** Real SDK token shape: `{id, len, metadata}` (no `_meta` wrapper).
 *  See node_modules/@dittolive/ditto/types/ditto.d.ts. */
interface AttachmentToken {
  id: string;
  len: number;
  metadata: Record<string, string>;
}

interface DetectedAttachment {
  path: string;
  token: AttachmentToken;
  metadata: AttachmentMetadata;
}

function formatBytes(n: number): string {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  if (n < 1024 * 1024 * 1024) { return `${(n / (1024 * 1024)).toFixed(1)} MB`; }
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isAttachmentToken(obj: Record<string, unknown>): obj is AttachmentToken & Record<string, unknown> {
  if (typeof obj.id !== 'string') { return false; }
  if (typeof obj.len !== 'number' && typeof obj.len !== 'bigint') { return false; }
  if (!obj.metadata || typeof obj.metadata !== 'object' || Array.isArray(obj.metadata)) { return false; }
  return true;
}

function pickContentType(meta: Record<string, unknown>): string | undefined {
  const m = meta as Record<string, string | undefined>;
  return m.mimeType ?? m.contentType ?? m.mime_type ?? m.type;
}

function pickFilename(meta: Record<string, unknown>): string | undefined {
  const m = meta as Record<string, string | undefined>;
  return m.name ?? m.filename ?? m.fileName ?? m.file_name;
}

function detectAttachments(value: unknown, path = ''): DetectedAttachment[] {
  const out: DetectedAttachment[] = [];
  walk(value, path, out);
  return out;
}

function walk(v: unknown, path: string, out: DetectedAttachment[]): void {
  if (!v || typeof v !== 'object') { return; }
  if (Array.isArray(v)) {
    v.forEach((el, i) => walk(el, `${path}[${i}]`, out));
    return;
  }
  const obj = v as Record<string, unknown>;
  if (isAttachmentToken(obj)) {
    const meta = obj.metadata;
    out.push({
      path,
      token: { id: obj.id, len: Number(obj.len), metadata: meta as Record<string, string> },
      metadata: {
        id: obj.id,
        length: Number(obj.len),
        contentType: pickContentType(meta),
        filename: pickFilename(meta),
      },
    });
    return;
  }
  for (const [k, val] of Object.entries(obj)) {
    walk(val, path ? `${path}.${k}` : k, out);
  }
}

@customElement('attachment-viewer-element')
export class AttachmentViewerElement extends LitElement {
  @property() json: string | undefined;
  @state() private loaded: Record<string, { uri: string; mime: string }> = {};
  @state() private progress: Record<string, number> = {};
  @state() private errors: Record<string, string> = {};

  static styles = [codiconStyles, css`
    :host { display: block; margin-top: 12px; color: var(--vscode-foreground); }
    .att {
      padding: 8px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      margin-bottom: 6px;
      overflow: hidden;
    }
    /* Header: wrap onto multiple lines when filename + size + MIME
       overflow the panel width (the Inspector pane is narrow). */
    .att-header {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 8px;
      align-items: center;
      margin-bottom: 4px;
      font-size: 12px;
    }
    .att-name {
      font-weight: 600;
      word-break: break-all;
      min-width: 0;
    }
    .att-meta {
      color: var(--vscode-descriptionForeground);
      word-break: break-all;
      font-family: var(--vscode-editor-font-family);
    }
    .att-img { max-width: 100%; max-height: 240px; display: block; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 0;
      padding: 4px 8px;
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .err { color: var(--vscode-charts-red); margin-top: 4px; word-break: break-word; }
    .progress { color: var(--vscode-descriptionForeground); margin-top: 4px; }
  `];

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('message', this.onMsg);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('message', this.onMsg);
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('json')) {
      // Attachment state is keyed by tokenIds derived from the CURRENT
      // row's JSON. Keeping entries for every row ever selected would grow
      // these records for the life of the panel.
      this.loaded = {};
      this.progress = {};
      this.errors = {};
    }
  }

  private onMsg = (e: MessageEvent): void => {
    const m = e.data;
    if (!m) { return; }
    if (m.type === 'inspector.attachmentLoaded') {
      this.loaded = { ...this.loaded, [m.tokenId]: { uri: m.webviewUri, mime: m.mimeType } };
    } else if (m.type === 'inspector.attachmentProgress') {
      this.progress = { ...this.progress, [m.tokenId]: m.pct };
    } else if (m.type === 'inspector.attachmentError') {
      this.errors = { ...this.errors, [m.tokenId]: m.message };
    }
  };

  render() {
    if (!this.json) { return html``; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.json);
    } catch {
      return html``;
    }
    const found = detectAttachments(parsed);
    if (found.length === 0) { return html``; }
    return html`${found.map((a, i) => {
      const tokenId = `${a.metadata.id}_${i}`;
      const loaded = this.loaded[tokenId];
      const err = this.errors[tokenId];
      const pct = this.progress[tokenId];
      const isImage = (a.metadata.contentType ?? '').startsWith('image/');
      return html`
        <div class="att">
          <div class="att-header">
            <span class="codicon codicon-file"></span>
            <span class="att-name">${a.metadata.filename ?? 'attachment'}</span>
            <span class="att-meta">${formatBytes(a.metadata.length)}</span>
            <span class="att-meta">${a.metadata.contentType ?? 'unknown type'}</span>
          </div>
          ${err ? html`<div class="err">${err}</div>` : ''}
          ${pct !== undefined && !loaded ? html`<div class="progress">Loading… ${pct}%</div>` : ''}
          ${loaded
            ? (isImage
                ? html`<img class="att-img" src=${loaded.uri}>`
                : html`<button @click=${() => this.save(a.token, tokenId)}>Save…</button>`)
            : html`<button @click=${() => this.fetch(a.token, tokenId)}>Fetch</button>`}
        </div>
      `;
    })}`;
  }

  private fetch(token: AttachmentToken, tokenId: string): void {
    postToHost({ type: 'inspector.fetchAttachment', token, tokenId });
  }
  private save(token: AttachmentToken, tokenId: string): void {
    postToHost({ type: 'inspector.saveAttachment', token, tokenId });
  }
}
