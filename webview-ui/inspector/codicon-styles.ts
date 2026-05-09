import { css } from 'lit';

/**
 * Codicon glyphs used by Inspector elements.
 *
 * The `@font-face` for `codicon` is registered at the document level by
 * `InspectorViewProvider.html()` via `<link rel="stylesheet" href="codicon.css">`,
 * which IS visible to shadow roots (fonts are document-global). However, the
 * `.codicon-*` class rules from that file DON'T cross shadow boundaries, so
 * each element that wants to render a glyph has to redeclare them locally.
 *
 * Mirrors the pattern in `webview-ui/peers/peers-element.ts`.
 */
export const codiconStyles = css`
  .codicon {
    font: normal normal normal 16px/1 codicon;
    display: inline-block;
    text-decoration: none;
    text-rendering: auto;
    text-align: center;
    text-transform: none;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    user-select: none;
  }
  .codicon-history::before      { content: '\\ea82'; }
  .codicon-clock::before        { content: '\\ea82'; }
  .codicon-star::before         { content: '\\ea6a'; }
  .codicon-json::before         { content: '\\eb0f'; }
  .codicon-dashboard::before    { content: '\\eacd'; }
  .codicon-question::before     { content: '\\eb32'; }
  .codicon-trash::before        { content: '\\ea81'; }
  .codicon-code::before         { content: '\\eac4'; }
  .codicon-file::before         { content: '\\ea7b'; }
  .codicon-chrome-close::before { content: '\\eab8'; }
`;
