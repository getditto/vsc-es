// webview-ui/shared/json-viewer.ts
//
// A read-only JSON viewer Lit element backed by CodeMirror 6.
// Features:
//   • JSON syntax highlighting (keys, strings, numbers, booleans, null)
//   • Fold gutter — click the chevrons in the gutter to collapse {} or []
//   • Line numbers
//   • VS Code theme colors via CSS custom properties
//
// Used by:
//   • <ditto-query-editor> JSON results view (renders all rows as a JSON array)
//   • <query-json-element>  Inspector JSON tab (renders the selected row)

import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { EditorState, Compartment, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { EditorView, lineNumbers, drawSelection, keymap, Decoration, type DecorationSet } from '@codemirror/view';
import { foldGutter, syntaxHighlighting, HighlightStyle, foldKeymap } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { json } from '@codemirror/lang-json';

/** A `[fromCharOffset, toCharOffset)` slice of the doc for one top-level item. */
export interface DocumentRange { from: number; to: number; }

/**
 * High-contrast JSON token colors tuned for VS Code's default dark theme.
 * Falls back to hard-coded hexes when the theme doesn't define the
 * matching `--vscode-*` token color variable, so readability is consistent
 * across themes (the CodeMirror `defaultHighlightStyle` was washed-out red
 * on a dark background and effectively unreadable).
 */
const dittoJsonHighlight = HighlightStyle.define([
  // object keys — light blue ("property" in VS Code dark+)
  { tag: t.propertyName, color: 'var(--vscode-symbolIcon-propertyForeground, #9cdcfe)' },
  // string values — orange/peach
  { tag: t.string,       color: 'var(--vscode-debugTokenExpression-string, #ce9178)' },
  // numbers — light green
  { tag: t.number,       color: 'var(--vscode-debugTokenExpression-number, #b5cea8)' },
  // booleans + null — blue keyword color
  { tag: t.bool,         color: 'var(--vscode-debugTokenExpression-boolean, #569cd6)', fontWeight: 'bold' },
  { tag: t.null,         color: 'var(--vscode-debugTokenExpression-boolean, #569cd6)', fontWeight: 'bold' },
  // structural punctuation — soft foreground
  { tag: t.punctuation,  color: 'var(--vscode-foreground)', opacity: '0.7' as unknown as string },
  { tag: t.bracket,      color: 'var(--vscode-foreground)', opacity: '0.85' as unknown as string },
]);

/** State effect: replace the currently-known document ranges. */
const setRanges = StateEffect.define<DocumentRange[]>();
/** State effect: replace the highlighted range index (-1 = none). */
const setSelectedIndex = StateEffect.define<number>();

const selectionField = StateField.define<{ ranges: DocumentRange[]; selected: number; deco: DecorationSet }>({
  create: () => ({ ranges: [], selected: -1, deco: Decoration.none }),
  update(prev, tr) {
    let { ranges, selected } = prev;
    for (const e of tr.effects) {
      if (e.is(setRanges)) ranges = e.value;
      if (e.is(setSelectedIndex)) selected = e.value;
    }
    if (ranges === prev.ranges && selected === prev.selected && !tr.docChanged) {
      return { ranges, selected, deco: prev.deco };
    }
    const builder = new RangeSetBuilder<Decoration>();
    if (selected >= 0 && selected < ranges.length) {
      const r = ranges[selected];
      const startLine = tr.state.doc.lineAt(Math.min(r.from, tr.state.doc.length)).number;
      const endLine = tr.state.doc.lineAt(Math.min(Math.max(r.to - 1, r.from), tr.state.doc.length)).number;
      for (let n = startLine; n <= endLine; n++) {
        const line = tr.state.doc.line(n);
        builder.add(line.from, line.from, Decoration.line({ class: 'cm-doc-selected' }));
      }
    }
    return { ranges, selected, deco: builder.finish() };
  },
  provide: f => EditorView.decorations.from(f, v => v.deco),
});

@customElement('json-viewer')
export class JsonViewer extends LitElement {
  /** The JSON string to display. Updates re-flow the document. */
  @property() value = '';

  /** Optional: clickable top-level item ranges. Each click within a range
   *  emits a `documentSelected` CustomEvent whose `detail.index` matches the
   *  position in this array. */
  @property({ attribute: false }) ranges: DocumentRange[] = [];

  /** Optional: index of the currently-highlighted range. -1 for none. */
  @property({ type: Number }) selectedIndex = -1;

  private view?: EditorView;
  private readonly readOnlyCompartment = new Compartment();

  // Render in light DOM so CodeMirror's own stylesheets and theming reach
  // the editor surface — its CSS-in-JS is global, not shadow-scoped.
  protected createRenderRoot(): HTMLElement {
    return this;
  }

  firstUpdated(): void {
    const host = this.querySelector('.cm-host') as HTMLElement | null;
    if (!host) { return; }
    const initialRanges = this.ranges;
    const initialSelected = this.selectedIndex;
    // If we're rendered inside a parent component's shadow root (which the
    // Query Editor and Inspector tabs do), CodeMirror needs to know — its
    // theme stylesheets are attached to the given root, and getSelection /
    // input handling need the shadow scope to work correctly.
    const rootNode = this.getRootNode();
    const rootOption: Document | ShadowRoot | undefined =
      rootNode instanceof ShadowRoot || rootNode instanceof Document ? rootNode : undefined;
    this.view = new EditorView({
      parent: host,
      root: rootOption,
      state: EditorState.create({
        doc: this.value,
        extensions: [
          // Minimal read-only setup — no autocomplete, search, history, brackets etc.
          lineNumbers(),
          foldGutter(),
          drawSelection(),
          syntaxHighlighting(dittoJsonHighlight),
          keymap.of(foldKeymap),
          json(),
          this.readOnlyCompartment.of(EditorState.readOnly.of(true)),
          selectionField,
          EditorView.domEventHandlers({
            click: (event, view) => {
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos == null) { return false; }
              const cur = view.state.field(selectionField).ranges;
              const idx = cur.findIndex(r => pos >= r.from && pos < r.to);
              if (idx < 0) { return false; }
              this.dispatchEvent(new CustomEvent('documentSelected', {
                detail: { index: idx },
                bubbles: true,
                composed: true,
              }));
              return false;
            },
          }),
          EditorView.theme({
            '&': {
              fontSize: '12px',
              backgroundColor: 'var(--vscode-editor-background)',
              color: 'var(--vscode-editor-foreground)',
            },
            '.cm-content': {
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              caretColor: 'transparent',
            },
            '.cm-gutters': {
              backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))',
              color: 'var(--vscode-editorLineNumber-foreground)',
              border: 'none',
            },
            '.cm-activeLine, .cm-activeLineGutter': {
              backgroundColor: 'transparent',
            },
            '.cm-foldPlaceholder': {
              color: 'var(--vscode-foreground)',
              backgroundColor: 'var(--vscode-editor-inactiveSelectionBackground)',
              border: 'none',
              borderRadius: '3px',
              padding: '0 4px',
            },
            // Selected-document highlight: a soft background plus a
            // left accent so the row of clicked JSON is unmistakable.
            '.cm-doc-selected': {
              backgroundColor: 'var(--vscode-list-activeSelectionBackground, rgba(80,140,200,0.18))',
              boxShadow: 'inset 3px 0 0 var(--vscode-focusBorder, #007acc)',
            },
          }),
        ],
      }),
    });
    // Apply any initial ranges/selection (the StateField was created empty).
    if (initialRanges.length > 0 || initialSelected >= 0) {
      this.view.dispatch({
        effects: [setRanges.of(initialRanges), setSelectedIndex.of(initialSelected)],
      });
    }
  }

  updated(changed: Map<string, unknown>): void {
    if (!this.view) { return; }
    const effects: StateEffect<unknown>[] = [];
    if (changed.has('value')) {
      const cur = this.view.state.doc.toString();
      if (cur !== this.value) {
        this.view.dispatch({
          changes: { from: 0, to: cur.length, insert: this.value },
        });
      }
    }
    if (changed.has('ranges')) {
      effects.push(setRanges.of(this.ranges));
    }
    if (changed.has('selectedIndex')) {
      effects.push(setSelectedIndex.of(this.selectedIndex));
    }
    if (effects.length > 0) {
      this.view.dispatch({ effects });
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.view?.destroy();
    this.view = undefined;
  }

  render() {
    return html`<div class="cm-host" style="height:100%;"></div>`;
  }
}
