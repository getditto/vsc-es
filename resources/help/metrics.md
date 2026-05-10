# Query Metrics

The Query Metrics panel keeps a running history of every DQL query
you've executed in this connection, alongside its `EXPLAIN` plan.
Think of it as the **Metrics** tab in the Query Inspector, but for
every past run rather than only the most-recent one — useful for
comparing two versions of a query side-by-side, or for spotting why
a query that used to be fast got slow.

---

## How it works

- Every query you run in the Query Editor is automatically captured
  with its `EXPLAIN` plan.
- Up to **200 records** are kept per connection. When the buffer fills,
  the oldest record is dropped automatically — no maintenance required.
- History lives in memory only — it's lost on extension reload or
  when this connection is closed. The buffer is intentionally bounded
  and not persisted; a fresh session starts with a clean slate.
- History is **per connection** — switching databases doesn't mix
  histories, so a query you ran on `tasks-prod` won't show up in the
  metrics for `tasks-dev`.

---

## Reading the list

The left pane lists the most-recent query first. Each row shows:

| Element | Meaning |
|---------|---------|
| **Timestamp** | When the query ran (local time, including milliseconds when relevant). |
| **Location pill** | `Local` for queries that ran against the active SDK store, `HTTP` for queries that ran against the Ditto Server's REST API. **This is the key field for understanding latency variance** — a 20 ms vs. 200 ms gap on the same query is almost always "different transport," not regression. |
| **Latency pill** | Colour-coded — green under 50 ms, amber under 500 ms, red beyond. |
| **Index dot** | Green if `EXPLAIN` mentions an index; orange if the query did a full scan. The detection is a string match on the EXPLAIN output, so treat it as a strong hint rather than a guarantee. |
| **DQL preview** | The first two lines of the query, truncated. |

Click a row to load it into the detail pane on the right.

---

## The detail pane

For the selected record you'll see:

- **DQL** — the full query text.
- **Stat badges** — Time, Results, Index, **Location**, and the
  timestamp.
- **EXPLAIN** — the plan output, rendered through the same JSON viewer
  the Query Editor uses (fold gutters, word-wrap, syntax-highlight).

---

## Tips

- If two runs of the same query disagree on latency, compare their
  **Location** pills first. A Local run hits an in-process store; an
  HTTP run goes over the network and serialises everything — they're
  not the same measurement.
- If a query's **Index dot is orange**, consider whether a
  `CREATE INDEX` would help. The Indexes drill-in under each
  collection is the place to add one.
- **Clear** drops every record for the current connection. Useful
  before a clean demo run, or when you've been iterating and want to
  start measuring from a known baseline.
- For per-query advice (e.g. "this SELECT could use a LIMIT clause"),
  see the **Metrics** tab in the Query Inspector — it surfaces the
  same hints against the last-run query as you go.
