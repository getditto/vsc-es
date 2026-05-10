/**
 * Per-installation user preferences for the Query Metrics inspector
 * — currently just one boolean, but factored as a store so the
 * "Reset Query Metrics Tips" command can talk to a single place and
 * future tips don't have to invent their own persistence.
 *
 * Stored in `globalState` (not workspaceState, not per-DB) because
 * the user explicitly asked for "I know what I'm doing" to apply
 * across every connection on this VS Code installation.
 */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const KEY_HIDE_LIMIT_HINT = 'dittoMetricsPrefs.v1.hideLimitHint';

export interface MetricsPreferences {
  /** True when the user has dismissed the LIMIT-clause suggestion. */
  hideLimitHint: boolean;
}

export class MetricsPreferencesStore {
  constructor(private readonly memento: MementoLike) {}

  /** Snapshot of the current preferences. Defaults each field to
   *  false so a fresh install sees the tip. */
  get(): MetricsPreferences {
    return {
      hideLimitHint: this.memento.get<boolean>(KEY_HIDE_LIMIT_HINT) ?? false,
    };
  }

  /** Flag the LIMIT hint as dismissed. Idempotent. */
  async dismissLimitHint(): Promise<void> {
    await this.memento.update(KEY_HIDE_LIMIT_HINT, true);
  }

  /** Re-enable every dismissed tip. Used by the
   *  "Ditto: Reset Query Metrics Tips" command so a developer who
   *  later wants the suggestion back doesn't have to clear extension
   *  storage. */
  async resetAll(): Promise<void> {
    await this.memento.update(KEY_HIDE_LIMIT_HINT, undefined);
  }
}
