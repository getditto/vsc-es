# Log Analyzer

## What is the Log Analyzer?

The **Log Analyzer** is your live triage tool for the connected database. It watches every log line the SDK emits and every log line the extension writes for this connection, scans them against a catalog of known problem patterns, and surfaces the results as severity-ranked counts, time-binned histograms, and a fully searchable virtualized table.

Use the Log Analyzer to answer:

- "Is anything wrong right now?"
- "What specifically is wrong, and what should I do about it?"
- "Did something spike at a particular time?"
- "Why are my connections so churny?"
- "Show me every error that contains this exact string."

The panel is scoped to the connection you opened it from. It opens from the **Log Analyzer** row in the per-database tree (between **Database Metrics** and the **Import** divider), and closes automatically when that database disconnects.

> The Log Analyzer is a **diagnostic tool**, not a source of truth. It reads the
> same on-disk log file the SDK and the extension write to; the file is the
> canonical record. Clear the in-memory view with the **Clear** button whenever
> you want a fresh slate without touching the file.

---

## Opening the Log Analyzer

1. Make sure the database is **connected** (status dot green).
2. Expand the database row in the **Ditto** sidebar.
3. Click **Log Analyzer** (between Database Metrics and the Import section).

The panel opens with the connection name in its tab title — `Log Analyzer — <connection name>`.

Each connection gets its own Log Analyzer panel. Opening the analyzer for the same connection a second time reveals the existing panel; opening it for a different connection at the same time gives that connection its own panel.

---

## Scope: what data the panel shows

When the panel opens, it backfills its view from the on-disk log file (`ditto-edge-studio.log` plus any rotated `.1` / `.2` … files), **filtered to lines after this database's most-recent connect time**. New live lines stream in continuously after that.

This is important: the analyzer does **not** show weeks of historical log content from previous extension sessions. If you've been using the extension for months, the rotating log file may contain millions of lines — only the slice that belongs to the connection you're currently looking at is surfaced.

If you disconnect and reconnect, the panel auto-closes and the next open starts fresh from the new connect time.

---

## The toolbar

Four controls along the top:

- **⏸ Pause** — stops the panel from updating. State still accumulates server-side; nothing is dropped. Use when an error storm makes the live table unreadable.
- **▶ Resume** — re-enables live updates and flushes whatever queued up while paused.
- **⨯ Clear** — wipes the in-memory state for this session: counts, problems, histograms, line buffer. The on-disk log file is **not** touched; closing and re-opening the panel will re-backfill the same data.
- **⚙ Patterns** — opens the **Manage Log Patterns** editor (a separate webview). Patterns are catalog-level rather than per-connection, so this editor is shared across all databases.

---

## Summary section

Top of the panel, collapsible. Updates at ~4 Hz while the panel is active. Three rows:

**Counts row**
- **Critical** — total lines that matched a severity-5 pattern (deadlock, query-too-big, crash signals)
- **Errors** — total `ERROR`-level lines
- **Warnings** — total `WARN`-level lines
- **Problems** — total pattern matches across all severities
- **Lines** — total processed lines (including info/debug/trace)

**SDK info row**
- **SDK** — the Ditto SDK version detected from the log stream
- **Tags** — distinct logger tags observed (e.g. `sdk`, `ext:DittoManager`, `ext:CollectionsRepository`)
- **Range** — time range from first to most-recent line in the buffer

Click the chevron to collapse the section and give the log table more space. Your collapsed/expanded preference persists for the lifetime of the panel.

---

## Histograms section

Three SVG charts, collapsible, all updated live:

### Log Volume by Level
Stacked bars per time bin. Bar height shows total log volume; the stack breaks out errors (red), warnings (amber), info (blue), and lower levels (grey). Bin width adapts to the session range — ~1 second for short sessions, up to 5 minutes for longer ones — so the chart always renders ~40 bars. Look here for "did something spike, and what kind?"

### Problems over Time
One bar per time bin, colored by the **maximum severity** in that bin (red for critical, amber for high, yellow for medium). Shares its time axis with the Log Volume chart so visual alignment shows whether a problem spike corresponded to a general log-volume spike or appeared on its own.

### Connection Durations
Log-scale horizontal bars summarizing how long each replication connection lasted before closing. Bins are `0–1s`, `1–5s`, `5–30s`, `30s–5m`, `5m+`. A healthy mesh shows most connections in the `5m+` bucket; a churny mesh concentrates in `0–1s` and `1–5s`. Populated from the SDK's `physical connection started` / `ended` log lines, paired by remote peer.

---

## Filter tabs

Below the histograms, five tabs with live count badges:

- **All** — every line in the buffer
- **Critical** — lines that matched any severity-5 pattern
- **Errors** — `ERROR`-level lines
- **Warnings** — `WARN`-level lines
- **Problems** — lines that matched any pattern (any severity)

Clicking a tab re-queries the service and updates the table. The count badges reflect what's currently in the buffer for each tab; they update live as new lines arrive.

---

## Search box

To the right of the filter tabs. Free-text, case-insensitive substring match. **Debounced 200 ms** — keep typing without each keystroke triggering a re-query.

Search runs against:
- The line's **message** (`text`)
- The line's **tag** (`sdk`, `ext:Foo`, …)
- Any **user tags** attached by a pattern's `user_tag` field (see Patterns help)

So typing `query` in Search will surface lines whose pattern attached a `query` user tag, even if the underlying message text doesn't contain the word.

