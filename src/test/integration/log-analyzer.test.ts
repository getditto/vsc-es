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

  test('opening the Log Analyzer command does not throw', async () => {
    // Smoke test: panel creation goes through real WebviewPanel, real
    // backfillProvider (Logger.readAllLogs), real diff subscription.
    // We just assert the command resolves without throwing.
    await vscode.commands.executeCommand('dittoVsce.openLogAnalyzer');
    // Re-execute to exercise the singleton-reveal path.
    await vscode.commands.executeCommand('dittoVsce.openLogAnalyzer');
  });

  test('opening the Pattern Editor command does not throw', async () => {
    await vscode.commands.executeCommand('dittoVsce.openLogPatternEditor');
    await vscode.commands.executeCommand('dittoVsce.openLogPatternEditor');
  });

  test('Logging tree exposes the two new nodes', () => {
    // The tree is registered with id 'dittoLogging' in package.json. We can't
    // call its provider directly from here, but we can verify the contribution
    // is declared and the commands the nodes use are present (covered above).
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
