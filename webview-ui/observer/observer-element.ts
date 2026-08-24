import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, HostMessages } from '../shared/messaging.js';
import { assertNever } from '../shared/assert-never.js';
import '../shared/json-viewer.js';
import '../shared/result-table-element.js';
import './events-table-element.js';
import type { ObserverEvent } from '../../src/ditto/ObserverEventStore.js';
import type { ObserverOut } from '../../src/ipc/messages.js';

/** Cap on rows rendered in the detail pane — matches the Query panel's
 *  page size. The event's full result set can be arbitrarily large. */
const DETAIL_ROW_CAP = 1000;

type DetailView = 'json' | 'table';
type EventFilter = 'items' | 'inserted' | 'updated';

/** Top-level Observer panel shell. Composes the toolbar, events
 *  table (top half), and detail pane (bottom half — JSON or table
 *  view of the selected event's data, optionally filtered to just
 *  inserted/updated rows).
 *
 *  The webview maintains its own bounded ring buffer of events so
 *  the host can drop messages liberally and the UI still scrolls
 *  smoothly during high-frequency change firehoses. Capacity must
 *  match `ObserverEventStore.capacity` so the two stay in lockstep
 *  on long sessions. */
@customElement('ditto-observer-panel')
export class DittoObserverPanel extends LitElement {
  @state() private observer = { id: '', name: '', query: '' };
  @state() private active = false;
  /** Bounded ring buffer mirroring the host's. Capacity must match
   *  `ObserverEventStore.capacity` (500). */
  @state() private events: ObserverEvent[] = [];
  @state() private selectedEventId: string | null = null;
  @state() private detailView: DetailView = 'json';
  @state() private eventFilter: EventFilter = 'items';
  @state() private selectedRowIndex: number | null = null;

