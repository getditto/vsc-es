import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

// esbuild targets CJS, so Node's built-in `__dirname` is available at runtime.
// Avoid `import.meta.url` here since esbuild can't resolve it for CJS output.
declare const __dirname: string;

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 });
  const testsRoot = __dirname;
  const depth = process.env.DITTO_CI_DEPTH ?? 'load';
  // 'load' runs the cheap smoke tests that don't need live Ditto connectivity.
  // 'e2e' runs everything, including network-dependent suites.
  const patterns = depth === 'e2e'
    ? ['**/*.test.js']
    : ['activation.test.js', 'log-analyzer.test.js'];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const matches = await glob(pattern, { cwd: testsRoot });
    for (const f of matches) {
      if (seen.has(f)) continue;
      seen.add(f);
      mocha.addFile(path.resolve(testsRoot, f));
    }
  }
  return new Promise((resolve, reject) => {
    mocha.run(failures => failures > 0 ? reject(new Error(`${failures} failed`)) : resolve());
  });
}
