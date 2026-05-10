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
    if (shouldHideInterface(name, addresses[0]?.internal === true)) { continue; }

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
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Whether to drop an interface from the displayed list entirely. The
 * panel is for "what real networks am I on" diagnostics; tunnel-style
 * pseudo-interfaces just clutter that:
 *
 *   - **loopback** (`internal: true`) — never used by Ditto for sync.
 *   - **utun\\*** — macOS VPN / hypervisor tunnels (Tailscale, Docker
 *     Desktop, VMware Fusion, etc.). They show up with their own
 *     IPs that aren't useful for "is my LAN reachable" questions.
 *   - **llw\\*** — macOS low-latency wireless (AWDL companion link
 *     used for Continuity / AirDrop). Always present on Apple
 *     Silicon, never relevant to the operator.
 *
 * Exported so the unit test can verify each filter rule.
 */
export function shouldHideInterface(name: string, internal: boolean): boolean {
  if (internal) { return true; }
  const n = name.toLowerCase();
  if (n.startsWith('utun')) { return true; }
  if (n.startsWith('llw')) { return true; }
  return false;
}

/**
 * Best-effort classifier for the interface name. We deliberately do
 * NOT try to split Wi-Fi from Ethernet — on macOS specifically, `en0`
 * could be either (it's Wi-Fi on a bare laptop but Ethernet when a
 * Thunderbolt dock is plugged in), and `os.networkInterfaces()`
 * doesn't give us the medium type. The single `'lan'` label also
 * matches the existing "LAN" umbrella our network graph uses for
 * the AccessPoint transport, which spans both physical mediums.
 *
 * Exported separately so the unit test can drive it directly without
 * pulling in `os.networkInterfaces()`.
 */
export function classifyInterface(name: string, internal: boolean): LocalNetworkInterface['kind'] {
  if (internal) { return 'loopback'; }
  const n = name.toLowerCase();
  // Any name pattern that's known to be a "real" network adapter on
  // any supported platform → LAN. Order doesn't matter because every
  // branch returns the same kind.
  if (n.startsWith('wlan') || n.startsWith('wlp') || n.startsWith('wifi') || n === 'wi-fi') {
    return 'lan';
  }
  if (n.startsWith('eth') || n.startsWith('eno') || n.startsWith('ens') || n.startsWith('enp')) {
    return 'lan';
  }
  if (n.startsWith('en')) {
    // macOS en0/en1/en2 — could be Wi-Fi or Ethernet via a dock;
    // either way it's LAN-traffic-capable for Ditto's purposes.
    return 'lan';
  }
  return 'other';
}