The **shown / total** indicator next to the search box (e.g. `1,000 / 12,403`) tells you how much of the buffer matched and how much was paged. The table windows the first 1,000 matches; scroll-loading isn't yet wired, so refine your search or filter if you need to see older matches.

---

## Log table

Five columns, all but Message resizable via drag handles between headers:

| Column | What it shows |
|--------|---------------|
| **Timestamp** | `HH:MM:SS.mmm` from the line |
| **Level** | Color-coded — red ERROR, amber WARN, white INFO, dim DEBUG/TRACE |
| **Tag** | The logger tag — `sdk`, `ext:DittoManager`, etc. Blue chip |
| **User Tag** | Comma-separated labels attached by pattern `user_tag` fields. Purple chip. Empty when no labeled pattern matched |
| **Message** | The line body |

### Resizing columns
Hover the divider line between two headers — the cursor flips to `col-resize`. Drag left or right to resize. Minimum column width is 40 px (a column can't be dragged invisible). Widths persist for the lifetime of the panel.

### Virtualization
Only the visible window of rows is rendered into the DOM, with a small overscan. The table handles thousands of rows smoothly — scroll without lag. The buffer is capped at 50,000 lines total; older lines age out as new ones arrive.

### Clicking a row
Single-click any row to open the **line detail drawer** on the right side of the panel. Click another row to swap. Click the `×` on the drawer to close.

---

## Line detail drawer

The drawer slides in from the right when you click a row. It shows just the selected line, broken out into structured fields with clear dividers:

- **Timestamp** — full ISO 8601 (date + time + millis)
- **Level** — rendered as a colored pill
- **Tag** — rendered as a blue chip, or "(no tag)" if absent
- **User tags** — only shown if the line carries any pattern-attached labels; rendered as purple chips
- **Message** — monospace, full word-wrap, no truncation

The drawer is a flyout over the right edge of the panel; it doesn't push the table content. Click anywhere on a row to refresh the drawer with that line.

---

## Pattern-based problem detection

Every line the panel sees is scanned through a regex catalog. When a pattern matches, the line counts toward the **Problems** tab and contributes to the **Problems over Time** histogram.

Each pattern carries:
- A **severity** (1–5) that determines color in the histograms and ordering
- A **recommendation** string — human-readable advice surfaced where the problem is reported
- An optional **level filter** that scopes when the pattern fires
- An optional **tag filter** (regex against the existing tag) that further scopes by source
- An optional **user tag** that labels matching lines

The catalog is two-tiered:
- **Bundled patterns** ship with the extension (deadlocks, expired certs, OOM, query-too-big, auth failures, segfaults, …). Read-only.
- **User patterns** are your own. Add them in **Manage Log Patterns** (the ⚙ Patterns toolbar button).

See the Pattern Editor help (`patternEditor.html`) for full details on creating patterns.

---

## Lifecycle

- **Singleton per connection.** Re-clicking Log Analyzer on the same database reveals the existing panel.
- **Closes on disconnect.** When the database leaves the `active` lifecycle state, the panel auto-disposes. Reconnect produces a fresh view (counts, histograms, buffer all reset).
- **`retainContextWhenHidden`** — switching to another VS Code tab and back preserves your scroll position, search box contents, active filter tab, drawer state, and accordion collapse/expand state.

---

## Common workflows

**"Is anything wrong right now?"** → Look at the **Summary** counts. Non-zero Critical = look at the **Critical** tab. Non-zero Problems with zero Critical = look at the **Problems** tab.

**"Did something spike around 14:30?"** → Open the **Log Volume by Level** histogram. Look for the bar at that time. The colored stack tells you which level(s) spiked.

**"Show me every line that mentions `peer_abc`"** → Type `peer_abc` in Search. Filter stays on All so you see every level.

**"Filter the table to the recommendations the catalog flagged"** → Click the **Problems** tab. Each row will have a non-empty User Tag column if your patterns set `user_tag`.

**"What was the full message of this truncated row?"** → Click the row. The drawer shows the message with full word-wrap.

**"I want to label every query-engine log line and then filter by that label"** → Open **Manage Log Patterns**, add a pattern with regex `(?:creating\|deleting) DQL index\|statement aborts`, set `tag_filter` to `^sdk$`, set `user_tag` to `query`. Save. Type `query` in Search to see only those lines.

**"Pause while I read this error"** → Click ⏸ Pause. The table freezes. Read, then ▶ Resume.

**"My panel is stuck on stale state"** → Click ⨯ Clear. Counts reset. New lines stream in normally.

---

## Troubleshooting

**Counts are zero, panel is empty.** The database isn't currently in `active` state, or backfill hit an error. Check the Ditto Output Channel for messages tagged `ext:LogAnalyzerPanel`.

**Connection Durations histogram is empty.** No `physical connection` lines in this session yet. The SDK only emits them once it actually opens or closes a connection. Wait for sync traffic.

**The User Tag column is always empty.** You haven't added any user patterns with a `user_tag` value. Bundled patterns ship without user tags by design — open Manage Log Patterns and add one to start labeling.

**Search by user tag isn't matching.** The pattern with that `user_tag` may not be matching any lines. Open the Pattern Editor, find the pattern, paste a sample log line into the **Test line** field, and check whether ✓ Matches turns on.

**Pattern Editor doesn't show my custom patterns.** Check the `dittoVsce.logAnalyzer.customPatternsFile` setting — if it points at an unreadable path, the editor falls back to the default location. Look for a toast on first open.
