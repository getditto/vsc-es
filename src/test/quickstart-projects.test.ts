import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUICKSTART_PROJECTS,
  QUICKSTART_REPO_URL,
  QUICKSTART_FOLDER_NAME,
  ENV_DESTINATIONS,
  EDGE_SERVER_RELATIVE_DIR,
  EDGE_SERVER_YAML_NAME,
} from '../quickstart/quickstart-projects.js';

test('QUICKSTART_PROJECTS — every entry has non-empty directoryName and displayName', () => {
  assert.ok(QUICKSTART_PROJECTS.length > 0, 'must list at least one project');
  for (const p of QUICKSTART_PROJECTS) {
    assert.ok(p.directoryName.length > 0, `empty directoryName in entry ${JSON.stringify(p)}`);
    assert.ok(p.displayName.length > 0, `empty displayName in entry ${JSON.stringify(p)}`);
  }
});

test('QUICKSTART_PROJECTS — directoryNames are unique', () => {
  const seen = new Set<string>();
  for (const p of QUICKSTART_PROJECTS) {
    assert.equal(seen.has(p.directoryName), false, `duplicate directoryName: ${p.directoryName}`);
    seen.add(p.directoryName);
  }
});

test('ENV_DESTINATIONS — matches SwiftUI: root + flutter_app + go-tui', () => {
  assert.deepEqual(ENV_DESTINATIONS, ['.env', 'flutter_app/.env', 'go-tui/.env']);
});

test('Repo URL and folder name match SwiftUI/upstream', () => {
  assert.equal(QUICKSTART_REPO_URL, 'https://github.com/getditto/quickstart.git');
  assert.equal(QUICKSTART_FOLDER_NAME, 'quickstart');
  assert.equal(EDGE_SERVER_RELATIVE_DIR, 'edge-server');
  assert.equal(EDGE_SERVER_YAML_NAME, 'quickstart_config.yaml');
});
