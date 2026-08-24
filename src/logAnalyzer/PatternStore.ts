import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { KeyedRawPattern } from './PatternEngine.js';

interface PatternStoreOptions {
  bundledPath: string;
  resolveUserPath: () => string;
  logger: { warn(m: string, ctx?: unknown): void; error(m: string, ctx?: unknown): void };
}

export class PatternStore {
  private bundled: KeyedRawPattern[] = [];
  private user: Map<string, KeyedRawPattern> = new Map();
  private bundledKeys = new Set<string>();
  private readonly emitter = new EventEmitter();

  constructor(private readonly opts: PatternStoreOptions) {}

  async load(): Promise<void> {
    this.bundled = await this.readBundled();
    this.bundledKeys = new Set(this.bundled.map(p => p.key));
    this.user = await this.readUser();
  }

  listAll(): { bundled: KeyedRawPattern[]; user: KeyedRawPattern[] } {
    return { bundled: this.bundled.slice(), user: [...this.user.values()] };
  }

  async add(p: KeyedRawPattern): Promise<void> {
    if (this.bundledKeys.has(p.key)) {
      throw new Error(`Key collides with bundled pattern: ${p.key}`);
    }
    this.user.set(p.key, p);
    await this.writeUser();
    this.emitter.emit('change');
  }

  async update(key: string, p: KeyedRawPattern): Promise<void> {
    if (this.bundledKeys.has(p.key)) {
      throw new Error(`Cannot rename to a bundled key: ${p.key}`);
    }
    this.user.delete(key);
    this.user.set(p.key, p);
    await this.writeUser();
    this.emitter.emit('change');
  }

  async delete(key: string): Promise<void> {
    if (this.bundledKeys.has(key)) {
      throw new Error(`Cannot delete bundled pattern: ${key}`);
    }
    this.user.delete(key);
    await this.writeUser();
    this.emitter.emit('change');
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.emitter.on('change', listener);
    return { dispose: () => this.emitter.off('change', listener) };
  }

  /** Parse a patterns file into key→pattern pairs, validating the store
   *  boundary: the document must be an object and each entry must be an
   *  object — otherwise `{key, ...p}` would silently spread garbage (a
   *  string entry, say, becomes `{key, 0: 's', 1: 't', …}`). Malformed
   *  entries are skipped with a warn; syntactically invalid JSON still
   *  throws, which readUser catches and readBundled propagates, exactly as
   *  before. */
  private parsePatternFile(raw: string, source: string): [string, KeyedRawPattern][] {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      this.opts.logger.warn(`PatternStore: ${source} file is not an object; ignoring`);
      return [];
    }
    const out: [string, KeyedRawPattern][] = [];
    for (const [key, p] of Object.entries(obj)) {
      if (typeof p !== 'object' || p === null || Array.isArray(p)) {
        this.opts.logger.warn(`PatternStore: skipping malformed entry '${key}' in ${source} file`);
        continue;
      }
      out.push([key, { key, ...(p as Omit<KeyedRawPattern, 'key'>) }]);
    }
    return out;
  }

  private async readBundled(): Promise<KeyedRawPattern[]> {
    const raw = await fs.readFile(this.opts.bundledPath, 'utf8');
    return this.parsePatternFile(raw, 'bundled').map(([, p]) => p);
  }

  private async readUser(): Promise<Map<string, KeyedRawPattern>> {
    const userPath = this.opts.resolveUserPath();
    try {
      const raw = await fs.readFile(userPath, 'utf8');
      return new Map(this.parsePatternFile(raw, 'user'));
    } catch (err: unknown) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== 'ENOENT') {
        this.opts.logger.warn('PatternStore: user file invalid; using empty', { err: String(err) });
      }
      return new Map();
    }
  }

  private async writeUser(): Promise<void> {
    const userPath = this.opts.resolveUserPath();
    await fs.mkdir(path.dirname(userPath), { recursive: true });
    const obj: Record<string, Omit<KeyedRawPattern, 'key'>> = {};
    for (const [key, p] of this.user) {
      const { key: _k, ...rest } = p;
      obj[key] = rest;
    }
    await fs.writeFile(userPath, JSON.stringify(obj, null, 2), 'utf8');
  }
}
