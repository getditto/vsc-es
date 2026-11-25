# Changelog

Full release notes for every version are on
[GitHub Releases](https://github.com/getditto/vsc-es/releases).

## 0.96.2

- Smaller extension package: it now contains only the files the extension
  runs, without development scripts or unused third-party sources.
- Adds a Marketplace icon, gallery banner, and this changelog.

## 0.96.1

- Clearer extension overview: capabilities, platform requirements, and limits
  up front, with three steps to get connected.
- Published under the `DittoLive` publisher ID. VS Code treats
  `DittoLive.ditto-vsce` as a separate extension from `ditto.ditto-vsce`;
  register your connections again in the new extension.

## 0.96.0

- Bundles Ditto SDK 5.3.0-rc.1.
- Optional local database encryption under **Advanced Configuration**.
- Support bundles, SDK log export, and query metrics and profiling updates.
- Sync and HTTP-mode queries now work against self-managed Ditto Servers that
  use plain HTTP.

## 0.9.5

- Embedded MCP server so AI agents can query and manage the active database
  (off by default, enabled per connection).
- System Metrics split out of Database Metrics into its own screen.
- Hardening across connections, panels, and observers.

## 0.9.0 and earlier

See [GitHub Releases](https://github.com/getditto/vsc-es/releases).
