# Manage Log Patterns

## What is the Pattern Editor?

The **Pattern Editor** manages the regex catalog the **Log Analyzer** scans against. When a pattern matches a log line, the line counts toward the Problems tab, contributes to the Problems-over-Time histogram, and (if you set a User Tag) is labeled in the log table.

Two kinds of patterns coexist:

- **Bundled patterns** — ship with the extension. Deadlocks, expired certificates, OOM kills, query-too-big, auth failures, segfaults. These are the known signatures the Ditto team curates. Listed in the editor with a 🔒 lock icon. **Read-only** — no edit or delete.
- **User patterns** — your own. Full add / edit / delete. Persist to a JSON file on disk; survive extension reloads, reconnects, and platform updates.

The editor is **global** (not per-database) — patterns apply to whichever Log Analyzer panel is currently open. Opening this editor doesn't require an active connection.

---

## Opening the editor

Two paths:

- **From the Log Analyzer toolbar** — click **⚙ Patterns**
- **From the global Logging sidebar** — click **Manage Log Patterns**

Either opens the same singleton webview. Re-clicking reveals the existing panel.

---

## The pattern list

Two stacked sections:

### Bundled (read-only)
Every catalog entry that shipped with the extension. Each row shows:
- 🔒 lock icon
- Pattern **key** (e.g. `deadlock_critical`)
- **Severity** badge
- Pattern preview (regex)

No edit/delete buttons. The bundled catalog updates via extension releases.

### User patterns
Your additions. Each row shows the same fields as bundled, plus:
- **Edit** button — loads the pattern into the form
- **Delete** button — removes after a confirm

If you've never added a user pattern, the section says **"None yet. Use the Add Pattern button above."**

---

## Adding a pattern

Click **+ Add Pattern** in the top-right of the editor. A form panel slides in. Fill out the fields and click **Save**.

### Form fields

#### Key (required)
A unique identifier for the pattern. Letters, numbers, underscores. Conventionally `lowercase_snake_case`.

- Must be unique across **all** patterns (bundled + user). Trying to use a bundled key blocks save with "Collides with bundled key."
- When editing an existing user pattern, the key can stay the same.

Examples: `query_engine_activity`, `my_custom_error`, `slow_save_warning`.

#### Pattern (required)
A JavaScript regular expression matched against the line's **message body** (the text after the tag prefix). Case-insensitive flag is added automatically — don't write `(?i)`.

- Live-validated as you type. Invalid syntax shows the parser error inline; the Save button stays disabled until the regex compiles.
- Anchors (`^` `$`) match the start/end of the line's message body, not the raw log line.
- Regex special characters need backslash escaping: `\\.`, `\\(`, `\\?`, etc.

Examples:
- `deadlock|write transaction.*elapsed` — match either word
- `Query too big\\. It exceeded the server's size limit of [\\d.]+ [A-Z]+` — exact phrase with a number
- `^reconnect attempt \\d+` — only when the message *starts* with this

#### Severity (required)
1 to 5. Determines color and ordering throughout the analyzer:

| Severity | Color | Use for |
|----------|-------|---------|
| **5** | Red (CRITICAL) | Deadlocks, crashes, fatal failures |
| **4** | Red (HIGH) | Recoverable errors that need attention |
| **3** | Amber (MEDIUM) | Warnings that may or may not matter |
| **2** | Blue (LOW) | Informational, but worth tracking |
| **1** | Grey (INFO) | Lifecycle events, audit trail |

#### Recommendation (required)
Human-readable advice surfaced wherever this pattern's matches appear (the Problems list, the line detail drawer, etc.). Write it as actionable guidance — what should the reader do?

**Patterns with an empty recommendation are silently dropped.** This is by design — the catalog is intentionally a signal/noise filter, and an un-actionable match isn't worth surfacing.

Good examples:
- *"Transaction blocked for an extended period at ERROR level. Possible deadlock or system issue."*
- *"Peers in the mesh have expired certificates. Check device clocks."*
- *"Query exceeded the server's size limit. Replication has been disabled. Add more selective filters or split the query."*

Bad examples:
- *"This is a deadlock"* (no action)
- *"Check the logs"* (too vague)

#### Level filter (optional, exact match)
Restricts the pattern to fire only on lines at exactly this level. Useful for tiered patterns where the same regex should mean different things at different severities:

- `deadlock_critical` uses `level_filter: error` — only fires on ERROR lines
- `deadlock_warning` uses `level_filter: warn` — only fires on WARN lines

Both can share similar regexes; the level filter keeps them mutually exclusive. Leave blank to match any level.

#### Tag filter (optional)
A regex matched against the line's **existing** tag — the one written by the logger (`sdk`, `ext:DittoManager`, `ext:CollectionsRepository`, etc.). Scopes *when* the pattern fires; it does **not** apply a label.

| Common pattern | Scopes to |
|----------------|-----------|
| `^sdk$` | Only lines from the Ditto SDK |
| `^ext:` | Only lines from extension subsystems |
| `^ext:DittoManager$` | Only lines from the DittoManager |

Leave blank to match any tag.

#### User tag (optional)
A label **applied to** every line this pattern matches. Distinct from the Tag filter above:

| Field | What it does |
|-------|---------|
| **Tag filter** | Matches against the line's existing tag (scopes when the pattern fires) |
| **User tag** | Writes a tag onto matching lines (for filtering / grouping) |

User tags surface in two places in the Log Analyzer:
1. The **User Tag column** in the log table — comma-separated chips
2. The **search box's haystack** — typing the user tag in Search filters to lines that carry it

