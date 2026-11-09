import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Assertions about `package.json` itself.
 *
 * `package.json` is the source of truth for every contribution point, and
 * nothing else typechecks it. These are the manifest invariants that were
 * previously either unchecked or delegated to a human squinting at the
 * Extension Development Host.
 */
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  engines: { vscode: string; node: string };
  contributes: {
    viewsContainers: Record<string, { id: string; title: string; icon: string }[]>;
    views: Record<string, { id: string; type?: string }[]>;
    commands: { command: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
    configuration: { properties: Record<string, { scope?: string; type: string }> };
  };
  capabilities?: Record<string, unknown>;
  activationEvents: string[];
  devDependencies?: Record<string, string>;
};

/** Minimum `major.minor` the manifest's contribution points require. */
const MIN_VSCODE = { major: 1, minor: 106 };

test('engines.vscode is high enough for the secondary side bar container', () => {
  // `contributes.viewsContainers.secondarySidebar` only became stable in VS Code
  // 1.106. Below that the Inspector's container is silently ignored and its view
  // falls back to the Explorer — no error, just the wrong place. Lowering this
  // floor is the regression, so assert on the floor rather than on the symptom.
  const raw = manifest.engines.vscode;
  const m = /^\^?(\d+)\.(\d+)\./.exec(raw);
  assert.ok(m, `engines.vscode should be a caret semver, got ${raw}`);
  const [major, minor] = [Number(m[1]), Number(m[2])];
  assert.ok(
    major > MIN_VSCODE.major || (major === MIN_VSCODE.major && minor >= MIN_VSCODE.minor),
    `engines.vscode is ${raw}; contributes.viewsContainers.secondarySidebar needs `
    + `>= ${MIN_VSCODE.major}.${MIN_VSCODE.minor}`,
  );
});

test('the Inspector container is contributed to the secondary side bar', () => {
  const containers = manifest.contributes.viewsContainers.secondarySidebar;
  assert.ok(Array.isArray(containers), 'secondarySidebar must be an array');
  const inspector = containers.find(c => c.id === 'dittoInspector');
  assert.ok(inspector, 'expected a dittoInspector container');
  assert.ok(inspector.icon, 'a container without an icon renders blank in the bar');
});

test('every views key names a container that exists', () => {
  // A typo here produces a view that never appears, with no error anywhere.
  const containerIds = new Set(
    Object.values(manifest.contributes.viewsContainers).flat().map(c => c.id),
  );
  // 'explorer', 'debug', etc. are built in; only our own prefixed ones must resolve.
  for (const key of Object.keys(manifest.contributes.views)) {
    if (!key.startsWith('ditto')) { continue; }
    assert.ok(containerIds.has(key), `views."${key}" has no matching viewsContainer`);
  }
});

test('every menu entry references a declared command', () => {
  // The usual failure is renaming a command and missing one of its menu
  // entries, which leaves a context-menu item that does nothing.
  const declared = new Set(manifest.contributes.commands.map(c => c.command));
  const missing: string[] = [];
  for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
    for (const entry of entries) {
      if (!declared.has(entry.command)) { missing.push(`${menu} → ${entry.command}`); }
    }
  }
  assert.deepEqual(missing, [], 'menu entries pointing at undeclared commands');
});

test('the log-analyzer pattern path setting is machine-scoped', () => {
  // Window scope lets a workspace's .vscode/settings.json point the extension
  // at an arbitrary file, whose entries are compiled into RegExps and run
  // against every log line on the extension host's only thread.
  const prop = manifest.contributes.configuration.properties['dittoVsce.logAnalyzer.customPatternsFile'];
  assert.ok(prop, 'setting must exist');
  assert.equal(
    prop.scope, 'machine',
    'a workspace must not be able to choose which file the extension reads',
  );
});

test('workspace-trust and virtual-workspace support are declared', () => {
  // Undeclared means VS Code has to guess, and the extension shows up in the
  // restricted-mode UI with no explanation for the user.
  const caps = manifest.capabilities as {
    untrustedWorkspaces?: { supported?: unknown; restrictedConfigurations?: string[] };
    virtualWorkspaces?: { supported?: unknown };
  } | undefined;
  assert.ok(caps, 'capabilities must be declared');
  assert.ok(caps.untrustedWorkspaces?.supported !== undefined, 'untrustedWorkspaces');
  assert.ok(caps.virtualWorkspaces?.supported !== undefined, 'virtualWorkspaces');
  assert.ok(
    caps.untrustedWorkspaces?.restrictedConfigurations?.includes(
      'dittoVsce.logAnalyzer.customPatternsFile',
    ),
    'the pattern-file setting must be listed as restricted in untrusted workspaces',
  );
});

test('command ids are unique and namespaced', () => {
  const ids = manifest.contributes.commands.map(c => c.command);
  assert.deepEqual(
    ids.filter(id => !id.startsWith('dittoVsce.')), [],
    'commands must be namespaced to avoid colliding with other extensions',
  );
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], 'duplicate command declarations');
});

test('@types/vscode does not outrun the declared engines.vscode floor', () => {
  // `vsce package` refuses to build when the types package is newer than the
  // engine floor: "@types/vscode ~1.140.0 greater than engines.vscode
  // ^1.106.0. Either upgrade engines.vscode or use an older @types/vscode
  // version". Raising engines.vscode to satisfy the types would drop support
  // for every VS Code release below it (the README documents ≥ 1.106), so the
  // types are the side that has to move. This assertion fails at test time
  // rather than in the release pipeline, where it red-screens a tagged build.
  const raw = manifest.engines.vscode;
  const m = /^\^?(\d+)\.(\d+)\./.exec(raw);
  assert.ok(m, `engines.vscode should be a caret semver, got ${raw}`);
  const floor = `${Number(m[1])}.${Number(m[2])}`;
  const types = manifest.devDependencies?.['@types/vscode'];
  assert.ok(types, '@types/vscode must be declared as a devDependency');
  const tm = /(\d+)\.(\d+)/.exec(types);
  assert.ok(tm, `@types/vscode should be a semver range, got ${types}`);
  assert.ok(
    Number(tm[1]) < Number(m[1]) || (Number(tm[1]) === Number(m[1]) && Number(tm[2]) <= Number(m[2])),
    `@types/vscode ${types} is newer than engines.vscode ${raw} (floor ${floor}) — `
    + 'vsce package will refuse to build. Pin @types/vscode to the engine floor '
    + 'rather than raising engines.vscode.',
  );
});

test('package.json version has matching release notes (release gate pre-check)', () => {
  // The release workflow hard-fails when the pushed tag ≠ package.json
  // version. Repo convention is that a version and its
  // docs/releases/v<version>.md notes land in the same commit — v0.9.5's
  // notes shipped without the bump, so tagging would have red-screened
  // the release. Assert both directions so neither half drifts again.
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  assert.ok(
    existsSync(`docs/releases/v${version}.md`),
    `docs/releases/v${version}.md is missing — write the notes with the bump`,
  );
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  assert.equal(lock.version, version, 'package-lock.json root version drifted from package.json');
  assert.equal(lock.packages['']?.version, version, 'package-lock.json packages[""] version drifted');
});
