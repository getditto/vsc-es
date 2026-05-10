# Presence

The Presence panel surfaces Ditto's live mesh — every device this app
is currently aware of, the transports each connection is using, and
how data is flowing between them. This page explains what mesh
networking is, what the Presence API gives you, and how each piece of
this panel maps to those concepts.

---

## Mesh networking, briefly

Ditto isn't a client/server database. Every device running Ditto can
discover and talk to every other Ditto device on the same network or
within radio range, with or without internet access. The collection
of those devices is the **mesh**.

A few properties that fall out of being a mesh:

- **No single point of failure.** If the WiFi access point dies but
  the devices stay near each other, they keep syncing over Bluetooth
  LE or Apple's peer-to-peer WiFi (AWDL).
- **Multi-transport.** The same data can flow over LAN (WiFi/Ethernet),
  Bluetooth LE, AWDL/Wi-Fi Aware, or a WebSocket back to a Big Peer
  (Ditto Server). Each peer picks the best available path automatically.
- **Eventually consistent.** Two devices that lose contact and edit the
  same record will reconcile when they reconnect — no merge conflicts,
  no manual resolution.
- **Big Peers + Small Peers.** The Big Peer is the hosted Ditto Server
  in the cloud (paid tier). It joins the mesh over WebSocket and acts
  like any other peer, except it has high availability and can replicate
  your data into a managed store. Small Peers are the SDK-running
  devices (phones, laptops, embedded). A mesh can be all-Small-Peers
  (fully offline-capable) or include a Big Peer for cloud durability.

For the full primer see
<https://docs.ditto.live/key-concepts/mesh-networking>.

---

## The Presence API

Presence is the SDK feature that lets each peer **see who else is in
the mesh in real time**. When you observe presence, you get a
`PresenceGraph` containing:

- `localPeer` — info about this device (peer ID, device name, SDK
  language/version/platform).
- `remotePeers` — every other peer this device currently knows about,
  each with the list of `connections` it has open and the transports
  those connections use.

The graph is reactive — observers fire whenever a peer joins, leaves,
or reconfigures its links. The Presence panel below is a pretty UI on
top of that observer plus a second feed
(`SELECT * FROM system:data_sync_info`) that fills in cloud
(Big Peer / WebSocket) endpoints.

For deeper reading see
<https://docs.ditto.live/sdk/latest/sync/using-mesh-presence>.

---

## What you see in this panel

### Peers List

The **Peers List** tab is the canonical "who is connected?" view. Each
row is one peer, merged from two sources:

1. The local presence graph — the source of truth for direct
   peer-to-peer connections (LAN, Bluetooth LE, AWDL).
2. `system:data_sync_info` — surfaces sync sessions that don't appear
   in the presence graph, primarily the WebSocket session to a Big
   Peer / Ditto Server.

| Column | Description |
|--------|-------------|
| Device name | Human-readable identifier the peer reports |
| Transports | Active transport(s) on each connection |
| SDK | Language, version, and platform of the remote peer's SDK |
| Last update | Local commit ID the peer has synced up to |

A peer disappears from the list when it leaves the mesh (powered off,
moved out of range, network dropped). The Big Peer card disappears
when local sync is stopped.

### Presence Viewer

The **Presence Viewer** tab is the same data drawn as a graph: nodes
are peers, edges are connections, edge colors mirror the transport.
This is the easiest way to spot issues like one device being a hub for
all the others, or a connection silently downgrading from LAN to
Bluetooth.

> **About the "Direct Connected only" toggle**
>
> The toggle in the top-right of the graph defaults to **on** — only
> peers that have at least one direct edge to this device are shown,
> and only the spokes from this device are drawn. That's the readable
> view, and it's what you want 95% of the time.
>
> **Turning it off shows the full mesh — every peer the SDK knows
> about and every connection between every pair of them.** The rings
> auto-spread wider in this mode so chord lines have room to arc
> around the cluster rather than stab through it; you'll see the
> peers smoothly drift outward when you flip the toggle.
>
> Even with that spread, a fully-connected mesh of more than a handful
> of peers gets messy fast: you'll see a tangle of chord lines
> crossing each other. The layout engine does its best (BFS rings,
> parent-anchored placement, outward-arc chords, ring-expansion at the
> spread scale) but no algorithm can lay out a fully-connected mesh
> nicely. **It's not meant to look pretty** — it's meant to surface
> the underlying topology. Use this view to confirm "yes, there's a
> path between any two devices" or to diagnose silent partitions, not
> to take a screenshot for a slide deck.

### Local Network

The **Local Network** section reports what transports your machine
itself supports (LAN/mDNS, Bluetooth LE, AWDL/Wi-Fi Aware) — the OS
and hardware capabilities. This is informational; it doesn't change
what's running.

### Updating Transports (the cog icon)

The **cog** in the top-right of the Presence panel opens a popover
that lets you toggle individual transports — LAN, Bluetooth LE, and
AWDL — on the live connection. Use this to:

- Reproduce **fail-over behavior** (turn off LAN to verify your app
  still syncs over Bluetooth or WebSocket).
- Validate **firewall rules** for the transports you ship with.
- Test the user experience on a device that lacks one of the
  transports without changing your test device's hardware.

The change is applied with a soft cycle (sync stops → transport config
updates → sync restarts). You stay connected to the same database
throughout — no need to disconnect and reconnect manually.

### Start / Stop Sync

The button next to the cog stops or starts sync entirely. Useful for
testing what your app does when it's offline, or for taking a peer out
of the mesh without killing the process.
