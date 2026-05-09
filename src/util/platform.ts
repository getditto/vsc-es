/**
 * Host-side runtime platform detection. Drives the per-OS transport-support
 * matrix consumed by `DittoManager.connect()` /
 * `DittoManager.applyTransportConfig()` and the peers webview's transport
 * configuration popover.
 *
 * NEVER import this module from a webview (`webview-ui/`) — it reads
 * `process.platform`, which is undefined in the browser-like webview
 * sandbox. Webviews receive the resolved `platform` + `support` fields via
 * the `peer.platformInit` IPC message.
 */
export type Platform = 'macos' | 'windows' | 'linux' | 'other';

export function detectPlatform(): Platform {
  switch (process.platform) {
    case 'darwin': return 'macos';
    case 'win32':  return 'windows';
    case 'linux':  return 'linux';
    default:       return 'other';
  }
}

export interface TransportSupport {
  lan: true;
  bluetoothLE: boolean;
  awdl: boolean;
}

/**
 * Per-OS transport support matrix. LAN is universally available; Bluetooth LE
 * is supported on macOS + Windows; AWDL is Apple-only.
 *
 * Used as a defensive gate in both connect() and applyTransportConfig() so
 * a synced/replicated config that asserts AWDL=true on a Linux runtime never
 * actually attempts to enable AWDL.
 */
export function transportSupportFor(p: Platform): TransportSupport {
  return {
    lan: true,
    bluetoothLE: p === 'macos' || p === 'windows',
    awdl: p === 'macos',
  };
}
