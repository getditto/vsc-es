import { rm } from 'node:fs/promises';

/** Dispose of a scratch SDK store after its owner closes the instance. */
export async function removeSdkTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error: unknown) {
    // On Windows, native store handles can remain open until the test
    // process exits. Leave that scratch directory to OS temp cleanup.
    if (process.platform === 'win32' && error instanceof Error && 'code' in error
      && (error.code === 'EBUSY' || error.code === 'EPERM')) { return; }
    throw error;
  }
}
