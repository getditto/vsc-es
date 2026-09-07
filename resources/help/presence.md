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

> **Finding a peer with the search box**
>
> The search box in the Presence Graph tab bar matches peers by device
> name or peer ID (case-insensitive). While a query is active, matching
> peers and their connections stay at full opacity and everything else
> is dimmed — the same treatment a click selection gives. Matches are
> listed in a card below the box; clicking one (or pressing **Enter**
> for the first hit) jumps the graph into the focused-neighbourhood
> view on that peer, switching **Direct Connected only** off if
> needed — exactly like clicking its pill in the full mesh. The query
> is kept so you can hop between results; **Escape** (anywhere in the
> panel) or clearing the box restores the normal graph.

> **The peer detail card**
>
> Tap a peer once in the full mesh (**Direct** off) to focus it, then
> tap any peer in the focus ring — including the focused peer itself
> or **Me** — to open its detail card. The card shows everything the
> presence graph API reports about that peer (peer key, OS, SDK
> version, Cloud link, compatibility, and metadata key counts), even
> for peers only reachable through other peers. Commit and last-update
> rows are the one exception: those come from a local sync table, so
> they exist only for directly connected peers — indirect peers say
> so explicitly, and **Me** explains that local sync isn't tracked.
> Tap the same peer again, press **Escape**, or click open canvas to
> close the card (the focus is kept); the banner ✕ exits focus and
> takes the card with it. When a card's peer isn't the focused one,
> **Focus this peer** moves the orbit to it.

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
