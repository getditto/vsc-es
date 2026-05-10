import * as vscode from 'vscode';

/**
 * Custom URI scheme used to attach count-badge decorations to tree
 * items. Setting `TreeItem.resourceUri` to a URI with this scheme
 * routes the row through {@link CountBadgeDecorationProvider}, which
 * emits a `FileDecoration.badge` rendered at the row's far right —
 * the only TreeView affordance that gives the chip-like, right-aligned
 * count look the user asked for (mirroring VS Code's Extensions panel).
 */
export const COUNT_BADGE_SCHEME = 'ditto-count';

/**
 * Build a synthetic resourceUri that encodes a `count` for a stable
 * `key`. The count is part of the URI's query so the URI changes when
 * the count changes — that lets VS Code re-fetch the decoration without
 * requiring us to fire `onDidChangeFileDecorations` manually.
 *
 * The scheme is intentionally not `file:` so VS Code's file context
 * menus (Reveal in Explorer, Open With…, …) won't appear on our rows.
 */
export function makeCountUri(key: string, count: number): vscode.Uri {
  return vscode.Uri.from({
    scheme: COUNT_BADGE_SCHEME,
    path: '/' + key,
    query: `count=${count}`,
  });
}

/**
 * Renders right-aligned count chips on tree rows whose `resourceUri`
 * uses the {@link COUNT_BADGE_SCHEME}.
 *
 * Badge text is capped at two characters (the documented `FileDecoration.badge`
 * limit). For counts above 99 the badge shows `99` and the tooltip carries
 * the actual number — VS Code will silently truncate longer strings, which
 * looks worse than an explicit cap.
 */
export class CountBadgeDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri, _token: vscode.CancellationToken): vscode.FileDecoration | undefined {
    if (uri.scheme !== COUNT_BADGE_SCHEME) { return undefined; }
    const params = new URLSearchParams(uri.query);
    const raw = params.get('count');
    if (raw === null) { return undefined; }
    const count = Number.parseInt(raw, 10);
    if (Number.isNaN(count) || count <= 0) { return undefined; }
    return {
      badge: count <= 99 ? String(count) : '99',
      tooltip: count > 99 ? `${count} (truncated to 99 in chip)` : String(count),
    };
  }
}
