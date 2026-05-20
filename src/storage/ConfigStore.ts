import type { StoredDittoConfig } from '../models/DittoConfig.js';

const STORAGE_KEY = 'dittoConfigs.v1';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

type Listener = () => void;

export class ConfigStore {
  private listeners = new Set<Listener>();

  constructor(private readonly memento: MementoLike) {}

  list(): StoredDittoConfig[] {
    return this.memento.get<StoredDittoConfig[]>(STORAGE_KEY) ?? [];
  }

  get(id: string): StoredDittoConfig | undefined {
    return this.list().find(c => c.id === id);
  }

  async save(config: StoredDittoConfig): Promise<void> {
    const list = this.list();
    // Reject duplicate databaseIds. Two configs pointing at the same Ditto
    // database can race for the working-directory lock and confuse users
    // about which local store is which. Mirrors how SwiftUI Edge Studio
    // treats each (name, databaseId) pair as unique. Empty databaseIds slip
    // through here — `DatabaseEditorPanel.validate()` blocks them earlier.
    const trimmed = config.databaseId.trim();
    if (trimmed) {
      const conflict = list.find(c => c.id !== config.id && c.databaseId.trim() === trimmed);
      if (conflict) {
        throw new Error(
          `A connection with Database ID "${trimmed}" already exists ("${conflict.name}"). ` +
          `Each connection must use a unique Database ID.`,
        );
      }
    }
    const idx = list.findIndex(c => c.id === config.id);
    if (idx >= 0) { list[idx] = config; } else { list.push(config); }
    await this.memento.update(STORAGE_KEY, list);
    this.fire();
  }

  async delete(id: string): Promise<void> {
    const list = this.list().filter(c => c.id !== id);
    await this.memento.update(STORAGE_KEY, list);
    this.fire();
  }

  onDidChange(listener: Listener): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private fire() {
    for (const l of this.listeners) { l(); }
  }
}
