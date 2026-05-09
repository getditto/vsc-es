import * as vscode from 'vscode';

export type OpenPanelKind = 'query' | 'peers';

const KEY_PREFIX = 'dittoOpenPanels.v1.';

export class OpenPanelsTracker {
  constructor(private readonly state: vscode.Memento) {}

  list(databaseId: string): OpenPanelKind[] {
    return this.state.get<OpenPanelKind[]>(KEY_PREFIX + databaseId) ?? [];
  }

  async add(databaseId: string, kind: OpenPanelKind): Promise<void> {
    const cur = this.list(databaseId);
    if (cur.includes(kind)) return;
    await this.state.update(KEY_PREFIX + databaseId, [...cur, kind]);
  }

  async remove(databaseId: string, kind: OpenPanelKind): Promise<void> {
    const cur = this.list(databaseId);
    if (!cur.includes(kind)) return;
    await this.state.update(KEY_PREFIX + databaseId, cur.filter(k => k !== kind));
  }

  async deleteAll(databaseId: string): Promise<void> {
    await this.state.update(KEY_PREFIX + databaseId, undefined);
  }
}
