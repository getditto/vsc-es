import type { Logger } from '../logging/types.js';

interface SdkResource {
  close(): Promise<void>;
}

export async function closeSdkResource(resource: SdkResource, log: Logger): Promise<void> {
  try {
    await resource.close();
  } catch (err) {
    log.warn('SDK resource close failed', {
      resource: resource.constructor.name,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function withSdkResource<T extends SdkResource, R>(
  resource: T,
  log: Logger,
  use: (resource: T) => R | Promise<R>,
): Promise<R> {
  try {
    return await use(resource);
  } finally {
    await closeSdkResource(resource, log);
  }
}
