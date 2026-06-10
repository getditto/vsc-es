import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { KeyedRawPattern } from '../../../src/logAnalyzer/PatternEngine.js';
import type { LogLevel } from '../../../src/logging/types.js';

/** Add/Edit form for a single user pattern. Validates regex live,
 *  blocks save on bundled-key collisions, and exposes a Test line
 *  field for quick verification. Emits `save` (with `{ pattern,
 *  replaceKey? }`) and `cancel` bubbling events. */
@customElement('pattern-form')
export class PatternForm extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      margin: 12px 0;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    label { display: block; margin-top: 8px; }
    input, textarea, select {
      width: 100%;
      padding: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      font-family: var(--vscode-font-family);
      box-sizing: border-box;
    }
    textarea { font-family: var(--vscode-font-family); min-height: 60px; }
    .err { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 2px; }
    .ok  { color: #5cb85c; font-size: 12px; margin-top: 2px; }
    .row {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      justify-content: flex-end;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 0;
      padding: 4px 12px;
      cursor: pointer;
      font: inherit;
    }
    button:hover:not([disabled]) { background: var(--vscode-button-hoverBackground); }
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover:not([disabled]) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  `;

  @property({ type: Object }) editing: KeyedRawPattern | null = null;
  @property({ type: Array }) bundledKeys: string[] = [];

  @state() private key = '';
  @state() private pattern = '';
  @state() private severity = 3;
  @state() private recommendation = '';
  @state() private levelFilter = '';
  @state() private tagFilter = '';
  @state() private testInput = '';

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('editing')) {
      if (this.editing) {
        this.key = this.editing.key;
        this.pattern = this.editing.pattern;
        this.severity = this.editing.severity;
        this.recommendation = this.editing.recommendation;
        this.levelFilter = this.editing.level_filter ?? '';
        this.tagFilter = this.editing.tag_filter ?? '';
      } else {
        // Reset to empty form when transitioning from editing → new.
        this.key = '';
        this.pattern = '';
        this.severity = 3;
        this.recommendation = '';
        this.levelFilter = '';
        this.tagFilter = '';
        this.testInput = '';
      }
    }
  }

  private regexError(): string | null {
    if (this.pattern.length === 0) { return null; }
    try {
      new RegExp(this.pattern, 'i');
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /** Collision = key matches a bundled key. When editing an existing
   *  user pattern, the key may legitimately re-occur (we'd be
   *  overwriting it), but it must never overlap with a bundled key. */
  private collidesWithBundled(): boolean {
    return this.bundledKeys.includes(this.key.trim());
  }

  private testMatches(): boolean {
    try {
      return new RegExp(this.pattern, 'i').test(this.testInput);
    } catch {
      return false;
    }
  }

  private canSave(): boolean {
    return this.key.trim().length > 0
      && this.pattern.length > 0
      && this.regexError() === null
      && this.recommendation.trim().length > 0
      && !this.collidesWithBundled();
  }

  private save(): void {
    if (!this.canSave()) { return; }
    const out: KeyedRawPattern = {
      key: this.key.trim(),
      pattern: this.pattern,
      severity: this.severity,
      recommendation: this.recommendation.trim(),
    };
    if (this.levelFilter) { out.level_filter = this.levelFilter as LogLevel; }
    if (this.tagFilter) { out.tag_filter = this.tagFilter; }
    this.dispatchEvent(new CustomEvent('save', {
      detail: { pattern: out, replaceKey: this.editing?.key },
      bubbles: true,
      composed: true,
    }));
  }

  private cancel(): void {
    this.dispatchEvent(new CustomEvent('cancel', { bubbles: true, composed: true }));
  }

  render(): TemplateResult {
    const re = this.regexError();
    const coll = this.collidesWithBundled();
    const levels: ReadonlyArray<LogLevel> = ['error', 'warn', 'info', 'debug', 'trace'];
    return html`
      <label>Key
        <input
          .value=${this.key}
          @input=${(e: Event) => { this.key = (e.target as HTMLInputElement).value; }}
        />
      </label>
      ${coll ? html`<div class="err">Collides with bundled key</div>` : ''}
      <label>Pattern
        <input
          .value=${this.pattern}
          @input=${(e: Event) => { this.pattern = (e.target as HTMLInputElement).value; }}
        />
      </label>
      ${re
        ? html`<div class="err">${re}</div>`
        : (this.pattern ? html`<div class="ok">✓ valid regex</div>` : '')}
      <label>Severity
        <select
          .value=${String(this.severity)}
          @change=${(e: Event) => { this.severity = +(e.target as HTMLSelectElement).value; }}
        >
          ${[1, 2, 3, 4, 5].map(n => html`
            <option value=${n} ?selected=${this.severity === n}>${n}</option>
          `)}
        </select>
      </label>
      <label>Recommendation
        <textarea
          .value=${this.recommendation}
          @input=${(e: Event) => { this.recommendation = (e.target as HTMLTextAreaElement).value; }}
        ></textarea>
      </label>
      <label>Level filter (optional, exact match)
        <select
          .value=${this.levelFilter}
          @change=${(e: Event) => { this.levelFilter = (e.target as HTMLSelectElement).value; }}
        >
          <option value="">(any)</option>
          ${levels.map(l => html`
            <option value=${l} ?selected=${this.levelFilter === l}>${l}</option>
          `)}
        </select>
      </label>
      <label>Tag filter regex (optional)
        <input
          .value=${this.tagFilter}
          @input=${(e: Event) => { this.tagFilter = (e.target as HTMLInputElement).value; }}
        />
      </label>
      <label>Test line
        <input
          .value=${this.testInput}
          @input=${(e: Event) => { this.testInput = (e.target as HTMLInputElement).value; }}
          placeholder="Paste a log line to test the pattern"
        />
      </label>
      ${this.testInput
        ? html`<div class=${this.testMatches() ? 'ok' : 'err'}>
            ${this.testMatches() ? '✓ Matches' : '✗ No match'}
          </div>`
        : ''}
      <div class="row">
        <button class="secondary" @click=${() => this.cancel()}>Cancel</button>
        <button ?disabled=${!this.canSave()} @click=${() => this.save()}>Save</button>
      </div>
    `;
  }
}
