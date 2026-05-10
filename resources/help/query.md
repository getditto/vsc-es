# Query Editor

The Query Editor is where you read, write, and inspect data in a Ditto
database. It runs **Ditto Query Language (DQL)** — a SQL-like language
designed for the document store. For the full DQL spec see the official
[Ditto DQL reference](https://docs.ditto.live/dql/dql).

---

## Collections

Documents live in [collections](https://docs.ditto.live/key-concepts/apps-and-collections#collections).
A collection only appears in the tree once it has at least one document
locally — either because you
[`INSERT`](https://docs.ditto.live/dql/insert)ed one or because a
[Subscription](https://docs.ditto.live/key-concepts/syncing-data) pulled
it down from another peer.

---

## DQL primer

### [SELECT](https://docs.ditto.live/dql/select)

```sql
SELECT * FROM tasks
SELECT _id, title FROM tasks WHERE done = false
SELECT * FROM users WHERE age > 21 AND active = true
```

### [INSERT](https://docs.ditto.live/dql/insert)

```sql
INSERT INTO tasks DOCUMENTS ({ '_id': 'task1-1', 'title': 'New task', 'done': false })
```

### [UPDATE](https://docs.ditto.live/dql/update)

```sql
UPDATE tasks SET done = true WHERE _id = 'task1-1'
```

### [EVICT](https://docs.ditto.live/dql/evict)

Removes documents from the LOCAL store only — peers that still have
them will keep them. Useful for cleaning up data this device no longer
cares about without affecting the mesh.

```sql
EVICT FROM tasks WHERE deleted = true
```

### [DELETE](https://docs.ditto.live/dql/delete)

Removes documents from the entire mesh. Read the docs before using —
delete behavior with eventual consistency has nuances eviction doesn't.

---

## Execution modes

The **Run on** dropdown next to the Run button picks where the query
executes. The dropdown only appears when more than one mode is
available for this connection.

| Mode | Where it runs | Requires |
|------|---------------|----------|
| **Local** | The active SDK store on this device | Active connection |
| **HTTP** | The Ditto Server's REST API (`/api/v5/store/execute`) | HTTP API URL **and** HTTP API key set on the connection |

The Metrics tab shows **Location: Local Database** or **Location: HTTP**
above each result so a slow query reads as "different transport" rather
than "same query got slower."

A future release will add a third mode for the Ditto Edge Server REST
API.

---

## Query results

Results show below the editor in either of two views, switched with
the JSON / Table tabs above the results pane.

### JSON view

The default — full document syntax-highlighted by CodeMirror, with
fold gutters, line numbers, and word-wrap. Click anywhere inside a
top-level document to select that row.

### Table view

A flat tabular projection — one column per top-level field across all
result rows. Long values are truncated with the full value in a
hover tooltip. Click a row to select it.

### Pagination

Large result sets are paged client-side so 21,000-row queries don't
freeze the editor. The footer below the results shows:

- Total row count
- Page-size picker — `[10, 25, 50, 100, 200, 250, 1000]`, scaling
  with the result count
- `‹ Previous` / `Next ›` chevrons
- Current page indicator (`X of Y`)

Page changes are zero-IPC (the host sends the full row set once; the
webview re-slices). Picking a new page size keeps you anchored on the
first row of the page you were on.

---

## Selecting a row

- **Single click** on a Table row or anywhere inside a JSON document
  selects that row. The selection mirrors into the Inspector's JSON
  tab so you can see the full document with attachment detection.
- **Double click** is a stronger gesture — it selects AND switches the
  Inspector to the JSON tab. Use this when the Inspector is on
  History/Favorites/Metrics and you want to flip back to the document.

---

## Right-click on a row → Attachments

Right-click any row in either view to add or remove
[attachments](https://docs.ditto.live/dql/select#attachments) on that
document. Both flows require:

- An active connection (local mode)
- The last query is a single user collection (`SELECT … FROM <coll>`,
  not a join, not a system collection)
- The row has a string `_id`

### Add Attachment…

Walks you through native VS Code dialogs:

1. Pick a file. The picker is filtered by category — Images, Audio,
   Video, PDF, Text, Archives. Executable formats (`.exe`, `.bat`,
   `.sh`, `.msi`, `.app`, `.dmg`, `.pkg`) are intentionally excluded.
2. Files over **10 MB** show a soft warning before continuing; files
   over **20 MB** are refused.
3. Enter the field name on the document that will hold the attachment
   token. Must be a DQL identifier (letters, numbers, underscores).
4. The extension creates the attachment via
   `ditto.store.newAttachment(...)` and links it with
   `UPDATE <coll> SET <field> = :att WHERE _id = :docId`. The query
   re-runs automatically so the new field appears in the results.

### Delete Attachment…

Detects every attachment field on the row, presents a multi-select
QuickPick (with each field's filename + size + MIME), confirms with a
modal, then runs `UPDATE <coll> SET f1 = NULL, f2 = NULL WHERE _id = :id`.

> HTTP-mode upload is on the roadmap. Today both flows require an
> active SDK connection.

---

## Inspector

The Inspector lives in the auxiliary bar (right side). When the Query
Editor has focus the toolbar exposes five tabs:

| Tab | What it shows |
|-----|---------------|
| **History** | Every query you've run on this connection. Click to reload, right-click to favorite or delete. |
| **Favorites** | Queries you starred via the ★ Favorite button. |
| **JSON** | The full JSON of the currently-selected row, with attachment detection (see below). |
| **Metrics** | Last query's execution time, row count, run location, and EXPLAIN plan. |
| **Help** | This page. |

History and Favorites are persisted per-database and survive disconnect/
reconnect.

### JSON viewer + attachments

When you select a row, the Inspector's JSON tab renders the full
document AND scans it for attachment tokens (objects shaped like
`{id, len, metadata}`). For each one detected:

- A card appears below the JSON with the filename, size, and MIME type.
- **Fetch** downloads the attachment via `ditto.store.fetchAttachment`.
  For images it renders inline. For other types it offers a **Save…**
  button that writes the bytes to a path you choose.
- Failed fetches show the error inline; missing attachments (deleted
  remotely) report cleanly rather than spinning forever.

---

## Indexes

Indexes accelerate frequently-filtered queries. Available in Ditto
SDK v4.12+. (Note: subscription queries do **not** use indexes; only
ad-hoc queries do.)

### View existing indexes

```sql
SELECT * FROM system:indexes
```

### Create an index

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)
```

- Names must be unique per collection.
- One field per index — no composite indexes.
- Use `IF NOT EXISTS` to make repeat runs safe.

### Drop an index

```sql
DROP INDEX IF EXISTS idx_tasks_status ON tasks
```

### Multi-index query optimization

DQL v4.13+ supports **union** and **intersect** scans, so the
optimizer can combine multiple single-field indexes in one query:

```sql
-- Uses separate indexes on status and priority via union scan
SELECT * FROM tasks WHERE status = 'active' OR priority = 'high'
```

### Restrictions

- One field per index (no composites).
- Sub-field indexing requires an explicit index on the dotted path —
  `WHERE a.b = 1` needs `CREATE INDEX … ON coll (a.b)`.
- Functional predicates (`LOWER(field)`, `ILIKE`) bypass the index.
- The HTTP API does not support custom indexes.
- Only the latest data-type variant of a field is indexed.
