import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PatternEngine, type KeyedRawPattern } from '../logAnalyzer/PatternEngine.js';
import { parseLine } from '../logAnalyzer/LineParser.js';

const PATTERNS_DIR = path.resolve(import.meta.dirname, '../logAnalyzer/patterns');
const FIXTURES_DIR = path.join(PATTERNS_DIR, '__fixtures__');

async function loadBundled(): Promise<KeyedRawPattern[]> {
  const txt = await fs.readFile(path.join(PATTERNS_DIR, 'problem_patterns.json'), 'utf8');
  const obj = JSON.parse(txt) as Record<string, Omit<KeyedRawPattern, 'key'>>;
  return Object.entries(obj).map(([key, p]) => ({ key, ...p }));
}

test('fixtures: every bundled pattern has a matching fixture file', async () => {
  const bundled = await loadBundled();
  const files = await fs.readdir(FIXTURES_DIR);
  const txtFiles = files.filter(f => f.endsWith('.txt')).map(f => f.replace(/\.txt$/, ''));
  for (const p of bundled) {
    const hasFixture = txtFiles.some(name => name === p.key);
    assert.ok(hasFixture, `Missing fixture file for pattern: ${p.key}.txt`);
  }
});

test('fixtures: each fixture matches its expected key set', async () => {
  const bundled = await loadBundled();
  const engine = new PatternEngine({ listAll: () => ({ bundled, user: [] }) });
  engine.load();

  const files = (await fs.readdir(FIXTURES_DIR)).filter(f => f.endsWith('.txt'));
  for (const file of files) {
    const raw = (await fs.readFile(path.join(FIXTURES_DIR, file), 'utf8')).trimEnd();
    const expectedRaw = await fs.readFile(
      path.join(FIXTURES_DIR, file.replace(/\.txt$/, '.expected.json')),
      'utf8',
    );
    const expected = new Set<string>(JSON.parse(expectedRaw).matches);
    const line = parseLine(raw, 0);
    const actual = new Set(engine.scan(line).map(p => p.key));
    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      `Fixture ${file}: expected matches ${[...expected].join(', ')} got ${[...actual].join(', ')}`,
    );
  }
});
