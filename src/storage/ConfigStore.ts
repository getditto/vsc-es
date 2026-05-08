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
