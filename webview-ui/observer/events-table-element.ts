import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ObserverEvent } from '../../src/ditto/ObserverEventStore.js';

/** Compact events table for the top half of the Observer panel.
 *  Six columns: Time | Count | Inserted | Updated | Deleted | Moves.
 *  Mirrors the SwiftUI `ObserverEventsTableView` layout exactly so
 *  visual parity with the reference app holds. */
@customElement('ditto-events-table')
export class DittoEventsTable extends LitElement {
  @property({ attribute: false }) events: ObserverEvent[] = [];
  @property({ attribute: false }) selectedEventId: string | null = null;

  static override styles = css`
    :host { display: block; height: 100%; overflow: auto; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
    th { font-weight: 600; font-size: 11px; position: sticky; top: 0; background: var(--vscode-editorWidget-background); }
    tbody tr { cursor: pointer; }
    tbody tr.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .num { font-variant-numeric: tabular-nums; }
    .empty { padding: 48px; text-align: center; color: var(--vscode-descriptionForeground); }
    /* Diff-coloured count cells — match the Profile view's badge palette
     * so a user familiar with one panel reads the other intuitively. */
    .ins { color: var(--vscode-charts-green, #2ea043); }
    .upd { color: var(--vscode-charts-orange, #f57c00); }
    .del { color: var(--vscode-charts-red, #e53935); }
    .mov { color: var(--vscode-charts-purple, #8e24aa); }
  `;

  override render(): TemplateResult {
    if (this.events.length === 0) {
      return html`<div class="empty">No events yet. Activate the observer to start collecting.</div>`;
    }
    return html`
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Count</th>
            <th>Inserted</th>
            <th>Updated</th>
            <th>Deleted</th>
            <th>Moves</th>
          </tr>
        </thead>
        <tbody>
          ${this.events.map(e => html`
            <tr
              class=${this.selectedEventId === e.id ? 'selected' : ''}
              @click=${() => this.emitSelect(e.id)}
            >
              <td>${formatTime(e.eventTimeISO)}</td>
              <td class="num">${e.data.length}</td>
              <td class="num ins">${e.insertions.length}</td>
              <td class="num upd">${e.updates.length}</td>
              <td class="num del">${e.deletions.length}</td>
              <td class="num mov">${e.moves.length}</td>
            </tr>
          `)}
        </tbody>
      </table>
    `;
  }

  private emitSelect(id: string): void {
    const nextId = this.selectedEventId === id ? null : id;
    this.dispatchEvent(new CustomEvent('event-selected', {
      detail: { eventId: nextId },
      bubbles: true, composed: true,
    }));
  }
}

/** Render an ISO-8601 string as `HH:MM:SS.mmm` for the events table.
 *  Date portion is omitted because every event in a single panel
 *  session is from the same day in practice. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) { return iso; }
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
