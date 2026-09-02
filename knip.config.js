/** @type {import('knip').KnipConfig} */
export default {
  // Only the entries knip's defaults don't already cover — it auto-detects
  // test files, and files referenced from package.json scripts, on its own.
  // (Confirmed via `knip`'s own "Configuration hints" output; anything not
  // listed there as redundant stays here.)
  entry: ['webview-ui/*/main.ts'],
  project: ['src/**/*.ts', 'webview-ui/**/*.ts', 'scripts/**/*.mjs'],
  ignoreFiles: [
    // Invoked from esbuild.config.mjs via execFileSync with a
    // programmatically-joined path, not an import — invisible to knip's
    // dependency graph no matter which config knob points at it.
    'scripts/render-help.mjs',
  ],
  ignoreDependencies: [
    // Copied via fs.copyFileSync in esbuild.config.mjs for webview
    // <link>/@font-face consumption, not imported — knip can't see
    // filesystem-level usage.
    '@vscode/codicons',
    // Used by scripts/render-help.mjs, which is in ignoreFiles above (it's
    // spawned by path, not imported) — so this import is invisible too.
    'markdown-it',
  ],
};