This is how you add semantic categories to your logs. Examples:

- `user_tag: query` on a pattern that catches DQL index lifecycle + statement aborts. Type `query` in Search to see only query-engine activity.
- `user_tag: auth` on a pattern that catches token exchange + login failures.
- `user_tag: sync` on a pattern that catches replication state transitions.

Multiple patterns can label the same line — each pattern contributes its tag, and the resulting list is sorted and deduped. So a line that matches both your `query` and your `slow` patterns will show **`query, slow`** in the User Tag column.

Leave blank for no label.

#### Test line
Paste a sample log line. The form runs your regex against it live and shows ✓ Matches or ✗ No match. Useful for catching escape errors (forgot to escape a `.`?) without saving and waiting for live data.

---

## Editing a pattern

Click the **Edit** button on any user pattern. The form opens prefilled with that pattern's values. Make your changes and click **Save**.

The catalog hot-reloads — any open Log Analyzer panel picks up the change immediately without disconnect/reconnect.

---

## Deleting a pattern

Click the **Delete** button on any user pattern. The pattern is removed from the JSON file and the catalog reloads.

You **cannot delete bundled patterns** — the editor has no delete affordance on them, and the backing store rejects the operation server-side as defense-in-depth.

---

## Storage

User patterns live in a single JSON file:

```
<globalStorage>/log-analyzer/user_patterns.json
```

The setting **`dittoVsce.logAnalyzer.customPatternsFile`** lets you point at a different path:

```json
"dittoVsce.logAnalyzer.customPatternsFile": "${workspaceFolder}/.ditto/log-patterns.json"
```

Useful for:
- Sharing patterns across a team via version control
- Keeping different sets per project/workspace
- Backing up your catalog

On-disk format is identical to the bundled catalog:

```json
{
  "query_engine_activity": {
    "pattern": "(?:creating|deleting) DQL index|statement aborts",
    "severity": 2,
    "recommendation": "DQL engine event — index lifecycle or statement abort. Useful for tracing query planner work or interruptions.",
    "tag_filter": "^sdk$",
    "user_tag": "query"
  }
}
```

Power users can edit the file by hand — the editor reads it back correctly. The catalog watches for external file changes and hot-reloads.

---

## What happens when you save

1. Form validation runs — regex compiles, all required fields present, key doesn't collide with bundled
2. The pattern is written to `user_patterns.json` (creating the directory if missing)
3. The PatternStore fires a change event
4. The PatternEngine reloads its compiled catalog
5. Any open Log Analyzer panel re-issues its query — new pattern matches appear immediately

Failures (filesystem locked, JSON encoding error, etc.) surface inline at the top of the editor with the OS-level error message. Your form contents are preserved so you don't lose edits.

---

## Common workflows

**"I want to label every query-engine log line and then filter by that label"**
1. Click **+ Add Pattern**
2. Key: `query_engine_activity`
3. Pattern: `(?:creating|deleting) DQL index|DQL engine|statement aborts`
4. Severity: `2`
5. Recommendation: *"DQL engine event — index lifecycle or statement abort. Useful for tracing query planner work or interruptions."*
6. Tag filter: `^sdk$` (these all come from the SDK)
7. User tag: `query`
8. Save
9. Open the Log Analyzer, type `query` in Search → see only the labeled lines

**"My custom OOM message isn't being caught"**
1. Click **+ Add Pattern**
2. Key: `my_custom_oom`
3. Pattern: `Killed process .* \\(my-process-name\\)` (escape parens)
4. Severity: `4`
5. Paste a sample line into **Test line** to verify ✓ Matches
6. Recommendation: *"Process was killed by the OOM killer. Investigate memory pressure."*
7. Save

**"I want to update a bundled pattern's wording"**
You can't edit bundled patterns directly. But you CAN add a user pattern with a **more specific** regex that matches the same lines — the bundled pattern still fires, but your version provides a more contextual recommendation in the Problems list.

**"Share my catalog with my team"**
1. Set `dittoVsce.logAnalyzer.customPatternsFile` in workspace settings to `${workspaceFolder}/.ditto/log-patterns.json`
2. Commit `.ditto/log-patterns.json` to your repo
3. Teammates pick up the same setting from `.vscode/settings.json` and get the same catalog

---

## Troubleshooting

**The pattern doesn't fire when I expect it to.** Use the **Test line** field with a sample line from your logs. If it shows ✗ No match, the regex needs work. Common gotchas:
- Regex special characters need escaping: `\\.` not `.`, `\\(` not `(`
- The Tag filter has to match the line's existing tag — `^sdk$` won't match `[ext:Foo]`
- The Level filter is exact — `error` won't match WARN lines

**My pattern fires on too many lines.** Tighten the regex with anchors or more specific keywords. Use Tag filter to scope to a single subsystem. Check with the Test line field that lines you don't want to catch return ✗.

**Save is disabled.** Look at the inline errors:
- "Collides with bundled key" — pick a different key
- Regex compile error shown under Pattern — fix the regex
- Empty key, pattern, or recommendation — fill in the required fields

**My pattern file is invalid JSON.** The editor falls back to the bundled catalog and surfaces a toast with the error. Fix the file by hand or delete it; the editor will recreate from your next add.

**Patterns aren't loading from my custom path.** Double-check the path in `dittoVsce.logAnalyzer.customPatternsFile`. Variable substitution like `${workspaceFolder}` is supported. The file path needs to be readable + writable by VS Code; an unreadable file falls back to the default location.
