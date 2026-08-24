import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

const TRUNCATE_AT = 120;

/** Stringify a value that is known not to be a plain object/array. */
function primitiveText(value: unknown): string {
  if (value === null || value === undefined) { return ''; }
  if (typeof value === 'string') { return value; }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Objects, arrays, functions and symbols all stringify to something useless
  // ('[object Object]'), which is what the user would see in the field.
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

function renderCell(value: unknown): { display: string; full: string; nullish: boolean } {
  if (value === null) { return { display: 'null', full: 'null', nullish: true }; }
  if (value === undefined) { return { display: 'undefined', full: 'undefined', nullish: true }; }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return {
      display: json.length > TRUNCATE_AT ? json.slice(0, TRUNCATE_AT) + '…' : json,
      full: json,
      nullish: false,
    };
  }
  // Objects and arrays took the JSON branch above, but `unknown` stays
  // `unknown` in the else, so narrow explicitly: a widened value reaching
  // String() would render as '[object Object]' in the table.
  const s = primitiveText(value);
  return {
    display: s.length > TRUNCATE_AT ? s.slice(0, TRUNCATE_AT) + '…' : s,
    full: s,
    nullish: false,
  };
}

/**
 * Generic tabular renderer for a row set + column list.
 *
 * Selection state is owned by the parent (passed in via
 * `selectedRowIndex`); the element emits `row-selected` /
 * `row-activated` / `row-context-menu` custom events the parent
 * listens to. No feature-specific code (attachments, etc.) — the
 * parent layers those on the events as needed.
 *
 * Event detail shape: `{ absIndex, row, rowJson, event? }`. `absIndex`
 * is computed by adding `pageOffset` to the visible row's local
 * index — so callers that page client-side can pass the offset and
 * receive absolute indices into the full row set.
 */
@customElement('ditto-result-table')
export class DittoResultTable extends LitElement {
  @property({ attribute: false }) rows: Record<string, unknown>[] = [];
  @property({ attribute: false }) columns: string[] = [];
  /** Absolute index into the FULL row set of the currently-selected
   *  row, or null when nothing is selected. */
  @property({ attribute: false }) selectedRowIndex: number | null = null;
  /** Optional offset applied when computing the "absolute" index in
   *  emitted events — used by callers that page client-side. */
  @property({ attribute: false }) pageOffset = 0;

  static override styles = css`
    :host { display: block; height: 100%; overflow: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      text-align: left;
      padding: 6px 8px;
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
      vertical-align: top;
    }
    th {
      background: var(--vscode-editorWidget-background);
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      font-size: 11px;
      position: sticky;
      top: 0;
    }
    td {
      font-family: var(--vscode-editor-font-family);
      max-width: 480px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    td.nullish {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    tbody tr { cursor: pointer; }
    tbody tr.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    tbody tr.selected td.nullish {
      color: var(--vscode-list-activeSelectionForeground);
    }
    .empty {
      padding: 48px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
  `;

  override render(): TemplateResult {
    if (this.rows.length === 0) {
      return html`<div class="empty">No rows.</div>`;
    }
    return html`
      <table>
        <thead>
          <tr>${this.columns.map(c => html`<th scope="col">${c}</th>`)}</tr>
        </thead>
        <tbody>
          ${this.rows.map((row, i) => {
            const abs = this.pageOffset + i;
            const isSelected = this.selectedRowIndex === abs;
            return html`
              <tr
                class=${isSelected ? 'selected' : ''}
                aria-selected=${isSelected ? 'true' : 'false'}
                @click=${() => this.emit('row-selected', abs, row)}
                @dblclick=${() => this.emit('row-activated', abs, row)}
                @contextmenu=${(e: MouseEvent) => {
                  e.preventDefault();
                  this.emit('row-context-menu', abs, row, e);
                }}
              >
                ${this.columns.map(c => {
                  const cell = renderCell(row[c]);
                  return html`<td class=${cell.nullish ? 'nullish' : ''} title=${cell.full}>${cell.display}</td>`;
                })}
              </tr>
            `;
          })}
        </tbody>
      </table>
    `;
  }

  private emit(name: string, absIndex: number, row: Record<string, unknown>, event?: MouseEvent): void {
    this.dispatchEvent(new CustomEvent(name, {
      detail: { absIndex, row, rowJson: JSON.stringify(row, null, 2), event },
      bubbles: true,
      composed: true,
    }));
  }
}
