import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The extension host is a Node process shared with every other installed
 * extension, so a process-level error handler is not a safety net — it is a
 * cross-extension listener.
 *
 * This is a drift guard, not a style rule. The handlers it forbids were in
 * `activate()` and had captured 1,856 unhandled rejections in one real log set,
 * every identifiable one belonging to a different extension (Copilot, Vim,
 * Ionide, github-authentication, VS Code core). They were logged under our tag,
 * counted as our errors by our own Log Analyzer, written into the log file the
 * user exports to us, and leaked one listener per extension reload. Registering
 * an `uncaughtException` listener additionally suppresses Node's default
 * process termination, for the whole host.
 *
 * Catch rejections where they originate instead — see `webviewMessageHandler`
 * and the `no-floating-promises` lint rule.
 */

/** Process events that must never be listened to from extension-host code. */
const FORBIDDEN = ['uncaughtException', 'unhandledRejection', 'exit', 'beforeExit', 'SIGINT', 'SIGTERM'];

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests may legitimately install handlers for their own harness.
      if (entry.name === 'test') { continue; }
      await sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('no extension-host code registers a process-level error handler', async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles('src')) {
    const text = await fs.readFile(file, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      // Skip comments — the explanation in extension.ts names these events.
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      const m = /process\s*\.\s*(?:on|once|addListener|prependListener)\s*\(\s*['"]([^'"]+)['"]/.exec(code);
      // The regex's capture group is mandatory, so a match implies m[1] exists.
      if (m && FORBIDDEN.includes(m[1]!)) {
        offenders.push(`${file}:${i + 1} process.on('${m[1]}')`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'process-level handlers fire for every extension in the shared host, '
    + 'suppress Node\'s default crash behaviour, and leak across reloads',
  );
});

test('the reasoning is recorded where the handlers used to be', async () => {
  // A bare deletion invites the next person to re-add it as an obvious
  // improvement. The comment is the durable half of this fix, so assert it
  // survives refactoring of activate().
  const text = await fs.readFile('src/extension.ts', 'utf8');
  assert.match(text, /shared Node process/i, 'extension.ts should explain why these handlers are absent');
  assert.match(text, /uncaughtException/, 'and name the events it is warning about');
});
