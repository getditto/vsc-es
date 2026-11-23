import type { SecretSet } from '../models/DittoConfig.js';

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

const OPTIONAL_FIELDS = ['secretKey', 'httpApiKey', 'encryptionKey'] as const;
const FIELDS = ['token', ...OPTIONAL_FIELDS] as const;
type Field = typeof FIELDS[number];

function key(id: string, field: Field): string {
  return `ditto.${id}.${field}`;
}

export class SecretStore {
  constructor(private readonly secrets: SecretStorageLike) {}

  async read(id: string): Promise<SecretSet> {
    const out: SecretSet = { token: '' };
    out.token = (await this.secrets.get(key(id, 'token'))) ?? '';
    for (const field of OPTIONAL_FIELDS) {
      const value = await this.secrets.get(key(id, field));
      if (value !== undefined) { out[field] = value; }
    }
    return out;
  }

  async write(id: string, set: SecretSet): Promise<void> {
    await this.secrets.store(key(id, 'token'), set.token);
    for (const field of OPTIONAL_FIELDS) {
      const value = set[field];
      if (value) {
        await this.secrets.store(key(id, field), value);
      } else {
        await this.secrets.delete(key(id, field));
      }
    }
  }

  async deleteAll(id: string): Promise<void> {
    for (const f of FIELDS) {
      await this.secrets.delete(key(id, f));
    }
  }
}
