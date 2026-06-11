import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Log Analyzer integration', function () {
  this.timeout(15_000);

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    assert.ok(ext, 'ditto.ditto-vsce extension must be installed');
    if (!ext!.isActive) { await ext!.activate(); }
  });

  test('analyzer + pattern editor commands are registered', async () => {
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(
      cmds.includes('dittoVsce.openLogAnalyzer'),
      'expected dittoVsce.openLogAnalyzer in command list',
    );
    assert.ok(
      cmds.includes('dittoVsce.openLogPatternEditor'),
      'expected dittoVsce.openLogPatternEditor in command list',
    );
  });

  test('opening the Log Analyzer without a databaseId is a graceful no-op', async () => {
    // The Log Analyzer is per-database now — invoking without a databaseId
    // surfaces a warning instead of opening an unscoped panel. The command
    // must still resolve cleanly so commandPalette invocations don't throw.
    await vscode.commands.executeCommand('dittoVsce.openLogAnalyzer');
    await vscode.commands.executeCommand('dittoVsce.openLogAnalyzer', undefined);
  });

  test('opening the Log Analyzer with a databaseId opens the panel', async () => {
    // Passing a databaseId routes through the panel constructor. There's no
    // active connection in the load-depth harness, so the panel opens with
    // the friendly name fallback (= the id). We just assert the command
    // resolves cleanly; deeper E2E is left to DITTO_CI_DEPTH=e2e.
    await vscode.commands.executeCommand('dittoVsce.openLogAnalyzer', 'ci-fake-database-id');
    // Re-execute to exercise the singleton-reveal path.
    await vscode.commands.executeCommand('dittoVsce.openLogAnalyzer', 'ci-fake-database-id');
  });

  test('opening the Pattern Editor command does not throw', async () => {
    await vscode.commands.executeCommand('dittoVsce.openLogPatternEditor');
    await vscode.commands.executeCommand('dittoVsce.openLogPatternEditor');
  });

  test('dittoLogging view is registered', () => {
    // The Log Analyzer is no longer in the global Logging sidebar (it's
    // per-database now), but the Pattern Editor still is, so the view
    // must remain. The dittoLogging view is contributed by package.json.
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    const views = ext!.packageJSON?.contributes?.views?.dittoVsce as { id: string }[] | undefined;
    assert.ok(Array.isArray(views), 'dittoVsce views must be an array');
    assert.ok(
      views!.some(v => v.id === 'dittoLogging'),
      'expected a view with id "dittoLogging"',
    );
  });

  test('bundled pattern catalog ships in dist/', async () => {
    // Smoke check that Task 21's esbuild step deposited the JSON catalog
    // where PatternStore expects it (context.asAbsolutePath('dist/patterns/...')).
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    const root = ext!.extensionPath;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const catalog = path.join(root, 'dist', 'patterns', 'problem_patterns.json');
    const raw = await fs.readFile(catalog, 'utf8');
    const obj = JSON.parse(raw) as Record<string, { severity: number; recommendation: string }>;
    assert.ok(obj.deadlock_critical, 'expected deadlock_critical in bundled catalog');
    assert.equal(obj.deadlock_critical.severity, 5);
    assert.ok(obj.deadlock_critical.recommendation.length > 0);
  });
});
