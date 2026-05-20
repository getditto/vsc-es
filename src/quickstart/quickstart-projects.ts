/**
 * Single source of truth for what we know about the upstream
 * `getditto/quickstart` repo. Update here when the repo restructures
 * or adds a new per-project .env destination.
 *
 * Mirrors SwiftUI Edge Studio's `QuickstartDownloadService.swift`
 * — keep the two lists in sync when upstream changes.
 */

export interface QuickstartProject {
  /** Directory name in the cloned repo. */
  readonly directoryName: string;
  /** Human-readable label for UI surfaces. */
  readonly displayName: string;
}

export const QUICKSTART_REPO_URL = 'https://github.com/getditto/quickstart.git';

/** Default sub-directory name produced by `git clone <repo>` with no rename. */
export const QUICKSTART_FOLDER_NAME = 'quickstart';

/**
 * Relative paths (from the cloned repo root) where we write `.env`.
 * Hard-coded to match SwiftUI exactly — see design doc § ".env destinations".
 */
export const ENV_DESTINATIONS: readonly string[] = [
  '.env',
  'flutter_app/.env',
  'go-tui/.env',
];

/** Subfolder containing the Edge Server YAML; only configured when present. */
export const EDGE_SERVER_RELATIVE_DIR = 'edge-server';
export const EDGE_SERVER_YAML_NAME = 'quickstart_config.yaml';

/** Hard-coded project list, sorted by displayName for deterministic UI. */
export const QUICKSTART_PROJECTS: readonly QuickstartProject[] = [
  { directoryName: 'android-java',          displayName: 'Android Java' },
  { directoryName: 'android-kotlin',        displayName: 'Android Kotlin' },
  { directoryName: 'cpp-tui',               displayName: 'C++ TUI' },
  { directoryName: 'dotnet-maui',           displayName: '.NET MAUI' },
  { directoryName: 'dotnet-tui',            displayName: '.NET TUI' },
  { directoryName: 'dotnet-winforms',       displayName: '.NET WinForms' },
  { directoryName: 'edge-server',           displayName: 'Edge Server' },
  { directoryName: 'flutter_app',           displayName: 'Flutter' },
  { directoryName: 'go-tui',                displayName: 'Go TUI' },
  { directoryName: 'java-server',           displayName: 'Java Server' },
  { directoryName: 'javascript-tui',        displayName: 'JavaScript TUI' },
  { directoryName: 'javascript-web',        displayName: 'JavaScript Web' },
  { directoryName: 'kotlin-multiplatform',  displayName: 'Kotlin Multiplatform' },
  { directoryName: 'react-native',          displayName: 'React Native' },
  { directoryName: 'react-native-expo',     displayName: 'React Native Expo' },
  { directoryName: 'rust-tui',              displayName: 'Rust TUI' },
  { directoryName: 'swift',                 displayName: 'Swift' },
];
