# Subscriptions

Subscriptions tell Ditto **which documents to keep in sync** on this
device. A subscription is a saved DQL `SELECT` query — any document a
peer holds that matches the query will replicate to your local store
when that peer is reachable.

For the full conceptual reference see the Ditto docs on
[syncing data](https://docs.ditto.live/key-concepts/syncing-data#subscription-queries).

---

## Why subscriptions exist

Without a subscription, Ditto won't pull anything from peers — it's an
explicit opt-in. This is the right default: it keeps small devices
from accidentally drinking from a giant data firehose. You decide
exactly what each device needs.

The corollary: **a collection only appears in this app's tree once at
least one document for it lives in the local store.** That happens
either because you `INSERT`ed locally, or because a subscription
matched something a peer was holding.

---

## Writing a good subscription query

### Shape

Subscriptions don't support projections — they're "match these
documents, sync them," not "give me these fields." So the query is
almost always:

```sql
SELECT * FROM <collection>
```

…optionally narrowed with a
[`WHERE`](https://docs.ditto.live/dql/select#where) clause:

```sql
SELECT * FROM tasks WHERE deleted = false
SELECT * FROM messages WHERE roomId = 'team-engineering'
```

### Best practices

- **Filter aggressively.** Every document a subscription matches is
  pulled to the device, indexed locally, and counted against storage.
  A subscription that matches everything in a busy collection will
  swamp small devices.
- **Keep the predicate stable.** If your subscription's `WHERE` clause
  references something that changes often (e.g. a current-user id),
  that's fine — but avoid predicates that depend on values not yet on
  the device, since those will exclude documents until the predicate's
  state catches up.
- **One concept per subscription.** It's easier to reason about
  "tasks for this user" + "settings for this user" than one giant
  `OR`-laden query.

---

## Creating and managing subscriptions in this extension

The tree shows a **Subscriptions** parent node under each connected
database. Expand it to see your saved subscriptions; each row shows
the subscription's name and (when expanded) its DQL body.

### Create a new subscription

Click the **+** icon that appears on the **Subscriptions** row when
you hover. If your connection has both an HTTP API URL **and** an HTTP
API key set, the menu offers two choices:

- **New Subscription…** — a form that asks for a name and a DQL
  query. The name is just a label for the tree; the query is what
  drives the sync.
- **Import from Server…** — pulls every subscription known to your
  Ditto Server (via `SELECT * FROM __small_peer_info` over the REST
  API), filters out the ones you've already imported and any system
  collections, and lets you bulk-add them with a multi-select
  checklist. Useful when you're standing up a new device and want
  parity with what your peers are syncing.

If your connection has no HTTP credentials configured, clicking **+**
opens the New Subscription form directly (no menu).

You can also invoke either flow from the Command Palette:

- **Ditto: Import Subscriptions from Server…**

### Edit a subscription

Click the subscription's row in the tree. The form opens preloaded
with the current name and query. Save replaces the existing entry —
the in-memory subscription is cancelled and re-registered with the
SDK so the new query takes effect immediately.

You can also click the chevron next to a subscription to expand it
inline and read the query body without opening the editor.

### Delete a subscription

Right-click the subscription row in the tree and choose **Delete
Subscription**. The deletion immediately cancels the running
subscription and removes it from the saved list.

### Where subscriptions live

Saved subscriptions are persisted **per-database** in VS Code's
global state. Disconnecting and reconnecting preserves them; deleting
the connection wipes them with the rest of its per-DB state.

---

## After creating a subscription

The subscription is registered with the SDK immediately. As peers come
online with matching documents:

1. Documents start streaming into the local store.
2. The collection (if it didn't already exist locally) appears in the
   tree under **Collections**.
3. The collection's document count increments live as data arrives.

If you don't see anything appear, check the **Presence** panel — if
no peers are connected, there's nothing to pull from. The
subscription is still active and will pull as soon as a peer with
matching data is reachable.

---

## Quick reference

| You want to… | Action |
|--------------|--------|
| Add a hand-written subscription | Hover **Subscriptions** → **+** → *New Subscription…* |
| Bulk-import server-known subscriptions | Hover **Subscriptions** → **+** → *Import from Server…* (requires HTTP creds) |
| Edit an existing subscription | Click its row in the tree |
| See the DQL body without opening the editor | Click the chevron next to the subscription |
| Delete a subscription | Right-click the row → **Delete Subscription** |
| Find what subscriptions are syncing | Expand the **Subscriptions** parent in the tree |
