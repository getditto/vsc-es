# Database Metrics

The Database Metrics panel breaks down **how much disk space this
connection is using and where** — same idea as the Storage view in the
SwiftUI Edge Studio app. This version skips OS-level metrics (CPU,
RAM, open file descriptors) because Node.js doesn't have a clean path
to them; everything here is storage.

The panel computes on demand only — open it (the first snapshot
auto-fetches), then click **Refresh** when you want fresh numbers.
Computing a snapshot walks the data directory and runs one query per
collection, which can take a few seconds on large databases.

---

## Where the data lives

Each connection has its own data directory on disk at
`<VS Code globalStorageUri>/dittoData/<connectionId>/`. The breakdown
walks every file in that tree and buckets each one by directory or
suffix.

## The on-disk categories

| Category | What it is | Why it might be big |
|----------|-----------|---------------------|
| **Store** | The primary SQLite document store. Grows with document count and field richness. | Lots of documents, lots of fields, large field values. |
| **Replication** | Sync state — what this peer has told other peers it has, and what it expects from them. | Many peers in the mesh; long-running sessions without a checkpoint. |
| **Attachments** | Binary blobs linked from documents. Stored as separate files outside the store. | Lots of attachments, or a few large ones. |
| **Auth** | Auth tokens and session material (`ditto_auth/` + `ditto_auth_tmp/`). | Usually tiny. If big, something's off. |
| **WAL / SHM** | SQLite write-ahead log (`*-wal`) + shared-memory file (`*-shm`). Spikes mid-transaction. | A WAL that won't shrink usually means a checkpoint hasn't run — heavy active writers. |
| **Logs** | SDK and extension log files (`ditto_logs/` plus stray `.log` / `.log.gz` files). | Long verbose-logging sessions. Safe to delete if you need disk back. |
| **Other** | Everything else: `ditto_metrics/`, `ditto_system_info/`, lock files. | Almost always small. |

The percentages and fill bars are relative to the **total on disk**
shown in the header.

---

## Collections by CBOR payload size

The bottom table lists every user collection in the database with:

- **Documents** — row count.
- **CBOR size** — the sum of `cborData().byteLength` across every row.
- **% of payload** — share of the total CBOR payload.

### Why CBOR, not JSON

CBOR is the on-the-wire sync format. The byte count therefore
approximates **what a fresh peer would have to pull down to replicate
this collection** — far more useful than the inflated JSON view for
capacity planning. It's also cheaper to compute than materialising
each row into a JavaScript object, so the scan is gentler on memory
for million-row collections.

### Sort

Click any column header to sort. Default is largest by CBOR size,
descending — so the collection most likely to be your problem child
is on top.

---

## Tips

- The **Store** bucket and the **total CBOR payload** are not the
  same number. Store is raw on-disk SQLite (including overhead and
  indexes); CBOR is the canonical document payload. Comparing the
  two tells you roughly how much overhead the store is adding.
- Big **WAL** usually means the writer hasn't checkpointed recently.
  Stopping sync and reopening the connection forces a checkpoint and
  reclaims the WAL.
- Big **Logs** is almost always safe to clear — they're for
  troubleshooting, not for data.
- **Big Other** is the unexpected one. If Other dominates, file an
  issue with the breakdown so we can teach the categoriser about
  whatever Ditto added.
