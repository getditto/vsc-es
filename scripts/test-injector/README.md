# Test injector (Ditto SDK 5.1)

A small, self-contained Ditto app for manually exercising the extension's
diagnostics features (Debug Console, `system:metrics`, Log Analyzer). Ported
from `memory-benchmarks-compare/injector/dittov5-node`, adapted so the repo
stays light: **no pre-generated data is committed** — only the document
schemas. Generate data on demand, sized by how long you want the injector to
run.

## Generate data

```sh
# Sized from intended injector run: 4 docs/s for 15 minutes = 3,600 docs
npm run injector:generate -- --collection=orders --rate=4 --duration=15m

# …or an explicit count
npm run injector:generate -- --collection=tasks --count=500 --seed=7
```

- Collections: `tasks` (tiny CRUD docs), `orders` (large nested QSR orders),
  `movies` (mflix-shaped). Shapes match the benchmarks' `datasets/` folder —
  the injector also accepts those NDJSON files directly via `--dataset`.
- Output: `scripts/test-injector/data/<collection>.ndjson` (+ a
  `<collection>.meta.json` in the benchmarks' meta format). The `data/` dir is
  gitignored.
- Generation is deterministic per `--seed`.

## Run the injector

```sh
npm run injector:run -- --collection=orders --rate=4 --duration=15m \
    --debug-socket=/tmp/ditto-injector-debug.sock --metrics
```

| flag | default | notes |
|---|---|---|
| `--collection` | `tasks` | which dataset (used to find `data/<collection>.ndjson`) |
| `--dataset` | — | explicit NDJSON path (e.g. a benchmarks dataset file) |
| `--rate` | `4` | inserts per second (paced with ns-resolution) |
| `--duration` | `15m` | accepts `ms`/`s`/`m`/`h` |
| `--skip` | `0` | resume partway into the dataset |
| `--work-dir` | `/tmp/ditto-injector` | the app's Ditto persistence dir |
| `--debug-socket` | off | sets `ALTER SYSTEM SET debug_socket` (SDK 5.1) |
| `--metrics` | off | enables the startup-gated `system:metrics` exporter in the injector process |
| `--database-id`, `--license` | repo-root `.env` | offline license is **optional** |

Without a license the app runs **local-only** (no `sync.start`) — all the
diagnostics features work either way. With a license it activates offline,
restricts the collection to `SmallPeersOnly`, starts LAN-only sync, and
subscribes — same topology as the benchmark injector.

After the injection window the process stays alive (when a debug socket or
license is active) so you can keep poking at it; Ctrl+C to exit.

## Validating the extension features with it

- **Debug Console** — run with `--debug-socket`, then in the Extension
  Development Host: `Ditto: Open Debug Console` → connect to the socket path →
  run `SELECT * FROM orders LIMIT 5`, a mutation, and an intentionally invalid
  statement. Full checklist: `docs/MANUAL_TESTING.md` recipe T23.
- **system:metrics** — run with `--metrics --debug-socket`, then from the Debug
  Console: `SELECT * FROM system:metrics WHERE key LIKE 'ditto.network.dsoq%'`.
- **Logs** — the SDK writes its (bounded, always-on) log collection to the
  injector's work dir; the 5.1 recovery/reset patterns in the Log Analyzer
  catalog match those lines when the underlying conditions occur.
