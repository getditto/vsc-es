import type { SecretSet } from '../models/DittoConfig.js';

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

const FIELDS = ['token', 'secretKey', 'httpApiKey'] as const;
type Field = typeof FIELDS[number];

function key(id: string, field: Field): string {
  return `ditto.${id}.${field}`;
}

export class SecretStore {
  constructor(private readonly secrets: SecretStorageLike) {}

  async read(id: string): Promise<SecretSet> {
    const out: SecretSet = { token: '' };
    out.token = (await this.secrets.get(key(id, 'token'))) ?? '';
    const sk = await this.secrets.get(key(id, 'secretKey'));
    const hk = await this.secrets.get(key(id, 'httpApiKey'));
    if (sk !== undefined) { out.secretKey = sk; }
    if (hk !== undefined) { out.httpApiKey = hk; }
    return out;
  }

  async write(id: string, set: SecretSet): Promise<void> {
    await this.secrets.store(key(id, 'token'), set.token);
    if (set.secretKey !== undefined && set.secretKey !== '') {
      await this.secrets.store(key(id, 'secretKey'), set.secretKey);
    } else {
      await this.secrets.delete(key(id, 'secretKey'));
    }
    if (set.httpApiKey !== undefined && set.httpApiKey !== '') {
      await this.secrets.store(key(id, 'httpApiKey'), set.httpApiKey);
    } else {
      await this.secrets.delete(key(id, 'httpApiKey'));
    }
  }

  async deleteAll(id: string): Promise<void> {
    for (const f of FIELDS) {
      await this.secrets.delete(key(id, f));
    }
  }
}
