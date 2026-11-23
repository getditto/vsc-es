export const LOCAL_STORE_KEY_BYTES = 32;

/** Decode the canonical Base64 format used in SecretStorage. The caller clears valid bytes. */
export function decodeLocalStoreKey(encoded: string): Buffer | undefined {
  if (encoded.length !== 44) { return undefined; }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === LOCAL_STORE_KEY_BYTES && bytes.toString('base64') === encoded) { return bytes; }
  bytes.fill(0);
  return undefined;
}
