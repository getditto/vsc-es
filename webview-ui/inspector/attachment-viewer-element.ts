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

interface AttachmentToken {
  _meta: { id: string; length: number; contentType?: string; filename?: string; [k: string]: unknown };
}

interface DetectedAttachment {
  path: string;
  token: AttachmentToken;
  metadata: AttachmentMetadata;
}

function detectAttachments(value: unknown, path = ''): DetectedAttachment[] {
  const out: DetectedAttachment[] = [];
  walk(value, path, out);
  return out;
}

function walk(v: unknown, path: string, out: DetectedAttachment[]): void {
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (obj._meta && typeof obj._meta === 'object' && (obj._meta as { id?: string }).id) {
      const m = obj._meta as { id: string; length: number; contentType?: string; filename?: string };
      out.push({
        path,
        token: obj as unknown as AttachmentToken,
        metadata: { id: m.id, length: m.length, contentType: m.contentType, filename: m.filename },
      });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((el, i) => walk(el, `${path}[${i}]`, out));
    } else {
      for (const [k, val] of Object.entries(obj)) {
        walk(val, path ? `${path}.${k}` : k, out);
      }
    }
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
    }
    .att-header { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
    .att-img { max-width: 100%; max-height: 240px; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 0;
      padding: 4px 8px;
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .err { color: var(--vscode-charts-red); margin-top: 4px; }
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
            <span>${a.metadata.filename ?? 'attachment'}</span>
            <span>—</span>
            <span>${a.metadata.length} bytes</span>
            <span>—</span>
            <span>${a.metadata.contentType ?? '?'}</span>
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
