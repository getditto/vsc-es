// src/util/local-network.ts
//
// Read-only local-network adapter probe. Wraps `os.networkInterfaces()`
// into the wire shape the Presence panel renders. We deliberately stay
// inside Node's stdlib — no shell-outs to `airport`/`iwconfig`/`netsh`
// and no native modules — so this works the same on every platform
// VS Code runs on, never prompts for permission, and doesn't take a
// dep on tools that come and go.
//
// What we surface is the strict subset SwiftUI's NetworkInterfaceInfo
// can be filled from `os.networkInterfaces()` alone:
//   - interface name + best-effort kind (Wi-Fi vs Ethernet vs other)
//   - MAC address
//   - IPv4 + CIDR (multiple if the interface is aliased / VPN'd)
//   - IPv6 + CIDR (link-local AND global)
//
// What's deliberately NOT here: SSID, BSSID, RSSI, channel, link
// speed, MTU, gateway. See docs/Developer.md for why.

import * as os from 'node:os';
import type { LocalNetworkInterface } from '../ipc/messages.js';

/**
 * Snapshot every "up" network interface on this machine. `os.network
 * Interfaces()` only lists interfaces that have at least one address,
 * so unconfigured / down interfaces are silently absent — that's
 * actually what we want.
 */
export function readLocalNetworkInterfaces(): LocalNetworkInterface[] {
  const raw = os.networkInterfaces();
  const out: LocalNetworkInterface[] = [];
  for (const [name, addresses] of Object.entries(raw)) {
    if (!addresses || addresses.length === 0) { continue; }

    let mac: string | undefined;
    const ipv4: { address: string; cidr: string }[] = [];
    const ipv6: { address: string; cidr: string; scopeid?: number }[] = [];

    for (const a of addresses) {
      // Some platforms report '00:00:00:00:00:00' for loopback / VPN;
      // we keep the first non-zero MAC and ignore the placeholders.
      if (!mac && a.mac && a.mac !== '00:00:00:00:00:00') { mac = a.mac; }
      const cidr = a.cidr ?? `${a.address}/${a.netmask}`;
      if (a.family === 'IPv4') {
        ipv4.push({ address: a.address, cidr });
      } else if (a.family === 'IPv6') {
        ipv6.push({ address: a.address, cidr, scopeid: a.scopeid });
      }
    }

    out.push({
      name,
      kind: classifyInterface(name, addresses[0]?.internal === true),
      mac,
      ipv4,
      ipv6,
    });
  }
  // Stable, predictable order for the UI: loopback last, then by
  // name. Ditto's transports never use loopback so the user usually
  // wants the real interfaces up top.
  out.sort((a, b) => {
    if (a.kind === 'loopback' && b.kind !== 'loopback') { return 1; }
    if (b.kind === 'loopback' && a.kind !== 'loopback') { return -1; }
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Best-effort guess of "Wi-Fi vs Ethernet vs other" from the interface
 * name. Loopback is detected via the `internal` flag on the address
 * struct. Everything else is name-pattern heuristics that work on the
 * common platforms and degrade gracefully (`other` is fine for the UI).
 *
 * Exported separately so the unit test can drive it directly without
 * pulling in `os.networkInterfaces()`.
 */
export function classifyInterface(name: string, internal: boolean): LocalNetworkInterface['kind'] {
  if (internal) { return 'loopback'; }
  const n = name.toLowerCase();
  // macOS: en0 is usually Wi-Fi on laptops, Ethernet on desktops.
  // We can't tell from the name alone, so we lean on *common* device
  // patterns and let `other` cover the cases where we can't be sure.
  if (n.startsWith('wlan') || n.startsWith('wlp') || n.startsWith('wifi') || n === 'wi-fi') {
    return 'wifi';
  }
  // Linux ethernet conventions are checked BEFORE the macOS en*
  // shortcut so that eno*/ens*/enp* (which all start with "en")
  // don't get misclassified as Wi-Fi on Linux running this code.
  if (n.startsWith('eth') || n.startsWith('eno') || n.startsWith('ens') || n.startsWith('enp')) {
    return 'ethernet';
  }
  if (n.startsWith('en')) {
    // On macOS en0/en1 are conventionally Wi-Fi on laptops; we mark
    // them as wifi to match SwiftUI's behaviour on that platform.
    if (process.platform === 'darwin') { return 'wifi'; }
    return 'ethernet';
  }
  return 'other';
}
