# Observers

## What is an Observer?

An **Observer** registers a live DQL query against your local Ditto store. Whenever documents matching the query are inserted, updated, deleted, or reordered — whether the change came from a local write or a sync from a remote peer — the observer fires an event.

Use observers for:
- Watching a collection or filtered subset in real time as data flows in.
- Debugging sync behaviour by seeing exactly when and how documents arrive.
- Verifying that subscriptions are delivering the data you expect.

> Observers are **expensive**. Every active observer holds the SDK's
> attention, keeps result data materialised, and runs your diff
> calculation on every change. Activate observers only when you
> actually need to watch them, and stop them when you're done.

---

## Creating an Observer

1. Hover the **Observers** row under your database in the Connections tree and click the `＋` icon (or right-click → **New Observer…**).
2. Enter a descriptive **Name** and a DQL `SELECT` query.
3. Click **Save**.

The observer appears in the tree in an **inactive** state. No events are collected until you activate it.

> Observer queries must be `SELECT` statements. INSERT / UPDATE / DELETE / EVICT are rejected at save time.

---

## Activating an Observer

Click the observer row in the tree (or use the right-click context menu → **Open Observer**) to open the **Observer panel**. Click **▶ Activate** in the panel toolbar to start collecting events. Click **■ Stop** to cancel.

Activating an observer registers a live SDK observer with Ditto. Stopping it cancels the SDK observer and clears the panel's event buffer.

When you close the Observer panel, any running observer is stopped automatically — observers don't outlive their panel.

---

## Reading Events

The top half of the Observer panel is the **events table**. Each row is a single firing of the observer:

| Column | Meaning |
|---|---|
| **Time** | When the event was captured on this device (`HH:MM:SS.mmm`). |
| **Count** | How many documents the query matched at this firing. |
| **Inserted** | How many documents are new in this firing vs. the previous one. |
| **Updated** | How many existing documents changed. |
| **Deleted** | How many documents disappeared. |
| **Moves** | How many documents changed position in the result order. |

> The first firing always reports every document as an **Inserted** — that's the SDK's documented diff contract (there's no "previous" firing to compare against). Subsequent firings show real deltas.

The panel keeps the most recent **500 events**. Older events are dropped FIFO once the cap is reached. Click a row to inspect that event in the detail pane below.

---

## Inspecting an Event

Select an event in the events table — the bottom half of the panel reveals:

- A **JSON / Table** view toggle (mirrors the Query Editor's view toggle). JSON shows the documents pretty-printed; Table shows a flat row-per-document projection.
- A **Filter** dropdown that scopes the rendered documents:
  - **Items** — every document currently matching the query.
  - **Inserted** — only the documents new in this event.
  - **Updated** — only the documents changed in this event.

The selected row's full JSON also appears in the **Inspector** on the right — same JSON viewer + attachment detection as the Query Editor.

---

## Best Practices

- Use specific `WHERE` clauses to limit observer noise on large collections.
- Deactivate observers when you're not watching them.
- Pair observers with subscriptions: subscribe to a query so data syncs in, then observe to verify it arrived correctly.
- One observer per panel — there's no shared global registry. Closing the panel stops the observer.
