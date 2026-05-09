import type { Logger } from './types.js';

/**
 * Subset of the `@dittolive/ditto` `Logger` static surface that we depend on.
 *
 * IMPORTANT: `customLogCallback` is a *getter-only* static on the real SDK —
 * assigning to it directly (`Logger.customLogCallback = …`) throws TypeError
 * in strict mode. The proper setter is `setCustomLogCallback(callback)`.
 * Our test (`sdk-bridge.test.ts`) pins this contract.
 */
export interface DittoLoggerModule {
  setCustomLogCallback(
    callback?: (sdkLevel: string, message: string) => void,
  ): unknown;
}

const SDK_TO_HOST: Record<string, 'error' | 'warn' | 'info' | 'debug' | 'trace'> = {
  Error: 'error',
  Warning: 'warn',
  Info: 'info',
  Debug: 'debug',
  Verbose: 'trace',
};

/**
 * Wires the Ditto SDK's log stream into our host-side Logger under the caller's
 * tag. Translates the SDK's verbiage (`'Warning'`, `'Verbose'`) into our host
 * verbiage (`'warn'`, `'trace'`).
 *
 * Always uses `setCustomLogCallback` — never assigns to the getter-only
 * `customLogCallback` static. See `DittoLoggerModule` doc above.
 */
export function attachSdkLogBridge(
  dittoLogger: DittoLoggerModule,
  sdkLog: Logger,
): void {
  dittoLogger.setCustomLogCallback((sdkLevel, message) => {
    const level = SDK_TO_HOST[sdkLevel] ?? 'info';
    sdkLog[level](message);
  });
}
