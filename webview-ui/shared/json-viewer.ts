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
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers, drawSelection, keymap } from '@codemirror/view';
import { foldGutter, syntaxHighlighting, HighlightStyle, foldKeymap } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { json } from '@codemirror/lang-json';

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

@customElement('json-viewer')
export class JsonViewer extends LitElement {
  /** The JSON string to display. Updates re-flow the document. */
  @property() value = '';

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
          }),
        ],
      }),
    });
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('value') && this.view) {
      const cur = this.view.state.doc.toString();
      if (cur !== this.value) {
        this.view.dispatch({
          changes: { from: 0, to: cur.length, insert: this.value },
        });
      }
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