  static readonly eventBufferCap = 500;

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .toolbar .title { font-weight: 600; }
    .toolbar .query { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); }
    .toolbar .spacer { flex: 1; }
    button {
      padding: 4px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font: inherit;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .panes { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .events-pane { flex: 1; min-height: 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .detail-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .detail-toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border);
    }
    .detail-body { flex: 1; min-height: 0; overflow: auto; }
    .empty { padding: 48px; text-align: center; color: var(--vscode-descriptionForeground); }
  `;

  /** Host-message subscription. The controller owns its own lifetime, so a
   *  re-attach cannot leave a second handler bound to the stale element. */
  readonly hostMessages = new HostMessages<ObserverOut>(this, msg => {
    switch (msg.type) {
      case 'observer.init':
        this.observer = msg.observer;
        break;
      case 'observer.statusChanged':
        this.active = msg.active;
        break;
      case 'observer.events':
        this.appendEvents(msg.events);
        break;
      case 'observer.cleared':
        this.events = [];
        this.selectedEventId = null;
        this.selectedRowIndex = null;
        this.detailCache = null;
        break;
      default:
        assertNever(msg);
    }
  });

  override render(): TemplateResult {
    const selectedEvent = this.selectedEventId
      ? this.events.find(e => e.id === this.selectedEventId) ?? null
      : null;
    return html`
      <div class="toolbar">
        <span class="title">${this.observer.name || 'Observer'}</span>
        <span class="query">${this.observer.query}</span>
        <span class="spacer"></span>
        ${this.active
          ? html`<button @click=${() => postToHost({ type: 'observer.stop' })}>■ Stop</button>`
          : html`<button class="primary" @click=${() => postToHost({ type: 'observer.activate' })}>▶ Activate</button>`}
      </div>
      <div class="panes">
        <div class="events-pane">
          <ditto-events-table
            .events=${this.events}
            .selectedEventId=${this.selectedEventId}
            @event-selected=${(e: CustomEvent<{ eventId: string | null }>) => this.onEventSelected(e.detail.eventId)}
          ></ditto-events-table>
        </div>
        <div class="detail-pane">
          ${selectedEvent ? this.renderDetail(selectedEvent) : html`
            <div class="empty">
              ${this.events.length === 0
                ? this.active ? 'Waiting for events…' : 'Activate the observer to start collecting events.'
                : 'Select an event above to inspect its data.'}
            </div>
          `}
        </div>
      </div>
    `;
  }

  /** Memoized detail-pane payload. Events are immutable once appended, so
   *  (eventId × filter) fully determines both the filtered rows and their
   *  JSON rendering. Without this cache every incoming event batch —
   *  arriving per 100ms flush during high-frequency sync — re-stringified
   *  the selected event even when the selection never changed. Same
   *  discipline as jsonDocCache in the Query panel. */
  private detailCache: {
    eventId: string;
    filter: EventFilter;
    data: Record<string, unknown>[];
    truncated: boolean;
    fullLength: number;
    json: string;
  } | null = null;

  private detailPayload(event: ObserverEvent) {
    const cache = this.detailCache;
    if (cache && cache.eventId === event.id && cache.filter === this.eventFilter) {
      return cache;
    }
    // Cap the rows rendered in the detail pane. The event's result set can
    // be arbitrarily large, and every incoming event batch re-renders this
    // pane — an uncapped JSON.stringify or table mount per batch is a
    // render firehose.
    const full = this.filterData(event);
    const truncated = full.length > DETAIL_ROW_CAP;
    const data = truncated ? full.slice(0, DETAIL_ROW_CAP) : full;
    const next = {
      eventId: event.id,
      filter: this.eventFilter,
      data,
      truncated,
      fullLength: full.length,
      json: JSON.stringify(data, null, 2),
    };
    this.detailCache = next;
    return next;
  }

  private renderDetail(event: ObserverEvent): TemplateResult {
    const { data, truncated, fullLength, json } = this.detailPayload(event);
    // The host ships at most OBSERVER_ROW_CAP rows per event (see
    // DittoManager.registerObserver); flag it when this event exceeded the cap.
    const hostCapped = event.totalRows > event.data.length;
    const columns = this.computeColumns(data);
    return html`
      <div class="detail-toolbar">
        <button
          class=${this.detailView === 'json' ? 'primary' : ''}
          @click=${() => { this.detailView = 'json'; }}
        >JSON</button>
        <button
          class=${this.detailView === 'table' ? 'primary' : ''}
          @click=${() => { this.detailView = 'table'; }}
        >Table</button>
        <span class="spacer"></span>
        <label style="font-size:11px; color: var(--vscode-descriptionForeground);">
          Filter
          <select
            .value=${this.eventFilter}
            @change=${(e: Event) => { this.eventFilter = (e.target as HTMLSelectElement).value as EventFilter; this.selectedRowIndex = null; }}
          >
            <option value="items">Items (${event.data.length})</option>
            <option value="inserted">Inserted (${event.insertions.length})</option>
            <option value="updated">Updated (${event.updates.length})</option>
          </select>
        </label>
      </div>
      <div class="detail-body">
        ${hostCapped ? html`
          <div style="padding:4px 8px; font-size:11px; color: var(--vscode-editorWarning-foreground, #cca700);">
            ⚠ showing first ${event.data.length.toLocaleString()} of ${event.totalRows.toLocaleString()} rows
          </div>
        ` : ''}
        ${truncated ? html`
          <div style="padding:4px 8px; font-size:11px; color: var(--vscode-editorWarning-foreground, #cca700);">
            ⚠ showing first ${DETAIL_ROW_CAP.toLocaleString()} of ${fullLength.toLocaleString()} rows
          </div>
        ` : ''}
        ${this.detailView === 'json'
          ? html`<json-viewer
              .value=${json}
              wrap
            ></json-viewer>`
          : html`<ditto-result-table
              .rows=${data}
              .columns=${columns}
              .selectedRowIndex=${this.selectedRowIndex}
              @row-selected=${(e: CustomEvent<{ absIndex: number; rowJson: string }>) => {
                this.selectedRowIndex = e.detail.absIndex;
                postToHost({ type: 'observer.rowSelected', rowJson: e.detail.rowJson });
              }}
            ></ditto-result-table>`}
      </div>
    `;
  }

  private onEventSelected(eventId: string | null): void {
    this.selectedEventId = eventId;
    this.selectedRowIndex = null;
    postToHost({ type: 'observer.eventSelected', eventId });
  }

  private filterData(event: ObserverEvent): Record<string, unknown>[] {
    if (this.eventFilter === 'items') { return event.data; }
    const indexes = this.eventFilter === 'inserted' ? event.insertions : event.updates;
    return indexes.map(i => event.data[i]).filter((v): v is Record<string, unknown> => v !== undefined);
  }

  private computeColumns(rows: Record<string, unknown>[]): string[] {
    const keys = new Set<string>();
    for (const r of rows) { for (const k of Object.keys(r)) { keys.add(k); } }
    const all = [...keys];
    const hasId = keys.has('_id');
    const sorted = all.filter(k => k !== '_id').sort();
    return hasId ? ['_id', ...sorted] : sorted;
  }

  private appendEvents(batch: ObserverEvent[]): void {
    if (batch.length === 0) { return; }
    const merged = this.events.concat(batch);
    if (merged.length > DittoObserverPanel.eventBufferCap) {
      this.events = merged.slice(merged.length - DittoObserverPanel.eventBufferCap);
    } else {
      this.events = merged;
    }
  }
}
