import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import './components/pattern-list.js';
import './components/pattern-form.js';
import { postToHost, HostMessages } from '../shared/messaging.js';
import type { PatternEditorIn, PatternEditorOut } from '../../src/ipc/messages.js';
import type { KeyedRawPattern } from '../../src/logAnalyzer/PatternEngine.js';

/** Root element for the Pattern Editor panel. Holds the bundled +
 *  user pattern snapshots received from the host, and orchestrates
 *  the list ↔ form interaction. Children dispatch bubbling
 *  `edit` / `delete` / `save` / `cancel` events which this element
 *  translates into `PatternEditorIn` IPC messages.
 *
 *  Message contract: host pushes `patternEditor.snapshot` on open
 *  and after every successful save/delete. `patternEditor.saveOk`
 *  is a confirmation that closes the form; `patternEditor.saveFailed`
 *  surfaces an inline error banner while keeping the form open so
 *  the user can correct their input. */
@customElement('ditto-pattern-editor')
export class DittoPatternEditor extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 12px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      box-sizing: border-box;
    }
    .toolbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 8px;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 0;
      padding: 4px 10px;
      cursor: pointer;
      font: inherit;
      border-radius: 2px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .err {
      color: var(--vscode-inputValidation-errorForeground);
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 6px 10px;
      margin-bottom: 8px;
      border-radius: 4px;
    }
  `;

  @state() private bundled: KeyedRawPattern[] = [];
  @state() private user: KeyedRawPattern[] = [];
  @state() private editing: KeyedRawPattern | null = null;
  @state() private showForm = false;
  @state() private errMessage: string | null = null;

  /** Host-message subscription. The controller owns its own lifetime, so a
   *  re-attach cannot leave a second handler bound to the stale element. */
  readonly hostMessages = new HostMessages<PatternEditorOut>(this, msg => this.handleMessage(msg));

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('edit', this.onEdit);
    this.addEventListener('delete', this.onDelete);
    this.addEventListener('save', this.onSave);
    this.addEventListener('cancel', this.onCancel as EventListener);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('edit', this.onEdit);
    this.removeEventListener('delete', this.onDelete);
    this.removeEventListener('save', this.onSave);
    this.removeEventListener('cancel', this.onCancel as EventListener);
    super.disconnectedCallback();
  }

  private onEdit = (e: Event): void => {
    this.editing = (e as CustomEvent<KeyedRawPattern>).detail;
    this.showForm = true;
    this.errMessage = null;
  };

  private onDelete = (e: Event): void => {
    const { key } = (e as CustomEvent<{ key: string }>).detail;
    const msg: PatternEditorIn = { type: 'patternEditor.delete', key };
    postToHost(msg);
  };

  private onSave = (e: Event): void => {
    const detail = (e as CustomEvent<{ pattern: KeyedRawPattern; replaceKey?: string }>).detail;
    const msg: PatternEditorIn = {
      type: 'patternEditor.save',
      pattern: detail.pattern,
      ...(detail.replaceKey !== undefined ? { replaceKey: detail.replaceKey } : {}),
    };
    postToHost(msg);
  };

  private onCancel = (): void => {
    this.showForm = false;
    this.editing = null;
    this.errMessage = null;
  };

  private handleMessage = (m: PatternEditorOut): void => {
    if (!m) { return; }
    switch (m.type) {
      case 'patternEditor.snapshot':
        this.bundled = m.bundled;
        this.user = m.user;
        this.errMessage = null;
        break;
      case 'patternEditor.saveOk':
        this.showForm = false;
        this.editing = null;
        this.errMessage = null;
        break;
      case 'patternEditor.saveFailed':
        this.errMessage = m.message;
        break;
      default:
        break;
    }
  };

  private startAdd(): void {
    this.editing = null;
    this.showForm = true;
    this.errMessage = null;
  }

  override render(): TemplateResult {
    return html`
      <div class="toolbar">
        <button @click=${() => this.startAdd()}>+ Add Pattern</button>
      </div>
      ${this.errMessage ? html`<div class="err">${this.errMessage}</div>` : ''}
      ${this.showForm
        ? html`<pattern-form
            .editing=${this.editing}
            .bundledKeys=${this.bundled.map(p => p.key)}
          ></pattern-form>`
        : ''}
      <pattern-list .bundled=${this.bundled} .user=${this.user}></pattern-list>
    `;
  }
}
