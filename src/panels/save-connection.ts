import type { SecretSet, StoredDittoConfig } from '../models/DittoConfig.js';

interface ConfigPersistence {
  get(id: string): StoredDittoConfig | undefined;
  save(config: StoredDittoConfig): Promise<void>;
  delete(id: string): Promise<void>;
}

interface SecretPersistence {
  read(id: string): Promise<SecretSet>;
  write(id: string, secrets: SecretSet): Promise<void>;
  deleteAll?(id: string): Promise<void>;
}

export async function deleteConnectionAtomically(
  configs: ConfigPersistence,
  secrets: SecretPersistence,
  id: string,
): Promise<void> {
  const previousConfig = configs.get(id);
  if (!previousConfig || !secrets.deleteAll) { throw new Error('Connection no longer exists.'); }
  const previousSecrets = await secrets.read(id);
  let secretDeleteAttempted = false;
  let configDeleteAttempted = false;
  try {
    secretDeleteAttempted = true;
    await secrets.deleteAll(id);
    configDeleteAttempted = true;
    await configs.delete(id);
  } catch {
    let rollbackFailed = false;
    if (configDeleteAttempted) {
      try { await configs.save(previousConfig); } catch { rollbackFailed = true; }
    }
    if (secretDeleteAttempted) {
      try { await secrets.write(id, previousSecrets); } catch { rollbackFailed = true; }
    }
    throw new ConnectionPersistenceError(rollbackFailed, 'deleted');
  }
}

export class ConnectionPersistenceError extends Error {
  /** `action` names the operation that failed so the message doesn't say
   *  "could not be saved" on the delete path. */
  constructor(readonly rollbackFailed: boolean, action: 'saved' | 'deleted') {
    super(rollbackFailed
      ? `Connection could not be ${action}, and some previous values could not be restored. Review the connection before retrying.`
      : `Connection could not be ${action}. Previous values were restored.`);
  }
}

export function assertEditorSaveIsCurrent(args: {
  expectedId: string;
  incomingId: string;
  editingExisting: boolean;
  baseline: StoredDittoConfig | undefined;
  current: StoredDittoConfig | undefined;
}): void {
  if (args.incomingId !== args.expectedId) {
    throw new Error('Connection identity changed unexpectedly. Close and reopen the editor.');
  }
  if (args.editingExisting && !args.current) {
    throw new Error('This connection was deleted while the editor was open. Reopen the database list before saving.');
  }
  if (!args.editingExisting && args.current) {
    throw new Error('A connection with this identity already exists. Close and reopen the editor.');
  }
  if (args.editingExisting && JSON.stringify(args.current) !== JSON.stringify(args.baseline)) {
    throw new Error('This connection changed while the editor was open. Close and reopen it before saving.');
  }
}

/** Coordinate ConfigStore and SecretStorage with best-effort compensating
 * rollback. Neither VS Code store supports a cross-store transaction. */
export async function saveConnectionAtomically(
  configs: ConfigPersistence,
  secrets: SecretPersistence,
  config: StoredDittoConfig,
  nextSecrets: SecretSet,
): Promise<void> {
  const previousConfig = configs.get(config.id);
  // Hoisted so the catch block restores a properly-typed value rather
  //  than asserting non-null on a declaration the compiler can't prove.
  let previousSecrets: SecretSet | undefined;
  let configWriteAttempted = false;
  let secretsWriteAttempted = false;

  try {
    previousSecrets = await secrets.read(config.id);
    configWriteAttempted = true;
    await configs.save(config);
    secretsWriteAttempted = true;
    await secrets.write(config.id, nextSecrets);
  } catch {
    let rollbackFailed = false;
    if (secretsWriteAttempted && previousSecrets !== undefined) {
      try { await secrets.write(config.id, previousSecrets); } catch { rollbackFailed = true; }
    }
    if (configWriteAttempted) {
      try {
        if (previousConfig) { await configs.save(previousConfig); }
        else { await configs.delete(config.id); }
      } catch { rollbackFailed = true; }
    }
    throw new ConnectionPersistenceError(rollbackFailed, 'saved');
  }
}
