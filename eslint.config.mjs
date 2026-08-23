import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint config for the extension host (`src/`) and the Lit webviews
 * (`webview-ui/`).
 *
 * Type-aware linting is on. It is slower than the syntactic-only preset, but
 * the rules worth having here — floating promises, misused promises, unsafe
 * `any` flow across the IPC boundary — all need type information. `tsc
 * --noEmit` already runs in CI, so the type graph is being built regardless.
 *
 * Rule choices lean on what code review of this repo actually turns up
 * repeatedly, rather than on a maximal preset:
 *
 *   - `no-floating-promises` / `no-misused-promises`: the defect class behind
 *     every "the button silently did nothing" bug in the panels. VS Code's
 *     event APIs ignore a listener's return value, so handing them an async
 *     function loses the rejection.
 *   - `require-await`, `await-thenable`: catch the inverse mistake.
 *   - `no-unnecessary-condition` is deliberately OFF: the codebase defends
 *     against SDK values that are typed non-nullable but arrive undefined
 *     from native code, and the rule cannot tell that from dead code.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.vscode-test/**',
      'scripts/**',
      '*.vsix',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // The build and lint configs are outside tsconfig's `include`, so the
          // project service has no program for them. Linted against the default
          // project instead of being excluded — a syntax error in the build
          // script should still fail lint.
          allowDefaultProject: ['*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── The rules that earn their keep here ───────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // ── Deliberate relaxations ────────────────────────────────
      // The SDK's surface is largely `any`, and the extension casts at that
      // boundary on purpose. Flagging every read through it would bury the
      // findings above in noise; `no-explicit-any` below keeps the casts
      // visible and greppable, which is the part that matters.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',

      // `noUnusedLocals`/`noUnusedParameters` in tsconfig already cover this,
      // and the two disagree about `_`-prefixed parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // Template literals carrying a number or boolean are idiomatic in the
      // DQL and log-message builders throughout this codebase.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],

      // An async function with no await is usually interface conformance (a
      // Sink, a store, an IPC handler whose siblings are async). Not a defect,
      // and the rule fires ~90 times on this codebase for exactly that.
      '@typescript-eslint/require-await': 'off',

      // `ignoreReadBeforeAssign` matters for the deferred-subscription shape:
      // `let sub; const cleanup = () => sub?.dispose(); sub = subscribe(...)`.
      // The variable is assigned once, but a `const` cannot be hoisted above
      // the closure that reads it, so the default reading of the rule is
      // simply wrong there.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // Production code logs through the Logger (Logger.ts), never console.* —
    // console output from the extension host is invisible to users and
    // pollutes other extensions' output channels. Tests and build scripts
    // are exempt (separate blocks below).
    files: ['src/**/*.ts', 'webview-ui/**/*.ts'],
    ignores: ['src/test/**'],
    rules: { 'no-console': 'error' },
  },
  {
    // Webviews run in the browser; there is no Node global surface there, and
    // `vscode` must never be imported (the host/webview split is the whole
    // architecture).
    files: ['webview-ui/**/*.ts'],
    rules: {
      // Lit binds event listeners to the host element, so `@click=${this.foo}`
      // is correct by construction. The rule cannot see that and fires on
      // every template handler in the project.
      '@typescript-eslint/unbound-method': 'off',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                'Webviews must not import vscode. Communicate with the host through the typed postMessage contracts in src/ipc/messages.ts.',
            },
            {
              name: '@dittolive/ditto',
              message:
                'Webviews must not import the SDK. Keep it in the extension host and pass data over IPC.',
            },
          ],
        },
      ],
    },
  },
  {
    // The build script is Node ESM, not browser or extension-host code. Only
    // the globals it actually uses are declared — enough for `no-undef` to be
    // meaningful there rather than switched off wholesale.
    files: ['*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // Tests reach into internals and build deliberately-malformed fixtures.
    files: ['src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `node:test`'s `test()` returns a Promise that the runner owns; the
      // whole API is fire-and-forget by design. Leaving this on produced 555
      // findings, all of them this one idiom — enough noise to hide the single
      // real floating promise the rule found in src/.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
